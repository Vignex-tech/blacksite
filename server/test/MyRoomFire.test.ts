import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";

import appConfig from "../src/app.config.js";
import {
  DAMAGED_EVENT,
  EYE_HEIGHT,
  FIRE_MESSAGE,
  HIT_EVENT,
  MAX_HEALTH,
  ROOM_NAME,
  SHOT_EVENT,
  WEAPONS,
} from "../../shared/protocol.js";
import { FIRE_BURST, FIRE_RATE_HZ, MyRoom, parseFire } from "../src/rooms/MyRoom.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FACE_N = { yaw: 0, pitch: 0 };
const FACE_S = { yaw: Math.PI, pitch: 0 };

describe("MyRoom fire", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  /** Joins ghost `g`, warden `w`, ghost `g2` (in that order) with a manual clock. */
  async function setup() {
    const room = (await colyseus.createRoom<MyRoom>(ROOM_NAME, {})) as unknown as MyRoom & { waitForNextMessage(): Promise<void> };
    room.autoSimulate = false;
    const g = await colyseus.connectTo(room as any);
    const w = await colyseus.connectTo(room as any);
    const g2 = await colyseus.connectTo(room as any);
    let t = Math.ceil(room.now()); // whole ms: float sums like 1967.762 + 300 fall just short of an interval
    room.now = () => t;
    const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId)!;
    const place = (c: any, x: number, z: number, y = 0, mode = "ground") => {
      const p = player(c);
      p.x = x; p.z = z; p.y = y; p.mode = mode;
    };
    const events = (c: any) => {
      const got: Record<string, any[]> = { [SHOT_EVENT]: [], [HIT_EVENT]: [], [DAMAGED_EVENT]: [] };
      for (const k of Object.keys(got)) c.onMessage(k, (m: any) => got[k].push(m));
      return got;
    };
    const fire = async (c: any, payload: unknown = FACE_N, advance = 0) => {
      t += advance;
      c.send(FIRE_MESSAGE, payload);
      await room.waitForNextMessage();
    };
    return { room, g, w, g2, player, place, events, fire };
  }

  /** Open ground: ghost g at z -14, warden w 5 units north of it, both on x 15; g2 off to the side. */
  const lineUp = (s: Awaited<ReturnType<typeof setup>>) => {
    s.place(s.g, 15, -14);
    s.place(s.w, 15, -9);
    s.place(s.g2, 18, -14);
  };

  it("exports the fire bucket constants and gives players health, ammo and no reload", async () => {
    assert.strictEqual(FIRE_RATE_HZ, 10);
    assert.strictEqual(FIRE_BURST, 3);
    const { g, w, player } = await setup();
    assert.strictEqual(player(g).health, MAX_HEALTH.ghost);
    assert.strictEqual(player(g).ammo, WEAPONS.ghost.magazine);
    assert.strictEqual(player(w).health, MAX_HEALTH.warden);
    assert.strictEqual(player(w).ammo, WEAPONS.warden.magazine);
    assert.strictEqual(player(w).reloading, false);
  });

  it("parseFire accepts finite yaw and pitch, wraps yaw, clamps pitch and ignores extras", () => {
    assert.deepStrictEqual(parseFire({ yaw: 1, pitch: 0.5, x: 9, origin: {} }), { yaw: 1, pitch: 0.5 });
    const wrapped = parseFire({ yaw: 3 * Math.PI, pitch: 0 })!;
    assert.ok(Math.abs(Math.abs(wrapped.yaw) - Math.PI) < 1e-9);
    assert.strictEqual(parseFire({ yaw: 0, pitch: 99 })!.pitch, Math.PI / 2);
    assert.strictEqual(parseFire({ yaw: 0, pitch: -99 })!.pitch, -Math.PI / 2);
    for (const bad of [null, undefined, 1, "fire", [], [1, 2], {}, { yaw: 0 }, { pitch: 0 }, { yaw: "0", pitch: 0 },
      { yaw: 0, pitch: NaN }, { yaw: Infinity, pitch: 0 }, { yaw: 0, pitch: -Infinity }, { yaw: null, pitch: 0 }]) {
      assert.strictEqual(parseFire(bad), null, String(JSON.stringify(bad)));
    }
  });

  it("a Ghost shot hits a Warden for the sidearm damage; a Warden shot hits a Ghost for the rifle damage", async () => {
    const s = await setup();
    lineUp(s);
    await s.fire(s.g);
    assert.strictEqual(s.player(s.w).health, MAX_HEALTH.warden - WEAPONS.ghost.damage);
    assert.strictEqual(s.player(s.g).ammo, WEAPONS.ghost.magazine - 1);
    await s.fire(s.w, FACE_S);
    assert.strictEqual(s.player(s.g).health, MAX_HEALTH.ghost - WEAPONS.warden.damage);
    assert.strictEqual(s.player(s.w).ammo, WEAPONS.warden.magazine - 1);
  });

  it("a Ghost needs fewer rifle hits than a Warden needs sidearm hits", async () => {
    const s = await setup();
    lineUp(s);
    let wardenShots = 0;
    while (s.player(s.g).health > 0 && wardenShots < 100) {
      await s.fire(s.w, FACE_S, WEAPONS.warden.intervalMs);
      wardenShots++;
    }
    s.place(s.g2, 15, -14);
    let ghostShots = 0;
    while (s.player(s.w).health > 0 && ghostShots < 100) {
      await s.fire(s.g2, FACE_N, WEAPONS.ghost.intervalMs);
      ghostShots++;
    }
    assert.strictEqual(wardenShots, Math.ceil(MAX_HEALTH.ghost / WEAPONS.warden.damage));
    assert.strictEqual(ghostShots, Math.ceil(MAX_HEALTH.warden / WEAPONS.ghost.damage));
    assert.ok(wardenShots < ghostShots);
    assert.strictEqual(s.player(s.g).health, 0);
    assert.strictEqual(s.player(s.w).health, 0);
  });

  it("health is floored at 0", async () => {
    const s = await setup();
    lineUp(s);
    s.player(s.w).health = 5;
    await s.fire(s.g);
    assert.strictEqual(s.player(s.w).health, 0);
  });

  it("a wall between shooter and target blocks the shot but it still costs a round", async () => {
    const s = await setup();
    // wall-w-s spans x -10..-9.5; ghost outside to the west, warden inside.
    s.place(s.g, -12, -4.5);
    s.place(s.w, -8, -4.5);
    await s.fire(s.g, { yaw: Math.PI / 2, pitch: 0 });
    assert.strictEqual(s.player(s.w).health, MAX_HEALTH.warden);
    assert.strictEqual(s.player(s.g).ammo, WEAPONS.ghost.magazine - 1);
  });

  it("shots pass through teammates and hit the first enemy behind them; friendly fire is off", async () => {
    const s = await setup();
    s.place(s.g, 15, -14);
    s.place(s.g2, 15, -11);
    s.place(s.w, 15, -8);
    await s.fire(s.g);
    assert.strictEqual(s.player(s.g2).health, MAX_HEALTH.ghost);
    assert.strictEqual(s.player(s.w).health, MAX_HEALTH.warden - WEAPONS.ghost.damage);
  });

  it("the shooter is never hit by their own shot", async () => {
    const s = await setup();
    lineUp(s);
    await s.fire(s.g, { yaw: 0, pitch: Math.PI / 2 });
    assert.strictEqual(s.player(s.g).health, MAX_HEALTH.ghost);
  });

  it("aim pitch matters: a shot aimed over the target misses; a hanging Ghost is hit where it hangs", async () => {
    const s = await setup();
    lineUp(s);
    await s.fire(s.w, { yaw: Math.PI, pitch: 0.5 });
    assert.strictEqual(s.player(s.g).health, MAX_HEALTH.ghost);
    // Ghost hangs with feet at 1.2 (box 1.2..3.0); the eye is at 1.6, so a level shot hits.
    s.place(s.g, 15, -14, 1.2, "hanging");
    await s.fire(s.w, FACE_S, WEAPONS.warden.intervalMs);
    assert.strictEqual(s.player(s.g).health, MAX_HEALTH.ghost - WEAPONS.warden.damage);
  });

  it("a target beyond the weapon range is safe", async () => {
    const s = await setup();
    s.place(s.g, 15, -19);
    s.place(s.w, 15, -19 + WEAPONS.ghost.range + 2);
    await s.fire(s.g);
    assert.strictEqual(s.player(s.w).health, MAX_HEALTH.warden);
  });

  it("the weapon cooldown caps the fire rate on the server clock", async () => {
    const s = await setup();
    lineUp(s);
    const full = WEAPONS.ghost.magazine;
    await s.fire(s.g);
    await s.fire(s.g);
    await s.fire(s.g);
    assert.strictEqual(s.player(s.g).ammo, full - 1);
    await s.fire(s.g, FACE_N, WEAPONS.ghost.intervalMs - 1);
    assert.strictEqual(s.player(s.g).ammo, full - 1);
    await s.fire(s.g, FACE_N, 1);
    assert.strictEqual(s.player(s.g).ammo, full - 2);
  });

  it("a forged client firing every 50 ms gets at most one shot per interval", async () => {
    const s = await setup();
    lineUp(s);
    const sends = 13; // 600 ms of fire at 20 Hz
    for (let i = 0; i < sends; i++) await s.fire(s.g, FACE_N, i === 0 ? 0 : 50);
    const used = WEAPONS.ghost.magazine - s.player(s.g).ammo;
    assert.ok(used >= 1 && used <= Math.floor(600 / WEAPONS.ghost.intervalMs) + 1, `used ${used}`);
  });

  it("a burst of messages at one instant spends one round", async () => {
    const s = await setup();
    lineUp(s);
    for (let i = 0; i < 20; i++) await s.fire(s.g);
    assert.strictEqual(s.player(s.g).ammo, WEAPONS.ghost.magazine - 1);
  });

  it("an empty magazine does nothing and does not reload by itself", async () => {
    const s = await setup();
    lineUp(s);
    s.player(s.g).ammo = 0;
    await s.fire(s.g, FACE_N, 1000);
    assert.strictEqual(s.player(s.g).ammo, 0);
    assert.strictEqual(s.player(s.g).reloading, false);
    assert.strictEqual(s.player(s.w).health, MAX_HEALTH.warden);
  });

  it("a player who is reloading cannot fire", async () => {
    const s = await setup();
    lineUp(s);
    s.player(s.g).reloading = true;
    await s.fire(s.g, FACE_N, 1000);
    assert.strictEqual(s.player(s.g).ammo, WEAPONS.ghost.magazine);
    assert.strictEqual(s.player(s.w).health, MAX_HEALTH.warden);
  });

  it("invalid fire payloads spend no token: a bad flood does not block a later good shot", async () => {
    const s = await setup();
    lineUp(s);
    for (let i = 0; i < 10; i++) await s.fire(s.g, { yaw: "x", pitch: NaN });
    await s.fire(s.g);
    assert.strictEqual(s.player(s.g).ammo, WEAPONS.ghost.magazine - 1);
  });

  it("players at health 0 cannot be hit", async () => {
    const s = await setup();
    lineUp(s);
    s.player(s.w).health = 0;
    await s.fire(s.g);
    assert.strictEqual(s.player(s.w).health, 0);
    assert.strictEqual(s.player(s.g).ammo, WEAPONS.ghost.magazine - 1);
  });

  it("events: a Warden shot goes to everyone, a Ghost shot only to Ghosts; hit to the shooter, damaged to the victim", async () => {
    const s = await setup();
    lineUp(s);
    const eg = s.events(s.g), ew = s.events(s.w), eg2 = s.events(s.g2);
    await s.fire(s.g);
    await sleep(80);
    assert.strictEqual(eg[SHOT_EVENT].length, 1);
    assert.strictEqual(eg2[SHOT_EVENT].length, 1);
    assert.strictEqual(ew[SHOT_EVENT].length, 0, "a suppressed Ghost shot never reaches a Warden");
    assert.strictEqual(eg[SHOT_EVENT][0].shooter, s.g.sessionId);
    assert.strictEqual(eg[SHOT_EVENT][0].team, "ghost");
    assert.strictEqual(eg[SHOT_EVENT][0].hit, true);
    assert.deepStrictEqual(eg[HIT_EVENT], [{ target: s.w.sessionId, damage: WEAPONS.ghost.damage, killed: false }]);
    assert.deepStrictEqual(ew[DAMAGED_EVENT], [{ damage: WEAPONS.ghost.damage, health: MAX_HEALTH.warden - WEAPONS.ghost.damage, killed: false }]);
    assert.strictEqual(eg2[HIT_EVENT].length, 0);
    assert.strictEqual(eg2[DAMAGED_EVENT].length, 0);
    assert.strictEqual(ew[HIT_EVENT].length, 0);

    await s.fire(s.w, FACE_S, 1000);
    await sleep(80);
    assert.strictEqual(eg[SHOT_EVENT].length, 2);
    assert.strictEqual(eg2[SHOT_EVENT].length, 2);
    assert.strictEqual(ew[SHOT_EVENT].length, 1, "the Warden hears its own rifle");
    const shot = ew[SHOT_EVENT][0];
    assert.strictEqual(shot.team, "warden");
    assert.ok(Math.abs(shot.origin.y - EYE_HEIGHT) < 1e-9);
    assert.strictEqual(eg[DAMAGED_EVENT][0].damage, WEAPONS.warden.damage);
    assert.strictEqual(Object.keys(eg[DAMAGED_EVENT][0]).sort().join(), "damage,health,killed", "no shooter id or position");
  });

  it("a killing blow reports killed on both events; a miss sends a shot event with hit false and no hit event", async () => {
    const s = await setup();
    lineUp(s);
    const eg = s.events(s.g), ew = s.events(s.w);
    await s.fire(s.g, FACE_S);
    await sleep(80);
    assert.strictEqual(eg[SHOT_EVENT][0].hit, false);
    assert.strictEqual(eg[HIT_EVENT].length, 0);
    s.player(s.w).health = 10;
    await s.fire(s.g, FACE_N, 1000);
    await sleep(80);
    assert.strictEqual(eg[HIT_EVENT][0].killed, true);
    assert.strictEqual(eg[HIT_EVENT][0].damage, 10);
    assert.strictEqual(ew[DAMAGED_EVENT][0].killed, true);
    assert.strictEqual(ew[DAMAGED_EVENT][0].health, 0);
  });
});
