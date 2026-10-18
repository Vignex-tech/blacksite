// Per-player step for e2e tests: how far one accepted move at full input
// carries a given player. Today every player moves the server's single
// `SPEED`; after #20 each team moves TEAM_SPEED[team] / MOVE_RATE_HZ. The
// player's synced `team` decides, so the same test passes before and after.

// Namespace import: a missing export reads as undefined instead of failing to
// link, so if #20 drops `SPEED` the team branch still works.
import * as serverRoom from '../../../server/build/rooms/MyRoom.js'
import { isTeam, teamStep, type MoverLike } from './intent.js'

export * from './intent.js'

const room = serverRoom as unknown as { SPEED?: number; MOVE_RATE_HZ?: number }

/** Move rate the server's per-message step is derived from (Hz). */
export const MOVE_RATE_HZ: number = room.MOVE_RATE_HZ ?? 20

/**
 * Step per accepted move at full input for player `p`:
 * TEAM_SPEED[p.team] / MOVE_RATE_HZ when `p` has a team, otherwise the
 * server's exported SPEED (single speed, M1 and M2).
 */
export function stepFor(p: MoverLike): number {
  if (isTeam(p.team)) return teamStep(p.team, MOVE_RATE_HZ)
  if (p.team !== undefined) throw new Error(`player has an unknown team ${JSON.stringify(p.team)}`)
  if (typeof room.SPEED !== 'number') {
    throw new Error('player has no team and the server exports no SPEED')
  }
  return room.SPEED
}
