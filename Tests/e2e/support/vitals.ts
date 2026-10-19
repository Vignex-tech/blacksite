// Health, ammo and reloading (M5, #40). Optional on PlayerState and on hook
// players until the server (#41) and client (#48) send them; these helpers
// return undefined for a missing field instead of throwing, so specs written
// before and after those issues share one reader.
//
// To inspect what a tab or SDK client actually received:
//  - a browser tab: `captureMoves(page)` in frames.ts decodes the frames the
//    tab SENDS (fire/reload need a new case there, via decodeRoomMessage);
//  - an SDK client: `room.onMessage(SHOT_EVENT | HIT_EVENT | DAMAGED_EVENT, ...)`
//    (see `collectEvents`) and `room.state.players` (see `vitalsOf`).
// #47 should use `vitalsOf` / `hookVitals` plus `collectEvents`; the frames.ts
// decoder is enough for the wire-level check of what a client sends.

import type { BlacksiteSnapshot } from '../../../shared/testhook.js'
import type { GameRoom } from './sdk.js'

export interface Vitals {
  health?: number
  ammo?: number
  reloading?: boolean
}

function pick(p: Record<string, unknown> | undefined): Vitals | undefined {
  if (!p) return undefined
  const v: Vitals = {}
  if (typeof p.health === 'number') v.health = p.health
  if (typeof p.ammo === 'number') v.ammo = p.ammo
  if (typeof p.reloading === 'boolean') v.reloading = p.reloading
  return v
}

/** Vitals of `sessionId` in an SDK room's state; undefined if the player isn't in that client's state. Missing fields are omitted. */
export function vitalsOf(room: GameRoom, sessionId: string): Vitals | undefined {
  return pick(room.state.players.get(sessionId) as unknown as Record<string, unknown> | undefined)
}

/** Vitals of player `id` in a hook snapshot; undefined if the tab doesn't list that player. */
export function hookVitals(s: BlacksiteSnapshot, id: string): Vitals | undefined {
  return pick(s.players.find((p) => p.id === id) as unknown as Record<string, unknown> | undefined)
}

/**
 * Records every `type` message `room` receives. Read `.events` after the SDK
 * clients have left and assert once (a per-event expect() blocks the worker).
 */
export function collectEvents<T = unknown>(room: GameRoom, type: string): { events: T[] } {
  const rec = { events: [] as T[] }
  room.onMessage(type, (m: T) => {
    rec.events.push(m)
  })
  return rec
}
