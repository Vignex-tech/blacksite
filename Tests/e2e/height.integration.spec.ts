import { expect, test } from '@playwright/test'
import {
  ACTIONS,
  ACTION_MESSAGE,
  GRAVITY,
  JUMP_SPEED,
  STEP_HEIGHT,
  type Team,
} from '../../shared/protocol.js'
import { UPPER_LEVEL_Y } from '../../shared/map.js'
// Built server constants (server/build exists: Playwright's webServer runs it).
import { ACTION_BURST, ACTION_RATE_HZ, SIM_RATE_HZ, parseAction } from '../../server/build/rooms/MyRoom.js'
import { GRAYBOX_MAP, feetY, rectsOverlap, playerRect, type Point } from './support/geometry.js'
import { EPS, Walker, joinInOrder, pos, waitForState, type GameRoom } from './support/sdk.js'
import { track, type Sample } from './support/track.js'

// M4 server height simulation (#29, verified in #30) through real
// @colyseus/sdk clients: stairs, upper-level floors, walking off an edge,
// falling, Ghost jumps, refused Warden jumps, action validation and the
// action rate limit, and no way up from the ground except the ramp. Expected
// values come from shared/ (map data, GRAVITY, JUMP_SPEED, STEP_HEIGHT) and
// the server's exported constants, not from server rule code.
//
// Every client is a Walker with { ground: false } (these routes leave the
// ground on purpose), so the y-aware overlap watch (#28, support/geometry.ts)
// checks every player on every state change it receives.

// Each test creates its own room, so the slow walks (stairs, the tour) may run
// on both server-integration workers next to the other SDK specs, keeping e2e short.
test.describe.configure({ mode: 'parallel' })

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => (r.connection.isOpen ? r.leave().catch(() => {}) : undefined)))
})

/** Highest feet height a jump of `team` can reach: JUMP_SPEED^2 / (2 * GRAVITY) (0.50625 for a Ghost). */
const apexOf = (team: Team) => JUMP_SPEED[team] ** 2 / (2 * GRAVITY)
const GHOST_APEX = apexOf('ghost')

/** Number of jumps in a sample list: the times y starts rising (from the ground or after falling). */
function jumpStarts(samples: Sample[]): number {
  let n = 0
  let rising = false
  for (let i = 1; i < samples.length; i++) {
    const dy = samples[i].y - samples[i - 1].y
    // A patch with a horizontal move but no sim step keeps y: no change of direction.
    if (Math.abs(dy) <= 1e-6 && samples[i].mode === samples[i - 1].mode) continue
    const up = dy > 1e-6 && samples[i].mode === 'falling'
    if (up && !rising) n++
    rising = up
  }
  return n
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Message barrier: turns the walker to another yaw with yaw-only moves and
 * waits until the turn is synced. Messages from one client are handled in
 * order, so every action sent before it has been applied by then (a started
 * jump shows as 'falling' in the same patch or an earlier one).
 */
async function barrier(w: Walker): Promise<void> {
  const target = Math.abs(w.state.yaw) < 0.1 ? 0.5 : 0
  await w.face(target)
}

const isGround = (room: GameRoom) => () => {
  const p = pos(room, room.sessionId)
  return p.mode === 'ground'
}

/** Waits until the walker's own player is back in 'ground'. */
function landed(w: Walker): Promise<void> {
  return waitForState(w.room, `${w.name} lands`, isGround(w.room))
}

function expectNoViolations(...walkers: Walker[]) {
  for (const w of walkers) expect(w.violations, `${w.name}'s overlap watch`).toEqual([])
}

/** True if a player box centred at p overlaps a ramp's footprint. */
function onRamp(p: Point): boolean {
  return GRAYBOX_MAP.ramps.some((r) => rectsOverlap(playerRect(p), { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ }))
}

const STAIRS = GRAYBOX_MAP.ramps.find((r) => r.id === 'stairs-west')!
/** Middle of the stairs across their width (x -6.625): the climb starts south of their low edge. */
const STAIRS_X = (STAIRS.minX + STAIRS.maxX) / 2
/** Just south of the stairs' low edge (z 0.5): the player box touches it. */
const STAIRS_FOOT: Point = { x: STAIRS_X, z: STAIRS.minZ - 0.5 }
/** Fully on landing-nw (z 6..7.5), its north edge flush with the north wall. */
const LANDING_Z = 7

/** Holds +z (or -z) until the player's centre passes `z`. Fails after `max` steps. */
async function walkZUntil(w: Walker, sign: 1 | -1, done: (p: Point) => boolean, max = 200): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (done(w.pos)) return
    await w.step(0, sign)
  }
  throw new Error(`${w.name} did not get there in ${max} steps (at ${w.pos.x},${w.pos.z})`)
}

// ---------------------------------------------------------------------------
// No way up without the ramp. Each team walks a tour of the places where the
// upper level, a solid top or an anchor is closest to the ground: the south
// edges of the mezzanine and the catwalk (walking and jumping under them), low
// cover (crates, the low wall, yard cover), and every anchor spot (the climb
// anchors outside the west wall and inside the east wall, which are also on
// ledge-west-wall and below ledge-east-platform). At each, it pushes into
// the obstacle three times; the Ghost jumps before each push, the Warden
// sends a jump too (refused). 'climb' is never sent: climbing is #31 and #32.
// ---------------------------------------------------------------------------

interface Probe {
  /** Where to walk first (legs in `order`). */
  at: Point
  order: 'xz' | 'zx'
  /** Push direction (world axes, yaw 0). */
  dx: number
  dz: number
  what: string
}

/** Push rounds per probe: a Ghost jumps before each; a Warden's jumps are refused, so it needs fewer. */
const PROBE_ROUNDS: Record<Team, number> = { ghost: 3, warden: 2 }
/** Moves per push round (about the length of a jump), cut short once the push is blocked twice in a row. */
const PROBE_MOVES = 5

/**
 * Walks to the probe spot, then PROBE_ROUNDS times: jump (only Ghosts can),
 * push up to PROBE_MOVES moves while in the air, wait to land.
 */
async function runProbe(w: Walker, p: Probe): Promise<void> {
  await w.walkTo(p.at, p.order)
  if (p.dx === 0 && p.dz === 0) return // a waypoint only
  for (let r = 0; r < PROBE_ROUNDS[w.state.team]; r++) {
    w.room.send(ACTION_MESSAGE, { action: 'jump' })
    let blocked = 0
    for (let i = 0; i < PROBE_MOVES && blocked < 2; i++) blocked = (await w.step(p.dx, p.dz)).moved ? 0 : blocked + 1
    await landed(w)
  }
}

// Routes are planned by hand against shared/map.js (see each `what`); a
// Walker fails if a leg gets stuck, so a changed layout shows up here.
const GHOST_TOUR: Probe[] = [
  { at: { x: -5, z: -13.5 }, order: 'xz', dx: 0, dz: 1, what: 'cover-yard-s, from the south' },
  { at: { x: -11.5, z: -2 }, order: 'xz', dx: -1, dz: 0, what: 'cover-yard-w, from the east' },
  { at: { x: -11, z: 4.5 }, order: 'xz', dx: 1, dz: 0, what: 'climb-west / ledge-west-wall, outside the west wall' },
  { at: { x: -11.5, z: -0.5 }, order: 'xz', dx: 0, dz: 0, what: 'west yard, level with the west door' },
  { at: { x: -8.5, z: -2.4 }, order: 'xz', dx: 0, dz: 1, what: 'mezzanine south edge (ledge-mezz-south), in through the west door' },
  { at: { x: -5.25, z: -1.9 }, order: 'zx', dx: 0, dz: -1, what: 'cover-crate-sw, from the north' },
  { at: { x: 0, z: -2.4 }, order: 'xz', dx: 0, dz: -1, what: 'cover-low-wall, from the north' },
  { at: { x: 0, z: -2.4 }, order: 'xz', dx: 0, dz: 1, what: 'catwalk south edge (ledge-catwalk-south)' },
  { at: { x: 5.25, z: -1.9 }, order: 'zx', dx: 0, dz: -1, what: 'cover-crate-se, from the north' },
  { at: { x: 8.5, z: -2.5 }, order: 'xz', dx: 1, dz: 0, what: 'climb-east, inside the east wall' },
  { at: { x: 9, z: -2.5 }, order: 'xz', dx: 0, dz: 1, what: 'east platform south edge (ledge-east-platform)' },
]

const WARDEN_TOUR: Probe[] = [
  { at: { x: 0, z: -2.4 }, order: 'zx', dx: 0, dz: -1, what: 'cover-low-wall, from the north' },
  { at: { x: 0, z: -2.4 }, order: 'xz', dx: 0, dz: 1, what: 'catwalk south edge (ledge-catwalk-south)' },
  { at: { x: 5.25, z: -1.9 }, order: 'zx', dx: 0, dz: -1, what: 'cover-crate-se, from the north' },
  { at: { x: 8.5, z: -2.5 }, order: 'xz', dx: 1, dz: 0, what: 'climb-east, inside the east wall' },
  { at: { x: 9, z: -2.5 }, order: 'xz', dx: 0, dz: 1, what: 'east platform south edge (ledge-east-platform)' },
  { at: { x: -5.25, z: -1.9 }, order: 'zx', dx: 0, dz: -1, what: 'cover-crate-sw, from the north' },
  { at: { x: -8.5, z: -2.4 }, order: 'xz', dx: 0, dz: 1, what: 'mezzanine south edge (ledge-mezz-south)' },
  { at: { x: -11.5, z: -0.5 }, order: 'zx', dx: 0, dz: 0, what: 'out through the west door' },
  { at: { x: -11.5, z: -2 }, order: 'zx', dx: -1, dz: 0, what: 'cover-yard-w, from the east' },
  { at: { x: -11, z: 4.5 }, order: 'xz', dx: 1, dz: 0, what: 'climb-west / ledge-west-wall, outside the west wall' },
]

/** Fails unless every anchor is probed by `tour`: a climb point at a push's stop, a ledge segment within a unit of one. */
function expectEveryAnchorProbed(tour: Probe[], who: string) {
  for (const a of GRAYBOX_MAP.anchors) {
    const near = (p: Point) =>
      a.kind === 'climb'
        ? Math.hypot(p.x - a.x, p.z - a.z) <= 0.5 + 1e-9
        : Math.hypot(
            p.x - Math.min(Math.max(p.x, Math.min(a.x0, a.x1)), Math.max(a.x0, a.x1)),
            p.z - Math.min(Math.max(p.z, Math.min(a.z0, a.z1)), Math.max(a.z0, a.z1)),
          ) <= 1.0
    const probed = tour.some((p) => (p.dx !== 0 || p.dz !== 0) && (near(p.at) || near({ x: p.at.x + p.dx * 0.5, z: p.at.z + p.dz * 0.5 })))
    expect(probed, `the ${who} tour probes anchor ${a.id}`).toBe(true)
  }
}

/**
 * One team's tour in a fresh 1v1 room: `team`'s client walks `probes` while
 * the other client stands at its spawn and watches. Both clients run the
 * y-aware overlap watch and record the walker's heights.
 */
async function runTour(team: Team, probes: Probe[]) {
  expectEveryAnchorProbed(probes, team)
  // The third client is a second Ghost, the observer: a Ghost is sent every player, a Warden might not be sent a Ghost (#45).
  const [g, wd, obs] = await joinInOrder(3, open)
  const ghost = new Walker(g, 'ghost', { ground: false })
  const warden = new Walker(wd, 'warden', { ground: false })
  const [w, watcher] = team === 'ghost' ? [ghost, warden] : [warden, ghost]
  expect(w.state.team).toBe(team)
  const seen = track(w.room, w.room.sessionId)
  const seenByOther = track(obs, w.room.sessionId)
  const idle = track(watcher.room, watcher.room.sessionId)

  const log: string[] = []
  for (const p of probes) {
    const from = seen.samples.length
    await runProbe(w, p)
    const part = seen.samples.slice(from)
    const peak = Math.max(...part.map((s) => s.y))
    log.push(`${p.what}: peak y ${peak.toFixed(3)}, ${jumpStarts(part)} jumps, stopped at ${w.pos.x.toFixed(3)},${w.pos.z.toFixed(3)}`)
    // Never standing above the ground, and back on it at y 0 after each probe.
    expect(part.filter((s) => s.mode === 'ground' && s.y > EPS), `${team} at ${p.what}: grounded only at y 0`).toEqual([])
    expect(w.state.mode, `${team} at ${p.what}`).toBe('ground')
    expect(feetY(w.state), `${team} at ${p.what}`).toBe(0)
  }
  test.info().annotations.push({ type: `${team} tour`, description: log.join('\n') })

  for (const [who, s] of [[team, seen], [`${team} (other client's view)`, seenByOther]] as const) {
    expect(Math.max(...s.samples.map((v) => v.y)), `${who}: no higher than the jump apex`).toBeLessThanOrEqual(apexOf(team) + EPS)
    expect(s.samples.filter((v) => v.mode !== 'ground' && v.mode !== 'falling'), `${who}: only ground and falling`).toEqual([])
    expect(s.samples.filter((v) => v.y > STEP_HEIGHT && v.mode === 'ground'), `${who}: never stands above STEP_HEIGHT`).toEqual([])
  }
  const pushes = probes.filter((p) => p.dx !== 0 || p.dz !== 0).length
  if (team === 'ghost') {
    // The ghost really jumped in every probe round.
    expect(jumpStarts(seen.samples), 'ghost jumps').toBeGreaterThanOrEqual(pushes * PROBE_ROUNDS.ghost)
  } else {
    // A Warden's jumps are refused: it never leaves the ground.
    expect(seen.samples.filter((v) => v.mode !== 'ground' || v.y !== 0), 'warden on the ground the whole tour').toEqual([])
  }
  expect(idle.samples.filter((v) => v.mode !== 'ground' || v.y !== 0), 'the watcher stays put on the ground').toEqual([])
  expect([...seen.bad, ...seenByOther.bad, ...idle.bad]).toEqual([])
  expectNoViolations(ghost, warden)
}

test('no way up without the ramp (Ghost): walking and jumping into the mezzanine, catwalk and platform edges, onto cover and at every anchor spot never stands above STEP_HEIGHT', async () => {
  test.setTimeout(120_000)
  await runTour('ghost', GHOST_TOUR)
})

test('no way up without the ramp (Warden): walking (and refused jumps) into the same edges, cover and anchor spots never leaves the ground', async () => {
  test.setTimeout(120_000)
  await runTour('warden', WARDEN_TOUR)
})


test('the server exports the M4 contract: SIM_RATE_HZ, ACTION_RATE_HZ, ACTION_BURST and parseAction', () => {
  expect(SIM_RATE_HZ).toBe(20)
  expect(ACTION_RATE_HZ).toBe(5)
  expect(ACTION_BURST).toBe(2)
  for (const a of ACTIONS) {
    expect(parseAction({ action: a })).toBe(a)
    expect(parseAction({ action: a, x: 5, y: 9, anchorId: 'climb-west' }), 'extra fields are ignored').toBe(a)
  }
  for (const bad of [null, undefined, 0, 1, 'jump', true, [], ['jump'], [{ action: 'jump' }], {}, { action: 'fly' }, { action: 'JUMP' }, { action: 1 }, { action: ['jump'] }, { action: null }, { action: { action: 'jump' } }]) {
    expect(parseAction(bad), `parseAction(${JSON.stringify(bad)})`).toBeNull()
  }
})

test('stairs: a Warden climbs to UPPER_LEVEL_Y in ground mode and walks off the mezzanine (falling, then ground at y 0); a Ghost goes up and back down without falling', async () => {
  test.setTimeout(90_000)
  const [g, wd] = await joinInOrder(2, open)
  const ghost = new Walker(g, 'ghost', { ground: false })
  const warden = new Walker(wd, 'warden', { ground: false })
  expect(ghost.state.team).toBe('ghost')
  expect(warden.state.team).toBe('warden')
  // Both clients watch the warden; the ghost's own client watches the ghost.
  const wSeen = [track(wd, wd.sessionId), track(g, wd.sessionId)]
  const gSeen = track(g, g.sessionId)

  const wardenRun = async () => {
    // From the warden area: south to z 0 (under the catwalk), then west to the foot of the stairs.
    await warden.walkTo(STAIRS_FOOT, 'zx')
    // Within EPS: walk residue (ARRIVE) can leave the box a hair over the ramp's low edge.
    expect(Math.abs(feetY(warden.state))).toBeLessThan(EPS)
    expect(warden.state.mode).toBe('ground')
    const upFrom = wSeen[0].samples.length
    await walkZUntil(warden, 1, (p) => p.z >= LANDING_Z - 1e-6)
    const up = wSeen[0].samples.slice(upFrom)
    // Ground the whole way, never going down, ending at the upper level.
    expect(up.filter((s) => s.mode !== 'ground'), 'warden stays in ground mode on the stairs').toEqual([])
    for (let i = 1; i < up.length; i++) expect(up[i].y, `y never drops on the way up (sample ${i})`).toBeGreaterThanOrEqual(up[i - 1].y - EPS)
    expect(up.some((s) => s.y > STEP_HEIGHT && s.y < UPPER_LEVEL_Y - STEP_HEIGHT && onRamp(s)), 'seen part way up, on the ramp').toBe(true)
    // Above STEP_HEIGHT only while on the ramp or on an upper-level floor (y 3).
    for (const s of up) if (s.y > STEP_HEIGHT && !onRamp(s)) expect(Math.abs(s.y - UPPER_LEVEL_Y)).toBeLessThan(EPS)
    const top = warden.state
    expect(Math.abs(feetY(top) - UPPER_LEVEL_Y), `warden at y ${feetY(top)} on landing-nw`).toBeLessThan(EPS)
    expect(top.mode).toBe('ground')

    // West onto the mezzanine (x -8.5), then south off its south edge (z -1).
    await warden.walkTo({ x: -8.5, z: LANDING_Z }, 'xz')
    expect(Math.abs(feetY(warden.state) - UPPER_LEVEL_Y)).toBeLessThan(EPS)
    const offFrom = wSeen[0].samples.length
    const mezz = GRAYBOX_MAP.floors.find((f) => f.id === 'mezz-west')!
    // Walk until the server reports the fall (the box has left the slab), then stop sending.
    for (let i = 0; i < 200 && warden.state.mode === 'ground'; i++) {
      expect(warden.pos.z, 'still over the mezzanine while in ground mode').toBeGreaterThan(mezz.min.z - 0.5 - 0.11)
      await warden.step(0, -1)
    }
    expect(warden.state.mode).not.toBe('ground')
    await landed(warden)
    const off = wSeen[0].samples.slice(offFrom)
    const falling = off.filter((s) => s.mode === 'falling')
    expect(falling.length, 'warden seen falling').toBeGreaterThan(0)
    expect(falling.some((s) => s.y > 0 && s.y < UPPER_LEVEL_Y), 'seen in mid-air').toBe(true)
    // Falling only once the box is clear of the slab's south edge.
    for (const s of falling) expect(s.z).toBeLessThanOrEqual(mezz.min.z - 0.5 + EPS)
    for (let i = 1; i < off.length; i++) expect(off[i].y, 'a walk-off fall never rises').toBeLessThanOrEqual(off[i - 1].y + EPS)
    const end = warden.state
    expect(end.mode).toBe('ground')
    expect(Math.abs(feetY(end)), 'landed on the ground').toBeLessThan(EPS)
    // The ghost's client saw the same fall and landing.
    await waitForState(g, 'ghost sees the warden land', (s) => {
      const p = s.players.get(wd.sessionId) as unknown as Record<string, unknown>
      return p.mode === 'ground' && Math.abs(p.z - end.z) < EPS
    })
    expect(wSeen[1].samples.some((s) => s.mode === 'falling'), 'the other client saw the warden falling').toBe(true)
  }

  const ghostRun = async () => {
    // From the yard: in through the south door, round the low wall's east end, then west under the catwalk.
    await ghost.walkTo({ x: 0, z: -5 }, 'xz')
    await ghost.walkTo({ x: 3, z: -5 }, 'xz')
    await ghost.walkTo({ x: 3, z: STAIRS_FOOT.z }, 'xz')
    await ghost.walkTo(STAIRS_FOOT, 'xz')
    const upFrom = gSeen.samples.length
    await walkZUntil(ghost, 1, (p) => p.z >= LANDING_Z - 1e-6)
    expect(Math.abs(feetY(ghost.state) - UPPER_LEVEL_Y)).toBeLessThan(EPS)
    const downFrom = gSeen.samples.length
    await walkZUntil(ghost, -1, (p) => p.z <= STAIRS_FOOT.z + 1e-6)
    const up = gSeen.samples.slice(upFrom, downFrom)
    const down = gSeen.samples.slice(downFrom)
    expect([...up, ...down].filter((s) => s.mode !== 'ground'), 'ghost never leaves ground mode on the stairs').toEqual([])
    for (let i = 1; i < down.length; i++) expect(down[i].y, 'y never rises on the way down').toBeLessThanOrEqual(down[i - 1].y + EPS)
    expect(down.some((s) => s.y > STEP_HEIGHT && s.y < UPPER_LEVEL_Y - STEP_HEIGHT), 'seen part way down').toBe(true)
    expect(ghost.state.mode).toBe('ground')
    expect(Math.abs(feetY(ghost.state)), 'back on the ground').toBeLessThan(EPS)
  }

  await Promise.all([wardenRun(), ghostRun()])
  expect([...wSeen.flatMap((s) => s.bad), ...gSeen.bad]).toEqual([])
  expectNoViolations(ghost, warden)
})

test('jumps: a Ghost jump is seen falling, peaks at most at the JUMP_SPEED apex and lands; a mid-air jump and a Warden jump change nothing', async () => {
  // obs is a second Ghost: it is sent every player, so it can watch the first Ghost (a Warden might not be sent it, #45).
  const [g, wd, obs] = await joinInOrder(3, open)
  const ghost = new Walker(g, 'ghost', { ground: false })
  const warden = new Walker(wd, 'warden', { ground: false })
  const gSeen = track(g, g.sessionId)
  const gSeenByW = track(obs, g.sessionId)
  const wSeen = track(wd, wd.sessionId)
  const g0 = ghost.state
  const w0 = warden.state
  expect(g0.mode).toBe('ground')
  expect(feetY(g0)).toBe(0)

  // Ghost: jump, then (while rising) jump again. The second is refused: jumps need the ground.
  const t0 = Date.now()
  g.send(ACTION_MESSAGE, { action: 'jump' })
  await waitForState(g, 'ghost is in the air', (s) => (s.players.get(g.sessionId) as any).mode === 'falling')
  g.send(ACTION_MESSAGE, { action: 'jump' })
  await landed(ghost)
  const airMs = Date.now() - t0
  const ys = gSeen.samples.map((s) => s.y)
  const peak = Math.max(...ys)
  test.info().annotations.push({ type: 'ghost jump', description: `sampled apex ${peak.toFixed(3)} (limit ${GHOST_APEX.toFixed(3)}), ${airMs} ms to land, ${gSeen.samples.length} samples` })
  expect(gSeen.samples.some((s) => s.mode === 'falling'), 'seen in falling').toBe(true)
  // 20 Hz sampling can only miss the true apex from below; it rose visibly.
  expect(peak).toBeLessThanOrEqual(GHOST_APEX + EPS)
  expect(peak).toBeGreaterThan(STEP_HEIGHT / 2)
  expect(jumpStarts(gSeen.samples), 'one jump: the mid-air jump was refused').toBe(1)
  // A jump in place lands where it started, on the ground.
  const g1 = ghost.state
  expect(g1.mode).toBe('ground')
  expect(feetY(g1)).toBe(0)
  expect(g1.x).toBe(g0.x)
  expect(g1.z).toBe(g0.z)
  // About 2 * JUMP_SPEED / GRAVITY (0.45 s) in the air; generous bounds for a loaded machine.
  expect(airMs).toBeGreaterThan(200)
  expect(airMs).toBeLessThan(3_000)
  // The warden's client saw the same jump, never above the apex.
  expect(gSeenByW.samples.some((s) => s.mode === 'falling')).toBe(true)
  expect(Math.max(...gSeenByW.samples.map((s) => s.y))).toBeLessThanOrEqual(GHOST_APEX + EPS)

  // Warden: JUMP_SPEED.warden is 0, so a jump is refused and nothing changes.
  expect(JUMP_SPEED.warden).toBe(0)
  wd.send(ACTION_MESSAGE, { action: 'jump' })
  await barrier(warden)
  await sleep(300) // several sim steps, in case a refused jump still set something moving
  await barrier(warden)
  const w1 = warden.state
  expect(wSeen.samples.filter((s) => s.mode !== 'ground' || s.y !== 0), 'warden never leaves the ground').toEqual([])
  expect(w1.mode).toBe(w0.mode)
  expect(feetY(w1)).toBe(feetY(w0))
  expect([w1.x, w1.z]).toEqual([w0.x, w0.z])
  expect([...gSeen.bad, ...wSeen.bad, ...gSeenByW.bad]).toEqual([])
  expectNoViolations(ghost, warden)
})

test('invalid action payloads change nothing and spend no token; a burst is capped at ACTION_BURST and refills at ACTION_RATE_HZ; a 100 Hz jump flood stays within the budget', async () => {
  test.setTimeout(60_000)
  const [g] = await joinInOrder(1, open)
  const ghost = new Walker(g, 'ghost', { ground: false })
  const seen = track(g, g.sessionId)
  const start = ghost.state

  // Not a non-array object with `action` in ACTIONS: ignored whole.
  const invalid: unknown[] = [
    null, 42, -1, 0, Number.NaN, 'jump', '', true, false, [], ['jump'], [{ action: 'jump' }],
    {}, { action: 'fly' }, { action: 'JUMP' }, { action: ' jump' }, { action: 1 }, { action: true },
    { action: ['jump'] }, { action: null }, { action: { action: 'jump' } }, { jump: true }, { type: 'jump' },
  ]
  for (const m of invalid) g.send(ACTION_MESSAGE, m as never)
  await barrier(ghost)
  expect(g.connection.isOpen, 'invalid payloads do not disconnect').toBe(true)
  expect(seen.samples.filter((s) => s.mode !== 'ground' || s.y !== 0), 'invalid payloads change nothing').toEqual([])
  expect([ghost.state.x, ghost.state.z]).toEqual([start.x, start.z])

  // They spent no token: the bucket is still full (ACTION_BURST), so ACTION_BURST - 1
  // spending actions ('drop' is accepted and does nothing on the ground) leave one for a jump.
  // Extra fields are never read: a forged y or speed doesn't change the jump.
  for (let i = 0; i < ACTION_BURST - 1; i++) g.send(ACTION_MESSAGE, { action: 'drop' })
  g.send(ACTION_MESSAGE, { action: 'jump', y: 3, vy: 100, speed: 50, mode: 'ground' })
  await waitForState(g, 'the jump after the invalid payloads is accepted', (s) => (s.players.get(g.sessionId) as any).mode === 'falling')
  await landed(ghost)
  expect(Math.max(...seen.samples.map((s) => s.y)), 'forged fields do not raise the jump').toBeLessThanOrEqual(GHOST_APEX + EPS)
  expect(jumpStarts(seen.samples)).toBe(1)

  // Burst cap: refill to full, then ACTION_BURST back-to-back actions empty the bucket,
  // so a jump sent right behind them is refused (it arrives within a few ms).
  const refillMs = (n: number) => Math.ceil((n * 1000) / ACTION_RATE_HZ) + 100
  await sleep(refillMs(ACTION_BURST))
  for (let i = 0; i < ACTION_BURST; i++) g.send(ACTION_MESSAGE, { action: 'drop' })
  g.send(ACTION_MESSAGE, { action: 'jump' })
  await barrier(ghost)
  await sleep(150)
  await barrier(ghost)
  expect(jumpStarts(seen.samples), 'the jump past the burst was refused').toBe(1)
  expect(ghost.state.mode).toBe('ground')
  // Refill: one token per 1000 / ACTION_RATE_HZ ms, then a jump works again.
  await sleep(refillMs(1))
  g.send(ACTION_MESSAGE, { action: 'jump' })
  await waitForState(g, 'a jump after the refill is accepted', (s) => (s.players.get(g.sessionId) as any).mode === 'falling')
  await landed(ghost)
  expect(jumpStarts(seen.samples)).toBe(2)

  // Flood: 'jump' at about 100 Hz for 1 s. Refused jumps (in the air) spend tokens too,
  // so at most ACTION_BURST + ACTION_RATE_HZ * t get through, and each needs a landing first.
  await sleep(refillMs(ACTION_BURST))
  const before = seen.samples.length
  const t0 = Date.now()
  let sent = 0
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      g.send(ACTION_MESSAGE, { action: 'jump' })
      sent++
      if (Date.now() - t0 >= 1000) {
        clearInterval(timer)
        resolve()
      }
    }, 10)
  })
  const floodS = (Date.now() - t0) / 1000
  await landed(ghost)
  await barrier(ghost)
  await landed(ghost)
  const flood = seen.samples.slice(before - 1)
  const jumps = jumpStarts(flood)
  const cap = ACTION_BURST + ACTION_RATE_HZ * (floodS + 0.1)
  test.info().annotations.push({ type: 'jump flood', description: `${sent} jumps sent in ${floodS.toFixed(2)} s, ${jumps} accepted (cap ${cap.toFixed(1)})` })
  expect(sent).toBeGreaterThan(30)
  expect(jumps).toBeGreaterThanOrEqual(1)
  expect(jumps).toBeLessThanOrEqual(cap)
  // Jumps need the ground: each accepted jump is about 0.45 s in the air, so far fewer than the cap.
  expect(jumps).toBeLessThanOrEqual(Math.ceil(floodS / (2 * JUMP_SPEED.ghost / GRAVITY)) + 1)
  expect(Math.max(...flood.map((s) => s.y)), 'no jump goes higher than the apex').toBeLessThanOrEqual(GHOST_APEX + EPS)
  expect(g.connection.isOpen).toBe(true)
  expect(seen.bad).toEqual([])
  expectNoViolations(ghost)
})
