import { expect, test } from '@playwright/test'
import {
  DAMAGED_EVENT,
  EYE_HEIGHT,
  FIRE_MESSAGE,
  HIT_EVENT,
  SHOT_EVENT,
  WEAPONS,
  MAX_HEALTH,
  type DamagedEvent,
  type HitEvent,
  type ShotEvent,
} from '../../shared/protocol.js'
import { PLAYER_HEIGHT } from '../../shared/map.js'
import { feetY } from './support/geometry.js'
import { Walker, joinInOrder, waitForState, type GameRoom } from './support/sdk.js'
import { collectEvents, vitalsOf } from './support/vitals.js'

// M5 hitscan fire (#41, verified in #42) through real @colyseus/sdk clients:
// walls stop shots, line-of-sight hits do the weapon's damage and spend one
// round, the server caps a forged rapid-fire client by cooldown and magazine,
// invalid payloads change nothing and spend no token, teammates are passed
// through, a Warden up the stairs is hit at his real height, and the shot /
// hit / damaged events go to the right clients. Geometry is covered by Mocha
// (server/test/ballistics.test.ts); this spec only adds what needs a real
// server and real clients. Expected numbers come from shared/ (WEAPONS,
// MAX_HEALTH, EYE_HEIGHT), not from server rule code.
//
// Per Docs/handoff.md: problems are collected in arrays and asserted once,
// after the SDK clients have left; spawns are random, so a test reads the
// positions it was given; the server steps every 50 ms.

test.describe.configure({ mode: 'parallel' })

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => (r.connection.isOpen ? r.leave().catch(() => {}) : undefined)))
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const GHOST = WEAPONS.ghost
const WARDEN = WEAPONS.warden
/** Server clock step; cadence checks allow one extra step of slack. */
const STEP_MS = 50
/** Wait that clears either weapon's cooldown (300 ms for the Ghost) and the 10 Hz bucket. */
const COOL_MS = 450
/** Floats cross the wire as float32. */
const TOL = 1e-3

const me = (r: GameRoom) => r.sessionId
const health = (viewer: GameRoom, id: string) => vitalsOf(viewer, id)?.health
const ammo = (viewer: GameRoom, id: string) => vitalsOf(viewer, id)?.ammo

function fire(r: GameRoom, payload: unknown) {
  r.send(FIRE_MESSAGE, payload)
}

/** Yaw and pitch from `shooter`'s eye to the middle of `target`'s box, as `viewer` sees them (plus an optional drop in u). */
function aimAt(viewer: GameRoom, shooterId: string, targetId: string, targetY?: number) {
  const s = viewer.state.players.get(shooterId) as unknown as { x: number; y: number; z: number }
  const t = viewer.state.players.get(targetId) as unknown as { x: number; y: number; z: number }
  const dx = t.x - s.x
  const dz = t.z - s.z
  const dy = (targetY ?? feetY(t) + PLAYER_HEIGHT / 2) - (feetY(s) + EYE_HEIGHT)
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
}

/** Message barrier: a turn is a move, and one client's messages are handled in order. */
async function barrier(w: Walker): Promise<void> {
  await w.face(Math.abs(w.state.yaw - 0.5) < 0.1 ? 0.25 : 0.5)
}

function waitValue(r: GameRoom, what: string, read: () => number | undefined, want: number) {
  return waitForState(r, what, () => read() === want)
}

/** Registers no-op handlers so the SDK doesn't warn about event types a test doesn't read. */
function quiet(...rooms: GameRoom[]) {
  for (const r of rooms) for (const t of [SHOT_EVENT, HIT_EVENT, DAMAGED_EVENT]) r.onMessage(t, () => {})
}

/** A Ghost and a Warden at spawn, tracked by Walkers. */
async function pair() {
  const [g, w] = await joinInOrder(2, open)
  quiet(g, w)
  return {
    g,
    w,
    gw: new Walker(g, 'ghost', { ground: false }),
    ww: new Walker(w, 'warden', { ground: false }),
  }
}

test('a shot through a wall never hits, and stops at the wall', async () => {
  const { g, w, gw, ww } = await pair()
  const gid = me(g)
  const wid = me(w)
  const shots = collectEvents<ShotEvent>(g, SHOT_EVENT)
  const hits = collectEvents<HitEvent>(w, HIT_EVENT)
  // Both walk east, so the straight line between them crosses the south wall
  // east of the doorway (x -1.5..1.5), never through it.
  await Promise.all([gw.walkTo({ x: 3.9, z: gw.pos.z }), ww.walkTo({ x: 2.9, z: ww.pos.z })])
  const volleys = 3
  for (let i = 0; i < volleys; i++) {
    fire(w, aimAt(w, wid, gid))
    await sleep(COOL_MS)
  }
  await waitValue(w, 'warden spent three rounds', () => ammo(w, wid), WARDEN.magazine - volleys)
  await waitForState(g, 'ghost sees three shots', () => ammo(g, wid) === WARDEN.magazine - volleys)
  await sleep(100)
  const result = {
    ghostHealth: [health(g, gid), health(w, gid)],
    shots: shots.events.slice(),
    hits: hits.events.slice(),
    ghostX: gw.state.x,
    wardenX: ww.state.x,
    violations: [...gw.violations, ...ww.violations],
  }
  await Promise.all(open.splice(0).map((r) => r.leave().catch(() => {})))

  expect(result.violations).toEqual([])
  expect(result.ghostX, 'ghost is east of the doorway').toBeGreaterThan(3)
  expect(result.wardenX, 'warden is east of the doorway').toBeGreaterThan(2)
  expect(result.ghostHealth).toEqual([MAX_HEALTH.ghost, MAX_HEALTH.ghost])
  expect(result.hits, 'no hit event for a wall').toEqual([])
  expect(result.shots).toHaveLength(volleys)
  for (const s of result.shots) {
    expect(s.hit).toBe(false)
    // The ray started north of the south wall's inner face (z -7.5) and ended on it.
    expect(Math.abs(s.end.z - -7.5), `end ${JSON.stringify(s.end)} is on the wall face`).toBeLessThan(TOL)
  }
})

test('line of sight: hits, damage, ammo, events, height, forged fields and cadence', async () => {
  test.setTimeout(60_000)
  const { g, w, gw, ww } = await pair()
  const gid = me(g)
  const wid = me(w)
  const gShots = collectEvents<ShotEvent>(g, SHOT_EVENT)
  const wShots = collectEvents<ShotEvent>(w, SHOT_EVENT)
  const gHit = collectEvents<HitEvent>(g, HIT_EVENT)
  const wHit = collectEvents<HitEvent>(w, HIT_EVENT)
  const gDamaged = collectEvents<DamagedEvent>(g, DAMAGED_EVENT)
  const wDamaged = collectEvents<DamagedEvent>(w, DAMAGED_EVENT)

  // The Ghost walks in through the south doorway to (-0.9, -6); the Warden
  // walks to the foot of the west stairs and up them to z 3 (about 1.6 u up).
  await Promise.all([
    (async () => {
      await gw.walkTo({ x: -0.9, z: gw.pos.z })
      await gw.walkTo({ x: -0.9, z: -6 }, 'zx')
    })(),
    (async () => {
      await ww.walkTo({ x: -6.7, z: 0 }, 'zx')
      await ww.walkTo({ x: -6.7, z: 3 }, 'zx')
    })(),
  ])
  const wardenY = feetY(ww.state)

  // 1. Warden rifle hit on the Ghost (shooting down at the Ghost).
  fire(w, aimAt(w, wid, gid))
  await waitValue(g, 'ghost loses rifle damage', () => health(g, gid), MAX_HEALTH.ghost - WARDEN.damage)
  await waitValue(w, 'warden ammo 29', () => ammo(w, wid), WARDEN.magazine - 1)
  await sleep(COOL_MS)

  // 2. Ghost sidearm hit on the Warden, who is up the stairs (hit at his real height).
  const aimUp = aimAt(g, gid, wid)
  fire(g, aimUp)
  await waitValue(w, 'warden loses sidearm damage', () => health(w, wid), MAX_HEALTH.warden - GHOST.damage)
  await waitValue(g, 'ghost ammo 11', () => ammo(g, gid), GHOST.magazine - 1)
  await sleep(COOL_MS)

  // 3. Aimed at a Warden standing on the ground under the stairs: misses (the ramp is in the way).
  fire(g, aimAt(g, gid, wid, PLAYER_HEIGHT / 2))
  await waitValue(g, 'ghost ammo 10', () => ammo(g, gid), GHOST.magazine - 2)
  await sleep(COOL_MS)
  const afterLowAim = health(w, wid)

  // 4. Forged fields: damage 999 and a target are ignored; the hit does rifle damage.
  fire(w, { ...aimAt(w, wid, gid), damage: 999, target: wid, hit: true, health: 0 })
  await waitValue(g, 'ghost loses exactly rifle damage', () => health(g, gid), MAX_HEALTH.ghost - 2 * WARDEN.damage)
  await sleep(COOL_MS)
  // ...and a forged target does not turn a shot into a hit.
  fire(w, { yaw: 0, pitch: 1, damage: 999, target: gid })
  await waitValue(w, 'warden ammo 27', () => ammo(w, wid), WARDEN.magazine - 3)
  await sleep(COOL_MS)

  // 5. Forged rapid fire from the Ghost: a fire every 10 ms for 2 s.
  const healthBefore = health(w, wid)!
  const ammoBefore = ammo(g, gid)!
  const started = Date.now()
  while (Date.now() - started < 2000) {
    fire(g, aimUp)
    await sleep(10)
  }
  await barrier(gw)
  const elapsed = Date.now() - started
  await sleep(100)
  const spent = ammoBefore - ammo(g, gid)!
  const lost = healthBefore - health(w, wid)!

  const result = {
    wardenY,
    afterLowAim,
    gHealthSeenByW: health(w, gid),
    wHealthSeenByG: health(g, wid),
    spent,
    lost,
    elapsed,
    gShots: gShots.events.slice(),
    wShots: wShots.events.slice(),
    gHit: gHit.events.slice(),
    wHit: wHit.events.slice(),
    gDamaged: gDamaged.events.slice(),
    wDamaged: wDamaged.events.slice(),
    violations: [...gw.violations, ...ww.violations],
    gAmmoSeenByW: ammo(w, gid),
    wAmmoSeenByG: ammo(g, wid),
  }
  await Promise.all(open.splice(0).map((r) => r.leave().catch(() => {})))

  expect(result.violations).toEqual([])
  expect(result.wardenY, 'the Warden is well up the stairs').toBeGreaterThan(1.2)
  expect(result.afterLowAim, 'a shot at ground height under the stairs missed').toBe(MAX_HEALTH.warden - GHOST.damage)
  // Both clients agree on health and ammo.
  expect(result.gHealthSeenByW).toBe(MAX_HEALTH.ghost - 2 * WARDEN.damage)
  expect(result.wHealthSeenByG).toBe(result.afterLowAim - result.lost)
  expect(result.wAmmoSeenByG).toBe(WARDEN.magazine - 3)

  // Forged rapid fire: at most one shot per interval (plus the first and one server step), at least a few.
  const cap = Math.floor((result.elapsed + 2 * STEP_MS) / GHOST.intervalMs) + 1
  expect(result.spent, `spent ${result.spent} rounds in ${result.elapsed} ms`).toBeLessThanOrEqual(cap)
  expect(result.spent).toBeGreaterThanOrEqual(4)
  expect(result.lost, 'every accepted shot hit for the sidearm damage').toBe(result.spent * GHOST.damage)

  // Events. Shots: the Warden's reach both clients, the Ghost's only the Ghost.
  const wardenShots = (list: ShotEvent[]) => list.filter((s) => s.shooter === wid)
  const ghostShots = (list: ShotEvent[]) => list.filter((s) => s.shooter === gid)
  expect(wardenShots(result.gShots), 'ghost client heard the rifle').toHaveLength(3)
  expect(wardenShots(result.wShots), 'warden client heard the rifle').toHaveLength(3)
  expect(ghostShots(result.wShots), 'the suppressed sidearm never reaches the Warden').toEqual([])
  expect(ghostShots(result.gShots), 'ghost client got its own shots').toHaveLength(2 + result.spent)
  const first = wardenShots(result.gShots)[0]
  expect(first.team).toBe('warden')
  expect(first.hit).toBe(true)
  expect(Math.abs(first.origin.y - (wardenY + EYE_HEIGHT)), 'the ray starts at the shooter eye').toBeLessThan(TOL)
  // Shooter-side confirmation, victim-side notice.
  expect(result.wHit.map((h) => [h.target, h.damage, h.killed])).toEqual([
    [gid, WARDEN.damage, false],
    [gid, WARDEN.damage, false],
  ])
  expect(result.gHit).toHaveLength(1 + result.spent)
  expect(result.gHit[0]).toEqual({ target: wid, damage: GHOST.damage, killed: false })
  expect(result.gDamaged.map((d) => d.health)).toEqual([MAX_HEALTH.ghost - WARDEN.damage, MAX_HEALTH.ghost - 2 * WARDEN.damage])
  expect(result.wDamaged).toHaveLength(1 + result.spent)
  expect(result.wDamaged[0]).toEqual({ damage: GHOST.damage, health: MAX_HEALTH.warden - GHOST.damage, killed: false })
  for (const d of [...result.gDamaged, ...result.wDamaged]) {
    // No shooter id and no position.
    expect(Object.keys(d).sort()).toEqual(['damage', 'health', 'killed'])
  }
})

test('a forged rapid-fire Warden is capped by the cooldown; an empty magazine cannot fire', async () => {
  test.setTimeout(60_000)
  const { g, w, ww } = await pair()
  const wid = me(w)
  const heard = collectEvents<ShotEvent>(g, SHOT_EVENT)
  const ammoSeen: number[] = []
  w.onStateChange(() => {
    const a = ammo(w, wid)
    if (a !== undefined) ammoSeen.push(a)
  })
  // Aim at the sky so nothing is hit; ammo and shot events are the evidence.
  const sky = { yaw: 0, pitch: 1 }
  const started = Date.now()
  while (Date.now() - started < 2000) {
    fire(w, sky)
    await sleep(10)
  }
  await barrier(ww)
  const elapsed = Date.now() - started
  await sleep(100)
  const spentAt2s = WARDEN.magazine - ammo(w, wid)!
  // Keep hammering until the magazine is empty, then a second more.
  const limit = Date.now() + 15_000
  while (ammo(w, wid)! > 0 && Date.now() < limit) {
    fire(w, sky)
    await sleep(10)
  }
  const emptyAt = Date.now()
  while (Date.now() - emptyAt < 1000) {
    fire(w, sky)
    await sleep(10)
  }
  await barrier(ww)
  await sleep(150)
  const finalAmmo = ammo(w, wid)
  const shotCount = heard.events.filter((s) => s.shooter === wid).length
  await Promise.all(open.splice(0).map((r) => r.leave().catch(() => {})))

  const cap = Math.floor((elapsed + 2 * STEP_MS) / WARDEN.intervalMs) + 1
  expect(spentAt2s, `spent ${spentAt2s} rounds in ${elapsed} ms`).toBeLessThanOrEqual(cap)
  expect(spentAt2s).toBeGreaterThanOrEqual(6)
  expect(finalAmmo, 'the magazine empties, never below 0').toBe(0)
  expect(Math.min(...ammoSeen)).toBeGreaterThanOrEqual(0)
  expect(shotCount, 'exactly one shot event per round, none after the magazine is empty').toBe(WARDEN.magazine)
})

test('invalid fire payloads change nothing and spend no token', async () => {
  const { g, w, ww } = await pair()
  const gid = me(g)
  const wid = me(w)
  const heard = collectEvents<ShotEvent>(g, SHOT_EVENT)
  const hits = collectEvents<HitEvent>(w, HIT_EVENT)
  const invalid: unknown[] = [
    null,
    undefined,
    [],
    [0, 0],
    'fire',
    '',
    7,
    true,
    {},
    { yaw: 0 },
    { pitch: 0 },
    { yaw: '0', pitch: 0 },
    { yaw: 0, pitch: null },
    { yaw: NaN, pitch: 0 },
    { yaw: 0, pitch: Infinity },
  ]
  for (const p of invalid) fire(w, p)
  // Straight after (the bucket holds 3 and refills at 10 per second): a valid shot is accepted.
  fire(w, { yaw: 0, pitch: 1 })
  await barrier(ww)
  await waitValue(w, 'valid shot after invalid ones is accepted', () => ammo(w, wid), WARDEN.magazine - 1)
  const afterInvalid = ammo(w, wid)
  await sleep(COOL_MS)
  // A huge but finite yaw is a valid aim (wrapped by the server); it just spends a round.
  fire(w, { yaw: 1e308, pitch: 1 })
  await barrier(ww)
  await sleep(100)
  const afterHuge = ammo(w, wid)!
  await sleep(COOL_MS)
  fire(w, { yaw: 0, pitch: 1 })
  await waitValue(w, 'the connection survived 1e308', () => ammo(w, wid), afterHuge - 1)
  const result = {
    afterInvalid,
    afterHuge,
    finalAmmo: ammo(w, wid)!,
    ghostHealth: health(g, gid),
    shots: heard.events.length,
    hits: hits.events.length,
    open: w.connection.isOpen && g.connection.isOpen,
  }
  await Promise.all(open.splice(0).map((r) => r.leave().catch(() => {})))

  expect(result.afterInvalid, 'only the one valid shot spent a round').toBe(WARDEN.magazine - 1)
  expect([WARDEN.magazine - 2, WARDEN.magazine - 1]).toContain(result.afterHuge)
  expect(result.ghostHealth).toBe(MAX_HEALTH.ghost)
  expect(result.hits).toBe(0)
  expect(result.shots, 'one shot event per round spent').toBe(WARDEN.magazine - result.finalAmmo)
  expect(result.open).toBe(true)
})

test('shots pass through teammates, for both teams', async () => {
  const rooms = await joinInOrder(4, open)
  // Join order alternates teams: ghost, warden, ghost, warden.
  const [g1, w1, g2, w2] = rooms
  quiet(...rooms)
  const shots = collectEvents<ShotEvent>(g1, SHOT_EVENT)
  const hitsW = collectEvents<HitEvent>(w1, HIT_EVENT)
  const hitsG = collectEvents<HitEvent>(g1, HIT_EVENT)
  fire(w1, aimAt(w1, me(w1), me(w2)))
  fire(g1, aimAt(g1, me(g1), me(g2)))
  await waitValue(w1, 'warden spent a round', () => ammo(w1, me(w1)), WARDEN.magazine - 1)
  await waitValue(g1, 'ghost spent a round', () => ammo(g1, me(g1)), GHOST.magazine - 1)
  await sleep(150)
  const result = {
    w2: health(w1, me(w2)),
    g2: health(g1, me(g2)),
    hitsW: hitsW.events.length,
    hitsG: hitsG.events.length,
    shots: shots.events.map((s) => [s.team, s.hit]),
  }
  await Promise.all(open.splice(0).map((r) => r.leave().catch(() => {})))

  expect(result.w2).toBe(MAX_HEALTH.warden)
  expect(result.g2).toBe(MAX_HEALTH.ghost)
  expect(result.hitsW + result.hitsG).toBe(0)
  expect(result.shots.sort()).toEqual([['ghost', false], ['warden', false]])
})
