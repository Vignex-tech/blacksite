import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP, type GrayboxMap } from '../../shared/map.js'
import { CAN_HACK, HACK_RANGE, type Team, type TerminalStatus } from '../../shared/protocol.js'
import type { LocalPlayerState } from './traversalHint.ts'

// Hack feedback (M6, #60). Pure functions with no Babylon or DOM code. Every
// value comes from what the server sent; the client predicts neither progress
// nor range beyond a hint prompt (the server decides whether a hack runs).

/** The prompt (`#hack-prompt`) shown to a Ghost in range of the active terminal. */
export const HACK_PROMPT = 'F: hold to hack'
/** What a Warden sees when the server sets the alert. Text only: no arrow, no marker. */
export const ALERT_TEXT = 'Terminal alarm'
/** Shown to everyone once the terminal is hacked. */
export const HACKED_TEXT = 'Terminal hacked'

/** A terminal as received from room state. */
export interface TerminalSnapshot {
  status: TerminalStatus
  alert: boolean
}

/** The local player plus the optional health, so an eliminated Ghost gets no prompt. */
export interface HackLocal extends LocalPlayerState {
  health?: number
}

/** True if the received state says the active terminal is hacked. */
export function isHacked(terminals: ReadonlyMap<string, TerminalSnapshot>): boolean {
  return terminals.get(ACTIVE_TERMINAL_ID)?.status === 'hacked'
}

/**
 * `F: hold to hack` for a living Ghost on the ground within HACK_RANGE
 * (horizontal) of the active terminal while it isn't hacked; otherwise ''.
 * A hint only: the server checks range, mode and timing itself.
 */
export function hackPrompt(
  local: HackLocal | null,
  terminals: ReadonlyMap<string, TerminalSnapshot>,
  map: GrayboxMap = GRAYBOX_MAP,
): string {
  if (!local || local.team === null || !CAN_HACK[local.team]) return ''
  if (local.mode !== 'ground' || (local.health !== undefined && local.health <= 0)) return ''
  if (isHacked(terminals)) return ''
  const t = map.terminals.find((m) => m.id === ACTIVE_TERMINAL_ID)
  if (!t) return ''
  return Math.hypot(t.x - local.x, t.z - local.z) <= HACK_RANGE ? HACK_PROMPT : ''
}

/** Whole percent of a 0..1 progress (clamped; non-finite counts as 0). */
export function progressPercent(progress: number): number {
  return Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : 0
}

/**
 * Text of `#hack-bar` for a Ghost: `Hack 45%`, or '' for a Warden (never any
 * number), with no progress received, at 0, or once hacked.
 */
export function hackBarText(
  team: Team | null,
  progress: number | null,
  terminals: ReadonlyMap<string, TerminalSnapshot>,
): string {
  if (team === null || !CAN_HACK[team] || progress === null || isHacked(terminals)) return ''
  const pct = progressPercent(progress)
  return pct > 0 ? `Hack ${pct}%` : ''
}

/**
 * Text of `#hack-alert`: `Terminal hacked` for everyone once hacked,
 * `Terminal alarm` for a Warden while the alert flag is set, else ''.
 */
export function hackAlertText(team: Team | null, terminals: ReadonlyMap<string, TerminalSnapshot>): string {
  if (isHacked(terminals)) return HACKED_TEXT
  if (team === 'warden' && terminals.get(ACTIVE_TERMINAL_ID)?.alert === true) return ALERT_TEXT
  return ''
}
