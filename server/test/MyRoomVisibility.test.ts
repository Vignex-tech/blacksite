import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";

import appConfig from "../src/app.config.js";
import { ROOM_NAME } from "../../shared/protocol.js";
import { MyRoom } from "../src/rooms/MyRoom.js";

describe("MyRoom per-client visibility (#46)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  /** Joins ghost `g`, warden `w`, ghost `g2`, warden `w2`; a manual simulation. */
  async function setup(count = 4) {
    const room = (await colyseus.createRoom<MyRoom>(ROOM_NAME, {})) as unknown as MyRoom;
    room.autoSimulate = false;
    const clients: any[] = [];
    for (let i = 0; i < count; i++) clients.push(await colyseus.connectTo(room as any));
    const [g, w, g2, w2] = clients;
    const server = (c: any) => room.state.players.get(c.sessionId)!;
    const place = (c: any, x: number, z: number, y = 0) => {
      const p = server(c);
      p.x = x; p.z = z; p.y = y; p.mode = "ground";
    };
    /** Runs a simulation step, then waits until the clients have the patch. */
    const step = async () => {
      room.simulate(50);
      await room.waitForNextPatch();
      await new Promise((r) => setTimeout(r, 30));
    };
    /** Session ids a client holds in its decoded state. */
    const held = (c: any) => {
      const ids: string[] = [];
      c.state.players.forEach((_: unknown, id: string) => ids.push(id));
      return ids.sort();
    };
    return { room, g, w, g2, w2, server, place, step, held };
  }

  it("after join, a Warden holds itself and its Wardens, a Ghost holds everyone", async () => {
    const s = await setup();
    // Both Wardens outside the south wall, both Ghosts inside behind it (random spawns could be in line of sight).
    s.place(s.w, 8, -12);
    s.place(s.w2, 12, -12);
    s.place(s.g, 8, -5);
    s.place(s.g2, 6, -5);
    await s.step();
    const ids = [s.g, s.w, s.g2, s.w2].map((c) => c.sessionId);
    assert.deepStrictEqual(s.held(s.g), [...ids].sort());
    assert.deepStrictEqual(s.held(s.g2), [...ids].sort());
    assert.deepStrictEqual(s.held(s.w), [s.w.sessionId, s.w2.sessionId].sort());
    assert.deepStrictEqual(s.held(s.w2), [s.w.sessionId, s.w2.sessionId].sort());
  });

  it("a Ghost behind a wall is absent from the Warden's state; walking into sight adds it; leaving removes it", async () => {
    const s = await setup(2);
    s.place(s.w, 8, -12);
    s.place(s.g, 8, -5); // inside, behind wall-s-e
    await s.step();
    assert.strictEqual(s.w.state.players.get(s.g.sessionId), undefined);
    assert.deepStrictEqual(s.held(s.w), [s.w.sessionId]);
    assert.strictEqual(s.g.state.players.get(s.w.sessionId).x, 8);

    s.place(s.g, 15, -12); // open ground, same side
    await s.step();
    const seen = s.w.state.players.get(s.g.sessionId);
    assert.ok(seen, "Ghost in the open is sent");
    assert.ok(Math.abs(seen.x - 15) < 1e-4 && Math.abs(seen.z + 12) < 1e-4);

    // It moves and the Warden sees the new position, never an old one.
    s.place(s.g, 14, -11);
    await s.step();
    assert.ok(Math.abs(s.w.state.players.get(s.g.sessionId).x - 14) < 1e-4);

    s.place(s.g, 8, -5); // back behind the wall
    await s.step();
    assert.strictEqual(s.w.state.players.get(s.g.sessionId), undefined);
  });

  it("a Ghost moving behind the wall stops being updated: the Warden never learns where it went", async () => {
    const s = await setup(2);
    s.place(s.w, 8, -12);
    s.place(s.g, 15, -12);
    await s.step();
    assert.ok(s.w.state.players.get(s.g.sessionId));
    s.place(s.g, 3, -3);
    await s.step();
    s.place(s.g, 4, -2);
    await s.step();
    assert.strictEqual(s.w.state.players.get(s.g.sessionId), undefined);
    assert.deepStrictEqual(s.held(s.w), [s.w.sessionId]);
  });

  it("a Ghost within the near range is sent through a wall", async () => {
    const s = await setup(2);
    s.place(s.w, 8, -9);
    s.place(s.g, 8, -7);
    await s.step();
    assert.ok(s.w.state.players.get(s.g.sessionId), "2.0 away through the wall");
    s.place(s.w, 8, -11);
    await s.step();
    assert.strictEqual(s.w.state.players.get(s.g.sessionId), undefined);
  });

  it("an eliminated Ghost behind a wall is hidden like a live one; an eliminated Warden still holds its teammate", async () => {
    const s = await setup();
    s.place(s.w, 8, -12);
    s.place(s.g, 8, -5);
    s.place(s.w2, 12, -12);
    s.server(s.g).health = 0;
    s.server(s.w).health = 0;
    await s.step();
    assert.strictEqual(s.w.state.players.get(s.g.sessionId), undefined);
    assert.ok(s.w.state.players.get(s.w2.sessionId));
    assert.ok(s.g.state.players.get(s.w.sessionId), "a Ghost still sees the dead Warden");
  });

  it("a Ghost client leaving removes it from the Warden's state; a late joiner is sent per the same rule", async () => {
    const s = await setup(2);
    s.place(s.w, 8, -12);
    s.place(s.g, 15, -12);
    await s.step();
    assert.ok(s.w.state.players.get(s.g.sessionId));
    const id = s.g.sessionId;
    await s.g.leave();
    await s.step();
    assert.strictEqual(s.w.state.players.get(id), undefined);

    const g2 = await colyseus.connectTo(s.room as any);
    s.place(g2, 8, -5); // behind the wall
    await s.step();
    assert.strictEqual(s.w.state.players.get(g2.sessionId), undefined);
    assert.ok(g2.state.players.get(s.w.sessionId));
  });
});
