import { expect, test } from '@playwright/test'
import {
  ACTION_MESSAGE,
  CAN_CLIMB,
  CLIMB_SPEED,
  SHIMMY_SPEED,
  STEP_HEIGHT,
  type Action,
  type Team,
} from '../../shared/protocol.js'
import { PLAYER_HALF_SIZE, PLAYER_HEIGHT, UPPER_LEVEL_Y, type ClimbAnchor, type LedgeAnchor } from '../../shared/map.js'
// Built server constants (server/build exists: Playwright's webServer runs it).
import {
  ACTION_BURST,
  ACTION_RATE_HZ,
  CLIMB_STEP,
  MANTLE_DISTANCE,
  MOVE_RATE_HZ,
  SHIMMY_STEP,
} from '../../server/build/rooms/MyRoom.js'
import { GRAYBOX_MAP, feetY, playerRect, rectsOverlap, type Point } from './support/geometry.js'
import { EPS, Walker, joinInOrder, waitForState, type GameRoom } from './support/sdk.js'
import { track, type Sample } from './support/track.js'

// M4 climb and ledge-hang rules (#31, verified in #32) through real
// @colyseus/sdk clients: the Ghost's outside route up (climb-west, hang,
// mantle onto the mezzanine), the east route, grabbing a ledge while falling,
// shimmying, dropping, refused and over-budget actions, forged climbs, and
// Wardens refused at every anchor spot they can reach (then taking the
// stairs). Expected values come from shared/ (map anchors, speeds, reach) and
// the server's exported constants, not from server rule code.
//
// Every client is a Walker with { ground: false } (these routes leave the
// ground on purpose), so the y-aware overlap watch (#28, support/geometry.ts)
// checks every player on every state change it receives.

// Each test creates its own room, so the walks run on both
// server-integration workers next to the other SDK specs.
test.describe.configure({ mode: 'parallel' })

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => (r.connection.isOpen ? r.leave().catch(() => {}) : undefined)))
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const climbAnchor = (id: string) => GRAYBOX_MAP.anchors.find((a): a is ClimbAnchor => a.kind === 'climb' && a.id === id)!
const ledgeAnchor = (id: string) => GRAYBOX_MAP.anchors.find((a): a is LedgeAnchor => a.kind === 'ledge' && a.id === id)!
const CLIMBS = GRAYBOX_MAP.anchors.filter((a): a is ClimbAnchor => a.kind === 'climb')
const LEDGES = GRAYBOX_MAP.anchors.filter((a): a is LedgeAnchor => a.kind === 'ledge')
const CLIMB_WEST = climbAnchor('climb-west')
const CLIMB_EAST = climbAnchor('climb-east')
/** Feet height while hanging: hands (feet + PLAYER_HEIGHT) at the ledge. */
const HANG_Y = UPPER_LEVEL_Y - PLAYER_HEIGHT
/** Accepted full up-moves from the bottom of a climb anchor to its ledge. */
const MOVES_TO_TOP = (a: ClimbAnchor) => Math.ceil((a.maxY - a.minY) / CLIMB_STEP - 1e-9)

/** How far west of climb-west the refused near-miss climb is sent: just outside ANCHOR_RANGE (0.8). */
const ANCHOR_MISS = 0.9

/** Wait long enough for `n` action tokens to refill (ACTION_RATE_HZ), plus slack. */
const refillMs = (n: number) => Math.ceil((n * 1000) / ACTION_RATE_HZ) + 100

function act(w: Walker, action: Action, extra: object = {}) {
  w.room.send(ACTION_MESSAGE, { action, ...extra })
}

/**
 * Message barrier: turns the walker with yaw-only moves and waits until the
 * turn is synced. One client's messages are handled in order, so every action
 * sent before it has been applied by then. Yaw is stored in every mode.
 */
async function barrier(w: Walker): Promise<void> {
  await w.face(Math.abs(w.state.yaw - 0.5) < 0.1 ? 0.25 : 0.5)
}

/** Barrier, a few sim steps (in case something was set moving), then a barrier back to the starting yaw. */
async function settle(w: Walker): Promise<void> {
  const yaw = w.state.yaw
  await barrier(w)
  await sleep(150)
  await w.face(yaw)
}

const own = (w: Walker) => w.room.state.players.get(w.room.sessionId) as unknown as { x: number; y: number; z: number; mode: string }

function waitMode(w: Walker, mode: string, what = `${w.name} is ${mode}`): Promise<void> {
  return waitForState(w.room, what, () => own(w).mode === mode)
}

function snapshot(w: Walker) {
  const p = own(w)
  return { x: p.x, y: feetY(p), z: p.z, mode: p.mode }
}

function expectAt(w: Walker, want: { x: number; y: number; z: number; mode: string }, what: string) {
  const p = snapshot(w)
  expect(p.mode, `${what}: mode`).toBe(want.mode)
  expect(Math.abs(p.x - want.x), `${what}: x ${p.x} vs ${want.x}`).toBeLessThan(EPS)
  expect(Math.abs(p.y - want.y), `${what}: y ${p.y} vs ${want.y}`).toBeLessThan(EPS)
  expect(Math.abs(p.z - want.z), `${what}: z ${p.z} vs ${want.z}`).toBeLessThan(EPS)
}

/** Distance from (x, z) to a ledge's segment. */
function ledgeDistance(l: LedgeAnchor, p: Point): number {
  const ux = l.x1 - l.x0
  const uz = l.z1 - l.z0
  const t = Math.min(1, Math.max(0, ((p.x - l.x0) * ux + (p.z - l.z0) * uz) / (ux * ux + uz * uz)))
  return Math.hypot(p.x - (l.x0 + ux * t), p.z - (l.z0 + uz * t))
}

function onRamp(p: Point): boolean {
  return GRAYBOX_MAP.ramps.some((r) => rectsOverlap(playerRect(p), { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ }))
}

/**
 * The mode changes #31 documents: walking off or jumping (ground -> falling),
 * landing, grabbing a climb anchor or a ledge from the ground or in the air,
 * reaching the top (climbing -> hanging), stepping off the bottom
 * (climbing -> ground), mantling (hanging -> ground) and letting go
 * (climbing or hanging -> falling). hanging -> climbing is not one of them.
 */
const TRANSITIONS: Record<string, readonly string[]> = {
  ground: ['falling', 'climbing', 'hanging'],
  falling: ['ground', 'climbing', 'hanging'],
  climbing: ['hanging', 'ground', 'falling'],
  hanging: ['ground', 'falling'],
}

/**
 * Problems in one player's samples: an undocumented mode change, a climber
 * off a climb anchor's line or height range, a hanger off a ledge segment or
 * not at HANG_Y, someone standing somewhere other than the ground, a ramp or
 * the upper level, or a team that may not climb seen attached.
 */
function sampleProblems(samples: Sample[], team: Team): string[] {
  const out: string[] = []
  const at = (s: Sample) => `${s.mode} at ${s.x.toFixed(4)},${s.y.toFixed(4)},${s.z.toFixed(4)}`
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const prev = samples[i - 1]
    if (prev && prev.mode !== s.mode && !TRANSITIONS[prev.mode]?.includes(s.mode)) out.push(`undocumented ${prev.mode} -> ${s.mode} (${at(s)})`)
    if ((s.mode === 'climbing' || s.mode === 'hanging') && !CAN_CLIMB[team]) out.push(`${team} seen ${at(s)}`)
    if (s.mode === 'climbing') {
      const ok = CLIMBS.some((a) => Math.abs(s.x - a.x) < EPS && Math.abs(s.z - a.z) < EPS && s.y >= a.minY - EPS && s.y <= a.maxY + EPS)
      if (!ok) out.push(`${at(s)} is not on a climb anchor`)
    }
    if (s.mode === 'hanging') {
      if (Math.abs(s.y - HANG_Y) > EPS) out.push(`${at(s)}: feet not at ${HANG_Y}`)
      if (!LEDGES.some((l) => ledgeDistance(l, s) < EPS)) out.push(`${at(s)} is not on a ledge segment`)
    }
    if (s.mode === 'ground' && Math.abs(s.y) > EPS && Math.abs(s.y - UPPER_LEVEL_Y) > EPS && !onRamp(s)) out.push(`${at(s)}: standing in mid-air`)
    if (s.mode === 'falling' && prev?.mode === 'falling' && s.y > prev.y + EPS && !(prev.y < STEP_HEIGHT)) {
      // Only a jump rises while falling, and jumps start from the ground (low).
      const start = samples.slice(0, i).reverse().find((v) => v.mode !== 'falling')
      if (!start || start.mode !== 'ground') out.push(`rising while falling at ${at(s)} after ${start?.mode}`)
    }
  }
  return out
}

/** Modes in order, with repeats collapsed. */
function modeSequence(samples: Sample[]): string[] {
  return samples.map((s) => s.mode).filter((m, i, a) => i === 0 || a[i - 1] !== m)
}

function expectClean(walkers: Walker[], views: { who: string; team: Team; seen: ReturnType<typeof track> }[]) {
  for (const v of views) {
    expect(v.seen.bad, `${v.who}: y and mode synced`).toEqual([])
    expect(sampleProblems(v.seen.samples, v.team), `${v.who}: documented transitions and positions`).toEqual([])
  }
  for (const w of walkers) expect(w.violations, `${w.name}'s overlap watch`).toEqual([])
}

/**
 * Climbs with full up-moves until hanging. Every move raises the feet by
 * CLIMB_STEP (the last one is clamped to maxY and turns into hanging).
 * Returns how many moves changed the state.
 */
async function climbToTop(w: Walker, a: ClimbAnchor): Promise<number> {
  let moves = 0
  for (let i = 0; i < 40 && own(w).mode === 'climbing'; i++) {
    const before = snapshot(w)
    const r = await w.attachedStep(0, 1)
    if (!r.moved) continue
    moves++
    const after = snapshot(w)
    expect(after.y - before.y, `climb move ${moves} rises`).toBeGreaterThan(0)
    expect(after.y - before.y, `climb move ${moves} rises at most CLIMB_STEP`).toBeLessThanOrEqual(CLIMB_STEP + EPS)
    if (after.mode === 'climbing') expect(Math.abs(after.y - before.y - CLIMB_STEP), `climb move ${moves}`).toBeLessThan(EPS)
  }
  expect(own(w).mode, `${w.name} reached the top of ${a.id}`).toBe('hanging')
  return moves
}

/** Moves along the climb `n` times with dz `sign` (each move changes the feet by CLIMB_STEP). */
async function climbMoves(w: Walker, sign: 1 | -1, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await w.attachedStep(0, sign)
    expect(r.moved, `${w.name} climb move ${i + 1} of ${n} (dz ${sign})`).toBe(true)
  }
}

/**
 * Shimmies with dx `sign` until two moves in a row change nothing (clamped at
 * a segment end). Fails if any step leaves the ledge, its line or HANG_Y, or
 * moves by more than SHIMMY_STEP. Returns the number of moves that changed x or z.
 */
async function shimmyToEnd(w: Walker, ledge: LedgeAnchor, sign: 1 | -1): Promise<number> {
  let moves = 0
  let still = 0
  for (let i = 0; i < 200 && still < 2; i++) {
    const before = snapshot(w)
    const r = await w.attachedStep(sign, 0)
    const after = snapshot(w)
    expect(after.mode, 'still hanging while shimmying').toBe('hanging')
    expect(Math.abs(after.y - HANG_Y)).toBeLessThan(EPS)
    expect(ledgeDistance(ledge, after), `on ${ledge.id} at ${after.x},${after.z}`).toBeLessThan(EPS)
    const d = Math.hypot(after.x - before.x, after.z - before.z)
    expect(d).toBeLessThanOrEqual(SHIMMY_STEP + EPS)
    if (r.moved) {
      moves++
      still = 0
    } else still++
  }
  expect(still, `${w.name} stopped at an end of ${ledge.id}`).toBe(2)
  return moves
}

/**
 * Walks with dz -1 off the upper level's edge until the server reports
 * 'falling', then sends 'climb' once the hands are below the ledge (y < 1.8),
 * and once more on the next change if still falling above the reach. Resolves
 * with the feet heights the climbs were sent at, once the player is attached
 * or back on the ground.
 */
async function walkOffAndGrab(w: Walker): Promise<number[]> {
  for (let i = 0; i < 200 && own(w).mode === 'ground'; i++) await w.step(0, -1)
  expect(own(w).mode, `${w.name} walked off the edge`).toBe('falling')
  const sentAt: number[] = []
  const reachLow = HANG_Y - 0.6
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      w.room.onStateChange.remove(check)
      reject(new Error(`${w.name} neither grabbed nor landed (climbs sent at ${sentAt.join(', ')})`))
    }, 5_000)
    const check = () => {
      const p = own(w)
      if (p.mode !== 'falling') {
        clearTimeout(timer)
        w.room.onStateChange.remove(check)
        resolve()
        return
      }
      const y = feetY(p)
      if (sentAt.length < ACTION_BURST && y < UPPER_LEVEL_Y - PLAYER_HEIGHT + 0.6 - 0.01 && y > reachLow && !sentAt.includes(y)) {
        sentAt.push(y)
        act(w, 'climb')
      }
    }
    w.room.onStateChange(check)
    check()
  })
  return sentAt
}

/** Ghost route from its spawn (south yard) to the west yard at x -11.5, then north to z, outside the west wall. */
async function ghostToWestYard(w: Walker, z: number): Promise<void> {
  // West at the spawn's z (south of cover-yard-s), then north at x -11.5 (east of cover-yard-w, west of the wall).
  await w.walkTo({ x: -11.5, z }, 'xz')
}

test('the server exports the climbing constants: CLIMB_STEP, SHIMMY_STEP and MANTLE_DISTANCE', () => {
  expect(CLIMB_STEP).toBeCloseTo(CLIMB_SPEED / MOVE_RATE_HZ, 12)
  expect(SHIMMY_STEP).toBeCloseTo(SHIMMY_SPEED / MOVE_RATE_HZ, 12)
  expect(MANTLE_DISTANCE).toBe(2 * PLAYER_HALF_SIZE)
  expect(MOVES_TO_TOP(CLIMB_WEST)).toBe(16)
  expect(MOVES_TO_TOP(CLIMB_EAST)).toBe(16)
  expect(CAN_CLIMB).toEqual({ ghost: true, warden: false })
})

test('M4 gate (Ghost, west route): spawn to climb-west, climb, hang, mantle onto the mezzanine at UPPER_LEVEL_Y; then walk off its south edge, grab ledge-mezz-south, shimmy end to end, over-budget and wrong-mode actions change nothing, drop to the ground', async () => {
  test.setTimeout(90_000)
  // obs is a second Ghost: it is sent every player, so it can watch the first Ghost (a Warden might not be sent it, #45).
  const [g, wd, obs] = await joinInOrder(3, open)
  const ghost = new Walker(g, 'ghost', { ground: false })
  const warden = new Walker(wd, 'warden', { ground: false })
  expect(ghost.state.team).toBe('ghost')
  expect(warden.state.team).toBe('warden')
  const gSeen = track(g, g.sessionId)
  const gSeenByW = track(obs, g.sessionId)
  const wSeen = track(wd, wd.sessionId)
  const log: string[] = []

  const ghostRun = async () => {
    const t0 = Date.now()
    await ghostToWestYard(ghost, CLIMB_WEST.z)
    // Just out of ANCHOR_RANGE (0.9 from the anchor): climb is refused.
    await ghost.walkTo({ x: CLIMB_WEST.x - ANCHOR_MISS, z: CLIMB_WEST.z }, 'xz')
    const miss = snapshot(ghost)
    act(ghost, 'climb')
    await settle(ghost)
    expectAt(ghost, miss, 'climb just out of range is refused')
    // East into the wall: stopped flush at x -10.5, on the anchor.
    const stop = await ghost.push(1, 0, 40)
    expect(Math.abs(stop.x - CLIMB_WEST.x), `stopped at the west wall (x ${stop.x})`).toBeLessThan(EPS)
    const upFrom = gSeen.samples.length - 1
    act(ghost, 'climb')
    await waitMode(ghost, 'climbing')
    expectAt(ghost, { x: CLIMB_WEST.x, y: CLIMB_WEST.minY, z: CLIMB_WEST.z, mode: 'climbing' }, 'grabbed climb-west')
    expect(Math.abs(ghost.state.yaw - CLIMB_WEST.facing), 'yaw set to the anchor facing').toBeLessThan(EPS)
    const moves = await climbToTop(ghost, CLIMB_WEST)
    expect(moves, 'full up-moves to the top').toBe(MOVES_TO_TOP(CLIMB_WEST))
    const ledge = ledgeAnchor(CLIMB_WEST.ledgeId)
    expectAt(ghost, { x: CLIMB_WEST.x, y: HANG_Y, z: CLIMB_WEST.z, mode: 'hanging' }, `hanging from ${ledge.id}`)
    act(ghost, 'climb')
    await waitMode(ghost, 'ground')
    const top = { x: CLIMB_WEST.x + MANTLE_DISTANCE * Math.sin(ledge.facing), y: UPPER_LEVEL_Y, z: CLIMB_WEST.z + MANTLE_DISTANCE * Math.cos(ledge.facing), mode: 'ground' }
    expect([top.x, top.z]).toEqual([-9.5, 4.5])
    expectAt(ghost, top, 'mantled onto the upper level')
    const route = gSeen.samples.slice(upFrom)
    expect(modeSequence(route), 'the west route: grab, climb, hang, mantle').toEqual(['ground', 'climbing', 'hanging', 'ground'])
    for (let i = 1; i < route.length; i++) expect(route[i].y, 'y never drops on the way up').toBeGreaterThanOrEqual(route[i - 1].y - EPS)
    log.push(`west route: spawn to the mezzanine in ${Date.now() - t0} ms, ${moves} climb moves`)

    // The mezzanine's south edge: east to x -8.5 (ledge-mezz-south runs x -9..-7.5), south off the slab.
    const mezzLedge = ledgeAnchor('ledge-mezz-south')
    await ghost.walkTo({ x: -8.5, z: top.z }, 'xz')
    expect(Math.abs(feetY(ghost.state) - UPPER_LEVEL_Y)).toBeLessThan(EPS)
    const fallFrom = gSeen.samples.length - 1
    const sentAt = await walkOffAndGrab(ghost)
    log.push(`grab while falling: climb sent at y ${sentAt.map((y) => y.toFixed(3)).join(', ')}`)
    expect(own(ghost).mode, `grabbed ${mezzLedge.id} while falling`).toBe('hanging')
    const grabbed = snapshot(ghost)
    expect(ledgeDistance(mezzLedge, grabbed)).toBeLessThan(EPS)
    expect(Math.abs(grabbed.x - -8.5), 'snapped to the nearest point (same x)').toBeLessThan(EPS)
    expect(modeSequence(gSeen.samples.slice(fallFrom)), 'walk off, then grab').toEqual(['ground', 'falling', 'hanging'])

    // dz is ignored while hanging.
    const hang = snapshot(ghost)
    for (const dz of [1, -1]) expect((await ghost.attachedStep(0, dz)).moved, `dz ${dz} while hanging`).toBe(false)
    expectAt(ghost, hang, 'dz while hanging')
    // +dx is +x on a north-facing ledge: to x1 (-7.5), then back to x0 (-9).
    const east = await shimmyToEnd(ghost, mezzLedge, 1)
    expectAt(ghost, { x: Math.max(mezzLedge.x0, mezzLedge.x1), y: HANG_Y, z: mezzLedge.z0, mode: 'hanging' }, '+dx shimmies to the east end')
    const west = await shimmyToEnd(ghost, mezzLedge, -1)
    expectAt(ghost, { x: Math.min(mezzLedge.x0, mezzLedge.x1), y: HANG_Y, z: mezzLedge.z0, mode: 'hanging' }, '-dx shimmies to the west end')
    log.push(`shimmy on ${mezzLedge.id}: ${east} moves east, ${west} moves west`)
    expect(east).toBe(Math.ceil(Math.abs(-7.5 - -8.5) / SHIMMY_STEP - 1e-9))
    expect(west).toBe(Math.ceil(Math.abs(mezzLedge.x1 - mezzLedge.x0) / SHIMMY_STEP - 1e-9))

    // Jump while hanging changes nothing. Then the budget: ACTION_BURST no-op
    // jumps empty the bucket, so a drop right behind them is dropped too.
    await sleep(refillMs(ACTION_BURST))
    const held = snapshot(ghost)
    act(ghost, 'jump')
    await settle(ghost)
    expectAt(ghost, held, 'jump while hanging')
    await sleep(refillMs(ACTION_BURST))
    for (let i = 0; i < ACTION_BURST; i++) act(ghost, 'jump')
    act(ghost, 'drop')
    await settle(ghost)
    expectAt(ghost, held, 'a drop over the action budget is dropped')
    // One token later the drop works: falling (vy 0), then the ground at y 0 below the ledge.
    await sleep(refillMs(1))
    const dropFrom = gSeen.samples.length - 1
    act(ghost, 'drop')
    await waitMode(ghost, 'falling')
    await waitMode(ghost, 'ground')
    expectAt(ghost, { x: held.x, y: 0, z: held.z, mode: 'ground' }, 'dropped to the ground')
    const drop = gSeen.samples.slice(dropFrom)
    expect(modeSequence(drop)).toEqual(['hanging', 'falling', 'ground'])
    for (let i = 1; i < drop.length; i++) expect(drop[i].y, 'a drop never rises').toBeLessThanOrEqual(drop[i - 1].y + EPS)
  }

  // The warden walks out of the west door to the same anchor and is refused there (the ghost may be on it).
  const wardenRun = async () => {
    await warden.walkTo({ x: -11.5, z: 0 }, 'zx')
    await warden.walkTo({ x: -11.5, z: CLIMB_WEST.z }, 'xz')
    const stop = await warden.push(1, 0, 40)
    expect(Math.abs(stop.x - CLIMB_WEST.x)).toBeLessThan(EPS)
    const before = snapshot(warden)
    act(warden, 'climb')
    await settle(warden)
    expectAt(warden, before, 'warden climb at climb-west is refused')
  }

  await Promise.all([ghostRun(), wardenRun()])
  test.info().annotations.push({ type: 'west route', description: log.join('\n') })
  expect(wSeen.samples.filter((s) => s.mode !== 'ground' || Math.abs(s.y) > EPS), 'warden on the ground throughout').toEqual([])
  expect(modeSequence(gSeenByW.samples), "the observer's client saw the same transitions").toEqual(modeSequence(gSeen.samples))
  expectClean([ghost, warden], [
    { who: 'ghost', team: 'ghost', seen: gSeen },
    { who: "ghost (observer's view)", team: 'ghost', seen: gSeenByW },
    { who: 'warden', team: 'warden', seen: wSeen },
  ])
})

test('east route and Warden refusal: a Ghost climbs climb-east (no-op jump and climb while climbing, down to the ground, drop, re-grab) onto platform-east; a Warden is refused at every anchor spot on the way, takes the stairs and cannot grab a ledge while falling', async () => {
  test.setTimeout(90_000)
  const [g, wd] = await joinInOrder(2, open)
  const ghost = new Walker(g, 'ghost', { ground: false })
  const warden = new Walker(wd, 'warden', { ground: false })
  expect(ghost.state.team).toBe('ghost')
  expect(warden.state.team).toBe('warden')
  const gSeen = track(g, g.sessionId)
  const wSeen = track(wd, wd.sessionId)
  const wSeenByG = track(g, wd.sessionId)
  const log: string[] = []

  const ghostRun = async () => {
    // In through the south door, east south of the crates, north to the anchor inside the east wall.
    await ghost.walkTo({ x: 0, z: -5 }, 'xz')
    await ghost.walkTo({ x: CLIMB_EAST.x, z: -5 }, 'xz')
    await ghost.walkTo({ x: CLIMB_EAST.x, z: CLIMB_EAST.z }, 'xz')
    act(ghost, 'climb')
    await waitMode(ghost, 'climbing')
    const bottom = { x: CLIMB_EAST.x, y: CLIMB_EAST.minY, z: CLIMB_EAST.z, mode: 'climbing' }
    expectAt(ghost, bottom, 'grabbed climb-east')
    // Jump and climb while climbing change nothing; dx is ignored.
    act(ghost, 'jump')
    act(ghost, 'climb')
    await settle(ghost)
    expectAt(ghost, bottom, 'jump and climb while climbing')
    expect((await ghost.attachedStep(1, 0)).moved, 'dx while climbing').toBe(false)
    // Halfway up and back down: at minY over the ground it stands again.
    await climbMoves(ghost, 1, 8)
    expectAt(ghost, { ...bottom, y: 8 * CLIMB_STEP }, 'halfway up')
    // Down until it stands (8 moves, or 9 if float residue leaves the feet a hair above minY).
    let down = 0
    for (; down < 12 && own(ghost).mode === 'climbing'; down++) expect((await ghost.attachedStep(0, -1)).moved).toBe(true)
    expect(down).toBeGreaterThanOrEqual(8)
    expect(down).toBeLessThanOrEqual(9)
    expectAt(ghost, { ...bottom, mode: 'ground' }, 'climbed down to the ground')
    // Re-grab, halfway up, drop: falling with no upward speed, a drop while falling is a no-op, then the ground.
    await sleep(refillMs(ACTION_BURST))
    act(ghost, 'climb')
    await waitMode(ghost, 'climbing')
    await climbMoves(ghost, 1, 8)
    await sleep(refillMs(ACTION_BURST))
    const dropFrom = gSeen.samples.length - 1
    act(ghost, 'drop')
    await waitMode(ghost, 'falling')
    act(ghost, 'drop')
    await waitMode(ghost, 'ground')
    expectAt(ghost, { ...bottom, mode: 'ground' }, 'dropped to the ground')
    const drop = gSeen.samples.slice(dropFrom)
    expect(modeSequence(drop)).toEqual(['climbing', 'falling', 'ground'])
    for (let i = 1; i < drop.length; i++) expect(drop[i].y, 'a drop never rises').toBeLessThanOrEqual(drop[i - 1].y + EPS)
    // Up to ledge-east-platform and mantle onto platform-east.
    await sleep(refillMs(1))
    act(ghost, 'climb')
    await waitMode(ghost, 'climbing')
    const moves = await climbToTop(ghost, CLIMB_EAST)
    expect(moves).toBe(MOVES_TO_TOP(CLIMB_EAST))
    const ledge = ledgeAnchor(CLIMB_EAST.ledgeId)
    expectAt(ghost, { x: CLIMB_EAST.x, y: HANG_Y, z: CLIMB_EAST.z, mode: 'hanging' }, `hanging from ${ledge.id}`)
    expect(Math.abs(ghost.state.yaw - ledge.facing), 'yaw set to the ledge facing').toBeLessThan(EPS)
    act(ghost, 'climb')
    await waitMode(ghost, 'ground')
    expectAt(ghost, { x: 9, y: UPPER_LEVEL_Y, z: -1.5, mode: 'ground' }, 'mantled onto platform-east')
  }

  /** Sends climb where the warden stands; nothing may change. */
  const refuse = async (what: string) => {
    const before = snapshot(warden)
    act(warden, 'climb')
    await settle(warden)
    expectAt(warden, before, `warden climb ${what} is refused`)
    log.push(`refused: ${what} at ${before.x.toFixed(3)},${before.y.toFixed(3)},${before.z.toFixed(3)}`)
  }

  const wardenRun = async () => {
    // South under the catwalk to z -1.75 (north of the crates), east to the east wall.
    await warden.walkTo({ x: CLIMB_EAST.x, z: -1.75 }, 'zx')
    await warden.walkTo({ x: CLIMB_EAST.x, z: CLIMB_EAST.z }, 'xz')
    await refuse('on climb-east')
    await warden.walkTo({ x: 7.5, z: CLIMB_EAST.z }, 'xz')
    await refuse('under ledge-east-platform')
    await warden.walkTo({ x: -3, z: -1.75 }, 'zx')
    await refuse('under ledge-catwalk-south')
    await warden.walkTo({ x: -8.5, z: -1.75 }, 'xz')
    await refuse('under ledge-mezz-south')
    // Then the stairs: north under the mezzanine to z 0, east to the stairs' foot, up to landing-nw.
    await warden.walkTo({ x: -8.5, z: 0 }, 'xz')
    const stairs = GRAYBOX_MAP.ramps.find((r) => r.id === 'stairs-west')!
    await warden.walkTo({ x: (stairs.minX + stairs.maxX) / 2, z: 0 }, 'xz')
    for (let i = 0; i < 200 && warden.pos.z < 7 - 1e-6; i++) await warden.step(0, 1)
    expectAt(warden, { x: (stairs.minX + stairs.maxX) / 2, y: UPPER_LEVEL_Y, z: 7, mode: 'ground' }, 'warden at the top of the stairs')
    // Off the mezzanine's south edge, sending climb with ledge-mezz-south in a Ghost's reach.
    await warden.walkTo({ x: -8.5, z: 7 }, 'xz')
    const sentAt = await walkOffAndGrab(warden)
    log.push(`warden climb while falling past ledge-mezz-south sent at y ${sentAt.map((y) => y.toFixed(3)).join(', ')}`)
    expect(sentAt.length, 'the warden sent climb in a ledge grab window').toBeGreaterThan(0)
    await waitMode(warden, 'ground')
    expect(Math.abs(feetY(warden.state)), 'the warden fell to the ground').toBeLessThan(EPS)
  }

  await Promise.all([ghostRun(), wardenRun()])
  test.info().annotations.push({ type: 'warden refusals', description: log.join('\n') })
  for (const s of [wSeen, wSeenByG]) {
    expect(s.samples.filter((v) => v.mode !== 'ground' && v.mode !== 'falling'), 'warden only ever ground or falling').toEqual([])
    expect(Math.max(...s.samples.map((v) => v.y)), 'warden never above the upper level').toBeLessThanOrEqual(UPPER_LEVEL_Y + EPS)
  }
  // The warden left the ground only by the stairs (ground on the ramp) and fell only after walking off.
  expect(modeSequence(wSeen.samples)).toEqual(['ground', 'falling', 'ground'])
  expectClean([ghost, warden], [
    { who: 'ghost', team: 'ghost', seen: gSeen },
    { who: 'warden', team: 'warden', seen: wSeen },
    { who: "warden (ghost's view)", team: 'warden', seen: wSeenByG },
  ])
})

test('forged climbs: far from every anchor, a plain climb, a 100 Hz climb flood and climbs with forged anchorId, x, y, z and mode never change a Ghost or a Warden', async () => {
  const [g, wd] = await joinInOrder(2, open)
  const ghost = new Walker(g, 'ghost', { ground: false })
  const warden = new Walker(wd, 'warden', { ground: false })
  const views = [
    { w: ghost, seen: track(g, g.sessionId), team: 'ghost' as Team },
    { w: warden, seen: track(wd, wd.sessionId), team: 'warden' as Team },
  ]
  for (const { w } of views) {
    // Spawns are far from every anchor: the climb-anchor and ledge checks can't pass.
    const p = w.pos
    for (const a of CLIMBS) expect(Math.hypot(p.x - a.x, p.z - a.z)).toBeGreaterThan(2)
    for (const l of LEDGES) expect(ledgeDistance(l, p)).toBeGreaterThan(2)
  }
  const forged: object[] = [
    {},
    { anchorId: 'climb-west', x: CLIMB_WEST.x, y: 1, z: CLIMB_WEST.z },
    { anchorId: 'climb-east', x: CLIMB_EAST.x, y: CLIMB_EAST.maxY, z: CLIMB_EAST.z, mode: 'climbing' },
    { anchorId: 'ledge-catwalk-south', x: 0, y: HANG_Y, z: -1.5, mode: 'hanging', ledgeId: 'ledge-catwalk-south' },
    { anchorId: 'ledge-west-wall', x: -9.5, y: UPPER_LEVEL_Y, z: 4.5, mode: 'ground', team: 'ghost' },
  ]
  const run = async (w: Walker) => {
    for (const extra of forged) {
      act(w, 'climb', extra)
      await settle(w)
      await sleep(refillMs(1))
    }
    // Flood: about 100 Hz for 1 s, forged fields on every other one.
    const t0 = Date.now()
    let sent = 0
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        act(w, 'climb', sent % 2 ? forged[sent % forged.length] : {})
        sent++
        if (Date.now() - t0 >= 1000) {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })
    await settle(w)
    expect(sent).toBeGreaterThan(30)
    expect(w.room.connection.isOpen, `${w.name} still connected after the flood`).toBe(true)
  }
  await Promise.all([run(ghost), run(warden)])
  for (const { w, seen, team } of views) {
    // One distinct (x, y, z, mode) the whole time: barriers only turn the player.
    expect(seen.samples.map((s) => [s.x, s.y, s.z, s.mode]), `${w.name}'s position and mode never change`).toEqual([[seen.samples[0].x, 0, seen.samples[0].z, 'ground']])
    expect(seen.bad).toEqual([])
    expect(sampleProblems(seen.samples, team)).toEqual([])
    expect(w.violations).toEqual([])
  }
})
