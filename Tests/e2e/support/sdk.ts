// Shared helpers for the server-integration specs (*.integration.spec.ts):
// real @colyseus/sdk clients (Node, no browser) against the production server
// that Playwright's webServer starts. State is read only from what the SDK
// client receives; nothing here imports server code except exported constants.

import { expect } from '@playwright/test'
import { Client, type Room } from '@colyseus/sdk'
import { MOVE_MESSAGE, ROOM_NAME, TEAMS, type GameRoomState, type MoveMessage, type Team } from '../../../shared/protocol.js'
// Built server constants (server/build exists: Playwright's webServer runs it).
import { BOUND } from '../../../server/build/rooms/MyRoom.js'
import { overlapping, type Point } from './geometry.js'
import { isTeam, stepFor } from './movement.js'

const port = Number(process.env.E2E_PORT ?? 2567)
export const endpoint = `ws://localhost:${port}`

/** Synced numbers are float32 on the wire. */
export const EPS = 1e-4
/** Upper bound for a single state wait; a failure, never a delay. */
export const WAIT_MS = 5_000

export type GameRoom = Room<any, GameRoomState>

/** A player as synced by the server since #20: team and yaw are required. */
export interface SyncedPlayer {
  x: number
  z: number
  team: Team
  yaw: number
}

/**
 * Player `sessionId` as `room` sees it. Fails unless it has finite x, z and
 * yaw (yaw within -pi..pi, with float32 slack) and a team in TEAMS.
 */
export function pos(room: GameRoom, sessionId: string): SyncedPlayer {
  const p = room.state.players.get(sessionId) as unknown as Record<string, unknown> | undefined
  if (!p) throw new Error(`player ${sessionId} missing from ${room.sessionId}'s state`)
  const { x, z, team, yaw } = p
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof z !== 'number' || !Number.isFinite(z)) {
    throw new Error(`player ${sessionId} has a bad position ${String(x)},${String(z)}`)
  }
  if (!isTeam(team)) throw new Error(`player ${sessionId} has team ${JSON.stringify(team)}, not one of ${TEAMS.join(', ')}`)
  if (typeof yaw !== 'number' || !Number.isFinite(yaw) || Math.abs(yaw) > Math.PI + EPS) {
    throw new Error(`player ${sessionId} has yaw ${String(yaw)}, not a number in -pi..pi`)
  }
  return { x, z, team, yaw }
}

/** Player counts per team in `room`'s state. */
export function teamCounts(room: GameRoom): Record<Team, number> {
  const counts = Object.fromEntries(TEAMS.map((t) => [t, 0])) as Record<Team, number>
  room.state.players.forEach((_p, id) => counts[pos(room, id).team]++)
  return counts
}

/** Resolves once `predicate(room.state)` holds, checking now and on every state change. */
export function waitForState(room: GameRoom, what: string, predicate: (s: GameRoomState) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (s: GameRoomState) => {
      let ok = false
      try {
        ok = !!s && predicate(s)
      } catch {
        ok = false
      }
      if (ok) {
        clearTimeout(timer)
        room.onStateChange.remove(check)
        resolve()
      }
    }
    const timer = setTimeout(() => {
      room.onStateChange.remove(check)
      reject(new Error(`timed out after ${WAIT_MS} ms waiting for: ${what}`))
    }, WAIT_MS)
    room.onStateChange(check)
    check(room.state)
  })
}

export const sizeIs = (n: number) => (s: GameRoomState) => s.players?.size === n

/**
 * Creates a fresh room and joins `n` clients to it one at a time, in order,
 * pushing each into `open` (left after the test). Everyone sees each joiner
 * before the next one joins, so join order is strict. `options(i)` gives the
 * join options of joiner i (0-based).
 */
export async function joinInOrder(n: number, open: GameRoom[], options: (i: number) => object = () => ({})): Promise<GameRoom[]> {
  const first = (await new Client(endpoint).create(ROOM_NAME, options(0))) as GameRoom
  const rooms: GameRoom[] = [first]
  open.push(first)
  await waitForState(first, 'joiner 1 sees itself', sizeIs(1))
  for (let i = 1; i < n; i++) await joinRoom(first.roomId, rooms, open, options(i))
  return rooms
}

/** Joins one more client to `roomId`; waits until it and everyone in `rooms` see the new size. */
export async function joinRoom(roomId: string, rooms: GameRoom[], open: GameRoom[], options: object = {}): Promise<GameRoom> {
  const r = (await new Client(endpoint).joinById(roomId, options)) as GameRoom
  rooms.push(r)
  open.push(r)
  const n = rooms.length
  for (const room of rooms) await waitForState(room, `${room.sessionId} sees ${n} players`, sizeIs(n))
  return r
}

/** Leaves `room`, removes it from `rooms`, and waits until everyone left sees the new size. */
export async function leaveRoom(room: GameRoom, rooms: GameRoom[]): Promise<void> {
  const i = rooms.indexOf(room)
  if (i < 0) throw new Error('room not in list')
  rooms.splice(i, 1)
  await room.leave()
  for (const r of rooms) await waitForState(r, `${r.sessionId} sees ${rooms.length} players`, sizeIs(rooms.length))
}

// ---------------------------------------------------------------------------
// Walker: paced moves that wait for synced state.
//
// Moves are paced at PACE_MS (just over 1000 / MOVE_RATE_HZ), so the token
// bucket never drops one. Each step waits for the client's own state to change
// (or STEP_WAIT_MS when nothing changes), so waits follow state, not fixed
// sleeps.
// ---------------------------------------------------------------------------

/** Minimum gap between two moves from one client (ms). 1000 / MOVE_RATE_HZ is 50. */
export const PACE_MS = 55
/** How long a step waits for its move to show up in state before calling it blocked. */
export const STEP_WAIT_MS = 150
/** Consecutive unchanged steps that mean "stopped" (a rare dropped move can't fake it). */
export const STUCK_STEPS = 4
/**
 * A walk waypoint counts as reached within this distance on each axis. Well
 * below EPS, so a walk lands on its target as exactly as the wire allows and
 * a later check against the target within EPS can't fail on walk residue
 * (float32 resolution at |x| <= 20 is about 2e-6).
 */
export const ARRIVE = 1e-5

const clampUnit = (v: number) => Math.max(-1, Math.min(1, v))

/**
 * One SDK client walking its own player. Every state change it receives is
 * checked: no player in the room may overlap a ground solid or leave the
 * bounds at any moment, not only at the end of a walk.
 */
export class Walker {
  readonly violations: string[] = []
  private lastSend = 0

  constructor(
    readonly room: GameRoom,
    readonly name: string,
  ) {
    room.onStateChange((s: GameRoomState) => {
      s.players?.forEach((p, id: string) => {
        const hit = overlapping(p)
        if (hit.length) this.violations.push(`${id} at ${p.x},${p.z} overlaps ${hit.map((h) => h.id).join(',')}`)
        if (Math.abs(p.x) > BOUND + EPS || Math.abs(p.z) > BOUND + EPS) {
          this.violations.push(`${id} at ${p.x},${p.z} is outside +-BOUND`)
        }
      })
    })
  }

  /** This client's own synced player. */
  get state(): SyncedPlayer {
    return pos(this.room, this.room.sessionId)
  }

  get pos(): Point {
    const { x, z } = this.state
    return { x, z }
  }

  /** Step per accepted move at full input for this player (support/movement.ts). */
  get stepSize(): number {
    return stepFor(this.state)
  }

  /**
   * Sends one paced move; resolves once this client's own x, z or yaw changes
   * in synced state, or after STEP_WAIT_MS if nothing changed.
   */
  async send(msg: MoveMessage): Promise<{ changed: boolean; moved: boolean; at: SyncedPlayer }> {
    const wait = this.lastSend + PACE_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const before = this.state
    this.lastSend = Date.now()
    this.room.send(MOVE_MESSAGE, msg)
    const changed = await new Promise<boolean>((resolve) => {
      const check = () => {
        const p = this.state
        if (p.x !== before.x || p.z !== before.z || p.yaw !== before.yaw) done(true)
      }
      const done = (v: boolean) => {
        clearTimeout(timer)
        this.room.onStateChange.remove(check)
        resolve(v)
      }
      const timer = setTimeout(() => done(false), STEP_WAIT_MS)
      this.room.onStateChange(check)
    })
    const at = this.state
    return { changed, moved: at.x !== before.x || at.z !== before.z, at }
  }

  /** Sends one move without a yaw; resolves with the new position once synced, or the old one if blocked. */
  async step(dx: number, dz: number): Promise<{ moved: boolean; at: Point }> {
    const r = await this.send({ dx, dz })
    return { moved: r.moved, at: { x: r.at.x, z: r.at.z } }
  }

  /** Turns to `yaw` with yaw-only moves (resent until it lands); returns the synced yaw. */
  async face(yaw: number): Promise<number> {
    for (let i = 0; i < 20; i++) {
      if (Math.abs(this.state.yaw - yaw) < EPS) return this.state.yaw
      await this.send({ dx: 0, dz: 0, yaw })
    }
    throw new Error(`${this.name} did not turn to yaw ${yaw} (yaw ${this.state.yaw})`)
  }

  /**
   * Walks to `target` with world-aligned input proportional to the remaining
   * distance (so it lands on it), one axis at a time in `order`, or both at
   * once with 'both' (only where the bounding rectangle is clear). Turns to
   * yaw 0 first, so dx is +x and dz is +z. Fails if the player gets stuck.
   *
   * With the capped intent a 'both' leg still points at the target, so it
   * stays in the bounding rectangle and converges, only in more steps.
   */
  async walkTo(target: Point, order: 'xz' | 'zx' | 'both' = 'xz'): Promise<Point> {
    await this.face(0)
    const step = this.stepSize
    const legs: ('x' | 'z' | 'both')[] = order === 'both' ? ['both'] : order === 'xz' ? ['x', 'z'] : ['z', 'x']
    for (const leg of legs) {
      let stuck = 0
      for (;;) {
        const p = this.pos
        const ex = leg === 'z' ? 0 : target.x - p.x
        const ez = leg === 'x' ? 0 : target.z - p.z
        if (Math.abs(ex) < ARRIVE && Math.abs(ez) < ARRIVE) break
        const r = await this.step(
          Math.abs(ex) < ARRIVE ? 0 : clampUnit(ex / step),
          Math.abs(ez) < ARRIVE ? 0 : clampUnit(ez / step),
        )
        stuck = r.moved ? 0 : stuck + 1
        if (stuck >= STUCK_STEPS) {
          throw new Error(`${this.name} got stuck at ${r.at.x},${r.at.z} walking to ${target.x},${target.z}`)
        }
      }
    }
    return this.pos
  }

  /**
   * Holds (dx, dz) until the player stops moving, calling `each` after every
   * step with the position it reached. Returns where it stopped.
   */
  async push(dx: number, dz: number, maxSteps: number, each?: (at: Point) => void): Promise<Point> {
    let stuck = 0
    for (let i = 0; i < maxSteps; i++) {
      const r = await this.step(dx, dz)
      each?.(r.at)
      stuck = r.moved ? 0 : stuck + 1
      if (stuck >= STUCK_STEPS) return r.at
    }
    throw new Error(`${this.name} still moving after ${maxSteps} steps of (${dx}, ${dz}), at ${this.pos.x},${this.pos.z}`)
  }
}

/** Fails unless the player faces +z (yaw 0), so dx is +x and dz is +z. */
export function expectFacingPlusZ(p: SyncedPlayer, who: string) {
  expect(Math.abs(p.yaw), `${who} faces +z (yaw ${p.yaw})`).toBeLessThan(EPS)
}
