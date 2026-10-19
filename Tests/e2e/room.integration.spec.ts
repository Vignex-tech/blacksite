import { expect, test } from '@playwright/test'
import { MOVE_MESSAGE } from '../../shared/protocol.js'
// Built server constants (server/build exists: Playwright's webServer runs it).
import { BOUND, MOVE_BURST } from '../../server/build/rooms/MyRoom.js'
// Per-team step and #18's world-step formula (support/intent.ts), written
// independently of server code.
import { worldStep, type Vec } from './support/movement.js'
// Map data and player size come from shared/map.js (via support/geometry.ts).
import {
  GRAYBOX_MAP,
  PLAYER_HALF_SIZE,
  entrance,
  inRect,
  insideBuilding,
  groundProblems,
  overlapping,
  solid,
  stopAlongZ,
  type Point,
} from './support/geometry.js'
import {
  EPS,
  Walker,
  expectFacingPlusZ,
  godView,
  joinInOrder,
  leaveQuietly,
  pos,
  seenPos,
  sizeIs,
  waitForState,
  whenGone,
  type GameRoom,
} from './support/sdk.js'

// Two real @colyseus/sdk clients (Node, no browser) against the production
// server that Playwright's webServer starts. This project runs before the
// browser project (see playwright.config.ts), so no browser page can
// joinOrCreate into these rooms and change the player counts.
// Teams, per-team speed and yaw are covered in teams.integration.spec.ts.
//
// Since #45 these specs hold with the M5 visibility filter (#46): a Warden
// client is sent a Ghost only when it is near or in line of sight, so a Ghost
// is never read from the Warden client. Other players are read from a Ghost
// client (support/sdk.ts godView), which is sent everyone, or from the player's
// own client.

/** True if `to - from` equals `d` on both axes (within EPS). */
function movedBy(from: Vec, to: Vec, d: Vec): boolean {
  return Math.abs(to.x - from.x - d.x) < EPS && Math.abs(to.z - from.z - d.z) < EPS
}

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => (r.connection.isOpen ? r.leave().catch(() => {}) : undefined)))
})

/** A (ghost) creates a fresh room, B (warden) joins it by id. Each sees what it must (A sees both). */
async function joinPair() {
  const [a, b] = await joinInOrder(2, open)
  return { a, b }
}

/** A (ghost), B (warden) and C (a second ghost, the observer: it is sent every player, so it can watch A). */
async function joinTrio() {
  const [a, b, c] = await joinInOrder(3, open)
  return { a, b, c }
}

test('two clients join the same room, the Ghost sees 2 players keyed by sessionId, spawned inside the bounds', async () => {
  const { a, b } = await joinPair()
  expect(a.roomId).toBe(b.roomId)
  expect(a.sessionId).not.toBe(b.sessionId)

  // Balanced teams, ties to ghost: the 1st joiner (A, the creator) is a ghost
  // in the ghost area, the 2nd (B) a warden in the warden area, clear of
  // every solid, both facing +z (yaw 0).
  const expected: [string, keyof typeof GRAYBOX_MAP.spawnAreas][] = [
    [a.sessionId, 'ghost'],
    [b.sessionId, 'warden'],
  ]
  expect(a.state.players.size, 'the Ghost client is sent both players').toBe(2)
  expect(b.state.players.has(b.sessionId), 'the Warden client is sent itself').toBe(true)
  for (const room of [a, b]) {
    for (const [id, area] of expected) {
      // A Warden client may not be sent the Ghost (the filter); everything it is sent is checked.
      const p = seenPos(room, id, area)
      if (!p) continue
      expect(inRect(p, GRAYBOX_MAP.spawnAreas[area]), `${id} at ${p.x},${p.z} is in the ${area} area`).toBe(true)
      expect(p.team, `${id}'s team`).toBe(area)
      expectFacingPlusZ(p, id)
      expect(overlapping(p).map((s) => s.id), `${id} overlaps no solid`).toEqual([])
      expect(groundProblems(p), `${id} spawned on the ground`).toEqual([])
      expect(Math.abs(p.x)).toBeLessThanOrEqual(BOUND + EPS)
      expect(Math.abs(p.z)).toBeLessThanOrEqual(BOUND + EPS)
    }
  }
  // Both clients agree on every player both of them are sent (always the Warden; the Ghost only if the Warden sees it).
  for (const [id, area] of expected) {
    const pa = seenPos(a, id, area)!
    const pb = seenPos(b, id, area)
    if (!pb) continue
    expect(pa.x).toBeCloseTo(pb.x, 4)
    expect(pa.z).toBeCloseTo(pb.z, 4)
    expect(pa.team).toBe(pb.team)
  }
})

test("A's move { dx: 1, dz: 0 } moves A one step to its right as seen by another client, and not B", async () => {
  // C is a second Ghost: it is sent every player, so it can watch A (B, a Warden, may not be sent A).
  const { a, b, c } = await joinTrio()
  const a0 = pos(c, a.sessionId)
  const b0 = pos(c, b.sessionId)
  expectFacingPlusZ(a0, 'A')
  // One ghost step along A's right (+x at yaw 0).
  const d = worldStep(1, 0, a0.yaw, new Walker(a, 'A').stepSize)

  a.send(MOVE_MESSAGE, { dx: 1, dz: 0 })
  await waitForState(c, 'C sees A move', () => {
    const p = pos(c, a.sessionId)
    return Math.abs(p.x - a0.x) > EPS || Math.abs(p.z - a0.z) > EPS
  })

  const a1 = pos(c, a.sessionId)
  expect(Math.abs(a1.x - (a0.x + d.x)), `x ${a1.x}, expected ${a0.x + d.x}`).toBeLessThan(EPS)
  expect(Math.abs(a1.z - (a0.z + d.z)), `z ${a1.z}, expected ${a0.z + d.z}`).toBeLessThan(EPS)
  // B did not move, in its own view and in C's.
  for (const b1 of [pos(c, b.sessionId), pos(b, b.sessionId)]) {
    expect(Math.abs(b1.x - b0.x)).toBeLessThan(EPS)
    expect(Math.abs(b1.z - b0.z)).toBeLessThan(EPS)
  }
})

test('malformed and out-of-range moves do not move A or disconnect it', async () => {
  const { a, c } = await joinTrio() // C (a Ghost) sees A; a Warden might not
  let aLeft: number | undefined
  a.onLeave((code) => (aLeft = code))
  const a0 = pos(c, a.sessionId)
  const step = new Walker(a, 'A').stepSize
  // The sentinel is a forward move; with yaw 0 that is +z only.
  expectFacingPlusZ(a0, 'A')

  for (const payload of [{ dx: 'x' }, { dx: 'x', dz: 1 }, { dx: 1, dz: null }, {}, 'move', 42, [1, 1], null]) {
    a.send(MOVE_MESSAGE, payload as never)
  }
  // Messages from one client are handled in order. This sentinel moves only z,
  // so once B sees it, every malformed message above has been handled too.
  // x must be unchanged and z must have moved by exactly one step.
  a.send(MOVE_MESSAGE, { dx: 0, dz: 1 })
  await waitForState(c, "C sees A's sentinel z move", () => Math.abs(pos(c, a.sessionId).z - a0.z) > EPS)

  let a1 = pos(c, a.sessionId)
  expect(movedBy(a0, a1, worldStep(0, 1, 0, step)), `moved ${a1.x - a0.x},${a1.z - a0.z}`).toBe(true)

  // Out-of-range input is clamped to -1..1: at most one step per message.
  const a2 = a1
  a.send(MOVE_MESSAGE, { dx: -1000, dz: 0 })
  await waitForState(c, "C sees A's clamped x move", () => Math.abs(pos(c, a.sessionId).x - a2.x) > EPS)
  a1 = pos(c, a.sessionId)
  expect(movedBy(a2, a1, worldStep(-1, 0, 0, step)), `moved ${a1.x - a2.x},${a1.z - a2.z}`).toBe(true)
  expect(Math.abs(a1.x)).toBeLessThanOrEqual(BOUND)

  expect(a.connection.isOpen).toBe(true)
  expect(aLeft).toBeUndefined()
})

test("closing A removes it from B's and C's players, and C holds exactly B and itself", async () => {
  const { a, b, c } = await joinTrio()
  const aId = a.sessionId
  expect(godView([a, b, c]).state.players.has(b.sessionId)).toBe(true)

  await a.leave()
  // C (a Ghost) held all 3 and now holds B and itself; B (a Warden) holds itself and, if
  // the filter sends it, C (the Ghost A may or may not have been sent to it).
  await whenGone(b, aId)
  await whenGone(c, aId)
  await waitForState(c, 'C sees 2 players', sizeIs(2))
  for (const r of [b, c]) expect(r.state.players.get(aId)).toBeUndefined()
  expect(b.state.players.get(b.sessionId)).toBeDefined()
  expect(c.state.players.get(b.sessionId)).toBeDefined()
})

// ---------------------------------------------------------------------------
// Map collision and spawns (#13, verified in #15), through real SDK clients.
// Walker (support/sdk.ts) paces moves under the rate limit and checks every
// state change for overlap. Routes go one axis at a time (or diagonally only
// inside a rectangle known to be clear), with waypoints from GRAYBOX_MAP.
// ---------------------------------------------------------------------------

/** Balanced teams, ties to ghost: in a fresh room joiners 1 and 3 are ghosts and 2 and 4 wardens. */
const SPAWN_AREA_BY_JOIN = ['ghost', 'warden', 'ghost', 'warden'] as const

/** z just below the lowest solid, with half a unit to spare: everything south of it is open. */
const BELOW_SOLIDS_Z = Math.min(...GRAYBOX_MAP.solids.map((s) => s.min.z)) - PLAYER_HALF_SIZE - 0.5

test('balanced teams, ties to ghost: joiners 1 and 3 spawn in the ghost area, 2 and 4 in the warden area, clear of solids (5 fresh rooms)', async () => {
  test.setTimeout(60_000)
  for (let round = 0; round < 5; round++) {
    const rooms = await joinInOrder(4, open)
    for (const viewer of rooms) {
      rooms.forEach((joiner, i) => {
        const area = SPAWN_AREA_BY_JOIN[i]
        // A Warden client may not be sent a Ghost (the filter); a Ghost client is sent all four.
        const p = seenPos(viewer, joiner.sessionId, area)
        if (!p) return
        expect(inRect(p, GRAYBOX_MAP.spawnAreas[area]), `joiner ${i + 1} at ${p.x},${p.z} is in the ${area} area`).toBe(
          true,
        )
        expect(overlapping(p).map((s) => s.id), `joiner ${i + 1} overlaps no solid`).toEqual([])
        expect(groundProblems(p), `joiner ${i + 1} spawned on the ground`).toEqual([])
        expect(p.team, `joiner ${i + 1}'s team`).toBe(area)
        expectFacingPlusZ(p, `joiner ${i + 1}`)
      })
    }
    await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))
  }
})

test('walking into a wall stops flush with its face, a forged huge dz still stops there, and diagonal input slides', async () => {
  test.setTimeout(90_000)
  const [ghostRoom] = await joinInOrder(1, open)
  const g = new Walker(ghostRoom, 'ghost')
  expect(inRect(g.pos, GRAYBOX_MAP.spawnAreas.ghost)).toBe(true)

  // The south wall west of the south doorway, approached 1.5 units in from
  // its doorway end. The diagonal walk stays south of every solid.
  const wall = solid('wall-s-w')
  const { x } = await g.walkTo({ x: wall.max.x - 1.5, z: BELOW_SOLIDS_Z }, 'both')
  const face = wall.min.z - PLAYER_HALF_SIZE
  // stopAlongZ also fails if the path north meets a ramp, a pocket or a climb spot.
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
  // A forged huge diagonal into the wall clamps to (1, 1), then the intent's
  // length is capped at 1: x slides exactly step / sqrt(2), z stays flush.
  const expectSlide = (from: Point, to: Point, dx: number, what: string) => {
    const slide = worldStep(dx, 1, 0, step).x
    expect(Math.abs(to.x - from.x - slide), `${what} slid ${to.x - from.x}, expected ${slide}`).toBeLessThan(EPS)
    expect(Math.abs(to.z - face), `${what} stays flush with the wall`).toBeLessThan(EPS)
  }
  r = await g.step(1e9, 1e9)
  expectSlide(atFace, r.at, 1, 'a forged huge diagonal')

  // Diagonal (-x, +z) along the wall: x slides one capped step per move, z stays flush.
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
  const rooms = await joinInOrder(4, open)
  const [g1, w2, g3, w4] = rooms.map((r, i) => new Walker(r, `joiner ${i + 1} (${SPAWN_AREA_BY_JOIN[i]})`))

  /** Distance from an entrance's centre to the waypoints just inside and outside it. */
  const OFF = 1.5
  const through = async (w: Walker, to: Point, order: 'xz' | 'zx', inside: boolean) => {
    const at = await w.walkTo(to, order)
    expect(insideBuilding(at), `${w.name} at ${at.x},${at.z} is ${inside ? 'inside' : 'outside'}`).toBe(inside)
  }

  // The four routes run at the same time (players don't collide with each other).
  // Single-axis pushes check the other axis against where the push started,
  // not the waypoint, so walk residue can never fail them.
  await Promise.all([
    // Joiner 1, ghost: in and out of the south door, then -z to the bound.
    (async () => {
      const d = entrance('door-south')
      await g1.walkTo({ x: d.x, z: BELOW_SOLIDS_Z }, 'both')
      await through(g1, { x: d.x, z: d.z + OFF }, 'xz', true)
      await through(g1, { x: d.x, z: d.z - OFF }, 'xz', false)
      const startX = g1.pos.x
      expect(Math.abs(startX - d.x), `lined up with the door at x ${startX}`).toBeLessThan(EPS)
      const at = await g1.push(0, -1, 200, (p) => expect(Math.abs(p.x - startX)).toBeLessThan(EPS))
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
    // Joiner 3, ghost: round the building's west side, in and out of the west
    // door. The doorway opens under the mezzanine, next to the covered pocket
    // and the foot of the stairs (#27), so the ghost goes through half a unit
    // south of the doorway's centre line (still well inside the 3-wide gap)
    // to keep ROUTE_MARGIN from them; walkTo checks every leg.
    (async () => {
      const d = entrance('door-west')
      const z = d.z - 0.5
      await g3.walkTo({ x: d.x - OFF, z: BELOW_SOLIDS_Z }, 'both')
      await through(g3, { x: d.x - OFF, z }, 'zx', false)
      await through(g3, { x: d.x + OFF, z }, 'xz', true)
      await through(g3, { x: d.x - OFF, z }, 'xz', false)
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
      // east yard cover (a box at d.z just touches it), so step half a unit
      // south before running east.
      const yard = solid('cover-yard-e')
      const runZ = yard.min.z - PLAYER_HALF_SIZE - 0.5
      await w4.walkTo({ x: d.x + OFF, z: runZ }, 'zx')
      const startZ = w4.pos.z
      expect(Math.abs(startZ - runZ), `lined up south of the yard cover at z ${startZ}`).toBeLessThan(EPS)
      const at = await w4.push(1, 0, 200, (p) => expect(Math.abs(p.z - startZ)).toBeLessThan(EPS))
      expect(Math.abs(at.x - BOUND), `stopped at x ${at.x}`).toBeLessThan(EPS)
    })(),
  ])
  for (const w of [g1, w2, g3, w4]) expect(w.violations, `${w.name} saw no overlap`).toEqual([])
})

test('a flood of back-to-back moves is rate limited to the MOVE_BURST budget', async () => {
  const [ghostRoom] = await joinInOrder(1, open)
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
