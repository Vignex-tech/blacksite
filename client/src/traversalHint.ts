import { GRAYBOX_MAP, PLAYER_HEIGHT, type GrayboxMap, type LedgeAnchor } from '../../shared/map.js'
import { ANCHOR_RANGE, ANCHOR_REACH, CAN_CLIMB, type MovementMode, type Team } from '../../shared/protocol.js'

// HUD feedback for vertical movement (M4, #35). Pure functions with no
// Babylon or DOM code, so they can be unit-tested. Everything here is a
// display hint worked out from shared map data and the local player's server
// position; the server alone decides whether a climb, grab or drop happens.

/** The mode line (`#mode`) for each movement mode: the mode in plain words, plus the keys that work while attached. */
export const MODE_TEXT: Readonly<Record<MovementMode, string>> = Object.freeze({
  ground: 'On the ground',
  falling: 'In the air',
  climbing: 'Climbing: W/S climb up or down, C drop',
  hanging: 'Hanging: E climb up, C drop, A/D move',
})

/** The prompt (`#climb-prompt`) shown to a Ghost in reach of an anchor. */
export const CLIMB_PROMPT = 'E: climb'

/** Where the local player is, as received from the server. */
export interface LocalPlayerState {
  team: Team | null
  mode: MovementMode
  x: number
  y: number
  z: number
}

/** Nearest point of a ledge's segment to (x, z). */
function nearestOnLedge(l: LedgeAnchor, x: number, z: number): { x: number; z: number } {
  const sx = l.x1 - l.x0
  const sz = l.z1 - l.z0
  const len2 = sx * sx + sz * sz
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - l.x0) * sx + (z - l.z0) * sz) / len2))
  return { x: l.x0 + t * sx, z: l.z0 + t * sz }
}

/**
 * True if a Ghost at (x, y, z) is in range of an anchor it could take with E,
 * using the same range and reach as the server's rules (protocol.d.ts,
 * ActionMessage): a climb anchor within ANCHOR_RANGE with the feet within
 * ANCHOR_REACH of its minY..maxY, or a ledge segment within ANCHOR_RANGE
 * with the hands (y + PLAYER_HEIGHT) within ANCHOR_REACH of its y. It doesn't
 * check that the box fits; the server does.
 */
export function nearAnchor(x: number, y: number, z: number, map: GrayboxMap = GRAYBOX_MAP): boolean {
  return map.anchors.some((a) => {
    if (a.kind === 'climb') {
      return Math.hypot(a.x - x, a.z - z) <= ANCHOR_RANGE && y >= a.minY - ANCHOR_REACH && y <= a.maxY + ANCHOR_REACH
    }
    const p = nearestOnLedge(a, x, z)
    return Math.hypot(p.x - x, p.z - z) <= ANCHOR_RANGE && Math.abs(y + PLAYER_HEIGHT - a.y) <= ANCHOR_REACH
  })
}

/** Text of the mode line, or '' when there is no local player yet. */
export function modeText(local: LocalPlayerState | null): string {
  return local ? MODE_TEXT[local.mode] : ''
}

/**
 * Text of the climb prompt: CLIMB_PROMPT for a player whose team can climb,
 * on the ground or in the air, near an anchor; otherwise ''. A Warden never
 * sees it.
 */
export function climbPrompt(local: LocalPlayerState | null, map: GrayboxMap = GRAYBOX_MAP): string {
  if (!local || local.team === null || !CAN_CLIMB[local.team]) return ''
  if (local.mode !== 'ground' && local.mode !== 'falling') return ''
  return nearAnchor(local.x, local.y, local.z, map) ? CLIMB_PROMPT : ''
}
