// Terminal and hack helpers (M6, #55). Written before the server sends any
// terminal state (#56), so every reader tolerates its absence: `terminalsOf`
// returns [] and `collectProgress` stays empty until the server fills them.
//
//  - terminalsOf(room): the terminals an SDK client received, as plain data.
//    Read a Warden's view only to check what a Warden is NOT told (no hacker,
//    no progress); a Warden sees `hacking` only from the alert on (decision 9
//    on #53).
//  - collectProgress(room): records `hackProgress` messages (Ghost clients
//    only ever get them). Read `.progress` after the SDK clients have left and
//    assert once (a per-message expect() blocks the worker, #34).
//  - terminalPlacement(): where to stand to be just inside and just outside
//    HACK_RANGE of a terminal (default ACTIVE_TERMINAL_ID), read from the map
//    data, nothing hard-coded. Both points are clear of every ground obstacle
//    with 0.1 to spare, outside route hazards (ramps, pockets, climb spots),
//    inside the building and bounds, and the straight line between them is
//    clear, so one short step of a walker crosses the range edge. Walk there
//    with `Walker.walkTo`; the server accepts the ground (it is the same
//    ground test the map invariants check).

import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP, PLAYER_HALF_SIZE, type Terminal } from '../../../shared/map.js'
import { HACK_RANGE, HACK_PROGRESS_MESSAGE, type HackProgressMessage, type TerminalStatus } from '../../../shared/protocol.js'
import { GROUND_OBSTACLES, ROUTE_MARGIN, blocks, hazardsAt, insideBuilding, playerRect, type Point } from './geometry.js'
import type { GameRoom } from './sdk.js'

/** A terminal as a client received it in room state. */
export interface SeenTerminal {
  id: string
  status: TerminalStatus
  alert: boolean
}

/** The terminals in `room`'s state, sorted by id; [] while the server sends none. */
export function terminalsOf(room: GameRoom): SeenTerminal[] {
  const map = (room.state as unknown as { terminals?: { forEach(cb: (t: Record<string, unknown>, id: string) => void): void } }).terminals
  const out: SeenTerminal[] = []
  map?.forEach((t, id) => out.push({ id, status: t.status as TerminalStatus, alert: t.alert as boolean }))
  return out.sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** The terminal `id` (default the active one) in `room`'s state, or undefined. */
export function terminalOf(room: GameRoom, id: string = ACTIVE_TERMINAL_ID): SeenTerminal | undefined {
  return terminalsOf(room).find((t) => t.id === id)
}

/** Every `hackProgress` message `room` received, in order. */
export function collectProgress(room: GameRoom): { progress: HackProgressMessage[] } {
  const rec = { progress: [] as HackProgressMessage[] }
  room.onMessage(HACK_PROGRESS_MESSAGE, (m: HackProgressMessage) => {
    rec.progress.push(m)
  })
  return rec
}

/** Distance kept between a placed player box and any obstacle. */
export const PLACEMENT_CLEARANCE = 0.1
/** How far inside and outside the range edge the two points sit. */
export const RANGE_MARGIN = 0.1

export interface TerminalPlacement {
  terminal: Terminal
  /** Horizontal distance HACK_RANGE - RANGE_MARGIN from the terminal. */
  inside: Point
  /** Horizontal distance HACK_RANGE + RANGE_MARGIN, straight out from `inside`. */
  outside: Point
}

const freeGround = (p: Point): boolean => {
  const box = playerRect(p, PLAYER_HALF_SIZE)
  const b = GRAYBOX_MAP.bounds
  if (box.minX < b.minX || box.maxX > b.maxX || box.minZ < b.minZ || box.maxZ > b.maxZ) return false
  if (!insideBuilding(p) || hazardsAt(p, ROUTE_MARGIN).length) return false
  return !GROUND_OBSTACLES.some((o) => blocks(o, box, 0, -PLACEMENT_CLEARANCE))
}

/**
 * A pair of points on the ground just inside and just outside the hack range
 * of terminal `id`, in the first of 32 directions whose whole line is clear.
 * Throws if the map has no such direction.
 */
export function terminalPlacement(id: string = ACTIVE_TERMINAL_ID): TerminalPlacement {
  const terminal = GRAYBOX_MAP.terminals.find((t) => t.id === id)
  if (!terminal) throw new Error(`no terminal ${id} in the map`)
  const dIn = HACK_RANGE - RANGE_MARGIN
  const dOut = HACK_RANGE + RANGE_MARGIN
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * 2 * Math.PI
    const at = (d: number): Point => ({ x: terminal.x + Math.cos(a) * d, z: terminal.z + Math.sin(a) * d })
    const line = [dIn, (dIn + dOut) / 2, dOut]
    if (line.every((d) => freeGround(at(d)))) return { terminal, inside: at(dIn), outside: at(dOut) }
  }
  throw new Error(`no clear ground just inside and outside ${HACK_RANGE} of ${id}`)
}

/** Horizontal distance from `p` to `t` (what the server compares with HACK_RANGE). */
export const distanceTo = (p: Point, t: Point): number => Math.hypot(p.x - t.x, p.z - t.z)
