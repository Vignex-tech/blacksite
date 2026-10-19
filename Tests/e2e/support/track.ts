// Records the synced (x, y, z, mode) history of one player as one SDK client
// receives it. Shared by the M4 height (#30) and climbing (#32) specs.

import { MOVEMENT_MODES } from '../../../shared/protocol.js'
import { feetY, modeOf } from './geometry.js'
import type { GameRoom } from './sdk.js'

/** One synced state of a player, as one client saw it. */
export interface Sample {
  t: number
  x: number
  y: number
  z: number
  mode: string
}

/**
 * Records every distinct synced (x, y, z, mode) of player `id` as `room`
 * receives it, from now on. Fails (in `bad`) if y or mode is missing or has a
 * bad type: since #29 the server always sends both.
 */
export function track(room: GameRoom, id: string): { samples: Sample[]; bad: string[] } {
  const samples: Sample[] = []
  const bad: string[] = []
  const push = () => {
    const p = room.state.players?.get(id) as unknown as Record<string, unknown> | undefined
    if (!p) return
    if (typeof p.y !== 'number' || !Number.isFinite(p.y)) bad.push(`y is ${JSON.stringify(p.y)}`)
    if (typeof p.mode !== 'string' || !(MOVEMENT_MODES as readonly string[]).includes(p.mode)) bad.push(`mode is ${JSON.stringify(p.mode)}`)
    const s: Sample = { t: Date.now(), x: p.x as number, y: feetY(p as never), z: p.z as number, mode: modeOf(p as never) }
    const last = samples[samples.length - 1]
    if (!last || last.x !== s.x || last.y !== s.y || last.z !== s.z || last.mode !== s.mode) samples.push(s)
  }
  room.onStateChange(push)
  push()
  return { samples, bad }
}
