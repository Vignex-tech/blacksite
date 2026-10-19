import assert from "assert";
import { execFileSync } from "node:child_process";
import { DEFAULT_ROUND_SETTINGS } from "../../shared/protocol.js";
import {
  FAST_ROUND_SETTINGS,
  advanceRound,
  newRoundMachine,
  presetWarning,
  roundSettingsFromEnv,
  secondsLeft,
  type RoundConfig,
} from "../src/rules/round.js";

const CFG = { countdownMs: 1000, liveMs: 5000, endedMs: 2000, minPlayersPerTeam: 1 };
const BOTH = { ghost: 1, warden: 1 };

describe("roundSettingsFromEnv", () => {
  it("unset gives the defaults, fast the fast timers, open null", () => {
    assert.deepStrictEqual(roundSettingsFromEnv({}), DEFAULT_ROUND_SETTINGS);
    assert.deepStrictEqual(roundSettingsFromEnv({ BLACKSITE_ROUND_PRESET: "fast" }), { countdownMs: 2000, liveMs: 30000, endedMs: 3000, minPlayersPerTeam: 1 });
    assert.strictEqual(FAST_ROUND_SETTINGS.minPlayersPerTeam, 1);
    assert.strictEqual(roundSettingsFromEnv({ BLACKSITE_ROUND_PRESET: "open" }), null);
  });

  it("any other value throws", () => {
    for (const bad of ["", "FAST", "Open", "default", "fast ", "1"]) {
      assert.throws(() => roundSettingsFromEnv({ BLACKSITE_ROUND_PRESET: bad }), /BLACKSITE_ROUND_PRESET/, bad);
    }
  });

  it("logs a loud line only when a preset is set", () => {
    assert.strictEqual(presetWarning({}), undefined);
    assert.match(presetWarning({ BLACKSITE_ROUND_PRESET: "fast" })!, /!!!.*BLACKSITE_ROUND_PRESET=fast/);
  });

  it("the server module refuses to load with an unknown preset", () => {
    let message = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", "-e", "import('./src/rooms/MyRoom.ts')"], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, BLACKSITE_ROUND_PRESET: "bogus" },
        stdio: "pipe",
      });
    } catch (e) {
      message = String((e as { stderr?: Buffer }).stderr);
    }
    assert.match(message, /BLACKSITE_ROUND_PRESET/);
  });
});

describe("advanceRound", () => {
  it("waits until each team has the minimum, then counts down, goes live, ends, resets", () => {
    const m = newRoundMachine();
    let r = advanceRound(m, CFG, 0, { ghost: 1, warden: 0 });
    assert.strictEqual(m.phase, "waiting");
    assert.ok(!r.phaseChanged);
    r = advanceRound(m, CFG, 100, BOTH);
    assert.deepStrictEqual([m.phase, m.roundNumber, r.reset, r.phaseChanged], ["countdown", 1, true, true]);
    assert.strictEqual(secondsLeft(m, 100), 1);
    advanceRound(m, CFG, 1099, BOTH);
    assert.strictEqual(m.phase, "countdown");
    advanceRound(m, CFG, 1100, BOTH);
    assert.strictEqual(m.phase, "live");
    assert.strictEqual(secondsLeft(m, 1100), 5);
    assert.strictEqual(secondsLeft(m, 1101), 5);
    assert.strictEqual(secondsLeft(m, 2100), 4);
    advanceRound(m, CFG, 6099, BOTH);
    assert.strictEqual(m.phase, "live");
    advanceRound(m, CFG, 6100, BOTH);
    assert.deepStrictEqual([m.phase, m.winner, m.winReason], ["ended", "warden", "time_out"]);
    advanceRound(m, CFG, 8099, BOTH);
    assert.strictEqual(m.phase, "ended");
    r = advanceRound(m, CFG, 8100, BOTH);
    assert.deepStrictEqual([m.phase, m.roundNumber, m.winner, r.reset], ["countdown", 2, "", true]);
  });

  it("ended goes to waiting when the minimum no longer holds", () => {
    const m = newRoundMachine();
    advanceRound(m, CFG, 0, BOTH);
    advanceRound(m, CFG, 1000, BOTH);
    advanceRound(m, CFG, 6000, BOTH);
    assert.strictEqual(m.phase, "ended");
    advanceRound(m, CFG, 8000, { ghost: 0, warden: 1 });
    assert.deepStrictEqual([m.phase, m.winner, m.winReason], ["waiting", "", ""]);
  });

  it("aborts in countdown and live when a team is empty, with no winner", () => {
    for (const upTo of [0, 1000]) {
      const m = newRoundMachine();
      advanceRound(m, CFG, 0, BOTH);
      if (upTo) advanceRound(m, CFG, upTo, BOTH);
      advanceRound(m, CFG, upTo + 1, { ghost: 2, warden: 0 });
      assert.deepStrictEqual([m.phase, m.winner, m.winReason, m.endsAt], ["waiting", "", "", undefined]);
    }
  });

  it("a larger minimum waits for more players; open stays live and never ends", () => {
    const m = newRoundMachine();
    advanceRound(m, { ...CFG, minPlayersPerTeam: 2 }, 0, BOTH);
    assert.strictEqual(m.phase, "waiting");
    advanceRound(m, { ...CFG, minPlayersPerTeam: 2 }, 1, { ghost: 2, warden: 2 });
    assert.strictEqual(m.phase, "countdown");
    const open = newRoundMachine();
    const cfg: RoundConfig = null;
    advanceRound(open, cfg, 0, { ghost: 0, warden: 0 });
    advanceRound(open, cfg, 1e9, BOTH);
    assert.deepStrictEqual([open.phase, open.roundNumber, open.endsAt], ["live", 0, undefined]);
  });
});
