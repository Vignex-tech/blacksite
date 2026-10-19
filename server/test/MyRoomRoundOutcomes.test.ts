import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.js";
import appConfig from "../src/app.config.js";
import {
  FIRE_MESSAGE,
  HACK_DURATION_MS,
  HACK_PROGRESS_MESSAGE,
  INTERACT_MESSAGE,
  ROOM_NAME,
} from "../../shared/protocol.js";
import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP } from "../../shared/map.js";
import { MyRoom } from "../src/rooms/MyRoom.js";

const TERM = GRAYBOX_MAP.terminals.find((x) => x.id === ACTIVE_TERMINAL_ID)!;
const CFG = { countdownMs: 1000, liveMs: 30000, endedMs: 2000, minPlayersPerTeam: 1 };

describe("MyRoom round outcomes and terminal reset (#70)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => { await colyseus.cleanup(); });

  /** Ghost g, Warden w, Ghost g2 on a manual clock; the round is live when this returns. */
  async function setup(opts: { second?: boolean } = {}) {
    const room = (await colyseus.createRoom<MyRoom>(ROOM_NAME, {})) as unknown as MyRoom & { waitForNextMessage(): Promise<void> };
    room.autoSimulate = false;
    room.roundSettings = { ...CFG };
    const g = await colyseus.connectTo(room as any);
    const w = await colyseus.connectTo(room as any);
    const g2 = opts.second === false ? undefined : await colyseus.connectTo(room as any);
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
    const advance = (ms: number) => { t += ms; room.simulate(50); };
    const term = () => room.state.terminals.get(ACTIVE_TERMINAL_ID)!;
    /** Puts a Ghost at the terminal and holds interact (spends 300 ms). */
    const start = async (c: any) => { place(c, TERM.x, TERM.z); await send(c, INTERACT_MESSAGE, { active: true }, 300); };
    /** The Warden shoots a Ghost standing at the terminal (spends 300 ms). */
    const kill = async (victim: any) => {
      player(victim).health = 1;
      place(victim, TERM.x, TERM.z);
      place(w, TERM.x, -1);
      await send(w, FIRE_MESSAGE, { yaw: Math.PI, pitch: 0 }, 300);
      assert.strictEqual(player(victim).health, 0);
    };
    const round = () => ({ ...room.state.round.toJSON() });
    advance(50);
    advance(CFG.countdownMs);
    assert.strictEqual(room.state.round.phase, "live");
    return { room, g, w, g2: g2 as any, player, place, send, advance, term, start, kill, round };
  }

  it("Ghosts win with `hacked` the moment the terminal is hacked, and the terminal stays hacked", async () => {
    const { room, g, start, advance, term, round } = await setup();
    await start(g);
    advance(HACK_DURATION_MS - 1);
    assert.strictEqual(room.state.round.phase, "live");
    advance(1);
    assert.deepStrictEqual(round(), { phase: "ended", roundNumber: 1, secondsLeft: 2, winner: "ghost", winReason: "hacked" });
    assert.strictEqual(term().status, "hacked");
    assert.strictEqual(term().alert, false);
  });

  it("Wardens win with `ghosts_eliminated` when every connected Ghost is dead", async () => {
    const { room, g, g2, kill, advance, round } = await setup();
    await kill(g);
    advance(50);
    assert.strictEqual(room.state.round.phase, "live", "one Ghost is still alive");
    await kill(g2);
    advance(50);
    assert.deepStrictEqual(round(), { phase: "ended", roundNumber: 1, secondsLeft: 2, winner: "warden", winReason: "ghosts_eliminated" });
  });

  it("the timer gives Wardens `time_out`", async () => {
    const { advance, round } = await setup();
    advance(CFG.liveMs);
    assert.deepStrictEqual(round(), { phase: "ended", roundNumber: 1, secondsLeft: 2, winner: "warden", winReason: "time_out" });
  });

  it("order: a hack completing in the same step as the timer expiry goes to the Ghosts", async () => {
    const { g, start, advance, round } = await setup();
    advance(CFG.liveMs - HACK_DURATION_MS - 300);
    await start(g); // the 300 ms spent by the send put the hack exactly HACK_DURATION_MS before the end
    advance(HACK_DURATION_MS);
    assert.deepStrictEqual([round().winner, round().winReason], ["ghost", "hacked"]);
  });

  it("order: all Ghosts dead in the same step as the timer expiry is ghosts_eliminated, not time_out", async () => {
    const { g, g2, player, advance, round } = await setup();
    player(g).health = 0;
    player(g2).health = 0;
    advance(CFG.liveMs);
    assert.deepStrictEqual([round().winner, round().winReason], ["warden", "ghosts_eliminated"]);
  });

  it("order: a death processed before the step already stopped the hack, so it does not complete", async () => {
    const { room, g, g2, player, start, kill, advance, term, round } = await setup();
    player(g2).health = 0;
    await start(g);
    advance(9000);
    assert.ok(room.hackProgress > 0.85 && room.hackProgress < 1);
    await kill(g); // the shot lands before the hack would finish
    advance(5000);
    assert.deepStrictEqual([round().winner, round().winReason], ["warden", "ghosts_eliminated"]);
    assert.notStrictEqual(term().status, "hacked");
  });

  it("order: a hack that completes before the last Ghost's death message is processed wins for the Ghosts", async () => {
    const { room, g, g2, player, start, kill, advance, term, round } = await setup();
    player(g2).health = 0;
    await start(g);
    advance(9800);
    assert.ok(room.hackProgress > 0.9 && room.hackProgress < 1);
    // The shot is processed 300 ms later, after the hack's last moment.
    await kill(g);
    advance(50);
    assert.deepStrictEqual([round().winner, round().winReason], ["ghost", "hacked"]);
    assert.strictEqual(term().status, "hacked");
  });

  it("the last Ghost leaving while an eliminated Ghost stays: Wardens win ghosts_eliminated", async () => {
    const { g, g2, player, advance, round } = await setup();
    player(g2).health = 0;
    await g.leave();
    advance(50);
    assert.deepStrictEqual([round().phase, round().winner, round().winReason], ["ended", "warden", "ghosts_eliminated"]);
  });

  it("the last Ghost leaving alone aborts with no winner", async () => {
    const { g, round } = await setup({ second: false });
    await g.leave();
    assert.deepStrictEqual(round(), { phase: "waiting", roundNumber: 1, secondsLeft: 0, winner: "", winReason: "" });
  });

  it("the last Warden leaving aborts with no winner, even mid-hack", async () => {
    const { g, w, start, advance, round, term } = await setup();
    await start(g);
    advance(5000);
    await w.leave();
    assert.deepStrictEqual(round(), { phase: "waiting", roundNumber: 1, secondsLeft: 0, winner: "", winReason: "" });
    assert.notStrictEqual(term().status, "hacked");
  });

  it("ended is final after a Ghost win: late deaths, leaves and time change nothing", async () => {
    const { g, g2, player, start, advance, round } = await setup();
    await start(g);
    advance(HACK_DURATION_MS);
    assert.deepStrictEqual([round().phase, round().winner, round().winReason], ["ended", "ghost", "hacked"]);
    player(g).health = 0;
    player(g2).health = 0;
    advance(500);
    await g2.leave();
    await g.leave();
    assert.deepStrictEqual([round().phase, round().winner, round().winReason], ["ended", "ghost", "hacked"]);
  });

  it("ended is final after a time out: a late hack is ignored", async () => {
    const { room, g, start, advance, round } = await setup();
    advance(CFG.liveMs);
    assert.strictEqual(round().winReason, "time_out");
    await start(g);
    advance(1500);
    assert.deepStrictEqual([round().phase, round().winner, round().winReason], ["ended", "warden", "time_out"]);
    assert.strictEqual(room.hackProgress, 0);
  });

  it("at every countdown the terminals are idle, alert off, progress 0, and a second hack takes the full time", async () => {
    const { room, g, start, advance, term, round } = await setup();
    const firstRound = JSON.stringify(room.state.terminals.toJSON());
    await start(g);
    advance(HACK_DURATION_MS);
    assert.strictEqual(term().status, "hacked");
    advance(CFG.endedMs); // reset
    assert.deepStrictEqual([round().phase, round().roundNumber, round().winner, round().winReason], ["countdown", 2, "", ""]);
    assert.strictEqual(JSON.stringify(room.state.terminals.toJSON()), firstRound);
    assert.strictEqual(room.hackProgress, 0);
    advance(CFG.countdownMs);
    assert.strictEqual(round().phase, "live");
    // Not holding: nothing progresses.
    advance(3000);
    assert.strictEqual(room.hackProgress, 0);
    await start(g); // g is back at a spawn; start() places it at the terminal again
    advance(HACK_DURATION_MS - 1000);
    assert.strictEqual(round().phase, "live");
    assert.ok(room.hackProgress < 1 && room.hackProgress > 0.8, String(room.hackProgress));
    advance(1000);
    assert.deepStrictEqual([round().winner, round().winReason], ["ghost", "hacked"]);
  });

  it("a hack in progress with the alert on is wiped at the next countdown and does not carry over", async () => {
    const { room, g, start, advance, term, round } = await setup();
    advance(CFG.liveMs - 6300);
    await start(g);
    advance(5000);
    assert.deepStrictEqual([term().status, term().alert], ["hacking", true]);
    assert.ok(room.hackProgress > 0.4);
    advance(1000); // time out with the hack still held
    assert.strictEqual(round().winReason, "time_out");
    advance(CFG.endedMs);
    assert.strictEqual(round().phase, "countdown");
    assert.deepStrictEqual([term().status, term().alert, room.hackProgress], ["idle", false, 0]);
    advance(CFG.countdownMs);
    advance(10000);
    assert.deepStrictEqual([term().status, term().alert, room.hackProgress], ["idle", false, 0]);
    assert.strictEqual(round().phase, "live");
  });

  it("a round aborted after the hack still resets the terminal at the next countdown", async () => {
    const { room, g, w, start, advance, term, round } = await setup();
    await start(g);
    advance(HACK_DURATION_MS);
    await w.leave();
    assert.strictEqual(round().phase, "ended"); // the hack had already won
    await colyseus.connectTo(room as any);
    advance(CFG.endedMs);
    assert.strictEqual(round().phase, "countdown");
    assert.deepStrictEqual([term().status, term().alert, room.hackProgress], ["idle", false, 0]);
  });

  it("Wardens are told nothing hidden: no hack progress message, no Ghost count in the state", async () => {
    const { room, g, w, start, advance } = await setup();
    let toWarden = 0;
    w.onMessage(HACK_PROGRESS_MESSAGE, () => { toWarden += 1; });
    await start(g);
    advance(HACK_DURATION_MS);
    advance(CFG.endedMs);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(toWarden, 0);
    assert.deepStrictEqual(Object.keys(room.state.round.toJSON()).sort(), ["phase", "roundNumber", "secondsLeft", "winReason", "winner"]);
  });
});
