import type { RoundPhase, RoundState, RoundWinReason, Team } from '../../shared/protocol.js'

// Round overlays (M7, #72). Pure functions with no Babylon or DOM code, no
// layout, ids or coordinates. Everything shown comes from `state.round` as the
// server sent it: the client never counts time itself and reads no round
// setting from the URL or `location`.

/** The round fields the client reads (same shape as the shared RoundState). */
export type RoundView = Pick<RoundState, 'phase' | 'roundNumber' | 'secondsLeft' | 'winner' | 'winReason'>

export const WAITING_TEXT = 'Waiting for players'

/** The last this-many seconds of a countdown get large digits. */
export const COUNTDOWN_BIG_SECONDS = 3

/** Result headline for each win reason. */
export const RESULT_REASON_TEXT: Readonly<Record<RoundWinReason, string>> = {
  hacked: 'Ghosts win: terminal hacked',
  ghosts_eliminated: 'Wardens win: all Ghosts eliminated',
  time_out: 'Wardens win: time ran out',
}

const wholeSeconds = (s: number): number => (Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0)

/**
 * `M:SS` in countdown and live; '' in waiting and ended, before state
 * arrives, and when the server sent no timer (secondsLeft 0, the open preset).
 */
export function timerText(round: RoundView | null): string {
  if (!round || (round.phase !== 'countdown' && round.phase !== 'live')) return ''
  const s = wholeSeconds(round.secondsLeft)
  if (s === 0) return ''
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** `Waiting for players` in waiting, `Round N starts in S` in countdown, else ''. */
export function bannerText(round: RoundView | null): string {
  if (!round) return ''
  if (round.phase === 'waiting') return WAITING_TEXT
  if (round.phase === 'countdown') return `Round ${round.roundNumber} starts in ${wholeSeconds(round.secondsLeft)}`
  return ''
}

/** True for the large-digit style: the last seconds of a countdown. */
export function bannerIsBig(round: RoundView | null): boolean {
  if (!round || round.phase !== 'countdown') return false
  const s = wholeSeconds(round.secondsLeft)
  return s >= 1 && s <= COUNTDOWN_BIG_SECONDS
}

/**
 * Result screen text in `ended`: the reason line, `You win` or `You lose`
 * (when the local team is known) and `Next round in S` (when the server sent
 * seconds). '' outside ended and for an aborted round (no winner).
 */
export function resultText(round: RoundView | null, localTeam: Team | null): string {
  if (!round || round.phase !== 'ended' || round.winner === '' || round.winReason === '') return ''
  const headline = RESULT_REASON_TEXT[round.winReason]
  if (!headline) return ''
  const lines = [headline]
  if (localTeam) lines.push(localTeam === round.winner ? 'You win' : 'You lose')
  const s = wholeSeconds(round.secondsLeft)
  if (s > 0) lines.push(`Next round in ${s}`)
  return lines.join('\n')
}

/** Class for the result overlay: the winning team, or ''. */
export function resultClass(round: RoundView | null): Team | '' {
  return round && round.phase === 'ended' && round.winReason !== '' ? round.winner : ''
}

/** True once state says the round is anything but live. Unknown (no state yet) is not frozen. */
export function isFrozen(round: { phase: RoundPhase } | null): boolean {
  return round !== null && round.phase !== 'live'
}
