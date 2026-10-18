// Per-player step for e2e tests: how far one accepted move at full input
// carries a given player. Since #20 each team moves TEAM_SPEED[team] /
// MOVE_RATE_HZ per accepted move, so the player's synced `team` decides.

import { MOVE_RATE_HZ as SERVER_MOVE_RATE_HZ } from '../../../server/build/rooms/MyRoom.js'
import { isTeam, teamStep, type MoverLike } from './intent.js'

export * from './intent.js'

/** Move rate the server's per-message step is derived from (Hz). */
export const MOVE_RATE_HZ: number = SERVER_MOVE_RATE_HZ

/**
 * Step per accepted move at full input for player `p`:
 * TEAM_SPEED[p.team] / MOVE_RATE_HZ. Fails if `p` has no valid team (#20
 * syncs one for every player).
 */
export function stepFor(p: MoverLike): number {
  if (!isTeam(p.team)) throw new Error(`player has no valid team (${JSON.stringify(p.team)})`)
  return teamStep(p.team, MOVE_RATE_HZ)
}
