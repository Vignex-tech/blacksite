import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";

import appConfig from "../src/app.config.js";
import { ACTION_MESSAGE, GRAVITY, JUMP_SPEED, MOVE_MESSAGE, MOVEMENT_MODES, ROOM_NAME } from "../../shared/protocol.js";
import { GRAYBOX_MAP, UPPER_LEVEL_Y } from "../../shared/map.js";
import {
  ACTION_BURST,
  ACTION_RATE_HZ,
  MOVE_RATE_HZ,
  MyRoom,
  SIM_RATE_HZ,
  TEAM_STEP,
  parseAction,
} from "../src/rooms/MyRoom.js";
import { assertClear3, floor, ramp } from "./verticalHelpers.js";

const EPS = 1e-9;
const APEX = JUMP_SPEED.ghost ** 2 / (2 * GRAVITY);
const SIM_MS = 1000 / SIM_RATE_HZ;
const OPEN = { x: 15, z: -14 };
const STAIRS = ramp("stairs-west");
const STAIRS_X = (STAIRS.minX + STAIRS.maxX) / 2;
const LANDING = floor("landing-nw");
const CATWALK = floor("catwalk");

describe("MyRoom height, falling and actions", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  /**
   * A room with a ghost (`g`) and a warden (`w`), a manual clock and the
   * simulation driven only by the test. `move` and `act` advance the clock by
   * one move or action period first unless `advance` is false; `sim` runs
   * the simulation.
   */
  async function setup() {
    const room = (await colyseus.createRoom<MyRoom>(ROOM_NAME, {})) as unknown as MyRoom & { waitForNextMessage(): Promise<void> };
    room.autoSimulate = false;
    const g = await colyseus.connectTo(room as any);
    const w = await colyseus.connectTo(room as any);
    let t = Math.ceil(room.now()); // whole ms: float sums like 1967.762 + 300 fall just short of an interval
    room.now = () => t;
    const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId)!;
    const move = async (c: any, dx: number, dz: number, advance = true) => {
      if (advance) t += 1000 / MOVE_RATE_HZ;
      c.send(MOVE_MESSAGE, { dx, dz, yaw: 0 });
      await room.waitForNextMessage();
    };
    const act = async (c: any, payload: unknown, advance = true) => {
      if (advance) t += 1000 / ACTION_RATE_HZ;
      c.send(ACTION_MESSAGE, payload);
      await room.waitForNextMessage();
    };
    const sim = (ms: number) => room.simulate(ms);
    const place = (c: any, x: number, z: number, y = 0) => {
      const p = player(c);
      p.x = x; p.z = z; p.y = y; p.mode = "ground";
    };
    return { room, g, w, player, move, act, sim, place, tick: (ms: number) => { t += ms; } };
  }

  it("syncs y and mode: players spawn on the ground in 'ground' mode", async () => {
    const { room, g, w, player } = await setup();
    for (const c of [g, w]) {
      assert.strictEqual(player(c).y, 0);
      assert.strictEqual(player(c).mode, "ground");
      assert.ok(MOVEMENT_MODES.includes(player(c).mode as never));
    }
    await room.waitForNextPatch();
    const seen = (g.state as any).players.get(w.sessionId);
    assert.strictEqual(seen.y, 0);
    assert.strictEqual(seen.mode, "ground");
  });

  it("exports the action budget and the simulation rate", () => {
    assert.strictEqual(ACTION_RATE_HZ, 5);
    assert.strictEqual(ACTION_BURST, 2);
    assert.strictEqual(SIM_RATE_HZ, 20);
  });

  it("validates action payloads", () => {
    for (const a of ["jump", "climb", "drop"]) assert.strictEqual(parseAction({ action: a }), a);
    assert.strictEqual(parseAction({ action: "jump", anchorId: "x", x: 1 }), "jump");
    for (const bad of [null, undefined, 1, "jump", [], ["jump"], {}, { action: "fly" }, { action: 1 }, { action: "JUMP" }, { action: null }]) {
      assert.strictEqual(parseAction(bad), null, JSON.stringify(bad));
    }
  });

  it("a Warden walks up the stairs to the upper level, back down without falling, then off an edge and lands", async () => {
    const { w, player, move, sim, place } = await setup();
    place(w, STAIRS_X, STAIRS.minZ - 0.8);
    const p = player(w);
    const landingZ = (LANDING.min.z + LANDING.max.z) / 2;
    for (let i = 0; i < 100 && p.z < landingZ; i++) {
      await move(w, 0, 1);
      sim(SIM_MS);
      assert.strictEqual(p.mode, "ground", `up, at z ${p.z}`);
      assertClear3(p, "up");
    }
    assert.ok(Math.abs(p.y - UPPER_LEVEL_Y) < EPS, `y ${p.y}`);

    for (let i = 0; i < 100 && p.z > STAIRS.minZ - 0.8; i++) {
      await move(w, 0, -1);
      sim(SIM_MS);
      assert.strictEqual(p.mode, "ground", `down, at z ${p.z}, y ${p.y}`);
      assertClear3(p, "down");
    }
    assert.strictEqual(p.y, 0);

    place(w, 0, (CATWALK.min.z + CATWALK.max.z) / 2, UPPER_LEVEL_Y);
    let fell = false;
    for (let i = 0; i < 60 && !(fell && p.mode === "ground"); i++) {
      await move(w, 0, -1);
      sim(SIM_MS);
      if (p.mode === "falling") fell = true;
      assertClear3(p, "off the edge");
    }
    assert.ok(fell, "it fell");
    assert.strictEqual(p.mode, "ground");
    assert.strictEqual(p.y, 0);
  });

  it("a Ghost jump rises to at most the apex and lands; moves in the air keep the team step", async () => {
    const { g, player, act, move, sim, place } = await setup();
    place(g, OPEN.x, OPEN.z);
    const p = player(g);
    await act(g, { action: "jump" });
    assert.strictEqual(p.mode, "falling");
    sim(SIM_MS);
    const z0 = p.z;
    await move(g, 0, 1);
    assert.ok(Math.abs(p.z - (z0 + TEAM_STEP.ghost)) < EPS, "air step");
    let top = p.y;
    for (let i = 0; i < 40 && p.mode === "falling"; i++) {
      sim(SIM_MS);
      top = Math.max(top, p.y);
    }
    assert.ok(top > 0.3 && top <= APEX + EPS, `apex ${top}`);
    assert.strictEqual(p.mode, "ground");
    assert.strictEqual(p.y, 0);
  });

  it("refuses a Warden jump, a jump in the air, and treats climb and drop as no-ops", async () => {
    const { g, w, player, act, sim, place } = await setup();
    place(w, OPEN.x, OPEN.z);
    await act(w, { action: "jump" });
    sim(10 * SIM_MS);
    assert.strictEqual(player(w).mode, "ground");
    assert.strictEqual(player(w).y, 0);

    // A second jump mid-air doesn't extend the jump: it lands on the same step.
    place(g, OPEN.x, OPEN.z - 3);
    const p = player(g);
    await act(g, { action: "jump" });
    sim(3 * SIM_MS);
    await act(g, { action: "jump" });
    sim(SIM_MS);
    // Still on the first jump's parabola after 4 steps.
    const t4 = (4 * SIM_MS) / 1000;
    const expected = JUMP_SPEED.ghost * t4 - (GRAVITY * t4 * t4) / 2;
    assert.ok(Math.abs(p.y - expected) < 1e-9, `no second boost: y ${p.y}, expected ${expected}`);
    let steps = 4;
    while (p.mode === "falling" && steps < 50) { sim(SIM_MS); steps++; }
    const single = Math.ceil((2 * JUMP_SPEED.ghost) / GRAVITY / (SIM_MS / 1000));
    assert.ok(steps <= single, `${steps} steps vs ${single}`);

    for (const action of ["climb", "drop"]) {
      const before = { x: p.x, y: p.y, z: p.z, mode: p.mode };
      await act(g, { action });
      sim(SIM_MS);
      assert.deepStrictEqual({ x: p.x, y: p.y, z: p.z, mode: p.mode }, before, action);
    }
  });

  it("caps an action flood with its bucket, and invalid payloads spend nothing", async () => {
    const { room, g, player, act, sim, place, tick } = await setup();
    place(g, OPEN.x, OPEN.z);
    const p = player(g);
    const landed = () => { for (let i = 0; i < 40 && p.mode === "falling"; i++) sim(SIM_MS); };

    // Invalid payloads at one instant spend no tokens.
    for (const bad of [{}, { action: "fly" }, null, "jump", [1]]) await act(g, bad, false);
    // The burst: ACTION_BURST jumps at one instant (landing in between) all work.
    for (let i = 0; i < ACTION_BURST; i++) {
      await act(g, { action: "jump" }, false);
      assert.strictEqual(p.mode, "falling", `jump ${i}`);
      landed();
    }
    // The next one at the same instant is over budget.
    await act(g, { action: "jump" }, false);
    assert.strictEqual(p.mode, "ground", "over budget");
    // One refill period later it works again.
    tick(1000 / ACTION_RATE_HZ);
    await act(g, { action: "jump" }, false);
    assert.strictEqual(p.mode, "falling");
    landed();

    // A 100 Hz flood for one second gets at most ACTION_RATE_HZ + ACTION_BURST jumps through.
    let jumps = 0;
    for (let i = 0; i < 100; i++) {
      tick(10);
      await act(g, { action: "jump" }, false);
      if (p.mode === "falling") { jumps++; landed(); }
    }
    assert.ok(jumps <= ACTION_RATE_HZ + ACTION_BURST, `${jumps} jumps`);
    assert.ok(jumps >= ACTION_RATE_HZ - 1, `${jumps} jumps`);
    assert.strictEqual(room.clients.length, 2);
  });

  it("drives the simulation from the room's interval when autoSimulate is on", async () => {
    const { room, g, player, act, place } = await setup();
    place(g, OPEN.x, OPEN.z);
    room.autoSimulate = true;
    await act(g, { action: "jump" });
    const p = player(g);
    for (let i = 0; i < 100 && p.mode === "falling"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(p.mode, "ground");
    assert.strictEqual(p.y, 0);
    assert.ok(GRAYBOX_MAP.floors.length > 0);
  });
});
