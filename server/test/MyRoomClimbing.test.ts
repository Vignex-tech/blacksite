import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";

import appConfig from "../src/app.config.js";
import { ACTION_MESSAGE, ACTIONS, ANCHOR_RANGE, MOVE_MESSAGE, MOVEMENT_MODES, ROOM_NAME, STEP_HEIGHT } from "../../shared/protocol.js";
import { GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT, UPPER_LEVEL_Y, type Anchor, type ClimbAnchor, type LedgeAnchor } from "../../shared/map.js";
import { ACTION_BURST, ACTION_RATE_HZ, CLIMB_STEP, MOVE_RATE_HZ, MyRoom, SHIMMY_STEP, SIM_RATE_HZ, TEAM_STEP } from "../src/rooms/MyRoom.js";
import { nearestOnLedge } from "../src/rules/climbing.js";
import { assertClear3, floor, rng } from "./verticalHelpers.js";

const EPS = 1e-9;
const SIM_MS = 1000 / SIM_RATE_HZ;
const ANCHORS = GRAYBOX_MAP.anchors;
const CATWALK = floor("catwalk");

function anchor(id: string): Anchor {
  const a = ANCHORS.find((v) => v.id === id);
  if (!a) throw new Error(`no anchor ${id}`);
  return a;
}
const climbAnchor = (id: string) => anchor(id) as ClimbAnchor;
const ledge = (id: string) => anchor(id) as LedgeAnchor;

function distTo(a: Anchor, x: number, z: number): number {
  if (a.kind === "climb") return Math.hypot(a.x - x, a.z - z);
  const p = nearestOnLedge(a, x, z);
  return Math.hypot(p.x - x, p.z - z);
}

interface P { x: number; y: number; z: number; mode: string; yaw: number }
const snap = (p: P) => ({ x: p.x, y: p.y, z: p.z, mode: p.mode, yaw: p.yaw });

describe("MyRoom climbing and hanging", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  /** A room with a ghost (`g`) and a warden (`w`), a manual clock and a test-driven simulation. */
  async function setup() {
    const room = (await colyseus.createRoom<MyRoom>(ROOM_NAME, {})) as unknown as MyRoom & { waitForNextMessage(): Promise<void> };
    room.autoSimulate = false;
    const g = await colyseus.connectTo(room as any);
    const w = await colyseus.connectTo(room as any);
    let t = room.now();
    room.now = () => t;
    const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId)!;
    /** One move; the clock advances one move period first unless `advance` is false. */
    const move = async (c: any, dx: number, dz: number, yaw?: number, advance = true) => {
      if (advance) t += 1000 / MOVE_RATE_HZ;
      c.send(MOVE_MESSAGE, yaw === undefined ? { dx, dz } : { dx, dz, yaw });
      await room.waitForNextMessage();
    };
    const act = async (c: any, payload: unknown, advance = true) => {
      if (advance) t += 1000 / ACTION_RATE_HZ;
      c.send(ACTION_MESSAGE, payload);
      await room.waitForNextMessage();
    };
    const sim = (ms: number) => room.simulate(ms);
    const place = (c: any, x: number, z: number, y = 0, mode = "ground") => {
      const p = player(c);
      p.x = x; p.z = z; p.y = y; p.mode = mode;
    };
    return { room, g, w, player, move, act, sim, place, tick: (ms: number) => { t += ms; } };
  }

  it("a Ghost walks from the yard to climb-west, climbs, hangs from its ledge, mantles and stands on the upper level", async () => {
    const { room, g, player, move, act, place } = await setup();
    // A Warden is not sent a Ghost it cannot see (#46); a second Ghost watches the first.
    const watcher = await colyseus.connectTo(room as any);
    assert.strictEqual(room.state.players.get(watcher.sessionId)!.team, "ghost");
    const a = climbAnchor("climb-west");
    const l = ledge(a.ledgeId);
    place(g, -14, a.z);
    const p = player(g);
    // Walk east (yaw pi/2 faces +x) until stopped by the west wall.
    for (let i = 0; i < 60 && p.x < a.x - EPS; i++) {
      await move(g, 0, 1, Math.PI / 2);
      assertClear3(p, "walk");
    }
    assert.ok(Math.abs(p.x - a.x) < 1e-6, `stopped at x ${p.x}`);
    assert.strictEqual(p.mode, "ground");

    // A forged climb with an anchor id and a position is just a climb from here.
    await act(g, { action: "climb", anchorId: "ledge-east-platform", x: 8, y: 3, z: 0 });
    assert.deepStrictEqual(snap(p), { x: a.x, y: 0, z: a.z, mode: "climbing", yaw: a.facing });
    await room.waitForNextPatch();
    assert.strictEqual((watcher.state as any).players.get(g.sessionId).mode, "climbing");

    // dz climbs at CLIMB_STEP per move; dx is ignored; yaw is still stored.
    await move(g, 1, 0, 0.3);
    assert.strictEqual(p.y, 0);
    assert.strictEqual(p.x, a.x);
    assert.ok(Math.abs(p.yaw - 0.3) < EPS);
    let moves = 0;
    while (p.mode === "climbing" && moves < 40) {
      const y0 = p.y;
      await move(g, 0, 1);
      moves++;
      if (p.mode === "climbing") assert.ok(Math.abs(p.y - (y0 + CLIMB_STEP)) < 1e-9, `step ${moves}`);
      assertClear3(p, `climb ${moves}`);
    }
    assert.strictEqual(moves, Math.round((a.maxY - a.minY) / CLIMB_STEP));
    assert.strictEqual(p.mode, "hanging");
    assert.ok(Math.abs(p.y - (l.y - PLAYER_HEIGHT)) < EPS);
    assert.strictEqual(p.yaw, l.facing);

    // A jump while attached does nothing.
    const hung = snap(p);
    await act(g, { action: "jump" });
    room.simulate(5 * SIM_MS);
    assert.deepStrictEqual(snap(p), hung);

    await act(g, { action: "climb" });
    assert.strictEqual(p.mode, "ground");
    assert.strictEqual(p.y, UPPER_LEVEL_Y);
    assert.ok(Math.abs(p.x - (a.x + 2 * PLAYER_HALF_SIZE)) < EPS);
    assertClear3(p, "mantled");
    // It walks on along the mezzanine without falling.
    for (let i = 0; i < 10; i++) {
      await move(g, 0, 1, Math.PI / 2);
      room.simulate(SIM_MS);
      assert.strictEqual(p.mode, "ground");
      assert.strictEqual(p.y, UPPER_LEVEL_Y);
    }
  });

  it("climbs the inside route at climb-east onto platform-east, and climbs back down to the ground", async () => {
    const { g, player, move, act, place } = await setup();
    const a = climbAnchor("climb-east");
    place(g, a.x - 0.5, a.z - 0.3);
    const p = player(g);
    await act(g, { action: "climb" });
    assert.strictEqual(p.mode, "climbing");
    for (let i = 0; i < 5; i++) await move(g, 0, 1);
    for (let i = 0; i < 10 && p.mode === "climbing"; i++) await move(g, 0, -1);
    assert.strictEqual(p.mode, "ground");
    assert.strictEqual(p.y, 0);

    await act(g, { action: "climb" });
    for (let i = 0; i < 40 && p.mode === "climbing"; i++) await move(g, 0, 1);
    assert.strictEqual(p.mode, "hanging");
    await act(g, { action: "climb" });
    assert.strictEqual(p.mode, "ground");
    assert.strictEqual(p.y, UPPER_LEVEL_Y);
    assertClear3(p, "on platform-east");
  });

  it("a shimmy stays on the ledge's segment, and dz is ignored while hanging", async () => {
    const { g, player, move, act, place, sim } = await setup();
    const a = climbAnchor("climb-west");
    const l = ledge(a.ledgeId);
    place(g, a.x, a.z);
    const p = player(g);
    await act(g, { action: "climb" });
    for (let i = 0; i < 40 && p.mode === "climbing"; i++) await move(g, 0, 1);
    assert.strictEqual(p.mode, "hanging");

    const z0 = p.z;
    await move(g, 0, 1);
    assert.strictEqual(p.z, z0, "dz ignored");
    // Facing east, the right is -z.
    await move(g, 1, 0);
    assert.ok(Math.abs(p.z - (z0 - SHIMMY_STEP)) < EPS, `right is -z: ${p.z}`);
    let minZ = Infinity, maxZ = -Infinity;
    for (const dx of [1, -1]) {
      for (let i = 0; i < 100; i++) {
        await move(g, dx, 0);
        sim(SIM_MS);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
        assert.strictEqual(p.mode, "hanging");
        assert.ok(distTo(l, p.x, p.z) < 1e-9, `off the segment at (${p.x}, ${p.z})`);
        assertClear3(p, "shimmy");
      }
    }
    assert.ok(Math.abs(minZ - Math.min(l.z0, l.z1)) < EPS && Math.abs(maxZ - Math.max(l.z0, l.z1)) < EPS, `${minZ}..${maxZ}`);
  });

  it("a Ghost walks off the catwalk, grabs its ledge while falling, then drops and lands on the ground floor", async () => {
    const { g, player, move, act, sim, place } = await setup();
    const l = ledge("ledge-catwalk-south");
    place(g, 0, (CATWALK.min.z + CATWALK.max.z) / 2, UPPER_LEVEL_Y);
    const p = player(g);
    for (let i = 0; i < 40 && p.mode === "ground"; i++) await move(g, 0, -1, 0);
    assert.strictEqual(p.mode, "falling");
    for (let i = 0; i < 40 && p.mode === "falling"; i++) {
      sim(SIM_MS);
      await act(g, { action: "climb" });
    }
    assert.strictEqual(p.mode, "hanging");
    assert.ok(Math.abs(p.y - (l.y - PLAYER_HEIGHT)) < EPS);
    assert.ok(distTo(l, p.x, p.z) < 1e-9);
    // No gravity while hanging.
    sim(20 * SIM_MS);
    assert.strictEqual(p.mode, "hanging");

    await act(g, { action: "drop" });
    assert.strictEqual(p.mode, "falling");
    let steps = 0;
    for (; steps < 40 && p.mode === "falling"; steps++) {
      sim(SIM_MS);
      assertClear3(p, "drop");
    }
    assert.strictEqual(p.mode, "ground");
    assert.strictEqual(p.y, 0);
    assert.ok(steps > 2, `${steps} steps`);
    // Drop from the ground changes nothing.
    const before = snap(p);
    await act(g, { action: "drop" });
    assert.deepStrictEqual(snap(p), before);
  });

  it("refuses a Ghost climb one unit beyond ANCHOR_RANGE from every anchor, with forged fields too", async () => {
    const { g, player, act, place, sim, tick } = await setup();
    const p = player(g);
    let checked = 0;
    for (const a of ANCHORS) {
      const ref = a.kind === "climb" ? { x: a.x, z: a.z } : { x: (a.x0 + a.x1) / 2, z: (a.z0 + a.z1) / 2 };
      for (let k = 0; k < 8; k++) {
        const ang = (k * Math.PI) / 4;
        const x = ref.x + (ANCHOR_RANGE + 1) * Math.sin(ang);
        const z = ref.z + (ANCHOR_RANGE + 1) * Math.cos(ang);
        if (Math.min(...ANCHORS.map((o) => distTo(o, x, z))) < ANCHOR_RANGE + 1 - EPS) continue;
        place(g, x, z);
        sim(SIM_MS); // settles onto whatever is there (or starts a fall)
        for (let i = 0; i < 40 && p.mode === "falling"; i++) sim(SIM_MS);
        if (p.mode !== "ground") continue;
        try { assertClear3(p); } catch { continue; } // inside a solid: not a real spot
        const before = snap(p);
        await act(g, { action: "climb", anchorId: a.id, x: ref.x, z: ref.z, y: 1.2 });
        await act(g, { action: "climb" });
        sim(SIM_MS);
        assert.deepStrictEqual(snap(p), before, `${a.id} from (${x}, ${z})`);
        checked++;
      }
    }
    tick(1000);
    assert.ok(checked >= ANCHORS.length, `${checked} spots`);
  });

  it("refuses a Warden climb exactly on each anchor, from the ground or falling", async () => {
    const { w, player, act, place, sim } = await setup();
    const p = player(w);
    for (const a of ANCHORS) {
      if (a.kind === "climb") place(w, a.x, a.z, a.minY, "ground");
      else {
        const m = nearestOnLedge(a, (a.x0 + a.x1) / 2, (a.z0 + a.z1) / 2);
        place(w, m.x, m.z, a.y - PLAYER_HEIGHT, "falling");
      }
      const before = snap(p);
      await act(w, { action: "climb" });
      assert.deepStrictEqual(snap(p), before, a.id);
      assert.ok(p.mode !== "climbing" && p.mode !== "hanging");
      sim(40 * SIM_MS);
      assert.ok(p.mode !== "climbing" && p.mode !== "hanging");
    }
  });

  it("caps a forged climb flood with the shared action bucket", async () => {
    const { g, player, act, place, sim, tick } = await setup();
    const a = climbAnchor("climb-west");
    place(g, 15, -14);
    const p = player(g);
    // ACTION_BURST refused climbs far from every anchor, at one instant...
    for (let i = 0; i < ACTION_BURST; i++) await act(g, { action: "climb" }, false);
    // ...leave no token for a jump at the same instant.
    await act(g, { action: "jump" }, false);
    assert.strictEqual(p.mode, "ground");
    // At an anchor, a climb at the same instant is over budget too.
    place(g, a.x, a.z);
    await act(g, { action: "climb" }, false);
    assert.strictEqual(p.mode, "ground");
    tick(1000 / ACTION_RATE_HZ);
    await act(g, { action: "climb" }, false);
    assert.strictEqual(p.mode, "climbing");
    sim(SIM_MS);
  });

  it("re-grabs the climb anchor after dropping from it", async () => {
    const { g, player, move, act, sim, place } = await setup();
    const a = climbAnchor("climb-west");
    place(g, a.x, a.z);
    const p = player(g);
    await act(g, { action: "climb" });
    for (let i = 0; i < 10; i++) await move(g, 0, 1);
    const y = p.y;
    await act(g, { action: "drop" });
    assert.strictEqual(p.mode, "falling");
    sim(SIM_MS);
    assert.ok(p.y < y);
    await act(g, { action: "climb" });
    assert.strictEqual(p.mode, "climbing");
    assert.ok(p.y <= y && p.y >= a.minY);
  });

  it("fuzz: random moves and actions never overlap, never leave the bounds, and only Ghosts attach, only at anchors", async function () {
    this.timeout(120000);
    const climbs = ANCHORS.filter((a): a is ClimbAnchor => a.kind === "climb");
    const ledges = ANCHORS.filter((a): a is LedgeAnchor => a.kind === "ledge");
    // Legal starting spots near the anchors, on both levels.
    const spots: [number, number, number][] = [
      [-11.5, 4.5, 0], [-10.5, 3, 0], [8.5, -3, 0], [7, -3.2, 0], [0, -0.25, 3], [-8.5, -0.5, 3],
      [-8.5, 4.5, 3], [8, 0, 3], [-6.625, 0, 0], [15, -14, 0], [-3, -1.8, 0],
      [-10.5, 4.5, 0], [9, -2.5, 0], [-10.6, 6, 0],
    ];
    let attachedSeen = 0;
    for (const seed of [31, 3131]) {
      const { g, w, player, move, act, sim, place, tick } = await setup();
      const rand = rng(seed);
      for (let i = 0; i < 600; i++) {
        const c = rand() < 0.6 ? g : w;
        const r = rand();
        if (r < 0.05) {
          const [x, z, y] = spots[Math.floor(rand() * spots.length)];
          place(c, x, z, y);
        } else if (r < 0.6) {
          const dx = rand() < 0.2 ? 0 : rand() * 2 - 1;
          const dz = rand() < 0.2 ? 0 : rand() * 2 - 1;
          await move(c, dx, dz, rand() < 0.5 ? (rand() * 2 - 1) * Math.PI : undefined, false);
        } else {
          // Mostly 'climb' for the Ghost, so the fuzz spends time attached.
          const action = c === g && rand() < 0.6 ? "climb" : ACTIONS[Math.floor(rand() * ACTIONS.length)];
          await act(c, { action }, false);
        }
        tick(rand() * 120);
        if (rand() < 0.5) sim(rand() * 3 * SIM_MS);

        for (const who of [g, w]) {
          const p = player(who);
          const what = `seed ${seed} op ${i} ${p.team} ${p.mode}`;
          assertClear3(p, what);
          assert.ok(MOVEMENT_MODES.includes(p.mode as never), what);
          if (p.team === "warden") assert.ok(p.mode !== "climbing" && p.mode !== "hanging", what);
          if (p.mode === "climbing") {
            attachedSeen++;
            assert.ok(climbs.some((a) => a.x === p.x && a.z === p.z && p.y >= a.minY - EPS && p.y <= a.maxY + EPS), what);
          } else if (p.mode === "hanging") {
            attachedSeen++;
            assert.ok(ledges.some((l) => distTo(l, p.x, p.z) < 1e-9 && Math.abs(p.y - (l.y - PLAYER_HEIGHT)) < EPS), what);
          } else if (p.mode === "ground" && p.y > STEP_HEIGHT) {
            // High up only on authored floors and ramps (never on a solid top).
            const h = PLAYER_HALF_SIZE;
            const onFloor = GRAYBOX_MAP.floors.some((f) => Math.abs(f.max.y - p.y) < EPS && p.x + h > f.min.x && p.x - h < f.max.x && p.z + h > f.min.z && p.z - h < f.max.z);
            const onRamp = GRAYBOX_MAP.ramps.some((q) => p.x + h > q.minX && p.x - h < q.maxX && p.z + h > q.minZ && p.z - h < q.maxZ);
            assert.ok(onFloor || onRamp, `${what} standing at y ${p.y} on nothing authored`);
          }
        }
      }
      await colyseus.cleanup();
    }
    console.log(`      fuzz: ${attachedSeen} attached samples`);
    assert.ok(attachedSeen > 20, `the fuzz attached a Ghost (${attachedSeen} attached samples)`);
    assert.ok(TEAM_STEP.ghost > 0);
  });
});
