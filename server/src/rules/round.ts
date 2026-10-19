// Round state machine (M7, #68). Pure functions with no Colyseus dependency.
// Time is server time in ms, passed in by the caller. Settings come from the
// server's own environment at startup (roundSettingsFromEnv) and never from a
// client (rule 1).

import { DEFAULT_ROUND_SETTINGS, type RoundPhase, type RoundSettings, type RoundWinReason, type Team } from "../../../shared/protocol.js";

/** Name of the environment variable that picks a preset; read once at startup. */
export const ROUND_PRESET_ENV = "BLACKSITE_ROUND_PRESET";

/** The `fast` preset, for the second test server: short timers, one player per team. */
export const FAST_ROUND_SETTINGS: Readonly<RoundSettings> = Object.freeze({
  countdownMs: 2000,
  liveMs: 30000,
  endedMs: 3000,
  minPlayersPerTeam: 1,
});

/**
 * Round configuration: a RoundSettings, or null for the `open` preset (the
 * room is live from creation, with no timer; nothing ends or resets).
 */
export type RoundConfig = RoundSettings | null;

/**
 * Reads the preset from `env` (call once, at startup). Unset gives the
 * defaults, `fast` the fast timers, `open` null. Any other value throws, so the
 * server refuses to start.
 */
export function roundSettingsFromEnv(env: Readonly<Record<string, string | undefined>>): RoundConfig {
  const value = env[ROUND_PRESET_ENV];
  if (value === undefined) return { ...DEFAULT_ROUND_SETTINGS };
  if (value === "fast") return { ...FAST_ROUND_SETTINGS };
  if (value === "open") return null;
  throw new Error(`${ROUND_PRESET_ENV} must be unset, "fast" or "open"; got ${JSON.stringify(value)}`);
}

/** The loud startup line for a non-default preset, or undefined when none is set. */
export function presetWarning(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env[ROUND_PRESET_ENV];
  if (value === undefined) return undefined;
  return `!!! ${ROUND_PRESET_ENV}=${value}: round preset active (not the production defaults). Do not set this in a deployment. !!!`;
}

/** Mutable machine state. */
export interface RoundMachine {
  phase: RoundPhase;
  roundNumber: number;
  /** Server time (ms) at which the current timed phase ends; undefined when untimed. */
  endsAt: number | undefined;
  winner: Team | "";
  winReason: RoundWinReason | "";
}

export function newRoundMachine(): RoundMachine {
  return { phase: "waiting", roundNumber: 0, endsAt: undefined, winner: "", winReason: "" };
}

/**
 * Float slack (ms) removed before rounding up. With a fractional clock,
 * (now + 30000) - now can come out a hair over 30000, which would round up to
 * 31 (#75). One microsecond is far above the float error and far below any
 * real difference.
 */
export const SECONDS_LEFT_EPSILON_MS = 0.001;

/** Whole seconds left in a timed phase, rounded up; 0 when untimed or past. */
export function secondsLeft(m: RoundMachine, now: number): number {
  if (m.endsAt === undefined) return 0;
  return Math.max(0, Math.ceil((m.endsAt - now - SECONDS_LEFT_EPSILON_MS) / 1000));
}

export interface RoundAdvance {
  /** The phase changed (or a new countdown began). */
  phaseChanged: boolean;
  /** A countdown began: reset every player. */
  reset: boolean;
}

function enter(m: RoundMachine, phase: RoundPhase, endsAt: number | undefined) {
  m.phase = phase;
  m.endsAt = endsAt;
}

/** What the room observed this step, besides the connected counts. */
export interface RoundFacts {
  /** The active terminal has reached `hacked`. */
  hacked: boolean;
  /** Connected Ghosts with health above 0. */
  ghostsAlive: number;
}

/**
 * Advances the machine by at most one transition at server time `now`.
 * `counts` is the number of connected players per team. With `config` null
 * (open) the machine is live and stays so.
 *
 * Evaluation order inside one step while `live` (the first outcome is final,
 * `ended` is never left except by the end timer, #64/#70):
 *   1. hack completion: Ghosts win, reason `hacked`;
 *   2. a team has nobody connected: round aborted, no winner, back to waiting;
 *   3. connected Ghosts exist but none is alive: Wardens win `ghosts_eliminated`
 *      (this includes the last living Ghost leaving while eliminated ones stay);
 *   4. the timer ran out: Wardens win `time_out`.
 * A countdown only checks 2, then its timer. `facts` defaults to "no hack,
 * every connected Ghost alive".
 */
export function advanceRound(
  m: RoundMachine,
  config: RoundConfig,
  now: number,
  counts: Readonly<Record<Team, number>>,
  facts: Readonly<RoundFacts> = { hacked: false, ghostsAlive: counts.ghost },
): RoundAdvance {
  const out: RoundAdvance = { phaseChanged: false, reset: false };
  const from = m.phase;
  if (config === null) {
    if (m.phase !== "live") enter(m, "live", undefined);
    out.phaseChanged = from !== m.phase;
    return out;
  }
  const canStart = counts.ghost >= config.minPlayersPerTeam && counts.warden >= config.minPlayersPerTeam;
  const startCountdown = () => {
    m.roundNumber += 1;
    m.winner = "";
    m.winReason = "";
    enter(m, "countdown", now + config.countdownMs);
    out.reset = true;
  };
  const toWaiting = () => {
    m.winner = "";
    m.winReason = "";
    enter(m, "waiting", undefined);
  };
  const finish = (winner: Team, reason: RoundWinReason) => {
    m.winner = winner;
    m.winReason = reason;
    enter(m, "ended", now + config.endedMs);
  };
  switch (m.phase) {
    case "waiting":
      if (canStart) startCountdown();
      break;
    case "countdown":
    case "live":
      if (m.phase === "live" && facts.hacked) {
        finish("ghost", "hacked");
      } else if (counts.ghost === 0 || counts.warden === 0) {
        toWaiting();
      } else if (m.phase === "live" && facts.ghostsAlive <= 0) {
        finish("warden", "ghosts_eliminated");
      } else if (m.endsAt !== undefined && now >= m.endsAt) {
        if (m.phase === "countdown") enter(m, "live", now + config.liveMs);
        else finish("warden", "time_out");
      }
      break;
    case "ended":
      if (m.endsAt !== undefined && now >= m.endsAt) {
        if (canStart) startCountdown();
        else toWaiting();
      }
      break;
  }
  out.phaseChanged = from !== m.phase || out.reset;
  return out;
}
