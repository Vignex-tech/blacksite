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

/** Whole seconds left in a timed phase, rounded up; 0 when untimed or past. */
export function secondsLeft(m: RoundMachine, now: number): number {
  if (m.endsAt === undefined) return 0;
  return Math.max(0, Math.ceil((m.endsAt - now) / 1000));
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

/**
 * Advances the machine by at most one transition at server time `now`.
 * `counts` is the number of connected players per team. With `config` null
 * (open) the machine is live and stays so.
 */
export function advanceRound(
  m: RoundMachine,
  config: RoundConfig,
  now: number,
  counts: Readonly<Record<Team, number>>,
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
  switch (m.phase) {
    case "waiting":
      if (canStart) startCountdown();
      break;
    case "countdown":
    case "live":
      if (counts.ghost === 0 || counts.warden === 0) {
        toWaiting();
      } else if (m.endsAt !== undefined && now >= m.endsAt) {
        if (m.phase === "countdown") enter(m, "live", now + config.liveMs);
        else {
          m.winner = "warden";
          m.winReason = "time_out";
          enter(m, "ended", now + config.endedMs);
        }
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
