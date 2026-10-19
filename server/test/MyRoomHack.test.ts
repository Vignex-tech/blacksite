import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";

import appConfig from "../src/app.config.js";
import {
  HACK_DECAY_RATIO,
  HACK_DURATION_MS,
  HACK_PROGRESS_MESSAGE,
  HACK_RANGE,
  INTERACT_MESSAGE,
  ROOM_NAME,
} from "../../shared/protocol.js";
import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP } from "../../shared/map.js";
import { INTERACT_BURST, INTERACT_RATE_HZ, MyRoom } from "../src/rooms/MyRoom.js";
import { advanceProgress, canHack, parseInteract } from "../src/rules/hacking.js";

const TERM = GRAYBOX_MAP.terminals.find((x) => x.id === ACTIVE_TERMINAL_ID)!;
const OTHER = GRAYBOX_MAP.terminals.find((x) => x.id !== ACTIVE_TERMINAL_ID)!;

describe("hacking rules", () => {
  const ghost = { team: "ghost", health: 100, mode: "ground", x: TERM.x, y: 0, z: TERM.z };

  it("parseInteract needs a non-array object with a boolean active", () => {
    assert.strictEqual(parseInteract({ active: true, id: "x", x: 1 }), true);
    assert.strictEqual(parseInteract({ active: false }), false);
    for (const bad of [null, undefined, 1, "x", true, [], [true], {}, { active: 1 }, { active: "true" }, { active: null }]) {
      assert.strictEqual(parseInteract(bad), null, JSON.stringify(bad));
    }
  });

  it("canHack checks team, health, mode, range (with tolerance) and floor", () => {
    assert.ok(canHack(ghost, TERM));
    assert.ok(canHack({ ...ghost, x: TERM.x + HACK_RANGE }, TERM));
    assert.ok(!canHack({ ...ghost, x: TERM.x + HACK_RANGE + 1e-6 }, TERM));
    assert.ok(!canHack({ ...ghost, team: "warden" }, TERM));
    assert.ok(!canHack({ ...ghost, health: 0 }, TERM));
    for (const mode of ["falling", "climbing", "hanging"]) assert.ok(!canHack({ ...ghost, mode }, TERM), mode);
    assert.ok(!canHack({ ...ghost, y: 3 }, TERM));
  });

  it("advanceProgress gains, decays at the ratio, and clamps to 0..1", () => {
    assert.strictEqual(advanceProgress(0, HACK_DURATION_MS, true), 1);
    assert.strictEqual(advanceProgress(0.9, HACK_DURATION_MS, true), 1);
    assert.strictEqual(advanceProgress(0.5, HACK_DURATION_MS / 2, true), 1);
    assert.ok(Math.abs(advanceProgress(1, HACK_DURATION_MS / 2, false) - (1 - 0.5 * HACK_DECAY_RATIO)) < 1e-12);
    assert.strictEqual(advanceProgress(0.1, HACK_DURATION_MS, false), 0);
    assert.strictEqual(advanceProgress(0.3, 0, true), 0.3);
    assert.strictEqual(advanceProgress(0.3, -5, true), 0.3);
  });
});

describe("MyRoom hacking", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  /** Joins ghost g, warden w, ghost g2 with a manual clock starting on a whole ms. */
  async function setup() {
    const room = (await colyseus.createRoom<MyRoom>(ROOM_NAME, {})) as unknown as MyRoom & { waitForNextMessage(): Promise<void> };
    room.autoSimulate = false;
    const g = await colyseus.connectTo(room as any);
    const w = await colyseus.connectTo(room as any);
    const g2 = await colyseus.connectTo(room as any);
    let t = Math.ceil(room.now());
    room.now = () => t;
    const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId)!;
    const place = (c: any, x: number, z: number, y = 0, mode = "ground") => {
      const p = player(c);
      p.x = x; p.z = z; p.y = y; p.mode = mode;
    };
    const atTerminal = (c: any, dx = 0) => place(c, TERM.x + dx, TERM.z);
    const send = async (c: any, payload: unknown) => {
      c.send(INTERACT_MESSAGE, payload);
      await room.waitForNextMessage();
    };
    const hold = (c: any) => send(c, { active: true });
    const release = (c: any) => send(c, { active: false });
    const advance = (ms: number) => { t += ms; room.simulate(50); };
    const term = () => room.state.terminals.get(ACTIVE_TERMINAL_ID)!;
    return { room, g, w, g2, player, place, atTerminal, send, hold, release, advance, term, tick: (ms: number) => { t += ms; } };
  }

  it("creates one idle terminal per map terminal and exports the bucket", async () => {
    assert.strictEqual(INTERACT_RATE_HZ, 4);
    assert.strictEqual(INTERACT_BURST, 2);
    const { room } = await setup();
    assert.strictEqual(room.state.terminals.size, GRAYBOX_MAP.terminals.length);
    for (const def of GRAYBOX_MAP.terminals) {
      const e = room.state.terminals.get(def.id)!;
      assert.deepStrictEqual({ id: e.id, status: e.status, alert: e.alert }, { id: def.id, status: "idle", alert: false });
    }
  });

  it("a Ghost in range completes the hack in HACK_DURATION_MS within one step", async () => {
    const { room, g, atTerminal, hold, advance, term } = await setup();
    atTerminal(g);
    await hold(g);
    assert.strictEqual(term().status, "hacking");
    assert.strictEqual(room.hackProgress, 0);
    advance(HACK_DURATION_MS / 2);
    assert.ok(Math.abs(room.hackProgress - 0.5) < 1e-9);
    assert.strictEqual(term().status, "hacking");
    advance(HACK_DURATION_MS / 2);
    assert.strictEqual(room.hackProgress, 1);
    assert.strictEqual(term().status, "hacked");
    assert.strictEqual(term().alert, false);
  });

  it("hacked is final: later interacts and time change nothing", async () => {
    const { room, g, atTerminal, hold, release, advance, term, tick } = await setup();
    atTerminal(g);
    await hold(g);
    advance(HACK_DURATION_MS);
    assert.strictEqual(term().status, "hacked");
    tick(300);
    await release(g);
    tick(300);
    await hold(g);
    advance(60000);
    assert.strictEqual(term().status, "hacked");
    assert.strictEqual(room.hackProgress, 1);
  });

  it("only the active terminal can be hacked; the other stays idle", async () => {
    const { room, g, place, hold, advance } = await setup();
    place(g, OTHER.x, OTHER.z);
    await hold(g);
    advance(HACK_DURATION_MS);
    assert.strictEqual(room.state.terminals.get(OTHER.id)!.status, "idle");
    assert.strictEqual(room.state.terminals.get(ACTIVE_TERMINAL_ID)!.status, "idle");
    assert.strictEqual(room.hackProgress, 0);
  });

  it("a Warden in range, out of range, or forging from across the map changes nothing", async () => {
    const { room, g, w, atTerminal, place, hold, advance, term, tick } = await setup();
    atTerminal(w);
    await hold(w);
    advance(HACK_DURATION_MS);
    assert.strictEqual(term().status, "idle");
    assert.strictEqual(room.hackProgress, 0);

    place(g, TERM.x + HACK_RANGE + 0.05, TERM.z);
    tick(300);
    await hold(g);
    advance(HACK_DURATION_MS);
    assert.strictEqual(term().status, "idle");

    place(g, -TERM.x, -TERM.z);
    tick(300);
    await hold(g);
    advance(HACK_DURATION_MS);
    assert.strictEqual(term().status, "idle");
    assert.strictEqual(room.hackProgress, 0);
  });

  it("wrong mode, eliminated, and hacker who leaves range stop contributing", async () => {
    const { room, g, atTerminal, place, hold, advance, term, player, tick } = await setup();
    place(g, TERM.x, TERM.z, 0, "falling");
    await hold(g);
    advance(1000);
    assert.strictEqual(room.hackProgress, 0);

    atTerminal(g);
    tick(300);
    await hold(g);
    advance(2000);
    assert.ok(Math.abs(room.hackProgress - 0.2) < 1e-9);
    place(g, TERM.x + 5, TERM.z); // walked away
    advance(1000);
    const p = room.hackProgress;
    assert.ok(Math.abs(p - 0.15) < 1e-9, String(p));
    assert.strictEqual(term().status, "idle");
    atTerminal(g); // back in range: a held key does not resume
    advance(1000);
    assert.ok(room.hackProgress < p);

    tick(300);
    await hold(g);
    player(g).health = 0;
    advance(1000);
    assert.strictEqual(term().status, "idle");
  });

  it("invalid payloads spend no token; the flood limit holds", async () => {
    const { g, atTerminal, send, hold, release, term, tick } = await setup();
    atTerminal(g);
    for (const bad of [null, 5, "x", [], [true], {}, { active: 1 }, { active: "yes" }, { active: null }]) await send(g, bad);
    await hold(g); // burst token 1
    assert.strictEqual(term().status, "hacking");
    await release(g); // burst token 2
    assert.strictEqual(term().status, "idle");
    await hold(g); // no token left: ignored
    assert.strictEqual(term().status, "idle");
    tick(1000 / INTERACT_RATE_HZ);
    await hold(g); // one token refilled
    assert.strictEqual(term().status, "hacking");
  });

  it("progress decays at HACK_DECAY_RATIO of the gain rate and floors at 0", async () => {
    const { room, g, atTerminal, hold, release, advance, tick } = await setup();
    atTerminal(g);
    await hold(g);
    advance(HACK_DURATION_MS / 2);
    tick(300);
    await release(g);
    const before = room.hackProgress;
    assert.ok(before >= 0.5);
    advance(2000);
    assert.ok(Math.abs(room.hackProgress - (before - (2000 / HACK_DURATION_MS) * HACK_DECAY_RATIO)) < 0.04);
    advance(HACK_DURATION_MS * 4);
    assert.strictEqual(room.hackProgress, 0);
  });

  it("two hackers do not stack, and one leaving does not stop the other", async () => {
    const { room, g, g2, atTerminal, hold, advance, tick, term } = await setup();
    atTerminal(g);
    atTerminal(g2, 0.5);
    await hold(g);
    await hold(g2);
    advance(HACK_DURATION_MS / 2);
    assert.ok(Math.abs(room.hackProgress - 0.5) < 1e-9);
    await g.leave();
    await new Promise((r) => setTimeout(r, 50));
    tick(0);
    assert.strictEqual(term().status, "hacking");
    advance(HACK_DURATION_MS / 2);
    assert.strictEqual(term().status, "hacked");
  });

  it("Ghost clients get hackProgress when it changes; a Warden never does", async () => {
    const { g, w, atTerminal, hold, advance } = await setup();
    const gotG: number[] = [];
    const gotW: unknown[] = [];
    g.onMessage(HACK_PROGRESS_MESSAGE, (m: { progress: number }) => gotG.push(m.progress));
    w.onMessage(HACK_PROGRESS_MESSAGE, (m: unknown) => gotW.push(m));
    atTerminal(g);
    atTerminal(w);
    await hold(g);
    advance(HACK_DURATION_MS / 2);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(gotG.length >= 1);
    assert.ok(Math.abs(gotG[gotG.length - 1] - 0.5) < 1e-6);
    assert.deepStrictEqual(gotW, []);
  });

  it("terminal state carries only id, status and alert", async () => {
    const { room } = await setup();
    assert.deepStrictEqual(Object.keys(room.state.terminals.get(ACTIVE_TERMINAL_ID)!.toJSON()).sort(), ["alert", "id", "status"]);
  });
});
