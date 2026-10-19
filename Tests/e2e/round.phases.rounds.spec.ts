import { expect, test } from '@playwright/test'
import {
  ACTION_MESSAGE,
  FIRE_MESSAGE,
  INTERACT_MESSAGE,
  MAX_HEALTH,
  MOVE_MESSAGE,
  RELOAD_MESSAGE,
  ROUND_EVENT,
  SHOT_EVENT,
  WEAPONS,
  type RoundPhase,
} from '../../shared/protocol.js'
import { GRAYBOX_MAP } from '../../shared/map.js'
import { collectProgress, terminalOf } from './support/terminal.js'
import { ROUND_FAST, collectRoundEvents, createRound, joinRound, roundOf, roundPlain, waitForPhase } from './support/rounds.js'
import { scanFrames, searchable } from './support/scan.js'
import { godView, leaveQuietly, pos, teamOf, waitForState, type GameRoom } from './support/sdk.js'
import { collectEvents } from './support/vitals.js'
import { visibilityOf } from './support/visibility.js'
import { framesOf } from './support/wire.js'

// M7 round phases, lock-out, reset, join/leave and startup-only configuration
// (#68, verified in #69), through real @colyseus/sdk clients on the `fast`
// server (port 2568: countdown 2 s, live 30 s, ended 3 s). Every client is
// built from roundEndpoint and every test creates its own room, so the tests
// run in parallel. Nothing here reads the preset to decide what to expect.
//
//  1. lock-out: a lone Ghost stays in `waiting` and cannot move or fire; a
//     Warden joining starts the countdown; secondsLeft only falls; moves, fire,
//     reload, jump and interact during `countdown` change nothing; `live`
//     starts after about 2 s and then moves work.
//  2. the full cycle (the slow test, about 36 s): live lasts about 30 s and
//     ends `time_out` with the Wardens winning; `ended` is frozen too; a new
//     countdown follows with roundNumber + 1 and everyone back at a spawn,
//     yaw 0, full health and ammo. A Ghost joining mid-`live` sits out (health
//     0, moves ignored) and is revived by that reset.
//  3. a team that empties aborts the round to `waiting`; a new joiner restarts.
//  4. forgery: create/join options and extra fields on registered messages do
//     not change the timers; an unregistered type closes only the forger (4002).
//  5. a Warden's wire carries `round` and nothing about the Ghost count, hack
//     progress or the hacker.
//
// Per Docs/handoff.md: problems are collected and asserted once, after the SDK
// clients have left; truth about a Ghost is read from a Ghost client.

test.describe.configure({ mode: 'parallel' })

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The local player as received, with the fields an ignored input could change. */
function snap(r: GameRoom) {
  const p = r.state.players.get(r.sessionId) as unknown as Record<string, unknown>
  const { x, y, z, yaw, mode, health, ammo, reloading } = p
  return { x, y, z, yaw, mode, health, ammo, reloading }
}

/**
 * Sends every kind of input a client can. The yaw 1 and the intent would show
 * in position and yaw if accepted; the fire would spend ammo. Over 0.5 s.
 */
async function mash(r: GameRoom) {
  for (let i = 0; i < 4; i++) {
    r.send(MOVE_MESSAGE, { dx: 1, dz: 1, yaw: 1 })
    r.send(FIRE_MESSAGE, { yaw: 0, pitch: 0 })
    await sleep(60)
  }
  r.send(RELOAD_MESSAGE)
  r.send(ACTION_MESSAGE, { action: 'jump' })
  r.send(INTERACT_MESSAGE, { active: true })
  await sleep(300)
  r.send(INTERACT_MESSAGE, { active: false })
  await sleep(100)
}

/** Records `secondsLeft` and phase on every state change of `r`. */
function watchRound(r: GameRoom) {
  const seen: { t: number; phase: RoundPhase; roundNumber: number; secondsLeft: number }[] = []
  r.onStateChange(() => {
    const x = roundOf(r)
    if (x) seen.push({ t: Date.now(), phase: x.phase, roundNumber: x.roundNumber, secondsLeft: x.secondsLeft })
  })
  return seen
}

const inArea = (p: { x: number; z: number }, a: { minX: number; maxX: number; minZ: number; maxZ: number }) =>
  p.x >= a.minX - 1e-4 && p.x <= a.maxX + 1e-4 && p.z >= a.minZ - 1e-4 && p.z <= a.maxZ + 1e-4

test('a lone Ghost waits and is frozen; a Warden starts the countdown; inputs are ignored until live', async () => {
  const g = await createRound(open)
  const gShots = collectEvents(g, SHOT_EVENT)
  const gProgress = collectProgress(g)
  const events = collectRoundEvents(g)
  const gWatch = watchRound(g)

  const waiting = roundPlain(roundOf(g)!)
  const beforeWaiting = snap(g)
  await mash(g)
  await sleep(200)
  const afterWaiting = snap(g)
  const stillWaiting = roundOf(g)!.phase

  const w = await joinRound(g.roomId, open)
  const wShots = collectEvents(w, SHOT_EVENT)
  const wProgress = collectProgress(w)
  const wWatch = watchRound(w)
  await waitForPhase(g, 'countdown', 2000)
  const tCountdown = Date.now()
  const cd = roundPlain(roundOf(g)!)
  // Spawns were drawn at the reset that started the countdown; positions must stay.
  const gBefore = snap(g)
  const wBefore = snap(w)
  await Promise.all([mash(g), mash(w)])
  const gAfter = snap(g)
  const wAfter = snap(w)
  const phaseAfterMash = roundOf(g)!.phase

  await waitForPhase(g, 'live', 4000)
  const tLive = Date.now()
  const live0 = roundPlain(roundOf(g)!)
  // Positive control: once live, a move is accepted.
  const z0 = (g.state.players.get(g.sessionId) as any).z as number
  await sleep(60)
  g.send(MOVE_MESSAGE, { dx: 0, dz: 1, yaw: 0 })
  await waitForState(g, 'the Ghost moves once live', (s) => ((s.players.get(g.sessionId) as any).z as number) > z0 + 0.05)
  const terminal = terminalOf(g)
  events.stop()

  const countdownSecs = gWatch.filter((s) => s.phase === 'countdown').map((s) => s.secondsLeft)
  const wardenSecs = wWatch.filter((s) => s.phase === 'countdown').map((s) => s.secondsLeft)
  const result = {
    waiting,
    stillWaiting,
    waitingFrozen: afterWaiting,
    cd,
    live0,
    phases: events.phases(),
    elapsed: tLive - tCountdown,
    monotonic: [countdownSecs, wardenSecs].map((a) => a.every((v, i) => i === 0 || v <= a[i - 1]!)),
    secondsSeen: [...new Set(countdownSecs)],
    shots: [gShots.events.length, wShots.events.length],
    progress: [...gProgress.progress, ...wProgress.progress].map((m) => m.progress),
    terminal: terminal?.status,
    phaseAfterMash,
  }
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(result.waiting).toMatchObject({ phase: 'waiting', roundNumber: 0, secondsLeft: 0, winner: '', winReason: '' })
  expect(afterWaiting, 'a lone Ghost cannot move, turn, fire, reload or jump').toEqual(beforeWaiting)
  expect(result.stillWaiting, 'a lone Ghost stays in waiting').toBe('waiting')
  expect(result.cd).toMatchObject({ phase: 'countdown', roundNumber: 1, winner: '', winReason: '' })
  expect(result.cd.secondsLeft).toBeGreaterThanOrEqual(1)
  expect(result.cd.secondsLeft).toBeLessThanOrEqual(ROUND_FAST.countdownMs / 1000 + 1)
  expect(gAfter, 'countdown: the Ghost ignores every input').toEqual(gBefore)
  expect(wAfter, 'countdown: the Warden ignores every input').toEqual(wBefore)
  expect(result.phaseAfterMash).toBe('countdown')
  expect(result.monotonic, 'secondsLeft only falls').toEqual([true, true])
  expect(result.secondsSeen.every((v) => v >= 1 && v <= ROUND_FAST.countdownMs / 1000 + 1)).toBe(true)
  expect(result.elapsed, 'live starts after about 2 s').toBeGreaterThan(1400)
  expect(result.elapsed).toBeLessThan(3400)
  expect(result.live0).toMatchObject({ phase: 'live', roundNumber: 1, winner: '', winReason: '' })
  expect(result.live0.secondsLeft).toBeGreaterThanOrEqual(29)
  // +1 tolerance: the server can show one second too many for a patch (float sum, see bug #75).
  expect(result.live0.secondsLeft).toBeLessThanOrEqual(ROUND_FAST.liveMs / 1000 + 1)
  expect(result.phases, 'one event per phase change').toEqual(['countdown', 'live'])
  expect(result.shots, 'no shot was fired before live').toEqual([0, 0])
  expect(result.progress.every((v) => v === 0), 'no hack progress before live').toBe(true)
  expect(result.terminal).toBe('idle')
})

test('a full round times out for the Wardens, then a new countdown resets everyone; a mid-live joiner sits out and is revived', async () => {
  test.setTimeout(90_000)
  const g = await createRound(open)
  const events = collectRoundEvents(g)
  const w = await joinRound(g.roomId, open)
  await waitForPhase(g, 'live', 5000)
  const tLive = Date.now()

  // The first Ghost leaves the spawn area and spends two shots.
  const spawn = { ...snap(g) }
  for (let i = 0; i < 50; i++) {
    g.send(MOVE_MESSAGE, { dx: 0, dz: 1, yaw: 0 })
    await sleep(55)
  }
  g.send(FIRE_MESSAGE, { yaw: 0, pitch: 0 })
  await sleep(350)
  g.send(FIRE_MESSAGE, { yaw: 0, pitch: 0 })
  await sleep(350)
  const moved = { ...snap(g) }

  // A third client (a Ghost) joins while live: it sits out.
  const g2 = await joinRound(g.roomId, open)
  const g2Join = { ...snap(g2) }
  const g2Before = snap(g2)
  await mash(g2)
  const g2After = snap(g2)

  await waitForPhase(g, 'ended', 40_000)
  const tEnded = Date.now()
  const ended = roundPlain(roundOf(g)!)
  const endedBefore = snap(g)
  await mash(g)
  const endedAfter = snap(g)

  await waitForPhase(g, 'countdown', 6000)
  const tNext = Date.now()
  const next = roundPlain(roundOf(g)!)
  const gReset = snap(g)
  const wReset = snap(w)
  const g2Reset = snap(g2)
  events.stop()
  const phases = events.events.map((e) => [e.phase, e.roundNumber, e.winner, e.winReason])
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(spawn.ammo).toBe(WEAPONS.ghost.magazine)
  expect(inArea(moved as { x: number; z: number }, GRAYBOX_MAP.spawnAreas.ghost), 'the Ghost walked out of its spawn area').toBe(false)
  expect(moved.ammo, 'two shots were spent').toBe(WEAPONS.ghost.magazine - 2)
  expect(g2Join.health, 'a joiner during live sits out').toBe(0)
  expect(g2After, 'a sat-out joiner cannot act').toEqual(g2Before)
  expect(tEnded - tLive, 'live lasts about 30 s').toBeGreaterThan(28_500)
  expect(tEnded - tLive).toBeLessThan(32_500)
  expect(ended).toMatchObject({ phase: 'ended', roundNumber: 1, winner: 'warden', winReason: 'time_out' })
  expect(endedAfter, 'ended: inputs are ignored').toEqual(endedBefore)
  expect(tNext - tEnded, 'ended lasts about 3 s').toBeGreaterThan(2_400)
  expect(tNext - tEnded).toBeLessThan(4_500)
  expect(next).toMatchObject({ phase: 'countdown', roundNumber: 2, winner: '', winReason: '' })
  for (const [who, s] of [['Ghost', gReset], ['Warden', wReset], ['sat-out Ghost', g2Reset]] as const) {
    expect(s.yaw, `${who} faces yaw 0`).toBeCloseTo(0, 4)
    expect(s.mode).toBe('ground')
    expect(s.y).toBeCloseTo(0, 4)
    expect(s.reloading).toBe(false)
  }
  expect(inArea(gReset as { x: number; z: number }, GRAYBOX_MAP.spawnAreas.ghost), 'Ghost back in its spawn area').toBe(true)
  expect(inArea(g2Reset as { x: number; z: number }, GRAYBOX_MAP.spawnAreas.ghost)).toBe(true)
  expect(inArea(wReset as { x: number; z: number }, GRAYBOX_MAP.spawnAreas.warden), 'Warden in its spawn area').toBe(true)
  expect(gReset.health).toBe(MAX_HEALTH.ghost)
  expect(gReset.ammo, 'full magazine again').toBe(WEAPONS.ghost.magazine)
  expect(g2Reset.health, 'the sat-out joiner is revived').toBe(MAX_HEALTH.ghost)
  expect(g2Reset.ammo).toBe(WEAPONS.ghost.magazine)
  expect(wReset.health).toBe(MAX_HEALTH.warden)
  expect(wReset.ammo).toBe(WEAPONS.warden.magazine)
  expect(phases).toEqual([
    ['countdown', 1, '', ''],
    ['live', 1, '', ''],
    ['ended', 1, 'warden', 'time_out'],
    ['countdown', 2, '', ''],
  ])
})

test('a team that empties aborts the round to waiting; a new joiner restarts it', async () => {
  const g = await createRound(open)
  const events = collectRoundEvents(g)
  const w = await joinRound(g.roomId, open)
  await waitForPhase(g, 'live', 5000)
  await leaveQuietly(w)
  await waitForPhase(g, 'waiting', 2000)
  const aborted = roundPlain(roundOf(g)!)
  await sleep(1000)
  const stillWaiting = roundOf(g)!.phase

  // A new Warden restarts the round (number 2); leaving during the countdown aborts again.
  const w2 = await joinRound(g.roomId, open)
  await waitForPhase(g, 'countdown', 2000)
  const restarted = roundPlain(roundOf(g)!)
  await leaveQuietly(w2)
  await waitForPhase(g, 'waiting', 2000)
  const second = roundPlain(roundOf(g)!)
  events.stop()
  const phases = events.phases()
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(aborted).toMatchObject({ phase: 'waiting', roundNumber: 1, secondsLeft: 0, winner: '', winReason: '' })
  expect(stillWaiting, 'a lone Ghost does not restart the round').toBe('waiting')
  expect(restarted).toMatchObject({ phase: 'countdown', roundNumber: 2 })
  expect(second).toMatchObject({ phase: 'waiting', roundNumber: 2, winner: '', winReason: '' })
  expect(phases).toEqual(['countdown', 'live', 'waiting', 'countdown', 'waiting'])
})

test('forged options and messages do not change the timers; an unregistered type closes only the forger (4002)', async () => {
  const forged = {
    roundSettings: { countdownMs: 50, liveMs: 100, endedMs: 50, minPlayersPerTeam: 0 },
    preset: 'open',
    liveMs: 100,
    countdownMs: 50,
    endedMs: 50,
    minPlayersPerTeam: 0,
    phase: 'live',
    roundNumber: 50,
  }
  const g = await createRound(open, forged)
  const events = collectRoundEvents(g)
  await sleep(700)
  const lone = roundPlain(roundOf(g)!)

  const w = await joinRound(g.roomId, open, forged)
  await waitForPhase(g, 'countdown', 2000)
  const t0 = Date.now()
  const g2 = await joinRound(g.roomId, open, forged)
  const closes: number[] = []
  const othersClosed: number[] = []
  g2.onLeave((code) => closes.push(code))
  for (const r of [g, w]) r.onLeave((code) => othersClosed.push(code))

  // Forged registered messages: extra fields that name settings or a phase.
  const extra = { roundSettings: forged.roundSettings, liveMs: 1, countdownMs: 1, phase: 'live', preset: 'open' }
  for (const r of [w, g2]) {
    r.send(MOVE_MESSAGE, { dx: 0, dz: 0, yaw: 0, ...extra })
    r.send(FIRE_MESSAGE, { yaw: 0, pitch: 0, ...extra })
    r.send(ACTION_MESSAGE, { action: 'jump', ...extra })
    r.send(INTERACT_MESSAGE, { active: false, ...extra })
    r.send(RELOAD_MESSAGE, extra)
  }
  // The round event is server to client; as a client message it is unregistered.
  g2.send(ROUND_EVENT, { phase: 'ended', roundNumber: 99, winner: 'ghost', winReason: 'hacked' })
  const waitMs = (ms: number) => sleep(Math.max(0, ms - (Date.now() - t0)))
  await waitMs(1100)
  const midCountdown = roundPlain(roundOf(g)!)
  const g2Open = g2.connection.isOpen

  await waitForPhase(g, 'live', 3000)
  const elapsed = Date.now() - t0
  const tLive = Date.now()
  await sleep(1500)
  const stillLive = roundPlain(roundOf(g)!)
  const othersOpen = [g.connection.isOpen, w.connection.isOpen]
  const othersClosedBefore = [...othersClosed]
  events.stop()
  const phases = events.phases()
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(lone, 'forged create options: a lone Ghost still waits').toMatchObject({ phase: 'waiting', roundNumber: 0 })
  expect(midCountdown, 'a 50 ms forged countdown did not apply').toMatchObject({ phase: 'countdown', roundNumber: 1 })
  expect(midCountdown.secondsLeft).toBeGreaterThanOrEqual(1)
  expect(g2Open, 'the forger was closed').toBe(false)
  expect(closes, 'the forger is closed with 4002').toEqual([4002])
  expect(othersClosedBefore, 'nobody else is closed').toEqual([])
  expect(othersOpen).toEqual([true, true])
  expect(elapsed, 'the countdown still lasts about 2 s').toBeGreaterThan(1000)
  expect(elapsed).toBeLessThan(2800)
  expect(stillLive, 'a forged 100 ms live did not apply').toMatchObject({ phase: 'live', roundNumber: 1, winner: '', winReason: '' })
  expect(phases, 'the forged ended event changed nothing').toEqual(['countdown', 'live'])
})

test('a Warden wire carries round and nothing about the Ghost count, hack progress or the hacker', async () => {
  test.setTimeout(45_000)
  const g = await createRound(open, {}, true)
  const gid = g.sessionId
  let w = await joinRound(g.roomId, open, {}, true)
  // Spawns are drawn at the reset that starts each countdown, and most are in
  // the Warden's line of sight. Re-roll (the Warden leaves and rejoins) until
  // the Ghost is placed where the Warden is not sent it.
  let placement = ''
  for (let i = 0; i < 60; i++) {
    await waitForPhase(g, 'countdown', 3000)
    await waitForState(w, 'the Warden has its spawn', (s) => !!s.players?.has(w.sessionId))
    placement = visibilityOf(pos(g, w.sessionId), pos(g, gid))
    await sleep(200)
    placement = visibilityOf(pos(g, w.sessionId), pos(g, gid))
    if (placement === 'hidden' && !w.state.players.has(gid)) break
    await leaveQuietly(w)
    await waitForPhase(g, 'waiting', 3000)
    w = await joinRound(g.roomId, open, {}, true)
  }
  const sentSince = Date.now()
  const ghostAt = { ...pos(g, gid) }
  const wardenHolds = w.state.players.has(gid)
  await waitForPhase(w, 'live', 5000)
  await sleep(1200)
  const round = (w.state as any).round.toJSON()
  const stateKeys = Object.keys((w.state as any).toJSON()).sort()

  const values = [ghostAt.x, ghostAt.z].filter(searchable)
  const window = { from: sentSince, to: Date.now() }
  const wardenHits = scanFrames(framesOf(w), { ids: [gid, 'hackProgress'], values, ...window })
  const control = scanFrames(framesOf(g), { ids: [gid], values })
  // The `round` message is a public event: phase, number, winner, reason.
  const wardenRound = scanFrames(framesOf(w), { ids: ['round', 'phase', 'roundNumber'], ...window })
  const roleCheck = [teamOf(g), teamOf(w)]
  const view = godView([g, w])
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(roleCheck).toEqual(['ghost', 'warden'])
  expect(view).toBe(g)
  expect(placement, 'a hidden Ghost placement was reached').toBe('hidden')
  expect(wardenHolds, 'the Warden state does not hold the Ghost').toBe(false)
  expect(values.length, 'the scan searched for coordinates').toBeGreaterThan(0)
  expect(control.some((h) => h.what.startsWith('session id')), 'positive control: the Ghost frames hold its id').toBe(true)
  expect(wardenRound.length, 'positive control: the Warden receives round data').toBeGreaterThan(0)
  expect(round).toEqual({ phase: 'live', roundNumber: expect.any(Number), secondsLeft: expect.any(Number), winner: '', winReason: '' })
  expect(Object.keys(round).sort()).toEqual(['phase', 'roundNumber', 'secondsLeft', 'winReason', 'winner'])
  expect(stateKeys, 'room state has no alive count or hack field').toEqual(['players', 'round', 'terminals'])
  expect(wardenHits, 'no Ghost id, coordinates or hackProgress in the Warden frames').toEqual([])
})
