import { expect, test } from '@playwright/test'
import { Client } from '@colyseus/sdk'
import { MAX_TEAM_SIZE, MOVE_MESSAGE, ROOM_NAME, TEAMS, TEAM_SPEED, type Team } from '../../shared/protocol.js'
// Built server constants (server/build exists: Playwright's webServer runs it).
import { MAX_CLIENTS, MOVE_BURST, MOVE_RATE_HZ, TEAM_STEP } from '../../server/build/rooms/MyRoom.js'
import { teamStep, worldStep, type Vec } from './support/movement.js'
import { GRAYBOX_MAP, groundProblems, inRect, overlapping, solid, PLAYER_HALF_SIZE, type Point } from './support/geometry.js'
import {
  EPS,
  Walker,
  endpoint,
  expectFacingPlusZ,
  godView,
  joinInOrder,
  joinRoom,
  leaveRoom,
  pos,
  seenPos,
  teamCounts,
  teamCountsOf,
  teamOf,
  waitForState,
  type GameRoom,
} from './support/sdk.js'

// Milestone 3 server rules (#20, verified in #21) through real @colyseus/sdk
// clients: balanced teams that clients can't choose, team spawns, per-team
// speed, camera-relative moves with a validated and wrapped yaw, and the rate
// limit on rotated and turn-only moves. Expected values come from
// shared/protocol.js and #18's formula (support/intent.ts), not server code.
//
// Since #45 these specs hold with the M5 visibility filter (#46): a Warden
// client is not sent a Ghost it can't see, so team counts and Ghost positions
// are read from a Ghost client (godView, sent everyone), from each client's
// view of itself (teamCountsOf), or from an extra Ghost observer.

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => (r.connection.isOpen ? r.leave().catch(() => {}) : undefined)))
})

/** The team a new joiner must get: fewer players, ties to the first in TEAMS (ghost). */
function expectedTeam(counts: Record<Team, number>): Team {
  let best: Team = TEAMS[0]
  for (const t of TEAMS) if (counts[t] < counts[best]) best = t
  return best
}

/**
 * Checks one freshly spawned player as every client in `viewers` sees it. A
 * Warden client may not be sent a Ghost (the filter): it is checked only if it
 * is; a client that must see the player (mustSee) fails if it doesn't.
 */
function expectFreshSpawn(viewers: GameRoom[], id: string, team: Team, who: string) {
  for (const v of viewers) {
    const p = seenPos(v, id, team)
    if (!p) continue
    expect(p.team, `${who}'s team as ${v.sessionId} sees it`).toBe(team)
    expectFacingPlusZ(p, who)
    expect(inRect(p, GRAYBOX_MAP.spawnAreas[team]), `${who} at ${p.x},${p.z} is in the ${team} area`).toBe(true)
    expect(overlapping(p).map((s) => s.id), `${who} overlaps no solid`).toEqual([])
    expect(groundProblems(p), `${who} spawned on the ground`).toEqual([])
  }
}

const countsText = (c: Record<Team, number>) => TEAMS.map((t) => `${t} ${c[t]}`).join(', ')

/** A ghost's open yard south of the building: this point and 4 units around it are clear. */
const GHOST_YARD: Point = { x: 7, z: -14 }

/** Length of a displacement on (x, z). */
const len = (v: Vec) => Math.hypot(v.x, v.z)
const delta = (from: Vec, to: Vec): Vec => ({ x: to.x - from.x, z: to.z - from.z })
/** Smallest difference between two angles (radians), so pi and -pi are 0 apart. */
const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

test('the server exports the contract: TEAM_STEP is TEAM_SPEED / MOVE_RATE_HZ and MAX_CLIENTS is two full teams', () => {
  for (const t of TEAMS) expect(TEAM_STEP[t], `TEAM_STEP.${t}`).toBeCloseTo(TEAM_SPEED[t] / MOVE_RATE_HZ, 12)
  expect(MAX_CLIENTS).toBe(TEAMS.length * MAX_TEAM_SIZE)
})

test('balance: 2 joiners make 1v1, 4 make 2v2, 8 make 4v4, counts never differ by more than 1, and a 9th join is refused', async () => {
  test.setTimeout(60_000)
  const first = (await new Client(endpoint).create(ROOM_NAME)) as GameRoom
  open.push(first)
  await waitForState(first, 'joiner 1 sees itself', (s) => s.players?.size === 1)
  const rooms: GameRoom[] = [first]
  expectFreshSpawn(rooms, first.sessionId, 'ghost', 'joiner 1')

  for (let i = 1; i < MAX_CLIENTS; i++) {
    const want = expectedTeam(teamCounts(first)) // first is a Ghost: it is sent everyone
    const r = await joinRoom(first.roomId, rooms, open)
    expectFreshSpawn(rooms, r.sessionId, want, `joiner ${i + 1}`)
    // Every Ghost client sees all the players; a Warden client only some, so the
    // counts from each client's view of itself must balance too.
    for (const v of rooms.filter((x) => teamOf(x) === 'ghost')) {
      const c = teamCounts(v)
      expect(Math.abs(c.ghost - c.warden), `after ${i + 1} joins ${v.sessionId} sees ${countsText(c)}`).toBeLessThanOrEqual(1)
    }
    const own = teamCountsOf(rooms)
    expect(Math.abs(own.ghost - own.warden), `after ${i + 1} joins the clients are ${countsText(own)}`).toBeLessThanOrEqual(1)
    const n = i + 1
    if (n === 2 || n === 4 || n === 8) {
      expect(teamCounts(first), `${n} joiners`).toEqual({ ghost: n / 2, warden: n / 2 })
      expect(own, `${n} joiners, by each client's own team`).toEqual({ ghost: n / 2, warden: n / 2 })
    }
  }

  // The room is full (MAX_CLIENTS): a 9th join is refused, and nobody is dropped.
  await expect(new Client(endpoint).joinById(first.roomId), 'a 9th join is refused').rejects.toThrow()
  for (const v of rooms) {
    expect(v.connection.isOpen).toBe(true)
    // A Ghost client holds all 8; a Warden client holds its 4 Wardens plus the Ghosts it can see.
    if (teamOf(v) === 'ghost') expect(v.state.players.size).toBe(MAX_CLIENTS)
    else expect(v.state.players.size).toBeGreaterThanOrEqual(MAX_TEAM_SIZE)
  }
  expect(teamCounts(first)).toEqual({ ghost: MAX_TEAM_SIZE, warden: MAX_TEAM_SIZE })
  expect(teamCountsOf(rooms)).toEqual({ ghost: MAX_TEAM_SIZE, warden: MAX_TEAM_SIZE })

  // A warden leaves: the seat opens again and the next joiner fills it as a warden.
  const warden = rooms.find((r) => pos(first, r.sessionId).team === 'warden' && r !== first)!
  await leaveRoom(warden, rooms)
  const back = await joinRoom(first.roomId, rooms, open)
  expectFreshSpawn(rooms, back.sessionId, 'warden', 'the joiner after a warden left')
  expect(teamCounts(first)).toEqual({ ghost: MAX_TEAM_SIZE, warden: MAX_TEAM_SIZE })
  expect(teamCountsOf(rooms)).toEqual({ ghost: MAX_TEAM_SIZE, warden: MAX_TEAM_SIZE })
})

test('leave and rejoin: the joiner fills the team that is short, never by join order (10 cycles)', async () => {
  test.setTimeout(90_000)
  // Ghost A and warden B join; A leaves; C joins as a ghost.
  const rooms = await joinInOrder(2, open)
  const [a, b] = rooms
  expect(pos(a, a.sessionId).team).toBe('ghost')
  expect(pos(a, b.sessionId).team).toBe('warden')
  await leaveRoom(a, rooms)
  const c = await joinRoom(b.roomId, rooms, open)
  expectFreshSpawn(rooms, c.sessionId, 'ghost', 'C (after ghost A left)')
  // The old join counter's failure: B (warden) leaves, D must be a warden
  // (the 4th join by order would have been ghost, ghost, warden... alternating).
  await leaveRoom(b, rooms)
  const d = await joinRoom(c.roomId, rooms, open)
  expectFreshSpawn(rooms, d.sessionId, 'warden', 'D (after warden B left)')

  // Fill to 2v2, then cycles that remove one or two players (picked by a
  // fixed pattern, so both teams and both ghosts at once get removed) and
  // refill. Every joiner must land on the short team, and the room is back
  // to 2v2 after each cycle.
  await joinRoom(c.roomId, rooms, open)
  await joinRoom(c.roomId, rooms, open)
  expect(teamCounts(godView(rooms))).toEqual({ ghost: 2, warden: 2 })
  expect(teamCountsOf(rooms)).toEqual({ ghost: 2, warden: 2 })
  const leavePatterns: Team[][] = [
    ['ghost'],
    ['warden'],
    ['ghost', 'ghost'],
    ['warden', 'warden'],
    ['ghost', 'warden'],
    ['warden', 'ghost'],
    ['ghost'],
    ['ghost', 'ghost'],
    ['warden'],
    ['warden', 'warden'],
  ]
  for (const [cycle, pattern] of leavePatterns.entries()) {
    for (const team of pattern) {
      const leaver = [...rooms].reverse().find((r) => teamOf(r) === team)
      if (!leaver) throw new Error(`cycle ${cycle + 1}: no ${team} left to remove`)
      await leaveRoom(leaver, rooms)
    }
    while (rooms.length < 4) {
      const want = expectedTeam(teamCountsOf(rooms))
      const r = await joinRoom(rooms[0].roomId, rooms, open)
      expectFreshSpawn(rooms, r.sessionId, want, `cycle ${cycle + 1} joiner`)
    }
    // Every Ghost client sees all four; every client knows its own team, so the clients are 2v2.
    for (const v of rooms.filter((x) => teamOf(x) === 'ghost')) expect(teamCounts(v), `after cycle ${cycle + 1}`).toEqual({ ghost: 2, warden: 2 })
    expect(teamCountsOf(rooms), `after cycle ${cycle + 1}, by each client's own team`).toEqual({ ghost: 2, warden: 2 })
  }
})

test('join options cannot choose a team, a position or a yaw', async () => {
  const forged = [
    { team: 'warden' },
    { team: 'ghost', x: 0, z: 0, yaw: 2 },
    { team: 'warden', role: 'admin' },
    { team: ['warden'] },
  ]
  const rooms = await joinInOrder(forged.length, open, (i) => forged[i])
  const want: Team[] = ['ghost', 'warden', 'ghost', 'warden']
  rooms.forEach((r, i) => expectFreshSpawn(rooms, r.sessionId, want[i], `joiner ${i + 1} with ${JSON.stringify(forged[i])}`))
})

test('per-team step: a ghost and a warden each move TEAM_SPEED[team] / MOVE_RATE_HZ on { dx: 0, dz: 1 }', async () => {
  const [g, w] = await joinInOrder(2, open)
  const steps: Partial<Record<Team, number>> = {}
  // Both spawn areas have more than one step of open space north of them.
  // Each mover is watched by a client that is always sent it: the Ghost by
  // itself (a Warden might not be sent it), the Warden by the Ghost.
  for (const [mover, viewer] of [
    [g, g],
    [w, g],
  ] as const) {
    const p0 = pos(viewer, mover.sessionId)
    expectFacingPlusZ(p0, p0.team)
    mover.send(MOVE_MESSAGE, { dx: 0, dz: 1 })
    await waitForState(viewer, `the other client sees the ${p0.team} move`, () => pos(viewer, mover.sessionId).z !== p0.z)
    const p1 = pos(viewer, mover.sessionId)
    const want = TEAM_SPEED[p0.team] / MOVE_RATE_HZ
    expect(Math.abs(p1.z - p0.z - want), `${p0.team} moved ${p1.z - p0.z}, expected ${want}`).toBeLessThan(EPS)
    expect(Math.abs(p1.x - p0.x), `${p0.team} x unchanged`).toBeLessThan(EPS)
    steps[p0.team] = p1.z - p0.z
  }
  expect(Math.abs(steps.ghost! - steps.warden!), 'the ghost step differs from the warden step').toBeGreaterThan(10 * EPS)
})

test('camera-relative moves follow #18 formula, yaw wraps into -pi..pi, and a yaw-only move turns without moving', async () => {
  test.setTimeout(60_000)
  // A second Ghost watches: a Ghost is sent every player, a Warden might not be sent the first Ghost.
  const [gRoom, , obs] = await joinInOrder(3, open)
  const g = new Walker(gRoom, 'ghost')
  await g.walkTo(GHOST_YARD, 'both')
  const step = g.stepSize
  const seenByObserver = () => pos(obs, gRoom.sessionId)

  const cases: { msg: { dx: number; dz: number; yaw: number }; what: string; want: Vec }[] = [
    { msg: { dx: 0, dz: 1, yaw: Math.PI / 2 }, what: 'yaw pi/2, forward is +x', want: { x: step, z: 0 } },
    { msg: { dx: 1, dz: 0, yaw: -Math.PI / 2 }, what: 'yaw -pi/2, right is +z', want: { x: 0, z: step } },
    {
      msg: { dx: 0, dz: 1, yaw: Math.PI / 4 },
      what: 'yaw pi/4, forward is the +x+z diagonal',
      want: { x: step / Math.SQRT2, z: step / Math.SQRT2 },
    },
    { msg: { dx: -1, dz: 0, yaw: Math.PI }, what: 'yaw pi, left is +x', want: { x: step, z: 0 } },
    { msg: { dx: 0, dz: -1, yaw: -Math.PI / 4 }, what: 'yaw -pi/4, back is the +x-z diagonal', want: { x: step / Math.SQRT2, z: -step / Math.SQRT2 } },
  ]
  for (const c of cases) {
    // Hand-written expectation agrees with #18's formula (support/intent.ts).
    const f = worldStep(c.msg.dx, c.msg.dz, c.msg.yaw, step)
    expect(Math.abs(f.x - c.want.x) + Math.abs(f.z - c.want.z), `${c.what}: formula`).toBeLessThan(1e-9)
    const before = g.state
    const r = await g.send(c.msg)
    expect(r.moved, `${c.what}: moved`).toBe(true)
    const d = delta(before, r.at)
    expect(Math.abs(d.x - c.want.x), `${c.what}: dx ${d.x}, expected ${c.want.x}`).toBeLessThan(EPS)
    expect(Math.abs(d.z - c.want.z), `${c.what}: dz ${d.z}, expected ${c.want.z}`).toBeLessThan(EPS)
    expect(angleDiff(r.at.yaw, c.msg.yaw), `${c.what}: yaw ${r.at.yaw} stored`).toBeLessThan(EPS)
    // The observer sees the same position and yaw.
    await waitForState(obs, `observer sees the ghost after "${c.what}"`, () => {
      const p = seenByObserver()
      return Math.abs(p.x - r.at.x) < EPS && Math.abs(p.z - r.at.z) < EPS && Math.abs(p.yaw - r.at.yaw) < EPS
    })
  }

  // A yaw-only move turns without moving, and the other client sees the new yaw.
  const p0 = g.state
  const turn = await g.send({ dx: 0, dz: 0, yaw: 1.234 })
  expect(turn.changed, 'the yaw-only move changed state').toBe(true)
  expect(turn.moved, 'the yaw-only move did not move').toBe(false)
  expect(Math.abs(turn.at.yaw - 1.234)).toBeLessThan(EPS)
  expect(Math.abs(turn.at.x - p0.x) + Math.abs(turn.at.z - p0.z)).toBeLessThan(EPS)
  await waitForState(obs, 'observer sees the ghost turn to 1.234', () => Math.abs(seenByObserver().yaw - 1.234) < EPS)
  expect(Math.abs(seenByObserver().x - p0.x) + Math.abs(seenByObserver().z - p0.z)).toBeLessThan(EPS)

  // Out-of-range yaws are stored wrapped into -pi..pi. Each turn starts from
  // yaw 0, so its change is always visible.
  const wraps: [number, (y: number) => boolean, string][] = [
    [3 * Math.PI, (y) => Math.abs(Math.abs(y) - Math.PI) < EPS, 'about +-pi'],
    [-3 * Math.PI, (y) => Math.abs(Math.abs(y) - Math.PI) < EPS, 'about +-pi'],
    [2 * Math.PI + 0.5, (y) => Math.abs(y - 0.5) < EPS, '0.5'],
    [5 * Math.PI / 2, (y) => Math.abs(y - Math.PI / 2) < EPS, 'pi/2'],
    [-7 * Math.PI / 2, (y) => Math.abs(y - Math.PI / 2) < EPS, 'pi/2'],
    [-(2 * Math.PI) * 1000 - 1, (y) => Math.abs(y - -1) < 1e-3, '-1'],
    [1e300, (y) => Math.abs(y) <= Math.PI + EPS, 'within -pi..pi'],
  ]
  for (const [yaw, ok, text] of wraps) {
    await g.face(0)
    const start = g.state
    const r = await g.send({ dx: 0, dz: 0, yaw })
    expect(ok(r.at.yaw), `yaw ${yaw} is stored as ${r.at.yaw}, expected ${text}`).toBe(true)
    expect(Math.abs(r.at.x - start.x) + Math.abs(r.at.z - start.z), `turning to ${yaw} did not move`).toBeLessThan(EPS)
    await waitForState(obs, `observer sees yaw ${yaw} wrapped`, () => Math.abs(seenByObserver().yaw - r.at.yaw) < EPS)
  }
  expect(g.violations).toEqual([])
})

test('forged yaws (non-number, non-finite) are ignored whole and spend no budget; huge input with any yaw moves at most one step', async () => {
  test.setTimeout(60_000)
  // A second Ghost watches: a Ghost is sent every player, a Warden might not be sent the first Ghost.
  const [gRoom, , obs] = await joinInOrder(3, open)
  let left: number | undefined
  gRoom.onLeave((code) => (left = code))
  const g = new Walker(gRoom, 'ghost')
  await g.walkTo(GHOST_YARD, 'both')
  // Let the budget refill to MOVE_BURST (one token per 1000 / MOVE_RATE_HZ ms).
  await new Promise((r) => setTimeout(r, ((MOVE_BURST + 1) * 1000) / MOVE_RATE_HZ))
  const step = g.stepSize
  const p0 = g.state
  expectFacingPlusZ(p0, 'ghost')

  // Each would move forward (+z at yaw 0) and turn if it were accepted.
  const badYaws: unknown[] = ['1', 'pi', '', {}, { v: 1 }, [], [1], null, true, false, NaN, Infinity, -Infinity]
  for (const yaw of badYaws) gRoom.send(MOVE_MESSAGE, { dx: 0, dz: 1, yaw } as never)
  // Sentinel, sent straight after: a +x move with no yaw. Messages are handled
  // in order, and if the ignored ones had spent tokens the budget would be
  // empty and the sentinel dropped, so it must land on the first try.
  const r = await g.send({ dx: 1, dz: 0 })
  expect(r.moved, 'the sentinel landed on the first try (ignored messages spend no token)').toBe(true)
  const d = delta(p0, r.at)
  expect(Math.abs(d.x - step), `x moved ${d.x}, expected one step at yaw 0`).toBeLessThan(EPS)
  expect(Math.abs(d.z), `z moved ${d.z}: a forged-yaw move was applied`).toBeLessThan(EPS)
  expect(Math.abs(r.at.yaw), `yaw ${r.at.yaw} unchanged`).toBeLessThan(EPS)
  await waitForState(obs, 'observer sees the sentinel', () => Math.abs(pos(obs, gRoom.sessionId).x - r.at.x) < EPS)
  expect(Math.abs(pos(obs, gRoom.sessionId).yaw)).toBeLessThan(EPS)
  expect(gRoom.connection.isOpen).toBe(true)
  expect(left).toBeUndefined()

  // Huge or diagonal input with any yaw: clamped, capped at length 1, so one
  // step at most, in the direction #18's formula gives.
  const forged: { dx: number; dz: number; yaw: number }[] = [
    { dx: 1e9, dz: -1e9, yaw: 0.7 },
    { dx: -1e300, dz: 0, yaw: 2.5 },
    { dx: 0, dz: 1e9, yaw: -1.1 },
    { dx: 5, dz: 5, yaw: -2.9 },
    { dx: 1, dz: 1, yaw: 0.3 },
    { dx: -1, dz: 1, yaw: 3 * Math.PI },
    { dx: 0.6, dz: 0.8, yaw: 1 },
  ]
  for (const msg of forged) {
    await g.walkTo(GHOST_YARD)
    const before = g.state
    const res = await g.send(msg)
    expect(res.moved, `${JSON.stringify(msg)} moved`).toBe(true)
    const m = delta(before, res.at)
    const want = worldStep(msg.dx, msg.dz, msg.yaw, step)
    expect(len(m), `${JSON.stringify(msg)} moved ${len(m)}, at most one step ${step}`).toBeLessThanOrEqual(step + EPS)
    expect(Math.abs(m.x - want.x) + Math.abs(m.z - want.z), `${JSON.stringify(msg)} moved ${m.x},${m.z}`).toBeLessThan(2 * EPS)
  }
  expect(g.violations).toEqual([])
})

/**
 * Floods `mover` with `{ dx: 0, dz: 1, yaw }` every few ms for `ms`, then
 * waits until a yaw-only sentinel lands (so the whole flood was handled).
 * Returns the displacement and the time from the first flood message to the
 * sentinel showing up: the server handled the flood within that window.
 */
async function flood(w: Walker, yaw: number, ms: number): Promise<{ moved: Vec; seconds: number; before: Point }> {
  await w.face(yaw)
  await new Promise((r) => setTimeout(r, ((MOVE_BURST + 1) * 1000) / MOVE_RATE_HZ))
  const before = w.pos
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    w.room.send(MOVE_MESSAGE, { dx: 0, dz: 1, yaw })
    await new Promise((r) => setTimeout(r, 4))
  }
  const sentinel = yaw > 0 ? yaw - 1 : yaw + 1
  await w.face(sentinel)
  const seconds = (Date.now() - t0) / 1000
  return { moved: delta(before, w.pos), seconds, before }
}

test('speed cap: floods of rotated moves from each team stay within (MOVE_BURST + MOVE_RATE_HZ * t) * step', async () => {
  test.setTimeout(60_000)
  const [gRoom, wRoom] = await joinInOrder(2, open)
  const g = new Walker(gRoom, 'ghost')
  const w = new Walker(wRoom, 'warden')
  // Clear runs: the ghost from its yard toward +x-z, the warden from the
  // south-west corner of its spawn area toward +x+z (between the pillars).
  const wardenStart = { x: GRAYBOX_MAP.spawnAreas.warden.minX, z: GRAYBOX_MAP.spawnAreas.warden.minZ }
  await Promise.all([g.walkTo(GHOST_YARD, 'both'), w.walkTo(wardenStart, 'both')])
  const FLOOD_MS = 1000
  const runs = await Promise.all([
    flood(g, (3 * Math.PI) / 4, FLOOD_MS).then((r) => ({ ...r, w: g, yaw: (3 * Math.PI) / 4 })),
    flood(w, Math.PI / 4, FLOOD_MS).then((r) => ({ ...r, w, yaw: Math.PI / 4 })),
  ])
  for (const run of runs) {
    const team = run.w.state.team
    const step = teamStep(team, MOVE_RATE_HZ)
    const dist = len(run.moved)
    const cap = (MOVE_BURST + MOVE_RATE_HZ * run.seconds) * step
    expect(dist, `${team} moved ${dist} in ${run.seconds} s, cap ${cap}`).toBeLessThanOrEqual(cap + EPS)
    // Sustained speed: at most the team speed, plus the burst spread over t.
    expect(dist / run.seconds, `${team} speed`).toBeLessThanOrEqual(TEAM_SPEED[team] + (MOVE_BURST * step) / run.seconds + EPS)
    // Not vacuous: at least the burst got through, along the yaw's forward
    // direction, in whole steps (nothing hit a wall).
    expect(dist, `${team} moved at least the burst`).toBeGreaterThanOrEqual(MOVE_BURST * step - EPS)
    const fwd = worldStep(0, 1, run.yaw, 1)
    const across = Math.abs(run.moved.x * fwd.z - run.moved.z * fwd.x)
    expect(across, `${team} moved straight along its forward direction`).toBeLessThan(1e-3)
    const steps = dist / step
    expect(Math.abs(steps - Math.round(steps)), `${team} moved ${steps} steps`).toBeLessThan(1e-3)
  }
  for (const wk of [g, w]) expect(wk.violations).toEqual([])
})

test('yaw-only floods are rate limited too: they spend the budget that later moves would need', async () => {
  const [gRoom] = await joinInOrder(1, open)
  const g = new Walker(gRoom, 'ghost')
  await new Promise((r) => setTimeout(r, ((MOVE_BURST + 1) * 1000) / MOVE_RATE_HZ))
  const p0 = g.pos
  const step = g.stepSize
  // 20 turns, then MOVE_BURST forward moves, all back to back. If turns were
  // free the moves would all land (MOVE_BURST steps); since turns spend the
  // budget, at most one token can refill in time for them.
  for (let i = 0; i < 20; i++) gRoom.send(MOVE_MESSAGE, { dx: 0, dz: 0, yaw: 1 })
  for (let i = 0; i < MOVE_BURST; i++) gRoom.send(MOVE_MESSAGE, { dx: 0, dz: 1 })
  // Sentinel: a yaw-only turn to a new value, resent paced until it lands.
  await g.face(-1)
  const moved = len(delta(p0, g.pos))
  expect(moved, `moves after the turn flood went ${moved}, budget allows at most one step`).toBeLessThanOrEqual(step + EPS)
  // The budget refills: a paced move goes through afterwards.
  const r = await g.send({ dx: 0, dz: 1 })
  expect(r.moved, 'a paced move lands after the flood').toBe(true)
  expect(g.violations).toEqual([])
})

test('collision holds with rotated moves: walking into a wall at yaw pi/4 slides along it, never overlapping', async () => {
  test.setTimeout(60_000)
  const [gRoom] = await joinInOrder(1, open)
  const g = new Walker(gRoom, 'ghost')
  // Below the south wall east of the door, 1 unit short of its face.
  const wall = solid('wall-s-e')
  const face = wall.min.z - PLAYER_HALF_SIZE
  const start = { x: wall.min.x + 3.5, z: face - 1 }
  await g.walkTo(GHOST_YARD, 'both')
  await g.walkTo(start, 'both')
  const step = g.stepSize
  const diag = step / Math.SQRT2
  let prev = g.state
  let flushMoves = 0
  for (let i = 0; i < 30; i++) {
    const r = await g.send({ dx: 0, dz: 1, yaw: Math.PI / 4 })
    expect(r.moved, `move ${i + 1} moved`).toBe(true)
    const d = delta(prev, r.at)
    // x is never blocked here: it slides one diagonal component every move.
    expect(Math.abs(d.x - diag), `move ${i + 1}: x slid ${d.x}, expected ${diag}`).toBeLessThan(EPS)
    // z rises by the same until the box reaches the face, then stays flush.
    const wantZ = Math.min(prev.z + diag, face)
    expect(Math.abs(r.at.z - wantZ), `move ${i + 1}: z ${r.at.z}, expected ${wantZ}`).toBeLessThan(EPS)
    expect(r.at.z, 'never past the face').toBeLessThanOrEqual(face + EPS)
    if (Math.abs(r.at.z - face) < EPS) flushMoves++
    prev = r.at
  }
  expect(flushMoves, 'slid along the wall for several moves').toBeGreaterThan(10)
  expect(prev.x + PLAYER_HALF_SIZE, 'still under the wall').toBeLessThan(wall.max.x)
  expect(g.violations).toEqual([])
})
