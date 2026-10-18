// Strict checks of the client test hook's team and facing fields (#22, #23).
// Since #22 every player in a connected snapshot has a `team` in TEAMS and a
// finite `yaw` (the server wraps it into -pi..pi), and `localTeam` is the
// local player's team. Used by the browser specs.

import { expect } from '@playwright/test'
import { TEAMS } from '../../../shared/protocol.js'
import type { BlacksiteSnapshot } from '../../../shared/testhook.js'
import { isTeam } from './intent.js'

/** float32 on the wire. */
const EPS = 1e-4

/**
 * Fails unless every player in `s` has a known team and a finite yaw in
 * -pi..pi, and `localTeam` equals the local player's team. `version` is 1.
 */
export function expectTeamsAndYaws(s: BlacksiteSnapshot): void {
  const who = s.sessionId ?? 'a disconnected tab'
  expect(s.version, `${who}: version is still 1`).toBe(1)
  for (const p of s.players) {
    expect(isTeam(p.team), `${who} sees ${p.id} with team ${JSON.stringify(p.team)}, one of ${TEAMS.join(', ')}`).toBe(true)
    expect(typeof p.yaw === 'number' && Number.isFinite(p.yaw), `${who} sees ${p.id} with a finite yaw (${String(p.yaw)})`).toBe(true)
    expect(Math.abs(p.yaw), `${who} sees ${p.id} with yaw ${p.yaw} in -pi..pi`).toBeLessThanOrEqual(Math.PI + EPS)
  }
  const local = s.players.filter((p) => p.isLocal)
  expect(local, `${who} has exactly one local player`).toHaveLength(1)
  expect(s.localTeam, `${who}: localTeam is the local player's team`).toBe(local[0].team)
}
