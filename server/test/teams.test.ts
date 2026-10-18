import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";

import appConfig from "../src/app.config.js";
import { MAX_TEAM_SIZE, ROOM_NAME, TEAMS } from "../../shared/protocol.js";
import { GRAYBOX_MAP } from "../../shared/map.js";
import { assignTeam, teamCounts } from "../src/rules/teams.js";
import { MyRoom, MAX_CLIENTS } from "../src/rooms/MyRoom.js";
import { assertClear, inRect } from "./mapHelpers.js";

const team = (t: string) => ({ team: t });

describe("team rules (pure)", () => {
  it("gives the first joiner ghost and breaks ties to ghost", () => {
    assert.strictEqual(assignTeam([]), "ghost");
    assert.strictEqual(assignTeam([team("ghost"), team("warden")]), "ghost");
  });

  it("picks the team with fewer players", () => {
    assert.strictEqual(assignTeam([team("ghost")]), "warden");
    assert.strictEqual(assignTeam([team("warden")]), "ghost");
    assert.strictEqual(assignTeam([team("ghost"), team("ghost"), team("warden")]), "warden");
    assert.strictEqual(assignTeam([team("warden"), team("warden")]), "ghost");
  });

  it("fills ghost, warden, ghost, ... up to MAX_TEAM_SIZE each, then refuses", () => {
    const players: { team: string }[] = [];
    for (let i = 0; i < 2 * MAX_TEAM_SIZE; i++) {
      const t = assignTeam(players);
      assert.strictEqual(t, i % 2 === 0 ? "ghost" : "warden", `joiner ${i}`);
      players.push(team(t!));
    }
    assert.deepStrictEqual(teamCounts(players), { ghost: MAX_TEAM_SIZE, warden: MAX_TEAM_SIZE });
    assert.strictEqual(assignTeam(players), null);
  });

  it("refuses when the smaller team is already full", () => {
    assert.strictEqual(assignTeam([team("ghost"), team("warden")], 1), null);
    assert.strictEqual(assignTeam([team("ghost")], 1), "warden");
  });

  it("ignores unknown team strings when counting", () => {
    assert.deepStrictEqual(teamCounts([team("ghost"), team("admin"), team("")]), { ghost: 1, warden: 0 });
  });

  it("room capacity is two full teams", () => {
    assert.strictEqual(MAX_CLIENTS, TEAMS.length * MAX_TEAM_SIZE);
    assert.strictEqual(MAX_CLIENTS, 8);
  });
});

describe("MyRoom teams", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => colyseus.cleanup());

  async function newRoom() {
    return (await colyseus.createRoom<MyRoom>(ROOM_NAME, {})) as unknown as MyRoom & { maxClients: number };
  }

  function teamOf(room: MyRoom, sessionId: string) {
    return room.state.players.get(sessionId)!.team;
  }

  async function waitForSize(room: MyRoom, size: number) {
    for (let i = 0; i < 100 && room.state.players.size !== size; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(room.state.players.size, size);
  }

  it("balances 8 joiners 4 v 4, each in its team's area at yaw 0, and refuses a 9th", async () => {
    const room = await newRoom();
    assert.strictEqual(room.maxClients, 8);
    const clients = [];
    for (let i = 0; i < 8; i++) clients.push(await colyseus.connectTo(room));
    clients.forEach((c, i) => {
      const p = room.state.players.get(c.sessionId)!;
      const expected = i % 2 === 0 ? "ghost" : "warden";
      assert.strictEqual(p.team, expected, `joiner ${i}`);
      assert.strictEqual(p.yaw, 0, `joiner ${i}`);
      assert.ok(inRect(p, GRAYBOX_MAP.spawnAreas[expected]), `joiner ${i} at (${p.x}, ${p.z})`);
      assertClear(p, `joiner ${i}`);
    });
    const counts = { ghost: 0, warden: 0 };
    room.state.players.forEach((p) => counts[p.team as "ghost" | "warden"]++);
    assert.deepStrictEqual(counts, { ghost: 4, warden: 4 });

    await assert.rejects(colyseus.connectTo(room));
    assert.strictEqual(room.state.players.size, 8);
  });

  it("syncs team and yaw to clients", async () => {
    const room = await newRoom();
    const a = await colyseus.connectTo(room);
    const b = await colyseus.connectTo(room);
    await room.waitForNextPatch();
    assert.strictEqual(a.state.players.get(b.sessionId)?.team, "warden");
    assert.strictEqual(b.state.players.get(a.sessionId)?.team, "ghost");
    assert.strictEqual(a.state.players.get(b.sessionId)?.yaw, 0);
  });

  it("ignores a forged team join option", async () => {
    const room = await newRoom();
    const a = await colyseus.connectTo(room, { team: "warden" });
    const b = await colyseus.connectTo(room, { team: "ghost" });
    const c = await colyseus.connectTo(room, { team: "admin", yaw: 2 });
    assert.strictEqual(teamOf(room, a.sessionId), "ghost");
    assert.strictEqual(teamOf(room, b.sessionId), "warden");
    assert.strictEqual(teamOf(room, c.sessionId), "ghost");
    assert.strictEqual(room.state.players.get(c.sessionId)!.yaw, 0);
  });

  it("keeps teams balanced when a player leaves and someone joins", async () => {
    const room = await newRoom();
    const a = await colyseus.connectTo(room);
    const b = await colyseus.connectTo(room);
    assert.strictEqual(teamOf(room, a.sessionId), "ghost");
    assert.strictEqual(teamOf(room, b.sessionId), "warden");

    await a.leave();
    await waitForSize(room, 1);
    const c = await colyseus.connectTo(room);
    assert.strictEqual(teamOf(room, c.sessionId), "ghost");
    assert.ok(inRect(room.state.players.get(c.sessionId)!, GRAYBOX_MAP.spawnAreas.ghost));

    // Repeated leave and rejoin never drifts.
    let current = c;
    for (let i = 0; i < 3; i++) {
      await current.leave();
      await waitForSize(room, 1);
      current = await colyseus.connectTo(room);
      assert.strictEqual(teamOf(room, current.sessionId), "ghost", `rejoin ${i}`);
    }
    assert.strictEqual(teamOf(room, b.sessionId), "warden");
  });

  it("does not rebalance remaining players when someone leaves", async () => {
    const room = await newRoom();
    const a = await colyseus.connectTo(room); // ghost
    const b = await colyseus.connectTo(room); // warden
    const c = await colyseus.connectTo(room); // ghost

    await b.leave();
    await waitForSize(room, 2);
    assert.strictEqual(teamOf(room, a.sessionId), "ghost");
    assert.strictEqual(teamOf(room, c.sessionId), "ghost");

    // The next joiner fills the emptier team.
    const d = await colyseus.connectTo(room);
    assert.strictEqual(teamOf(room, d.sessionId), "warden");
  });
});
