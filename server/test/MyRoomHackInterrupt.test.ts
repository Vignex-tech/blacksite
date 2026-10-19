import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";

import appConfig from "../src/app.config.js";
import {
  ACTION_MESSAGE,
  FIRE_MESSAGE,
  HACK_ALERT_AFTER_MS,
  HACK_DECAY_RATIO,
  HACK_DURATION_MS,
  INTERACT_MESSAGE,
  MOVE_MESSAGE,
  ROOM_NAME,
  WEAPONS,
} from "../../shared/protocol.js";
import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP } from "../../shared/map.js";
import { MyRoom } from "../src/rooms/MyRoom.js";

const TERM = GRAYBOX_MAP.terminals.find((x) => x.id === ACTIVE_TERMINAL_ID)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MyRoom hack interruptions and the Warden alert (#58)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  /** Ghost g, Warden w, Ghost g2 with a manual clock on a whole ms. Time only moves via advance/tick/send. */
  async function setup() {
    const room = (await colyseus.createRoom<MyRoom>(ROOM_NAME, {})) as unknown as MyRoom & { waitForNextMessage(): Promise<void> };
    room.autoSimulate = false;
    const g = await colyseus.connectTo(room as any);
    const w = await colyseus.connectTo(room as any);
    const g2 = await colyseus.connectTo(room as any);
    let t = Math.ceil(room.now());
    room.now = () => t;
    const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId)!;
    const place = (c: any, x: number, z: number) => {
      const p = player(c);
      p.x = x; p.z = z; p.y = 0; p.mode = "ground";
    };
    const send = async (c: any, type: string, payload: unknown, wait = 0) => {
      t += wait;
      c.send(type, payload);
      await room.waitForNextMessage();
    };
    const hold = (c: any) => send(c, INTERACT_MESSAGE, { active: true }, 300);
    const advance = (ms: number) => { t += ms; room.simulate(50); };
    const term = () => room.state.terminals.get(ACTIVE_TERMINAL_ID)!;
    const start = async (c: any, dx = 0) => { place(c, TERM.x + dx, TERM.z); await hold(c); };
    return { room, g, w, g2, player, place, send, hold, advance, term, start };
  }

  it("alert and status hacking appear only after HACK_ALERT_AFTER_MS of an unbroken hack", async () => {
    const { g, start, advance, term } = await setup();
    await start(g);
    assert.deepStrictEqual([term().status, term().alert], ["idle", false]);
    advance(HACK_ALERT_AFTER_MS - 50);
    assert.deepStrictEqual([term().status, term().alert], ["idle", false]);
    advance(50);
    assert.deepStrictEqual([term().status, term().alert], ["hacking", true]);
    advance(HACK_DURATION_MS - HACK_ALERT_AFTER_MS);
    assert.deepStrictEqual([term().status, term().alert], ["hacked", false]);
  });

  it("the alert goes off after releasing and the timer restarts from zero", async () => {
    const { g, hold, start, send, advance, term } = await setup();
    await start(g);
    advance(HACK_ALERT_AFTER_MS);
    assert.strictEqual(term().alert, true);
    await send(g, INTERACT_MESSAGE, { active: false }, 300);
    assert.deepStrictEqual([term().status, term().alert], ["idle", false]);
    await hold(g);
    advance(HACK_ALERT_AFTER_MS - 400);
    assert.strictEqual(term().alert, false);
    advance(400);
    assert.strictEqual(term().alert, true);
  });

  it("a move with non-zero intent interrupts; a turn-only move does not; a held key does not resume", async () => {
    const { room, g, start, send, advance, term } = await setup();
    await start(g);
    advance(2000);
    await send(g, MOVE_MESSAGE, { dx: 0, dz: 0, yaw: 1.2 }, 300); // aiming
    advance(1000);
    assert.ok(Math.abs(room.hackProgress - 0.33) < 1e-9);
    await send(g, MOVE_MESSAGE, { dx: 0, dz: 1 }, 300);
    assert.deepStrictEqual([term().status, term().alert], ["idle", false]);
    const kept = room.hackProgress;
    advance(1000);
    assert.ok(Math.abs(room.hackProgress - (kept - 0.1 * HACK_DECAY_RATIO)) < 1e-9, String(room.hackProgress));
    // Back in range with the key still down: no resume.
    const p = room.state.players.get(g.sessionId)!;
    p.x = TERM.x; p.z = TERM.z;
    const after = room.hackProgress;
    advance(1000);
    assert.ok(room.hackProgress < after);
  });

  it("damage interrupts at once with no extra penalty; a held key does not resume", async () => {
    const { room, g, w, start, place, send, advance, term } = await setup();
    await start(g);
    advance(4000);
    assert.strictEqual(term().alert, true);
    // Warden 4.5 units north of the terminal looks south at the Ghost.
    place(w, TERM.x, -1);
    await send(w, FIRE_MESSAGE, { yaw: Math.PI, pitch: 0 }, 300);
    const p = room.state.players.get(g.sessionId)!;
    assert.ok(p.health < 100 && p.health > 0, String(p.health));
    assert.deepStrictEqual([term().status, term().alert], ["idle", false]);
    assert.ok(Math.abs(room.hackProgress - 0.43) < 1e-9, "progress kept, no penalty: " + room.hackProgress);
    const kept = room.hackProgress;
    advance(1000);
    assert.ok(Math.abs(room.hackProgress - (kept - 0.1 * HACK_DECAY_RATIO)) < 1e-9);
  });

  it("a killed hacker stops hacking; a second Ghost who also holds keeps hacking", async () => {
    const { room, g, g2, w, start, place, send, advance, term } = await setup();
    await start(g);
    await start(g2, 0.5);
    advance(4000);
    assert.strictEqual(term().alert, true);
    room.state.players.get(g.sessionId)!.health = 1;
    place(w, TERM.x, -1);
    await send(w, FIRE_MESSAGE, { yaw: Math.PI, pitch: 0 }, 300);
    assert.strictEqual(room.state.players.get(g.sessionId)!.health, 0);
    // g2 kept hacking: still alerting, progress still rising, no stacking.
    assert.deepStrictEqual([term().status, term().alert], ["hacking", true]);
    const before = room.hackProgress;
    advance(1000);
    assert.ok(Math.abs(room.hackProgress - (before + 0.1)) < 1e-9);
    // A dead Ghost cannot start a hack; the last hacker releasing ends the alert.
    await send(g, INTERACT_MESSAGE, { active: true }, 300);
    await send(g2, INTERACT_MESSAGE, { active: false }, 300);
    assert.strictEqual(term().alert, false);
    const kept = room.hackProgress;
    advance(1000);
    assert.ok(room.hackProgress < kept);
  });

  it("jumping interrupts", async () => {
    const { room, g, start, send, advance, term } = await setup();
    await start(g);
    advance(1000);
    await send(g, ACTION_MESSAGE, { action: "jump" }, 300);
    assert.notStrictEqual(room.state.players.get(g.sessionId)!.mode, "ground");
    assert.deepStrictEqual([term().status, term().alert], ["idle", false]);
    const p = room.hackProgress;
    advance(100);
    assert.ok(room.hackProgress < p);
  });

  it("leaving range and leaving the room interrupt", async () => {
    const { room, g, g2, start, place, advance, term } = await setup();
    await start(g);
    advance(HACK_ALERT_AFTER_MS);
    assert.strictEqual(term().alert, true);
    place(g, TERM.x + 4, TERM.z);
    advance(50);
    assert.deepStrictEqual([term().status, term().alert], ["idle", false]);

    await start(g2);
    advance(HACK_ALERT_AFTER_MS);
    assert.strictEqual(term().alert, true);
    await g2.leave();
    await sleep(50);
    assert.deepStrictEqual([term().status, term().alert], ["idle", false]);
    const p = room.hackProgress;
    advance(1000);
    assert.ok(room.hackProgress < p);
  });

  it("the Warden client is told only status and alert: no progress, no hacker", async () => {
    const { room, g, w, start, place, advance } = await setup();
    const msgs: string[] = [];
    (w as any).onMessage("*", (type: string) => msgs.push(String(type)));
    place(w, TERM.x, -12); // outside the south wall, beyond the near range
    await start(g, 0.3);
    advance(1000);
    await sleep(100);
    const seen = () => w.state.terminals.get(ACTIVE_TERMINAL_ID);
    assert.deepStrictEqual([seen()?.status, seen()?.alert], ["idle", false]);
    advance(HACK_ALERT_AFTER_MS);
    await sleep(100);
    assert.deepStrictEqual([seen()?.status, seen()?.alert], ["hacking", true]);
    assert.deepStrictEqual(Object.keys(seen()!.toJSON()).sort(), ["alert", "id", "status"]);
    assert.ok(!w.state.players.has(g.sessionId), "the hacker is not sent to the Warden");
    assert.ok(!msgs.includes("hackProgress"));
    assert.ok(room.hackProgress > 0);
  });
});
