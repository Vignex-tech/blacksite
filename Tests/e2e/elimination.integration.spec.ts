import { expect, test } from '@playwright/test'
import {
  ACTION_MESSAGE,
  DAMAGED_EVENT,
  EYE_HEIGHT,
  FIRE_MESSAGE,
  HIT_EVENT,
  MAX_HEALTH,
  MOVE_MESSAGE,
  RELOAD_MESSAGE,
  SHOT_EVENT,
  WEAPONS,
  type DamagedEvent,
  type HitEvent,
  type ShotEvent,
  type Team,
} from '../../shared/protocol.js'
import { feetY } from './support/geometry.js'
import { Walker, godView, joinInOrder, joinRoom, leaveRoom, mustSee, pos, teamOf, waitForState, whenVisible, type GameRoom } from './support/sdk.js'
import { visibilityOf } from './support/visibility.js'
import { collectEvents, vitalsOf } from './support/vitals.js'

// M5 reload, kills and eliminated players (#43, verified in #44) through real
// @colyseus/sdk clients. Reload timing and the killing blow are checked end to
// end; the finer rules (reload refused with a full magazine, same-step kills,
// a hanging body falling and settling, the token not being spent) are Mocha
// tests in server/test/MyRoomReload.test.ts, and the hanging case is not
// repeated here because getting a Ghost onto a ledge in front of a Warden's
// line of sight would add a long walk. Expected numbers come from shared/.
//
// Since #45 these specs hold with the M5 visibility filter (#46): a Warden
// client is not sent a Ghost it can't see. The two players first walk onto the
// south doorway line, so the Warden does see the Ghost (`whenVisible`); aim
// angles and "is it still in the room" are read from the Ghost client (sent
// every player); a fresh Ghost that joins after a kill is not required to be
// visible to the Warden.
//
// Per Docs/handoff.md: problems are collected and asserted once, after the SDK
// clients have left; the server steps every 50 ms; spawns are random, so the
// two players first walk onto the line x = 0, which runs through the south
// doorway (x -1.5..1.5) and over the low cover wall (1.2 high) when aimed at
// the head.

test.describe.configure({ mode: 'parallel' })

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => (r.connection.isOpen ? r.leave().catch(() => {}) : undefined)))
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const GHOST = WEAPONS.ghost
const WARDEN = WEAPONS.warden
/** Hits that take a player from full health to 0 with the other team's weapon. */
const HITS_TO_KILL_GHOST = Math.ceil(MAX_HEALTH.ghost / WARDEN.damage)
const HITS_TO_KILL_WARDEN = Math.ceil(MAX_HEALTH.warden / GHOST.damage)
/** Head height used for aiming, so the ray clears the low cover wall. */
const HEAD_Y = 1.7
const SKY = { yaw: 0, pitch: 1 }
/** Reload timing: the server checks completion on its 50 ms step; allow message latency and a busy worker. */
const RELOAD_SLACK_BELOW = 150
const RELOAD_SLACK_ABOVE = 600

const me = (r: GameRoom) => r.sessionId
const health = (viewer: GameRoom, id: string) => vitalsOf(viewer, id)?.health
const ammo = (viewer: GameRoom, id: string) => vitalsOf(viewer, id)?.ammo
const fire = (r: GameRoom, payload: unknown) => r.send(FIRE_MESSAGE, payload)
const waitValue = (r: GameRoom, what: string, read: () => unknown, want: unknown) =>
  waitForState(r, what, () => read() === want)

function quiet(...rooms: GameRoom[]) {
  for (const r of rooms) for (const t of [SHOT_EVENT, HIT_EVENT, DAMAGED_EVENT]) r.onMessage(t, () => {})
}

/** Yaw and pitch from the shooter's eye to the target's head, as `viewer` sees them. `viewer` must be a Ghost client: a Warden client is not sent a Ghost it can't see. */
function aimAtHead(viewer: GameRoom, shooterId: string, targetId: string) {
  const s = viewer.state.players.get(shooterId) as unknown as { x: number; y: number; z: number }
  const t = viewer.state.players.get(targetId) as unknown as { x: number; y: number; z: number }
  const dx = t.x - s.x
  const dz = t.z - s.z
  const dy = feetY(t) + HEAD_Y - (feetY(s) + EYE_HEIGHT)
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
}

/** Of two clients, the one that is a Ghost: it is sent every player. */
function godViewOf(a: GameRoom, b: GameRoom): GameRoom {
  return godView([a, b])
}

/** What a client can see of one player: position, facing, mode and vitals. */
function snap(viewer: GameRoom, id: string) {
  const p = pos(viewer, id)
  return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, mode: p.mode, ...vitalsOf(viewer, id) }
}

/** A Ghost and a Warden walked onto x = 0 (south doorway line). */
async function faceOff() {
  const [g, w] = await joinInOrder(2, open)
  quiet(g, w)
  const gw = new Walker(g, 'ghost', { ground: false })
  const ww = new Walker(w, 'warden', { ground: false })
  await Promise.all([gw.walkTo({ x: 0, z: gw.pos.z }), ww.walkTo({ x: 0, z: ww.pos.z })])
  // On the doorway line the Warden sees the Ghost (its head clears the 1.2 cover), so the
  // Warden client is sent it; wait for that before anything reads the Ghost from the Warden.
  expect(visibilityOf(ww.state, gw.state), 'the Ghost is not hidden from the Warden on x = 0').not.toBe('hidden')
  await whenVisible(w, g.sessionId)
  return { g, w, gw, ww }
}

/**
 * Hammers an eliminated client with every kind of input, some forged, for
 * about 1.5 s: moves, actions, fire at the opponent and reloads. Streams run
 * side by side (separate rate limits), spaced so a server that wrongly
 * accepted them would show it.
 */
async function hammer(dead: GameRoom, opponent: GameRoom) {
  const aim = aimAtHead(godViewOf(dead, opponent), me(dead), me(opponent))
  const moves = (async () => {
    const payloads: unknown[] = [
      { dx: 1, dz: 0, yaw: 1 },
      { dx: 0, dz: 1 },
      { dx: -1, dz: -1, yaw: -2 },
      { dx: 1e6, dz: 1e6, x: 50, y: 5, z: 50, mode: 'ground', health: 100 },
      { dx: 0, dz: 0, yaw: 2.5 },
    ]
    for (const p of payloads) {
      dead.send(MOVE_MESSAGE, p)
      await sleep(70)
    }
  })()
  const actions = (async () => {
    for (const action of ['jump', 'climb', 'drop', 'jump']) {
      dead.send(ACTION_MESSAGE, { action, y: 9, mode: 'hanging' })
      await sleep(250)
    }
  })()
  const shooting = (async () => {
    for (let i = 0; i < 3; i++) {
      fire(dead, i === 2 ? { ...aim, damage: 999, target: me(opponent), hit: true } : aim)
      await sleep(180)
      dead.send(RELOAD_MESSAGE, {})
      await sleep(120)
    }
  })()
  await Promise.all([moves, actions, shooting])
  await sleep(500)
}

/**
 * Shared body of the two kill tests: `shooter` kills `victim` one hit at a
 * time, then the dead victim is hammered, then it leaves and rejoins.
 */
async function killAndLockOut(shooterTeam: Team) {
  const { g, w, gw, ww } = await faceOff()
  const shooter = shooterTeam === 'ghost' ? g : w
  const victim = shooterTeam === 'ghost' ? w : g
  const weapon = WEAPONS[shooterTeam]
  const victimTeam: Team = shooterTeam === 'ghost' ? 'warden' : 'ghost'
  const hitsToKill = shooterTeam === 'ghost' ? HITS_TO_KILL_WARDEN : HITS_TO_KILL_GHOST
  const sid = me(shooter)
  const vid = me(victim)
  const rooms = [g, w]
  const hits = collectEvents<HitEvent>(shooter, HIT_EVENT)
  const damaged = collectEvents<DamagedEvent>(victim, DAMAGED_EVENT)

  // The victim spends a round first, so a later reload would have something to refill.
  fire(victim, SKY)
  await waitValue(victim, 'victim spent a round', () => ammo(victim, vid), WEAPONS[victimTeam].magazine - 1)

  const healthAfterHit: (number | undefined)[] = []
  for (let i = 1; i <= hitsToKill; i++) {
    await sleep(weapon.intervalMs + 100)
    fire(shooter, aimAtHead(godViewOf(shooter, victim), sid, vid))
    const want = Math.max(0, MAX_HEALTH[victimTeam] - i * weapon.damage)
    await waitValue(shooter, `hit ${i} lands`, () => health(shooter, vid), want)
    healthAfterHit.push(health(shooter, vid))
  }
  await waitValue(victim, 'victim sees its own death', () => health(victim, vid), 0)

  const before = { dead: snap(victim, vid), seenByOther: snap(shooter, vid), shooter: snap(shooter, sid) }
  await hammer(victim, shooter)
  const after = { dead: snap(victim, vid), seenByOther: snap(shooter, vid), shooter: snap(shooter, sid) }
  const everything = godViewOf(shooter, victim) // the Ghost client is sent both players
  const stillInRoom = victim.connection.isOpen && everything.state.players.has(vid) && everything.state.players.size === 2
  const violations = [...gw.violations, ...ww.violations]

  // The dead client leaves and a new one joins: a fresh live player.
  const live = [...rooms]
  await leaveRoom(victim, live)
  const rejoined = await joinRoom(shooter.roomId, live, open)
  const fresh = { ...snap(rejoined, me(rejoined)), team: pos(rejoined, me(rejoined)).team }
  // The shooter sees the fresh player only if it must: a Warden shooter is not sent a fresh Ghost (the filter).
  const freshSeenByOther = shooter.state.players.has(me(rejoined)) ? snap(shooter, me(rejoined)) : undefined
  const freshSentWhenRequired = shooter.state.players.has(me(rejoined)) || !mustSee(teamOf(shooter), fresh.team)
  const oldGone = [shooter, rejoined].every((r) => !r.state.players.has(vid))
  rejoined.onMessage(SHOT_EVENT, () => {})
  const rejoinedAmmo = WEAPONS[fresh.team].magazine
  fire(rejoined, SKY)
  await waitValue(rejoined, 'fresh player can shoot', () => ammo(rejoined, me(rejoined)), rejoinedAmmo - 1)

  const result = {
    healthAfterHit,
    hits: hits.events.slice(),
    damaged: damaged.events.slice(),
    before,
    after,
    stillInRoom,
    fresh,
    freshSeenByOther,
    freshSentWhenRequired,
    oldGone,
    violations,
  }
  await Promise.all(open.splice(0).map((r) => (r.connection.isOpen ? r.leave().catch(() => {}) : undefined)))
  return { result, hitsToKill, weapon, victimTeam }
}

test('Ghost kill: four rifle hits eliminate it, then it cannot move, act, fire or reload; rejoining gives a fresh player', async () => {
  test.setTimeout(60_000)
  const { result, hitsToKill, victimTeam } = await killAndLockOut('warden')
  expect(result.violations).toEqual([])
  expect(victimTeam).toBe('ghost')
  expect(result.healthAfterHit).toEqual(
    Array.from({ length: hitsToKill }, (_, i) => Math.max(0, MAX_HEALTH.ghost - (i + 1) * WARDEN.damage)),
  )
  expect(result.healthAfterHit.at(-2), 'still alive one hit earlier').toBeGreaterThan(0)
  expect(result.hits).toHaveLength(hitsToKill)
  expect(result.hits.map((h) => h.killed)).toEqual([...Array(hitsToKill - 1).fill(false), true])
  expect(result.damaged.at(-1)).toEqual({ damage: WARDEN.damage, health: 0, killed: true })
  expectLockedOut(result)
})

test('Warden kill: ten sidearm hits eliminate it, then it cannot move, act, fire or reload; rejoining gives a fresh player', async () => {
  test.setTimeout(60_000)
  const { result, hitsToKill, victimTeam } = await killAndLockOut('ghost')
  expect(result.violations).toEqual([])
  expect(victimTeam).toBe('warden')
  expect(result.healthAfterHit).toEqual(
    Array.from({ length: hitsToKill }, (_, i) => Math.max(0, MAX_HEALTH.warden - (i + 1) * GHOST.damage)),
  )
  expect(result.healthAfterHit.at(-2), 'still alive one hit earlier').toBeGreaterThan(0)
  expect(result.hits).toHaveLength(hitsToKill)
  expect(result.hits.at(-1)).toEqual({ target: expect.any(String), damage: GHOST.damage, killed: true })
  expect(result.hits.filter((h) => h.killed)).toHaveLength(1)
  expect(result.damaged.at(-1)).toEqual({ damage: GHOST.damage, health: 0, killed: true })
  expectLockedOut(result)
})

test('the gate: a Ghost dies in fewer hits than a Warden', () => {
  expect(HITS_TO_KILL_GHOST).toBe(4)
  expect(HITS_TO_KILL_WARDEN).toBe(10)
  expect(HITS_TO_KILL_GHOST).toBeLessThan(HITS_TO_KILL_WARDEN)
})

function expectLockedOut(result: Awaited<ReturnType<typeof killAndLockOut>>['result']) {
  expect(result.before.dead.health).toBe(0)
  expect(result.after.dead, 'eliminated client: nothing about it changed').toEqual(result.before.dead)
  expect(result.after.seenByOther, 'and the other client sees the same').toEqual(result.before.seenByOther)
  expect(result.after.shooter, 'its forged input hurt, moved and spent nothing on the other player').toEqual(result.before.shooter)
  expect(result.after.dead.reloading, 'a reload did not start').toBeFalsy()
  expect(result.stillInRoom, 'the dead player stays in the room, connected').toBe(true)
  // Fresh player after leave and rejoin.
  expect(result.oldGone).toBe(true)
  expect(result.fresh.health).toBe(MAX_HEALTH[result.fresh.team])
  expect(result.fresh.mode).toBe('ground')
  expect(result.fresh.ammo).toBe(WEAPONS[result.fresh.team].magazine)
  expect(result.fresh.reloading).toBeFalsy()
  expect(result.freshSentWhenRequired, 'the shooter is sent the fresh player when it must be').toBe(true)
  if (result.freshSeenByOther) expect(result.freshSeenByOther.health).toBe(MAX_HEALTH[result.fresh.team])
}

test('reload takes about reloadMs, refills the magazine, blocks fire meanwhile; a second reload or a flood changes nothing', async () => {
  test.setTimeout(60_000)
  const [g, w] = await joinInOrder(2, open)
  quiet(g, w)
  const one = async (r: GameRoom, team: Team) => {
    const id = me(r)
    const wp = WEAPONS[team]
    const shots = collectEvents<ShotEvent>(r, SHOT_EVENT)
    const spend = 2
    for (let i = 0; i < spend; i++) {
      fire(r, SKY)
      await waitValue(r, `${team} spent round ${i + 1}`, () => ammo(r, id), wp.magazine - i - 1)
      await sleep(wp.intervalMs + 100)
    }
    // Reload with a part-empty magazine.
    const t0 = Date.now()
    r.send(RELOAD_MESSAGE, {})
    await waitValue(r, `${team} reloading`, () => vitalsOf(r, id)?.reloading, true)
    const ammoWhenStarted = ammo(r, id)
    // Fire during the reload: refused, no round spent, no shot event.
    fire(r, SKY)
    await sleep(wp.intervalMs + 100)
    fire(r, SKY)
    await sleep(100)
    const ammoWhileReloading = ammo(r, id)
    const mine = () => shots.events.filter((e) => e.shooter === id).length
    const shotsWhileReloading = mine()
    // An early second reload and a flood must not restart or extend it.
    await sleep(wp.reloadMs / 2 - (Date.now() - t0))
    r.send(RELOAD_MESSAGE, {})
    for (let i = 0; i < 15; i++) {
      r.send(RELOAD_MESSAGE, {})
      await sleep(10)
    }
    await waitValue(r, `${team} reload done`, () => vitalsOf(r, id)?.reloading, false)
    const duration = Date.now() - t0
    const ammoAfter = ammo(r, id)
    // Full magazine: a reload flood does nothing.
    for (let i = 0; i < 10; i++) {
      r.send(RELOAD_MESSAGE, {})
      await sleep(20)
    }
    await sleep(200)
    const afterFlood = { reloading: vitalsOf(r, id)?.reloading, ammo: ammo(r, id) }
    // Firing works again.
    fire(r, SKY)
    await waitValue(r, `${team} fires after reload`, () => ammo(r, id), wp.magazine - 1)
    return { team, ammoWhenStarted, ammoWhileReloading, shotsWhileReloading, duration, ammoAfter, afterFlood, shots: mine(), spend }
  }
  const [gr, wr] = await Promise.all([one(g, 'ghost'), one(w, 'warden')])
  await Promise.all(open.splice(0).map((r) => (r.connection.isOpen ? r.leave().catch(() => {}) : undefined)))

  for (const r of [gr, wr]) {
    const wp = WEAPONS[r.team]
    expect(r.ammoWhenStarted, `${r.team}: a reload does not refill at once`).toBe(wp.magazine - r.spend)
    expect(r.ammoWhileReloading, `${r.team}: firing during a reload spends nothing`).toBe(wp.magazine - r.spend)
    expect(r.shotsWhileReloading, `${r.team}: no shot event during a reload`).toBe(r.spend)
    expect(r.duration, `${r.team} reload took ${r.duration} ms`).toBeGreaterThanOrEqual(wp.reloadMs - RELOAD_SLACK_BELOW)
    expect(r.duration, `${r.team} reload took ${r.duration} ms`).toBeLessThanOrEqual(wp.reloadMs + RELOAD_SLACK_ABOVE)
    expect(r.ammoAfter).toBe(wp.magazine)
    expect(r.afterFlood).toEqual({ reloading: false, ammo: wp.magazine })
    expect(r.shots, `${r.team}: shot events are the two spent rounds plus the one after the reload`).toBe(r.spend + 1)
  }
})
