import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { ROOM_NAME, MOVE_MESSAGE, GROUND_SIZE } from "../../shared/protocol.js";
import { MyRoom, SPEED, BOUND, SPAWN_SPREAD } from "../src/rooms/MyRoom.js";

const EPS = 1e-9;

describe("MyRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await boot(appConfig));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  async function setup() {
    const room = await colyseus.createRoom<MyRoom>(ROOM_NAME, {});
    const a = await colyseus.connectTo(room);
    const b = await colyseus.connectTo(room);
    return { room: room as unknown as MyRoom & typeof room, a, b };
  }

  function pos(room: MyRoom, sessionId: string) {
    const p = room.state.players.get(sessionId);
    return { x: p.x, z: p.z };
  }

  async function sendMove(room: any, client: any, payload: unknown) {
    client.send(MOVE_MESSAGE, payload);
    await room.waitForNextMessage();
  }

  it("keeps the bound inside the shared ground", () => {
    assert.ok(BOUND > 0 && BOUND <= GROUND_SIZE / 2);
  });

  it("adds a player per client keyed by sessionId, near the spawn", async () => {
    const { room, a, b } = await setup();

    assert.strictEqual(room.state.players.size, 2);
    for (const client of [a, b]) {
      const p = pos(room, client.sessionId);
      assert.ok(Math.abs(p.x) <= SPAWN_SPREAD && Math.abs(p.z) <= SPAWN_SPREAD);
    }

    await room.waitForNextPatch();
    assert.strictEqual(a.state.players.size, 2);
    assert.ok(a.state.players.get(b.sessionId));
  });

  it("moves only the sender by dx/dz * SPEED", async () => {
    const { room, a, b } = await setup();
    const a0 = pos(room, a.sessionId);
    const b0 = pos(room, b.sessionId);

    await sendMove(room, a, { dx: 1, dz: -1 });

    const a1 = pos(room, a.sessionId);
    assert.ok(Math.abs(a1.x - (a0.x + SPEED)) < EPS);
    assert.ok(Math.abs(a1.z - (a0.z - SPEED)) < EPS);
    assert.deepStrictEqual(pos(room, b.sessionId), b0);

    await room.waitForNextPatch();
    // Synced numbers travel as float32 on the wire, so compare loosely.
    assert.ok(Math.abs(b.state.players.get(a.sessionId).x - a1.x) < 1e-4);
  });

  it("ignores invalid move payloads", async () => {
    const { room, a } = await setup();
    const a0 = pos(room, a.sessionId);

    const invalid: unknown[] = [
      { dx: "1", dz: 0 },
      { dx: 1, dz: null },
      { dx: NaN, dz: 0 },
      { dx: 0, dz: Infinity },
      { dx: -Infinity, dz: 1 },
      { dx: 1 },
      {},
      null,
      "move",
      42,
      [1, 1],
    ];
    for (const payload of invalid) {
      await sendMove(room, a, payload);
    }

    assert.deepStrictEqual(pos(room, a.sessionId), a0);
    // The client is still connected (invalid input is ignored, not fatal).
    assert.strictEqual(room.clients.length, 2);
  });

  it("clamps out-of-range input to at most SPEED per message", async () => {
    const { room, a } = await setup();
    const a0 = pos(room, a.sessionId);

    await sendMove(room, a, { dx: 1000, dz: -1e9 });

    const a1 = pos(room, a.sessionId);
    assert.ok(Math.abs(a1.x - (a0.x + SPEED)) < EPS);
    assert.ok(Math.abs(a1.z - (a0.z - SPEED)) < EPS);
  });

  it("never lets a player leave the ground bounds", async () => {
    const { room, a } = await setup();
    const player = room.state.players.get(a.sessionId);
    player.x = BOUND - SPEED / 2;
    player.z = -BOUND + SPEED / 2;

    for (let i = 0; i < 5; i++) {
      await sendMove(room, a, { dx: 1, dz: -1 });
    }
    assert.deepStrictEqual(pos(room, a.sessionId), { x: BOUND, z: -BOUND });

    for (let i = 0; i < 5; i++) {
      await sendMove(room, a, { dx: 5, dz: -5 });
    }
    assert.deepStrictEqual(pos(room, a.sessionId), { x: BOUND, z: -BOUND });
  });

  it("removes the player when a client leaves", async () => {
    const { room, a, b } = await setup();

    await a.leave();
    for (let i = 0; i < 50 && room.state.players.size !== 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.strictEqual(room.state.players.size, 1);
    assert.ok(room.state.players.has(b.sessionId));
    assert.ok(!room.state.players.has(a.sessionId));
  });
});
