import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";
import appConfig from "../src/app.config.js";
import {
  ACTION_MESSAGE,
  FIRE_MESSAGE,
  INTERACT_MESSAGE,
  MAX_HEALTH,
  MOVE_MESSAGE,
  RELOAD_MESSAGE,
  ROOM_NAME,
  ROUND_EVENT,
  WEAPONS,
} from "../../shared/protocol.js";
import { GRAYBOX_MAP } from "../../shared/map.js";
import { MyRoom, SPAWN_YAW } from "../src/rooms/MyRoom.js";
import { inRect } from "./mapHelpers.js";

const CFG = { countdownMs: 1000, liveMs: 5000, endedMs: 2000, minPlayersPerTeam: 1 };

describe("MyRoom rounds", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  /** A room on a manual clock; each advance moves time and runs one step. */
  async function create(options: Record<string, unknown> = {}) {
    const room = (await colyseus.createRoom<MyRoom>(ROOM_NAME, options)) as unknown as MyRoom & { waitForNextMessage(): Promise<void> };
    room.autoSimulate = false;
    let t = Math.ceil(room.now());
    room.now = () => t;
    const advance = (ms: number) => { t += ms; room.simulate(50); };
    return { room, advance };
  }
  const phase = (room: MyRoom) => room.state.round.phase;
  const round = (room: MyRoom) => ({ ...room.state.round.toJSON() });

  /** One Ghost and one Warden, round settings applied, first step run (countdown has started). */
  async function started() {
    const ctx = await create();
    ctx.room.roundSettings = { ...CFG };
    const g = await colyseus.connectTo(ctx.room as any);
    const w = await colyseus.connectTo(ctx.room as any);
    ctx.room.simulate(50);
    return { ...ctx, g, w };
  }

  it("the default (open) preset is live from creation with no timer", async () => {
    const { room, advance } = await create();
    assert.strictEqual(room.roundSettings, null);
    assert.deepStrictEqual(round(room), { phase: "live", roundNumber: 0, secondsLeft: 0, winner: "", winReason: "" });
    await colyseus.connectTo(room as any);
    advance(10 * 60 * 1000);
    assert.strictEqual(phase(room), "live");
    assert.strictEqual(room.state.players.size, 1);
  });

  it("walks waiting, countdown, live, ended, countdown with exact state values and events", async () => {
    const { room, advance } = await create();
    room.roundSettings = { ...CFG };
    const log: string[] = [];
    const g = await colyseus.connectTo(room as any);
    g.onMessage(ROUND_EVENT, (e: any) => log.push(`${e.phase}:${e.roundNumber}:${e.winner}:${e.winReason}`));
    advance(100);
    assert.deepStrictEqual(round(room), { phase: "waiting", roundNumber: 0, secondsLeft: 0, winner: "", winReason: "" });
    await colyseus.connectTo(room as any);
    advance(50);
    assert.deepStrictEqual(round(room), { phase: "countdown", roundNumber: 1, secondsLeft: 1, winner: "", winReason: "" });
    advance(1000);
    assert.deepStrictEqual(round(room), { phase: "live", roundNumber: 1, secondsLeft: 5, winner: "", winReason: "" });
    advance(2000);
    assert.strictEqual(room.state.round.secondsLeft, 3);
    advance(3000);
    assert.deepStrictEqual(round(room), { phase: "ended", roundNumber: 1, secondsLeft: 2, winner: "warden", winReason: "time_out" });
    advance(2000);
    assert.deepStrictEqual(round(room), { phase: "countdown", roundNumber: 2, secondsLeft: 1, winner: "", winReason: "" });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepStrictEqual(log, ["countdown:1::", "live:1::", "ended:1:warden:time_out", "countdown:2::"]);
  });

  it("waits while a team is below the minimum, starts when it holds", async () => {
    const { room, advance } = await create();
    room.roundSettings = { ...CFG, minPlayersPerTeam: 2 };
    await colyseus.connectTo(room as any);
    await colyseus.connectTo(room as any);
    advance(100);
    assert.strictEqual(phase(room), "waiting");
    await colyseus.connectTo(room as any);
    advance(100);
    assert.strictEqual(phase(room), "waiting");
    await colyseus.connectTo(room as any);
    advance(100);
    assert.strictEqual(phase(room), "countdown");
  });

  it("reset: fresh spawns at yaw 0, full health and magazine, ground mode, revived, teams kept", async () => {
    const { room, g, w, advance } = await started();
    advance(1000);
    const pg = room.state.players.get(g.sessionId)!;
    const pw = room.state.players.get(w.sessionId)!;
    pg.health = 0; pg.ammo = 0; pg.reloading = true; pg.mode = "hanging"; pg.x = 0; pg.z = 0; pg.yaw = 2; pg.y = 3;
    pw.health = 10; pw.ammo = 1;
    advance(5000);
    advance(2000);
    assert.strictEqual(phase(room), "countdown");
    assert.strictEqual(room.state.round.roundNumber, 2);
    for (const [p, team] of [[pg, "ghost"], [pw, "warden"]] as const) {
      assert.ok(inRect(p, GRAYBOX_MAP.spawnAreas[team]), team);
      assert.strictEqual(p.yaw, SPAWN_YAW);
      assert.strictEqual(p.health, MAX_HEALTH[team]);
      assert.strictEqual(p.ammo, WEAPONS[team].magazine);
      assert.strictEqual(p.reloading, false);
      assert.strictEqual(p.mode, "ground");
      assert.strictEqual(p.y, 0);
      assert.strictEqual(p.team, team);
    }
  });

  it("outside live, inputs are ignored and spend no token", async () => {
    const { room, g, advance } = await started();
    const p = room.state.players.get(g.sessionId)!;
    const x0 = p.x, z0 = p.z;
    const spam = async () => {
      for (let i = 0; i < 6; i++) {
        g.send(MOVE_MESSAGE, { dx: 1, dz: 1, yaw: 1 });
        g.send(ACTION_MESSAGE, "jump");
        g.send(FIRE_MESSAGE, { yaw: 0, pitch: 0 });
        g.send(RELOAD_MESSAGE, {});
        g.send(INTERACT_MESSAGE, { active: true });
      }
      for (let i = 0; i < 30; i++) await room.waitForNextMessage();
      assert.strictEqual(p.x, x0);
      assert.strictEqual(p.z, z0);
      assert.strictEqual(p.yaw, SPAWN_YAW);
      assert.strictEqual(p.mode, "ground");
      assert.strictEqual(p.ammo, WEAPONS.ghost.magazine);
      assert.strictEqual(p.reloading, false);
      assert.strictEqual(room.hackProgress, 0);
    };
    assert.strictEqual(phase(room), "countdown");
    await spam();
    advance(1000);
    advance(5000);
    assert.strictEqual(phase(room), "ended");
    await spam();
    advance(2000);
    advance(1000);
    assert.strictEqual(phase(room), "live");
    // The lock-out spent no token, so the full burst of 3 moves lands now.
    const x1 = p.x, z1 = p.z, yaw = p.yaw;
    for (let i = 0; i < 3; i++) g.send(MOVE_MESSAGE, { dx: 0, dz: 1 });
    for (let i = 0; i < 3; i++) await room.waitForNextMessage();
    assert.ok(Math.hypot(p.x - x1, p.z - z1) > 0.3, "all 3 burst moves landed");
    assert.strictEqual(p.yaw, yaw);
  });

  it("gravity and settling still run outside live", async () => {
    const { room, g } = await started();
    const p = room.state.players.get(g.sessionId)!;
    assert.strictEqual(phase(room), "countdown");
    p.mode = "falling"; p.y = 2;
    room.simulate(2000);
    assert.strictEqual(p.mode, "ground");
    assert.strictEqual(p.y, 0);
  });

  it("a join during live sits out, rejoining does not revive, the next reset does", async () => {
    const { room, advance } = await create();
    room.roundSettings = { ...CFG };
    const a = await colyseus.connectTo(room as any); // ghost
    await colyseus.connectTo(room as any); // warden
    const c = await colyseus.connectTo(room as any); // second ghost
    advance(50);
    advance(1000);
    assert.strictEqual(phase(room), "live");
    await c.leave();
    const j1 = await colyseus.connectTo(room as any);
    const p1 = room.state.players.get(j1.sessionId)!;
    assert.strictEqual(p1.team, "ghost");
    assert.strictEqual(p1.health, 0);
    const z = p1.z;
    j1.send(MOVE_MESSAGE, { dx: 0, dz: 1 });
    await room.waitForNextMessage();
    assert.strictEqual(room.state.players.get(j1.sessionId)!.z, z);
    await j1.leave();
    const j2 = await colyseus.connectTo(room as any);
    assert.strictEqual(room.state.players.get(j2.sessionId)!.health, 0);
    assert.strictEqual(phase(room), "live");
    advance(5000);
    advance(2000);
    assert.strictEqual(phase(room), "countdown");
    assert.strictEqual(room.state.players.get(j2.sessionId)!.health, MAX_HEALTH.ghost);
    assert.strictEqual(room.state.players.get(a.sessionId)!.health, MAX_HEALTH.ghost);
  });

  it("joins outside live are normal", async () => {
    const { room, advance } = await create();
    room.roundSettings = { ...CFG };
    await colyseus.connectTo(room as any);
    await colyseus.connectTo(room as any);
    advance(100);
    assert.strictEqual(phase(room), "countdown");
    const c = await colyseus.connectTo(room as any);
    assert.strictEqual(room.state.players.get(c.sessionId)!.health, MAX_HEALTH.ghost);
    advance(1000);
    advance(5000);
    assert.strictEqual(phase(room), "ended");
    const d = await colyseus.connectTo(room as any);
    assert.strictEqual(room.state.players.get(d.sessionId)!.health, MAX_HEALTH.warden);
  });

  it("aborts to waiting with no winner when a team empties in countdown or live, and restarts later", async () => {
    for (const toLive of [false, true]) {
      const { room, w, advance } = await started();
      if (toLive) advance(1000);
      assert.strictEqual(phase(room), toLive ? "live" : "countdown");
      await w.leave();
      assert.deepStrictEqual(round(room), { phase: "waiting", roundNumber: 1, secondsLeft: 0, winner: "", winReason: "" });
      await colyseus.connectTo(room as any);
      advance(50);
      assert.deepStrictEqual([phase(room), room.state.round.roundNumber], ["countdown", 2]);
      await colyseus.cleanup();
    }
  });

  it("leaving does not change the phase unless a team empties", async () => {
    const { room, advance } = await create();
    room.roundSettings = { ...CFG };
    await colyseus.connectTo(room as any);
    await colyseus.connectTo(room as any);
    const c = await colyseus.connectTo(room as any);
    advance(50);
    advance(1000);
    assert.strictEqual(phase(room), "live");
    await c.leave();
    assert.strictEqual(phase(room), "live");
  });

  it("forged options, join options and messages do not change settings", async () => {
    const forged = { roundSettings: { countdownMs: 1, liveMs: 1, endedMs: 1, minPlayersPerTeam: 1 }, preset: "fast", BLACKSITE_ROUND_PRESET: "fast" };
    const send = async (c: any) => {
      for (const type of ["roundSettings", "preset", "round", ROUND_EVENT, "setRound"]) {
        c.send(type, forged);
        c.send(type, forged.roundSettings);
      }
      await new Promise((r) => setTimeout(r, 100));
    };
    // Open room: forged create and join options, then forged messages.
    const open = await create(forged);
    assert.strictEqual(open.room.roundSettings, null);
    const a = await colyseus.connectTo(open.room as any, forged);
    await colyseus.connectTo(open.room as any, forged);
    await send(a);
    assert.strictEqual(open.room.roundSettings, null);
    open.advance(10000);
    assert.strictEqual(phase(open.room), "live");
    assert.strictEqual(open.room.state.round.roundNumber, 0);

    // Configured room: the same forgeries leave the settings and timing alone.
    const { room, advance } = await create();
    room.roundSettings = { ...CFG };
    await colyseus.connectTo(room as any, forged);
    await colyseus.connectTo(room as any, forged);
    const x = await colyseus.connectTo(room as any, forged);
    await send(x);
    assert.deepStrictEqual(room.roundSettings, CFG);
    advance(50);
    advance(1000);
    assert.deepStrictEqual([phase(room), room.state.round.secondsLeft], ["live", 5]);
  });

  it("state carries exactly the public round fields, no alive counts or hack progress", async () => {
    const { room } = await create();
    assert.deepStrictEqual(Object.keys(round(room)).sort(), ["phase", "roundNumber", "secondsLeft", "winReason", "winner"]);
  });
});
