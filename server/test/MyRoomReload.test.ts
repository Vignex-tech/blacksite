import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";

import appConfig from "../src/app.config.js";
import {
  ACTION_MESSAGE,
  DAMAGED_EVENT,
  FIRE_MESSAGE,
  HIT_EVENT,
  MOVE_MESSAGE,
  RELOAD_MESSAGE,
  ROOM_NAME,
  WEAPONS,
} from "../../shared/protocol.js";
import { MyRoom } from "../src/rooms/MyRoom.js";

const FACE_N = { yaw: 0, pitch: 0 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MyRoom reload and elimination", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  async function setup() {
    const room = (await colyseus.createRoom<MyRoom>(ROOM_NAME, {})) as unknown as MyRoom & { waitForNextMessage(): Promise<void> };
    room.autoSimulate = false;
    const g = await colyseus.connectTo(room as any);
    const w = await colyseus.connectTo(room as any);
    const g2 = await colyseus.connectTo(room as any);
    let t = room.now();
    room.now = () => t;
    const advance = (ms: number) => { t += ms; };
    const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId)!;
    const place = (c: any, x: number, z: number, y = 0, mode = "ground") => {
      const p = player(c);
      p.x = x; p.z = z; p.y = y; p.mode = mode;
    };
    const send = async (c: any, type: string, payload: unknown = {}, ms = 0) => {
      t += ms;
      c.send(type, payload);
      await room.waitForNextMessage();
    };
    // ghost g at z -14, warden w 5 north, ghost g2 beside g.
    place(g, 15, -14); place(w, 15, -9); place(g2, 18, -14);
    return { room, g, w, g2, player, place, send, advance };
  }

  it("reload refills the magazine after reloadMs on the server clock, checked in simulate", async () => {
    const s = await setup();
    s.player(s.g).ammo = 3;
    await s.send(s.g, RELOAD_MESSAGE);
    assert.strictEqual(s.player(s.g).reloading, true);
    assert.strictEqual(s.player(s.g).ammo, 3);
    s.advance(WEAPONS.ghost.reloadMs - 1);
    s.room.simulate(100);
    assert.strictEqual(s.player(s.g).reloading, true);
    s.advance(1);
    s.room.simulate(100);
    assert.strictEqual(s.player(s.g).reloading, false);
    assert.strictEqual(s.player(s.g).ammo, WEAPONS.ghost.magazine);
  });

  it("reload is refused with a full magazine, while already reloading, and for non-object payloads", async () => {
    const s = await setup();
    await s.send(s.g, RELOAD_MESSAGE);
    assert.strictEqual(s.player(s.g).reloading, false);
    s.player(s.g).ammo = 1;
    for (const bad of [null, "reload", [], [1], 5]) await s.send(s.g, RELOAD_MESSAGE, bad, 1000);
    assert.strictEqual(s.player(s.g).reloading, false);
    await s.send(s.g, RELOAD_MESSAGE, {}, 1000);
    assert.strictEqual(s.player(s.g).reloading, true);
    s.advance(WEAPONS.ghost.reloadMs - 100);
    await s.send(s.g, RELOAD_MESSAGE); // a second reload does not restart the timer
    s.advance(100);
    s.room.simulate(100);
    assert.strictEqual(s.player(s.g).reloading, false);
    assert.strictEqual(s.player(s.g).ammo, WEAPONS.ghost.magazine);
  });

  it("firing during a reload is refused", async () => {
    const s = await setup();
    s.player(s.g).ammo = 5;
    await s.send(s.g, RELOAD_MESSAGE);
    await s.send(s.g, FIRE_MESSAGE, FACE_N, 1000);
    assert.strictEqual(s.player(s.g).ammo, 5);
    s.advance(WEAPONS.ghost.reloadMs);
    s.room.simulate(100);
    await s.send(s.g, FIRE_MESSAGE, FACE_N, 1000);
    assert.strictEqual(s.player(s.g).ammo, WEAPONS.ghost.magazine - 1);
  });

  it("elimination cancels a reload, keeps ammo, and nothing refills it", async () => {
    const s = await setup();
    s.player(s.w).ammo = 4;
    await s.send(s.w, RELOAD_MESSAGE);
    s.player(s.w).health = 1;
    await s.send(s.g, FIRE_MESSAGE, FACE_N);
    assert.strictEqual(s.player(s.w).health, 0);
    assert.strictEqual(s.player(s.w).reloading, false);
    s.advance(WEAPONS.warden.reloadMs * 2);
    s.room.simulate(200);
    assert.strictEqual(s.player(s.w).ammo, 4);
    assert.strictEqual(s.player(s.w).reloading, false);
  });

  it("an eliminated player's move, action, fire and reload are ignored and spend no token", async () => {
    const s = await setup();
    s.player(s.g).health = 0;
    s.player(s.g).ammo = 3;
    const before = { x: s.player(s.g).x, z: s.player(s.g).z, yaw: s.player(s.g).yaw };
    for (let i = 0; i < 6; i++) {
      await s.send(s.g, MOVE_MESSAGE, { dx: 1, dz: 1, yaw: 1 }, 100);
      await s.send(s.g, ACTION_MESSAGE, { action: "jump" }, 300);
      await s.send(s.g, FIRE_MESSAGE, FACE_N, 400);
      await s.send(s.g, RELOAD_MESSAGE, {}, 400);
    }
    const p = s.player(s.g);
    assert.deepStrictEqual({ x: p.x, z: p.z, yaw: p.yaw }, before);
    assert.strictEqual(p.mode, "ground");
    assert.strictEqual(p.ammo, 3);
    assert.strictEqual(p.reloading, false);
    assert.ok(s.player(s.w).health > 0);
  });

  it("an eliminated hanging player falls and settles on the ground; a grounded body stays put", async () => {
    const s = await setup();
    s.place(s.g, 15, -14, 3, "hanging");
    s.player(s.g).health = 1;
    // The Warden shoots the hanging Ghost from 5 units away at the Ghost's eye height.
    s.place(s.w, 15, -9, 3, "ground");
    await s.send(s.w, FIRE_MESSAGE, { yaw: Math.PI, pitch: 0 });
    assert.strictEqual(s.player(s.g).health, 0);
    assert.strictEqual(s.player(s.g).mode, "falling");
    s.room.simulate(3000);
    assert.strictEqual(s.player(s.g).mode, "ground");
    assert.ok(Math.abs(s.player(s.g).y) < 1e-4);
    assert.strictEqual(s.player(s.g).health, 0);

    const at = { x: s.player(s.g2).x, z: s.player(s.g2).z };
    s.player(s.g2).health = 0;
    s.room.simulate(1000);
    assert.deepStrictEqual({ x: s.player(s.g2).x, z: s.player(s.g2).z }, at);
    assert.strictEqual(s.player(s.g2).mode, "ground");
  });

  it("kill order within one step: both shooters get hit, only the first gets killed", async () => {
    const s = await setup();
    s.place(s.g, 15, -14); s.place(s.g2, 15, -13); s.place(s.w, 15, -9);
    s.player(s.w).health = 1;
    const hits: Record<string, any[]> = { g: [], g2: [] };
    s.g.onMessage(HIT_EVENT, (m: any) => hits.g.push(m));
    s.g2.onMessage(HIT_EVENT, (m: any) => hits.g2.push(m));
    const wDamaged: any[] = [];
    s.w.onMessage(DAMAGED_EVENT, (m: any) => wDamaged.push(m));
    await s.send(s.g2, FIRE_MESSAGE, FACE_N); // nearer shooter fires first, so g2 gets the kill
    await s.send(s.g, FIRE_MESSAGE, FACE_N);
    await wait(50);
    assert.strictEqual(hits.g2.length, 1);
    assert.strictEqual(hits.g.length, 1);
    assert.strictEqual(hits.g2[0].killed, true);
    assert.strictEqual(hits.g[0].killed, false);
    assert.strictEqual(hits.g[0].damage, 0);
    assert.strictEqual(wDamaged.length, 1);
    assert.strictEqual(s.player(s.w).health, 0);
    // After a step the body is no longer a target.
    s.room.simulate(100);
    await s.send(s.g, FIRE_MESSAGE, FACE_N, 1000);
    await wait(50);
    assert.strictEqual(hits.g.length, 1);
  });

  it("an eliminated player keeps its seat; leaving and rejoining gives a fresh live player", async () => {
    const s = await setup();
    s.player(s.g).health = 0;
    assert.strictEqual(s.room.state.players.size, 3);
    const id = s.g.sessionId;
    await s.g.leave();
    await wait(50);
    const g3 = await colyseus.connectTo(s.room as any);
    assert.notStrictEqual(g3.sessionId, id);
    assert.ok(s.player(g3).health > 0);
    assert.strictEqual(s.player(g3).ammo, WEAPONS.ghost.magazine);
  });
});
