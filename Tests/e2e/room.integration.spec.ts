import { expect, test } from '@playwright/test'
import { Client, type Room } from '@colyseus/sdk'
import { MOVE_MESSAGE, ROOM_NAME, type GameRoomState, type PlayerState } from '../../shared/protocol.js'
// Built server constants (server/build exists: Playwright's webServer runs it).
import { BOUND, MOVE_BURST } from '../../server/build/rooms/MyRoom.js'
// Per-player step and #18's world-step formula (support/intent.ts), so these
// tests pass with today's single SPEED and with #20's per-team speed, capped
// diagonals and yaw.
import { allowedSteps, stepFor, worldStep, yawOf, type Vec } from './support/movement.js'
// Map data and player size come from shared/map.js (via support/geometry.ts).
import {
  GRAYBOX_MAP,
  PLAYER_HALF_SIZE,
  entrance,
  inRect,
  insideBuilding,
  overlapping,
  solid,
  stopAlongZ,
  type Point,
} from './support/geometry.js'

// Two real @colyseus/sdk clients (Node, no browser) against the production
// server that Playwright's webServer starts. This project runs before the
// browser project (see playwright.config.ts), so no browser page can
// joinOrCreate into these rooms and change the player counts.

const port = Number(process.env.E2E_PORT ?? 2567)
const endpoint = `ws://localhost:${port}`

/** Synced numbers are float32 on the wire. */
const EPS = 1e-4
/** Upper bound for a single state wait; a failure, never a delay. */
const WAIT_MS = 5_000

type GameRoom = Room<any, GameRoomState>

function pos(room: GameRoom, sessionId: string): PlayerState {
  const p = room.state.players.get(sessionId)
  if (!p) throw new Error(`player ${sessionId} missing from ${room.sessionId}'s state`)
  const out: PlayerState = { x: p.x, z: p.z }
  // team and yaw only when the server syncs them (#20).
  if (p.team !== undefined) out.team = p.team
  if (p.yaw !== undefined) out.yaw = p.yaw
  return out
}

/** True if `to - from` equals one of `steps` on both axes (within EPS). */
function movedByOneOf(from: Vec, to: Vec, steps: Vec[]): boolean {
  return steps.some((d) => Math.abs(to.x - from.x - d.x) < EPS && Math.abs(to.z - from.z - d.z) < EPS)
}

/** Fails unless the player faces +z (yaw 0, or no yaw field yet), so dx is +x and dz is +z. */
function expectFacingPlusZ(p: PlayerState, who: string) {
  expect(Math.abs(yawOf(p)), `${who} faces +z (yaw ${p.yaw})`).toBeLessThan(EPS)
}

/** Resolves once `predicate(room.state)` holds, checking now and on every state change. */
function waitForState(room: GameRoom, what: string, predicate: (s: GameRoomState) => boolean): Promise<void> {
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

const sizeIs = (n: number) => (s: GameRoomState) => s.players?.size === n

/** A creates a fresh room, B joins it by id; both see 2 players. */
async function joinPair() {
  const a = (await new Client(endpoint).create(ROOM_NAME)) as GameRoom
  const b = (await new Client(endpoint).joinById(a.roomId)) as GameRoom
  await waitForState(a, 'A sees 2 players', sizeIs(2))
  await waitForState(b, 'B sees 2 players', sizeIs(2))
  return { a, b }
}

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => (r.connection.isOpen ? r.leave().catch(() => {}) : undefined)))
})

test('two clients join the same room, each sees 2 players keyed by sessionId, spawned inside the bounds', async () => {
  const { a, b } = await joinPair()
  open.push(a, b)
  expect(a.roomId).toBe(b.roomId)
  expect(a.sessionId).not.toBe(b.sessionId)

  // Balanced teams, ties to ghost: the 1st joiner (A, the creator) spawns in
  // the ghost area, the 2nd (B) in the warden area, clear of every solid.
  const expected: [string, keyof typeof GRAYBOX_MAP.spawnAreas][] = [
    [a.sessionId, 'ghost'],
    [b.sessionId, 'warden'],
  ]
  for (const room of [a, b]) {
    for (const [id, area] of expected) {
      const p = pos(room, id)
      expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true)
      expect(inRect(p, GRAYBOX_MAP.spawnAreas[area]), `${id} at ${p.x},${p.z} is in the ${area} area`).toBe(true)
      if (p.team !== undefined) expect(p.team, `${id}'s team`).toBe(area)
      expect(overlapping(p).map((s) => s.id), `${id} overlaps no solid`).toEqual([])
      expect(Math.abs(p.x)).toBeLessThanOrEqual(BOUND + EPS)
      expect(Math.abs(p.z)).toBeLessThanOrEqual(BOUND + EPS)
    }
  }
  // Both clients agree on both positions.
  for (const id of [a.sessionId, b.sessionId]) {
    expect(pos(a, id).x).toBeCloseTo(pos(b, id).x, 4)
    expect(pos(a, id).z).toBeCloseTo(pos(b, id).z, 4)
  }
})

test("A's move { dx: 1, dz: 0 } moves A one step to its right as seen by B, and not B", async () => {
  const { a, b } = await joinPair()
  open.push(a, b)
  const a0 = pos(b, a.sessionId)
  const b0 = pos(b, b.sessionId)
  // One step along A's right for A's yaw (0 if absent) and team (support/intent.ts).
  const d = worldStep(1, 0, yawOf(a0), stepFor(a0))

  a.send(MOVE_MESSAGE, { dx: 1, dz: 0 })
  await waitForState(b, "B sees A move", () => {
    const p = pos(b, a.sessionId)
    return Math.abs(p.x - a0.x) > EPS || Math.abs(p.z - a0.z) > EPS
  })

  const a1 = pos(b, a.sessionId)
  expect(Math.abs(a1.x - (a0.x + d.x)), `x ${a1.x}, expected ${a0.x + d.x}`).toBeLessThan(EPS)
  expect(Math.abs(a1.z - (a0.z + d.z)), `z ${a1.z}, expected ${a0.z + d.z}`).toBeLessThan(EPS)
  const b1 = pos(b, b.sessionId)
  expect(Math.abs(b1.x - b0.x)).toBeLessThan(EPS)
  expect(Math.abs(b1.z - b0.z)).toBeLessThan(EPS)
})

test('malformed and out-of-range moves do not move A or disconnect it', async () => {
  const { a, b } = await joinPair()
  open.push(a, b)
  let aLeft: number | undefined
  a.onLeave((code) => (aLeft = code))
  const a0 = pos(b, a.sessionId)
  const yaw = yawOf(a0)
  const step = stepFor(a0)
  // The sentinel is a forward move; with yaw 0 that is +z only.
  expectFacingPlusZ(a0, 'A')

  for (const payload of [{ dx: 'x' }, { dx: 'x', dz: 1 }, { dx: 1, dz: null }, {}, 'move', 42, [1, 1], null]) {
    a.send(MOVE_MESSAGE, payload as never)
  }
  // Messages from one client are handled in order. This sentinel moves only z,
  // so once B sees it, every malformed message above has been handled too.
  // x must be unchanged and z must have moved by exactly one step.
  a.send(MOVE_MESSAGE, { dx: 0, dz: 1 })
  await waitForState(b, "B sees A's sentinel z move", () => Math.abs(pos(b, a.sessionId).z - a0.z) > EPS)

  let a1 = pos(b, a.sessionId)
  const fwd = worldStep(0, 1, yaw, step)
  expect(Math.abs(a1.x - (a0.x + fwd.x))).toBeLessThan(EPS)
  expect(Math.abs(a1.z - (a0.z + fwd.z))).toBeLessThan(EPS)

  // Out-of-range input is clamped to -1..1: at most one step per message.
  const a2 = a1
  const left = worldStep(-1000, 0, yaw, step)
  a.send(MOVE_MESSAGE, { dx: -1000, dz: 0 })
  await waitForState(b, "B sees A's clamped x move", () => Math.abs(pos(b, a.sessionId).x - a2.x) > EPS)
  a1 = pos(b, a.sessionId)
  expect(Math.abs(a1.x - (a2.x + left.x))).toBeLessThan(EPS)
  expect(Math.abs(a1.z - (a2.z + left.z))).toBeLessThan(EPS)
  expect(Math.abs(a1.x)).toBeLessThanOrEqual(BOUND)

  expect(a.connection.isOpen).toBe(true)
  expect(aLeft).toBeUndefined()
})

test("closing A drops B's player count to 1", async () => {
  const { a, b } = await joinPair()
  open.push(b)
  const aId = a.sessionId

  await a.leave()
  await waitForState(b, 'B sees 1 player', sizeIs(1))
  expect(b.state.players.get(aId)).toBeUndefined()
  expect(b.state.players.get(b.sessionId)).toBeDefined()
})

// ---------------------------------------------------------------------------
// Map collision and spawns (#13, verified in #15), through real SDK clients.
//
// Moves are paced at PACE_MS (just over 1000 / MOVE_RATE_HZ), so the token
// bucket never drops one. Each step waits for the client's own position to
// change in synced state (or STEP_WAIT_MS when it is blocked), so waits follow
// state, not fixed sleeps. Routes go one axis at a time (or diagonally only
// inside a rectangle known to be clear), with waypoints from GRAYBOX_MAP.
// ---------------------------------------------------------------------------

/** Minimum gap between two moves from one client (ms). 1000 / MOVE_RATE_HZ is 50. */
const PACE_MS = 55
/** How long a step waits for its move to show up in state before calling it blocked. */
const STEP_WAIT_MS = 150
/** Consecutive unchanged steps that mean "stopped" (a rare dropped move can't fake it). */
const STUCK_STEPS = 4
/** A walk waypoint counts as reached within this distance on each axis. */
const ARRIVE = 1e-3

const clampUnit = (v: number) => Math.max(-1, Math.min(1, v))

/**
 * One SDK client walking its own player. Every state change it receives is
 * checked: no player in the room may overlap a ground solid or leave the
 * bounds at any moment, not only at the end of a walk.
 */
class Walker {
  readonly violations: string[] = []
  private lastSend = 0

  constructor(
    readonly room: GameRoom,
    readonly name: string,
  ) {
    room.onStateChange((s: GameRoomState) => {
      s.players?.forEach((p: PlayerState, id: string) => {
        const hit = overlapping(p)
        if (hit.length) this.violations.push(`${id} at ${p.x},${p.z} overlaps ${hit.map((h) => h.id).join(',')}`)
        if (Math.abs(p.x) > BOUND + EPS || Math.abs(p.z) > BOUND + EPS) {
          this.violations.push(`${id} at ${p.x},${p.z} is outside +-BOUND`)
        }
      })
    })
  }

  get pos(): Point {
    return pos(this.room, this.room.sessionId)
  }

  /** This client's own synced player state (with team and yaw once #20 sends them). */
  get state(): PlayerState {
    return pos(this.room, this.room.sessionId)
  }

  /** Step per accepted move at full input for this player (support/movement.ts). */
  get stepSize(): number {
    return stepFor(this.state)
  }

  /** Sends one move; resolves with the new position once synced, or the old one if blocked. */
  async step(dx: number, dz: number): Promise<{ moved: boolean; at: Point }> {
    const wait = this.lastSend + PACE_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const before = this.pos
    this.lastSend = Date.now()
    this.room.send(MOVE_MESSAGE, { dx, dz })
    const moved = await new Promise<boolean>((resolve) => {
      const check = () => {
        const p = this.pos
        if (p.x !== before.x || p.z !== before.z) done(true)
      }
      const done = (v: boolean) => {
        clearTimeout(timer)
        this.room.onStateChange.remove(check)
        resolve(v)
      }
      const timer = setTimeout(() => done(false), STEP_WAIT_MS)
      this.room.onStateChange(check)
    })
    return { moved, at: this.pos }
  }

  /**
   * Walks to `target` with input proportional to the remaining distance (so
   * it lands on it exactly), one axis at a time in `order`, or both at once
   * with 'both' (only where the bounding rectangle is clear). Fails if the
   * player gets stuck on the way.
   *
   * The input is world-aligned, so the player must face +z (yaw 0, or no yaw
   * yet; nothing here sends a yaw). The step comes from the player's team.
   * With #20's capped intent a 'both' leg still points at the target, so it
   * stays in the bounding rectangle and converges, only in more steps.
   */
  async walkTo(target: Point, order: 'xz' | 'zx' | 'both' = 'xz'): Promise<Point> {
    expectFacingPlusZ(this.state, this.name)
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

/** Creates a fresh room and joins `n` clients to it one at a time, in order. */
async function joinInOrder(n: number): Promise<GameRoom[]> {
  const first = (await new Client(endpoint).create(ROOM_NAME)) as GameRoom
  const rooms: GameRoom[] = [first]
  open.push(first)
  await waitForState(first, 'joiner 1 sees itself', sizeIs(1))
  for (let i = 1; i < n; i++) {
    const r = (await new Client(endpoint).joinById(first.roomId)) as GameRoom
    rooms.push(r)
    open.push(r)
    // Everyone sees the new joiner before the next one joins, so join order is strict.
    for (const room of rooms) await waitForState(room, `${room.sessionId} sees ${i + 1} players`, sizeIs(i + 1))
  }
  return rooms
}

/**
 * Balanced teams, ties to ghost: in a fresh room joiners 1 and 3 are ghosts
 * and 2 and 4 wardens. Holds for #13's alternation by join order (today) and
 * for #20's team balance, as long as nobody leaves in between.
 */
const SPAWN_AREA_BY_JOIN = ['ghost', 'warden', 'ghost', 'warden'] as const

/** z just below the lowest solid, with half a unit to spare: everything south of it is open. */
const BELOW_SOLIDS_Z = Math.min(...GRAYBOX_MAP.solids.map((s) => s.min.z)) - PLAYER_HALF_SIZE - 0.5

test('balanced teams, ties to ghost: joiners 1 and 3 spawn in the ghost area, 2 and 4 in the warden area, clear of solids (5 fresh rooms)', async () => {
  test.setTimeout(60_000)
  for (let round = 0; round < 5; round++) {
    const rooms = await joinInOrder(4)
    for (const viewer of rooms) {
      rooms.forEach((joiner, i) => {
        const p = pos(viewer, joiner.sessionId)
        const area = SPAWN_AREA_BY_JOIN[i]
        expect(inRect(p, GRAYBOX_MAP.spawnAreas[area]), `joiner ${i + 1} at ${p.x},${p.z} is in the ${area} area`).toBe(
          true,
        )
        expect(overlapping(p).map((s) => s.id), `joiner ${i + 1} overlaps no solid`).toEqual([])
        if (p.team !== undefined) expect(p.team, `joiner ${i + 1}'s team`).toBe(area)
      })
    }
    await Promise.all(open.splice(0).map((r) => r.leave().catch(() => {})))
  }
})

test('walking into a wall stops flush with its face, a forged huge dz still stops there, and diagonal input slides', async () => {
  test.setTimeout(90_000)
  const [ghostRoom] = await joinInOrder(1)
  const g = new Walker(ghostRoom, 'ghost')
  expect(inRect(g.pos, GRAYBOX_MAP.spawnAreas.ghost)).toBe(true)

  // The south wall west of the south doorway, approached 1.5 units in from
  // its doorway end. The diagonal walk stays south of every solid.
  const wall = solid('wall-s-w')
  const { x } = await g.walkTo({ x: wall.max.x - 1.5, z: BELOW_SOLIDS_Z }, 'both')
  const face = wall.min.z - PLAYER_HALF_SIZE
  expect(stopAlongZ(g.pos, 1, BOUND), 'the first face north of this x is the wall').toBeCloseTo(face, 9)

  // Hold +z: stops with its centre half a box short of the face, x unchanged.
  const stopped = await g.push(0, 1, 200, (at) => expect(Math.abs(at.x - x)).toBeLessThan(EPS))
  expect(Math.abs(stopped.z - face), `stopped at z ${stopped.z}, face at ${face}`).toBeLessThan(EPS)

  // Back off half a step, then a forged huge dz: moves the remaining half
  // step, flush with the face, and never further (no tunnelling).
  const step = g.stepSize
  await g.walkTo({ x, z: face - step / 2 })
  let r = await g.step(0, 1e9)
  expect(r.moved).toBe(true)
  expect(Math.abs(r.at.z - face)).toBeLessThan(EPS)
  r = await g.step(0, 1e9)
  expect(Math.abs(r.at.z - face)).toBeLessThan(EPS)
  const atFace = r.at
  // A forged huge diagonal into the wall clamps to (1, 1). x slides one
  // clamped step: a full step today (no cap), step / sqrt(2) once #20 caps the
  // intent's length at 1. Either way more than 0 and at most one step, and z
  // stays flush with the face.
  /** The x slide of a (dx, +1) move along the wall, uncapped and capped. */
  const slides = (dx: number) => allowedSteps(dx, 1, 0, step).map((d) => ({ x: d.x, z: 0 }))
  const expectSlide = (from: Point, to: Point, dx: number, what: string) => {
    const slid = Math.abs(to.x - from.x)
    expect(slid, `${what} slides more than 0`).toBeGreaterThan(EPS)
    expect(slid, `${what} slides at most one step`).toBeLessThanOrEqual(step + EPS)
    expect(movedByOneOf(from, { x: to.x, z: from.z }, slides(dx)), `${what} slid ${to.x - from.x}`).toBe(true)
    expect(Math.abs(to.z - face), `${what} stays flush with the wall`).toBeLessThan(EPS)
  }
  r = await g.step(1e9, 1e9)
  expectSlide(atFace, r.at, 1, 'a forged huge diagonal')

  // Diagonal (-x, +z) along the wall: x slides one clamped step per move, z stays flush.
  let from = r.at
  for (let i = 0; i < 10; i++) {
    r = await g.step(-1, 1)
    expect(r.moved).toBe(true)
    expectSlide(from, r.at, -1, `diagonal move ${i + 1}`)
    from = r.at
  }

  // Diagonal (+x, +z): slides along the wall until the box clears its end
  // (x resolves before z), then z rises into the doorway.
  const clearOfWall = wall.max.x + PLAYER_HALF_SIZE
  let entered = false
  for (let i = 0; i < 100 && !entered; i++) {
    r = await g.step(1, 1)
    expect(r.moved).toBe(true)
    if (r.at.x < clearOfWall - EPS) {
      expect(Math.abs(r.at.z - face), `flush while the box is under the wall (x ${r.at.x})`).toBeLessThan(EPS)
    }
    entered = r.at.z > face + EPS
    if (entered) expect(r.at.x).toBeGreaterThan(clearOfWall - EPS)
  }
  expect(entered, 'slid off the end of the wall into the doorway').toBe(true)
  expect(g.violations).toEqual([])
})

test('every entrance can be walked through both ways, an inner corner holds, and the outer bound is +-BOUND', async () => {
  test.setTimeout(120_000)
  const rooms = await joinInOrder(4)
  const [g1, w2, g3, w4] = rooms.map((r, i) => new Walker(r, `joiner ${i + 1} (${SPAWN_AREA_BY_JOIN[i]})`))

  /** Distance from an entrance's centre to the waypoints just inside and outside it. */
  const OFF = 1.5
  const through = async (w: Walker, to: Point, order: 'xz' | 'zx', inside: boolean) => {
    const at = await w.walkTo(to, order)
    expect(insideBuilding(at), `${w.name} at ${at.x},${at.z} is ${inside ? 'inside' : 'outside'}`).toBe(inside)
  }

  // The four routes run at the same time (players don't collide with each other).
  await Promise.all([
    // Joiner 1, ghost: in and out of the south door, then -z to the bound.
    (async () => {
      const d = entrance('door-south')
      await g1.walkTo({ x: d.x, z: BELOW_SOLIDS_Z }, 'both')
      await through(g1, { x: d.x, z: d.z + OFF }, 'xz', true)
      await through(g1, { x: d.x, z: d.z - OFF }, 'xz', false)
      const at = await g1.push(0, -1, 200, (p) => expect(Math.abs(p.x - d.x)).toBeLessThan(EPS))
      expect(Math.abs(at.z - -BOUND), `stopped at z ${at.z}`).toBeLessThan(EPS)
    })(),
    // Joiner 2, warden: out and back in through the north door, then into the
    // inner north-east corner, which holds on both axes.
    (async () => {
      const d = entrance('door-north')
      const inZ = d.z - OFF
      await w2.walkTo({ x: w2.pos.x, z: inZ }, 'zx')
      await through(w2, { x: d.x, z: inZ }, 'xz', true)
      await through(w2, { x: d.x, z: d.z + OFF }, 'zx', false)
      await through(w2, { x: d.x, z: inZ }, 'zx', true)
      const east = solid('wall-e-n')
      const north = solid('wall-n-e')
      await w2.walkTo({ x: north.min.x + 1, z: inZ }, 'xz')
      const corner = { x: east.min.x - PLAYER_HALF_SIZE, z: north.min.z - PLAYER_HALF_SIZE }
      const at = await w2.push(1, 1, 100)
      expect(Math.abs(at.x - corner.x), `corner x ${at.x}, expected ${corner.x}`).toBeLessThan(EPS)
      expect(Math.abs(at.z - corner.z), `corner z ${at.z}, expected ${corner.z}`).toBeLessThan(EPS)
    })(),
    // Joiner 3, ghost: round the building's west side, in and out of the west door.
    (async () => {
      const d = entrance('door-west')
      await g3.walkTo({ x: d.x - OFF, z: BELOW_SOLIDS_Z }, 'both')
      await through(g3, { x: d.x - OFF, z: d.z }, 'zx', false)
      await through(g3, { x: d.x + OFF, z: d.z }, 'xz', true)
      await through(g3, { x: d.x - OFF, z: d.z }, 'xz', false)
    })(),
    // Joiner 4, warden: north of the pillar, east of it, then out, in and out
    // of the east door, and +x to the bound.
    (async () => {
      const d = entrance('door-east')
      const pillar = solid('pillar-ne')
      const aboveZ = entrance('door-north').z - OFF
      await w4.walkTo({ x: w4.pos.x, z: aboveZ }, 'zx')
      await w4.walkTo({ x: pillar.max.x + 2.5, z: aboveZ }, 'xz')
      await through(w4, { x: d.x - OFF, z: d.z }, 'zx', true)
      await through(w4, { x: d.x + OFF, z: d.z }, 'xz', false)
      await through(w4, { x: d.x - OFF, z: d.z }, 'xz', true)
      await through(w4, { x: d.x + OFF, z: d.z }, 'xz', false)
      // The doorway's centre line is exactly level with the south face of the
      // east yard cover (a box at d.z just touches it), and walks only land
      // within ARRIVE, so step half a unit south before running east.
      const yard = solid('cover-yard-e')
      const runZ = yard.min.z - PLAYER_HALF_SIZE - 0.5
      await w4.walkTo({ x: d.x + OFF, z: runZ }, 'zx')
      const at = await w4.push(1, 0, 200, (p) => expect(Math.abs(p.z - runZ)).toBeLessThan(EPS))
      expect(Math.abs(at.x - BOUND), `stopped at x ${at.x}`).toBeLessThan(EPS)
    })(),
  ])
  for (const w of [g1, w2, g3, w4]) expect(w.violations, `${w.name} saw no overlap`).toEqual([])
})

test('a flood of back-to-back moves is rate limited to the MOVE_BURST budget', async () => {
  const [ghostRoom] = await joinInOrder(1)
  const g = new Walker(ghostRoom, 'ghost')
  const p0 = g.pos
  expectFacingPlusZ(g.state, 'ghost')
  const step = g.stepSize
  // Open space: the ghost area and a few steps east of it are clear.
  for (let i = 0; i < 20; i++) ghostRoom.send(MOVE_MESSAGE, { dx: 1, dz: 0 })
  // Messages are handled in order: once a z-only sentinel lands, the whole
  // flood has been handled. Resend it at the paced rate until one gets through.
  let r = await g.step(0, -1)
  for (let i = 0; i < 20 && Math.abs(r.at.z - p0.z) < EPS; i++) r = await g.step(0, -1)
  expect(Math.abs(r.at.z - p0.z), 'a sentinel move landed').toBeGreaterThan(EPS)
  const moved = r.at.x - p0.x
  expect(moved, `flood moved ${moved}`).toBeGreaterThanOrEqual(MOVE_BURST * step - EPS)
  // At most one extra token can refill while the flood is in flight.
  expect(moved, `flood moved ${moved}`).toBeLessThanOrEqual((MOVE_BURST + 1) * step + EPS)
  expect(g.violations).toEqual([])
})
