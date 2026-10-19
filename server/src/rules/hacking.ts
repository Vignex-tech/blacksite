// Hacking one terminal (M6, #56). Pure code with no Colyseus dependency.
// The message contract is InteractMessage in shared/protocol.d.ts.

import { CAN_HACK, HACK_DECAY_RATIO, HACK_DURATION_MS, HACK_RANGE, STEP_HEIGHT, type Team } from "../../../shared/protocol.js";

/** Slack on the range check, so a player standing exactly HACK_RANGE away can hack. */
export const HACK_RANGE_TOLERANCE = 1e-9;

/** Floor height under every terminal (they stand on the ground floor in Phase 1). */
export const TERMINAL_FLOOR_Y = 0;

/** What canHack reads about a player. */
export interface HackerBody {
  team: Team | string;
  health: number;
  mode: string;
  x: number;
  y: number;
  z: number;
}

/** Where a terminal stands (x, z); only these are read. */
export interface TerminalSpot {
  x: number;
  z: number;
}

/**
 * Validates an `interact` payload. Returns `active`, or null (ignore the
 * message, spend no token) unless it is a non-array object with a boolean
 * `active`. Extra fields are never read.
 */
export function parseInteract(message: unknown): boolean | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const { active } = message as Record<string, unknown>;
  return typeof active === "boolean" ? active : null;
}

/**
 * True if the player may hack the terminal right now: a team in CAN_HACK, not
 * eliminated, on the ground, within HACK_RANGE horizontally and with feet
 * within STEP_HEIGHT of the terminal floor.
 */
export function canHack(player: HackerBody, terminal: TerminalSpot): boolean {
  if (!CAN_HACK[player.team as Team]) return false;
  if (!(player.health > 0)) return false;
  if (player.mode !== "ground") return false;
  if (Math.hypot(player.x - terminal.x, player.z - terminal.z) > HACK_RANGE + HACK_RANGE_TOLERANCE) return false;
  return Math.abs(player.y - TERMINAL_FLOOR_Y) <= STEP_HEIGHT;
}

/**
 * New progress (0 to 1) after `dtMs` of server time. While held it gains
 * dt / HACK_DURATION_MS (the number of hackers does not matter); otherwise it
 * decays at HACK_DECAY_RATIO of that rate, floored at 0.
 */
export function advanceProgress(progress: number, dtMs: number, held: boolean): number {
  if (!(dtMs > 0)) return progress;
  const delta = dtMs / HACK_DURATION_MS;
  const next = held ? progress + delta : progress - delta * HACK_DECAY_RATIO;
  return Math.min(1, Math.max(0, next));
}
