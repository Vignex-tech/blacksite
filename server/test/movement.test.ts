import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";

import appConfig from "../src/app.config.js";
import { MOVE_MESSAGE, ROOM_NAME, TEAM_SPEED, TEAMS } from "../../shared/protocol.js";
import { parseMove, worldStep, wrapYaw } from "../src/rules/movement.js";
import { MyRoom, MOVE_BURST, MOVE_RATE_HZ, TEAM_STEP } from "../src/rooms/MyRoom.js";
import { assertClear } from "./mapHelpers.js";

const EPS = 1e-9;
/** An open spot with more than 3 units of clearance in every direction. */
const OPEN = { x: 15, z: -14 };

type TeamName = "ghost" | "warden";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const near = (a: number, b: number, eps = EPS) => Math.abs(a - b) < eps;

describe("movement rules (pure)", () => {
  it("TEAM_STEP is TEAM_SPEED / MOVE_RATE_HZ for each team (ghost 0.12, warden 0.1)", () => {
    assert.deepStrictEqual(Object.keys(TEAM_STEP).sort(), [...TEAMS].sort());
    for (const t of TEAMS) assert.strictEqual(TEAM_STEP[t], TEAM_SPEED[t] / MOVE_RATE_HZ);
    assert.ok(near(TEAM_STEP.ghost, 0.12));
    assert.ok(near(TEAM_STEP.warden, 0.1));
    assert.ok(Object.isFrozen(TEAM_STEP));
  });

  it("wraps yaw into -pi..pi", () => {
    for (const y of [0, 1, -1, Math.PI / 2, -Math.PI / 2, 3]) assert.ok(near(wrapYaw(y), y), `${y}`);
    assert.ok(near(Math.abs(wrapYaw(3 * Math.PI)), Math.PI));
    assert.ok(near(Math.abs(wrapYaw(-3 * Math.PI)), Math.PI));
    assert.ok(near(wrapYaw(2 * Math.PI + 1), 1));
    assert.ok(near(wrapYaw(-2 * Math.PI - 1), -1));
    assert.ok(near(wrapYaw((5 * Math.PI) / 2), Math.PI / 2));
    for (const y of [1e6, -1e6, 1e300, -1e300, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      const w = wrapYaw(y);
      assert.ok(w >= -Math.PI && w <= Math.PI, `${y} -> ${w}`);
    }
  });

  it("accepts dx, dz and an optional finite yaw", () => {
    assert.deepStrictEqual(parseMove({ dx: 0.5, dz: -0.5 }), { dx: 0.5, dz: -0.5 });
    assert.deepStrictEqual(parseMove({ dx: 0, dz: 1, yaw: 1 }), { dx: 0, dz: 1, yaw: 1 });
    assert.deepStrictEqual(parseMove({ dx: 0, dz: 1, yaw: undefined }), { dx: 0, dz: 1 });
  });

  it("ignores the whole message for a non-finite or non-number yaw, dx or dz", () => {
    for (const yaw of ["1", {}, [], null, true, NaN, Infinity, -Infinity]) {
      assert.strictEqual(parseMove({ dx: 1, dz: 0, yaw }), null, `yaw ${String(yaw)}`);
    }
    for (const bad of [{ dx: "1", dz: 0 }, { dx: 0, dz: NaN }, { dz: 1 }, null, "move", [1, 1], 7]) {
      assert.strictEqual(parseMove(bad), null, JSON.stringify(bad));
    }
  });

  it("clamps each axis to -1..1, then caps the intent's length at 1", () => {
    const m = parseMove({ dx: 1000, dz: -1e9 })!;
    assert.ok(near(m.dx, Math.SQRT1_2) && near(m.dz, -Math.SQRT1_2));
    const d = parseMove({ dx: 1, dz: 1 })!;
    assert.ok(near(Math.hypot(d.dx, d.dz), 1));
    assert.deepStrictEqual(parseMove({ dx: 0.6, dz: 0.8 }), { dx: 0.6, dz: 0.8 });
    assert.deepStrictEqual(parseMove({ dx: -5, dz: 0 }), { dx: -1, dz: 0 });
  });

  it("wraps the parsed yaw", () => {
    const m = parseMove({ dx: 0, dz: 0, yaw: 2 * Math.PI + 0.5 })!;
    assert.ok(near(m.yaw!, 0.5));
  });

  it("follows the documented rotation: forward (sin, cos), right (cos, -sin)", () => {
    const s = 0.12;
    const cases: [number, number, number, number, number][] = [
      // dx, dz, yaw, expected x, expected z
      [0, 1, 0, 0, s],
      [1, 0, 0, s, 0],
      [0, 1, Math.PI / 2, s, 0],
      [1, 0, Math.PI / 2, 0, -s],
      [0, 1, Math.PI, 0, -s],
      [0, 1, -Math.PI / 2, -s, 0],
    ];
    for (const [dx, dz, yaw, x, z] of cases) {
      const w = worldStep(dx, dz, yaw, s);
      assert.ok(near(w.x, x) && near(w.z, z), `${dx},${dz} @ ${yaw}: ${w.x}, ${w.z}`);
    }
    // Yaw 0 keeps the M1/M2 mapping exactly.
    assert.deepStrictEqual(worldStep(1, -1, 0, 0.1), { x: 0.1, z: -0.1 });
  });
});

describe("MyRoom camera-relative movement", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => colyseus.cleanup());

  /** A room with a ghost (`g`) and a warden (`w`) and a manual clock. */
  async function setup() {
    const room = (await colyseus.createRoom<MyRoom>(ROOM_NAME, {})) as any;
    const g = await colyseus.connectTo(room);
    const w = await colyseus.connectTo(room);
    let t = room.now();
    room.now = () => t;
    const player = (c: { sessionId: string }) => (room as MyRoom).state.players.get(c.sessionId)!;
    /** Sends one move, advancing the clock by `ms` first (one rate step by default). */
    const send = async (c: any, payload: unknown, ms = 1000 / MOVE_RATE_HZ) => {
      t += ms;
      c.send(MOVE_MESSAGE, payload);
      await room.waitForNextMessage();
    };
    const place = (c: { sessionId: string }, x: number, z: number, yaw = 0) => {
      const p = player(c);
      p.x = x;
      p.z = z;
      p.yaw = yaw;
    };
    /**
     * Same as `send` but calls the room's move handler directly, skipping the
     * network round trip, for tests that send thousands of moves.
     */
    const sendFast = (c: { sessionId: string }, payload: unknown, ms = 1000 / MOVE_RATE_HZ) => {
      t += ms;
      room.messages[MOVE_MESSAGE](c, payload);
    };
    const stepOf = (c: { sessionId: string }) => TEAM_STEP[player(c).team as TeamName];
    assert.strictEqual(player(g).team, "ghost");
    assert.strictEqual(player(w).team, "warden");
    return { room: room as MyRoom, g, w, player, send, sendFast, place, stepOf };
  }

  it("stores a valid yaw, and a move without yaw keeps it", async () => {
    const { g, player, send, place } = await setup();
    place(g, OPEN.x, OPEN.z);
    await send(g, { dx: 0, dz: 0, yaw: 1.25 });
    assert.ok(near(player(g).yaw, 1.25));
    await send(g, { dx: 0, dz: 1 });
    assert.ok(near(player(g).yaw, 1.25));
    // The move used the kept yaw.
    assert.ok(near(player(g).x, OPEN.x + Math.sin(1.25) * TEAM_STEP.ghost));
    assert.ok(near(player(g).z, OPEN.z + Math.cos(1.25) * TEAM_STEP.ghost));
  });

  it("ignores the whole message for an invalid yaw: no move, no turn, no token spent", async () => {
    const { room, g, player, send, place } = await setup();
    place(g, OPEN.x, OPEN.z, 0.5);
    for (const yaw of ["1", { v: 1 }, [1], null, true, NaN, Infinity, -Infinity]) {
      await send(g, { dx: 1, dz: 1, yaw }, 0);
    }
    assert.deepStrictEqual({ x: player(g).x, z: player(g).z, yaw: player(g).yaw }, { x: OPEN.x, z: OPEN.z, yaw: 0.5 });
    assert.strictEqual(room.clients.length, 2);
    // The full burst is still available.
    for (let i = 0; i < MOVE_BURST; i++) await send(g, { dx: 0, dz: 1, yaw: 0 }, 0);
    assert.ok(near(player(g).z, OPEN.z + MOVE_BURST * TEAM_STEP.ghost));
  });

  it("wraps 3 pi and -3 pi into -pi..pi", async () => {
    const { g, player, send, place } = await setup();
    place(g, OPEN.x, OPEN.z);
    for (const yaw of [3 * Math.PI, -3 * Math.PI]) {
      await send(g, { dx: 0, dz: 0, yaw });
      assert.ok(near(Math.abs(player(g).yaw), Math.PI), `${yaw} -> ${player(g).yaw}`);
      assert.ok(player(g).yaw >= -Math.PI && player(g).yaw <= Math.PI);
    }
    await send(g, { dx: 0, dz: 0, yaw: 1e300 });
    assert.ok(player(g).yaw >= -Math.PI && player(g).yaw <= Math.PI);
  });

  it("yaw pi/2 forward moves +x and yaw pi forward moves -z by the team step", async () => {
    const { g, w, player, send, place, stepOf } = await setup();
    for (const c of [g, w]) {
      const step = stepOf(c);
      const team = player(c).team;
      place(c, OPEN.x, OPEN.z);
      await send(c, { dx: 0, dz: 1, yaw: Math.PI / 2 });
      assert.ok(near(player(c).x, OPEN.x + step) && near(player(c).z, OPEN.z), `${team} pi/2`);
      place(c, OPEN.x, OPEN.z);
      await send(c, { dx: 0, dz: 1, yaw: Math.PI });
      assert.ok(near(player(c).x, OPEN.x) && near(player(c).z, OPEN.z - step), `${team} pi`);
      place(c, OPEN.x, OPEN.z);
      await send(c, { dx: 1, dz: 0, yaw: Math.PI / 2 }); // strafing right at pi/2 is -z
      assert.ok(near(player(c).x, OPEN.x) && near(player(c).z, OPEN.z - step), `${team} strafe`);
    }
  });

  it("each team moves at its own step, and a diagonal is capped at one step", async () => {
    const { g, w, player, send, place, stepOf } = await setup();
    for (const c of [g, w]) {
      const step = stepOf(c);
      const team = player(c).team;
      place(c, OPEN.x, OPEN.z);
      await send(c, { dx: 0, dz: 1 });
      assert.ok(near(player(c).z - OPEN.z, step), `${team} straight`);
      for (const yaw of [0, 0.3, Math.PI / 4, 2, -2.5]) {
        place(c, OPEN.x, OPEN.z);
        await send(c, { dx: 1, dz: 1, yaw });
        const d = Math.hypot(player(c).x - OPEN.x, player(c).z - OPEN.z);
        assert.ok(near(d, step), `${team} diagonal at ${yaw}: ${d}`);
      }
    }
    assert.ok(TEAM_STEP.ghost > TEAM_STEP.warden);
  });

  it("a look-only move turns without moving and spends a token", async () => {
    const { g, player, send, place } = await setup();
    place(g, OPEN.x, OPEN.z);
    for (let i = 0; i < MOVE_BURST; i++) await send(g, { dx: 0, dz: 0, yaw: 0.1 * (i + 1) }, 0);
    assert.ok(near(player(g).yaw, 0.1 * MOVE_BURST));
    assert.deepStrictEqual({ x: player(g).x, z: player(g).z }, OPEN);
    // The budget was spent by turning: a move and turn at the same instant are dropped.
    await send(g, { dx: 0, dz: 1, yaw: 2 }, 0);
    assert.ok(near(player(g).yaw, 0.1 * MOVE_BURST));
    assert.deepStrictEqual({ x: player(g).x, z: player(g).z }, OPEN);
    // A flood of turns is limited like moves: one second at 100 Hz accepts at most rate + burst.
    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      const yaw = (i % 2 === 0 ? 1 : -1) * (1 + i / 1000);
      await send(g, { dx: 0, dz: 0, yaw }, 10);
      if (near(player(g).yaw, yaw)) accepted++;
    }
    assert.ok(accepted <= MOVE_RATE_HZ + MOVE_BURST, `accepted ${accepted}`);
    assert.ok(accepted >= MOVE_RATE_HZ - 1, `accepted ${accepted}`);
  });

  it("each team's sustained speed is at most TEAM_SPEED in any direction, diagonals included", async () => {
    const { g, w, player, sendFast, place, stepOf } = await setup();
    for (const c of [g, w]) {
      const team = player(c).team as TeamName;
      const step = stepOf(c);
      for (const yaw of [0, Math.PI / 4, 1, Math.PI / 2, 2.5, -Math.PI / 3, Math.PI]) {
        for (const [dx, dz] of [[0, 1], [1, 1], [-1, 1], [1000, -1000], [1, 0], [-0.3, -1]]) {
          // Let the bucket refill fully, then flood at 100 Hz for one simulated second.
          sendFast(c, { dx: 0, dz: 0 }, 1000);
          place(c, OPEN.x, OPEN.z, yaw);
          for (let i = 0; i < 100; i++) sendFast(c, { dx, dz }, 10);
          const moved = Math.hypot(player(c).x - OPEN.x, player(c).z - OPEN.z);
          const limit = TEAM_SPEED[team] + MOVE_BURST * step;
          assert.ok(moved <= limit + EPS, `${team} ${dx},${dz} @ ${yaw}: moved ${moved} > ${limit}`);
          assert.ok(moved >= TEAM_SPEED[team] - step - EPS, `${team} ${dx},${dz} @ ${yaw}: moved only ${moved}`);
        }
      }
    }
  });

  it("a rotated random walk never overlaps a solid or leaves the bounds", async () => {
    const { g, w, player, sendFast } = await setup();
    const random = rng(2024);
    for (let i = 0; i < 20000; i++) {
      const c = i % 2 === 0 ? g : w;
      const payload: Record<string, number> = { dx: random() * 4 - 2, dz: random() * 4 - 2 };
      if (random() < 0.7) payload.yaw = (random() * 2 - 1) * 10;
      sendFast(c, payload, 1000 / MOVE_RATE_HZ / 2);
      assertClear(player(c), `walk step ${i}`);
      assert.ok(player(c).yaw >= -Math.PI && player(c).yaw <= Math.PI);
    }
  });
});
