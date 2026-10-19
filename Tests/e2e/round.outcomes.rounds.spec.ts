import { expect, test } from '@playwright/test'
import {
  EYE_HEIGHT,
  FIRE_MESSAGE,
  INTERACT_MESSAGE,
  MAX_HEALTH,
  MOVE_MESSAGE,
  SHOT_EVENT,
  WEAPONS,
  type RoundEvent,
} from '../../shared/protocol.js'
import { GRAYBOX_MAP } from '../../shared/map.js'
import { feetY } from './support/geometry.js'
import { ROUND_FAST, collectRoundEvents, createRound, joinRound, roundOf, roundPlain, waitForPhase } from './support/rounds.js'
import { scanFrames, searchable } from './support/scan.js'
import { Walker, leaveQuietly, pos, type GameRoom } from './support/sdk.js'
import { collectProgress, terminalOf, terminalPlacement, watchTerminal } from './support/terminal.js'
import { collectEvents, vitalsOf } from './support/vitals.js'
import { visibilityOf } from './support/visibility.js'
import { framesOf } from './support/wire.js'

// M7 outcomes, edge cases and reset on the wire (#70, verified in #71),
// through real @colyseus/sdk clients on the `fast` server (port 2568:
// countdown 2 s, live 30 s, ended 3 s). Every client comes from roundEndpoint
// and every test makes its own room, so the four tests run in parallel.
//
//  A. a Ghost walks to the terminal and hacks it during `live` (about 22 s):
//     ended / ghost / hacked, visible to both teams; a Warden who cannot see
//     the hacker gets no hackProgress, Ghost id or Ghost coordinates; fire and
//     interact in `ended` change nothing; the next countdown has an idle
//     terminal with no alert. A SECOND full hack from zero does not fit the
//     30 s live window with margin (walk about 10 s + hack 10 s), so that is
//     Mocha: MyRoomRoundOutcomes "at every countdown the terminals are idle,
//     alert off, progress 0, and a second hack takes the full time".
//  B. the Warden kills the only Ghost: ended / warden / ghosts_eliminated,
//     then both are revived at the next countdown with full health and ammo.
//  C. the only Ghost leaves in `live`: abort to `waiting`, no winner, no
//     `ended`; a joiner restarts the round.
//  D. a Ghost that dies, leaves and rejoins sits out (health 0, inputs
//     ignored) while the other Ghost keeps the round going.
//
// Time-out is proven in round.phases.rounds.spec.ts (not repeated). Same-step
// ordering (hack vs elimination vs timer) is Mocha only
// (server/test/MyRoomRoundOutcomes.test.ts: three order tests plus the
// kill-before-step and hack-before-death tests).
//
// Added wall time: tests run in parallel in the `rounds` shard; the longest
// is A at about 25 s, shorter than the 35 s time-out test of #69, so the
// shard's critical path should not grow by more than a few seconds.
//
// Per Docs/handoff.md: problems are collected and asserted once, after the SDK
// clients have left; truth about a Ghost is read from a Ghost client.

test.describe.configure({ mode: 'parallel' })

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const GHOST = WEAPONS.ghost
const WARDEN = WEAPONS.warden
const HITS_TO_KILL_GHOST = Math.ceil(MAX_HEALTH.ghost / WARDEN.damage)
const HEAD_Y = 1.7
const SETTLE = 250

const inArea = (p: { x: number; z: number }, a: { minX: number; maxX: number; minZ: number; maxZ: number }) =>
  p.x >= a.minX - 1e-4 && p.x <= a.maxX + 1e-4 && p.z >= a.minZ - 1e-4 && p.z <= a.maxZ + 1e-4

function own(r: GameRoom) {
  const p = r.state.players.get(r.sessionId) as unknown as Record<string, unknown>
  const { x, y, z, yaw, mode, health, ammo, reloading } = p
  return { x, y, z, yaw, mode, health, ammo, reloading } as {
    x: number
    y: number
    z: number
    yaw: number
    mode: string
    health: number
    ammo: number
    reloading: boolean
  }
}

function quiet(...rooms: GameRoom[]) {
  for (const r of rooms) r.onMessage(SHOT_EVENT, () => {})
}

/** Yaw and pitch from the shooter's eye to the target's head, read from a Ghost client. */
function aimAtHead(viewer: GameRoom, shooterId: string, targetId: string) {
  const s = viewer.state.players.get(shooterId) as unknown as { x: number; y: number; z: number }
  const t = viewer.state.players.get(targetId) as unknown as { x: number; y: number; z: number }
  const dx = t.x - s.x
  const dz = t.z - s.z
  const dy = feetY(t) + HEAD_Y - (feetY(s) + EYE_HEIGHT)
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
}

/** Walks a Ghost and a Warden onto x = 0, the south doorway line, once live. */
async function faceOff(g: GameRoom, w: GameRoom) {
  await waitForPhase(g, 'live', 5000)
  const gw = new Walker(g, 'ghost', { ground: false })
  const ww = new Walker(w, 'warden', { ground: false })
  await Promise.all([gw.walkTo({ x: 0, z: gw.pos.z }), ww.walkTo({ x: 0, z: ww.pos.z })])
  await sleep(150)
  return { gw, ww, visibility: visibilityOf(ww.state, gw.state) }
}

/** The Warden fires at the Ghost's head, one shot per interval, until its health is 0 (at most 8 shots). */
async function shootDown(w: GameRoom, viewer: GameRoom, ghostId: string) {
  for (let i = 0; i < 8 && vitalsOf(viewer, ghostId)?.health !== 0; i++) {
    await sleep(WARDEN.intervalMs + 100)
    w.send(FIRE_MESSAGE, aimAtHead(viewer, w.sessionId, ghostId))
    await sleep(60)
  }
}

// The route test B of hack.integration.spec.ts walks: through the south door.
const ghostToInsideDoor = async (w: Walker) => {
  await w.walkTo({ x: 0, z: w.pos.z }, 'xz')
  await w.walkTo({ x: 0, z: -5.5 }, 'zx')
}

test('a Ghost hacks the terminal during live: ghost wins (hacked), the Warden is told nothing hidden, ended ignores fire and interact, the terminal resets', async () => {
  test.setTimeout(75_000)
  const g = await createRound(open, {}, true)
  const gid = g.sessionId
  const w = await joinRound(g.roomId, open, {}, true)
  const gEvents = collectRoundEvents(g)
  const wEvents = collectRoundEvents(w)
  const gProgress = collectProgress(g)
  const wProgress = collectProgress(w)
  const gTerm = watchTerminal(g)
  const wTerm = watchTerminal(w)
  quiet(g, w)
  const { inside } = terminalPlacement()
  await waitForPhase(g, 'live', 5000)
  const gw = new Walker(g, 'ghost')
  const ww = new Walker(w, 'warden')
  const idleBefore = [terminalOf(g)?.status, terminalOf(w)?.status]

  // The Warden stands outside the west wall: a wall between it and the terminal.
  const HIDDEN = { x: -11.5, z: -5.5 }
  await Promise.all([
    (async () => {
      await ghostToInsideDoor(gw)
      await gw.walkTo(inside, 'xz')
    })(),
    (async () => {
      await ww.walkTo({ x: ww.pos.x, z: -0.6 }, 'zx')
      await ww.walkTo({ x: HIDDEN.x, z: -0.6 }, 'xz')
      await ww.walkTo(HIDDEN, 'zx')
    })(),
  ])
  await sleep(300)
  const placement = visibilityOf(pos(g, w.sessionId), pos(g, gid))
  const heldGhost = w.state.players.has(gid)
  const ghostAt = { ...pos(g, gid) }
  const liveLeftAtPress = roundOf(g)!.secondsLeft

  const t0 = Date.now()
  g.send(INTERACT_MESSAGE, { active: true })
  await waitForPhase(g, 'ended', 20_000)
  const tEnded = Date.now()
  await waitForPhase(w, 'ended', 2000)
  const gEnded = roundPlain(roundOf(g)!)
  const wEnded = roundPlain(roundOf(w)!)
  const termAtEnd = [terminalOf(g), terminalOf(w)].map((t) => [t?.status, t?.alert])
  const scanTo = tEnded

  // fire and interact in `ended` change nothing.
  const gAmmo = own(g).ammo
  const wAmmo = own(w).ammo
  const progressAtEnd = gProgress.progress.length
  g.send(FIRE_MESSAGE, { yaw: 0, pitch: 0 })
  w.send(FIRE_MESSAGE, { yaw: 0, pitch: 0 })
  g.send(INTERACT_MESSAGE, { active: false })
  await sleep(150)
  g.send(INTERACT_MESSAGE, { active: true })
  await sleep(500)
  const afterEnded = { gAmmo: own(g).ammo, wAmmo: own(w).ammo, progress: gProgress.progress.length, phase: roundOf(g)!.phase, term: terminalOf(g)?.status }

  await waitForPhase(g, 'countdown', 6000)
  await waitForPhase(w, 'countdown', 2000)
  await sleep(200)
  const next = roundPlain(roundOf(g)!)
  const termAfterReset = [terminalOf(g), terminalOf(w)].map((t) => [t?.status, t?.alert])
  const otherAfterReset = [terminalOf(g, 'terminal-b')?.status, terminalOf(w, 'terminal-b')?.status]
  const lastProgress = gProgress.progress[gProgress.progress.length - 1]?.progress
  const statuses = { g: [...gTerm.statuses].sort(), w: [...wTerm.statuses].sort() }
  const spawnsOk = [inArea(own(g), GRAYBOX_MAP.spawnAreas.ghost), inArea(own(w), GRAYBOX_MAP.spawnAreas.warden)]

  const values = [ghostAt.x, ghostAt.z].filter(searchable)
  const window = { from: t0 + SETTLE, to: scanTo }
  const wardenHits = scanFrames(framesOf(w), { ids: [gid, 'hackProgress'], values, ...window })
  const wardenHackProgressAnytime = scanFrames(framesOf(w), { ids: ['hackProgress'] })
  const control = scanFrames(framesOf(g), { ids: [gid], values })
  const wardenRound = scanFrames(framesOf(w), { ids: ['round', 'winReason'], from: tEnded - 500 })
  gEvents.stop()
  wEvents.stop()
  const gEv: RoundEvent[] = gEvents.events
  const wEv: RoundEvent[] = wEvents.events
  const violations = [...gw.violations, ...ww.violations]
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(violations).toEqual([])
  expect(idleBefore, 'terminals start idle').toEqual(['idle', 'idle'])
  expect(placement, 'the Warden cannot see the hacker').toBe('hidden')
  expect(heldGhost, 'the Warden state does not hold the Ghost').toBe(false)
  expect(liveLeftAtPress, 'the hack started with time to spare').toBeGreaterThan(12)
  expect(tEnded - t0, 'the hack takes about 10 s').toBeGreaterThan(9000)
  expect(tEnded - t0).toBeLessThan(13_000)
  for (const e of [gEnded, wEnded]) {
    expect(e).toMatchObject({ phase: 'ended', roundNumber: 1, winner: 'ghost', winReason: 'hacked' })
    expect(e.secondsLeft, 'ended counts down from endedMs').toBeGreaterThanOrEqual(ROUND_FAST.endedMs / 1000 - 1)
    expect(e.secondsLeft).toBeLessThanOrEqual(ROUND_FAST.endedMs / 1000)
  }
  expect(termAtEnd, 'the hacked terminal stays hacked at ended, alert off').toEqual([['hacked', false], ['hacked', false]])
  const fromEnded = (ev: RoundEvent[]) => ev.slice(ev.findIndex((e) => e.phase === 'ended')).map((e) => [e.phase, e.roundNumber, e.winner, e.winReason])
  expect(fromEnded(gEv), 'Ghost round events').toEqual([['ended', 1, 'ghost', 'hacked'], ['countdown', 2, '', '']])
  expect(fromEnded(wEv), 'the Warden gets the same result').toEqual(fromEnded(gEv))
  expect(afterEnded.gAmmo, 'fire in ended is ignored (Ghost)').toBe(gAmmo)
  expect(afterEnded.wAmmo, 'fire in ended is ignored (Warden)').toBe(wAmmo)
  expect(afterEnded.progress, 'interact in ended starts nothing').toBe(progressAtEnd)
  expect(afterEnded.phase).toBe('ended')
  expect(afterEnded.term).toBe('hacked')
  expect(next).toMatchObject({ phase: 'countdown', roundNumber: 2, winner: '', winReason: '' })
  expect(termAfterReset, 'the next round starts with idle terminals, alert off').toEqual([['idle', false], ['idle', false]])
  expect(otherAfterReset).toEqual(['idle', 'idle'])
  expect(statuses.g, 'the Ghost saw idle, hacking and hacked').toEqual(['hacked', 'hacking', 'idle'])
  expect(lastProgress === undefined || lastProgress === 0, 'a progress message after the reset is 0').toBe(true)
  expect(spawnsOk).toEqual([true, true])
  // The Warden's wire.
  expect(wProgress.progress.length, 'a Warden never gets hackProgress').toBe(0)
  expect(wardenHackProgressAnytime, 'no hackProgress frame at all in the round').toEqual([])
  expect(values.length, 'the scan searched for coordinates').toBeGreaterThan(0)
  expect(control.some((h) => h.what.startsWith('session id')), 'positive control: the Ghost frames hold its id').toBe(true)
  expect(wardenRound.length, 'positive control: the Warden receives the result').toBeGreaterThan(0)
  expect(wardenHits, 'no Ghost id or coordinates in the Warden frames while hidden').toEqual([])
})

test('the Warden kills the only Ghost: warden wins (ghosts_eliminated), then both are revived at the next countdown', async () => {
  test.setTimeout(45_000)
  const g = await createRound(open)
  const gid = g.sessionId
  const w = await joinRound(g.roomId, open)
  quiet(g, w)
  const gEvents = collectRoundEvents(g)
  const wEvents = collectRoundEvents(w)
  const { visibility } = await faceOff(g, w)
  const startAmmo = own(w).ammo
  await shootDown(w, g, gid)
  await waitForPhase(g, 'ended', 3000)
  await waitForPhase(w, 'ended', 2000)
  const gEnded = roundPlain(roundOf(g)!)
  const wEnded = roundPlain(roundOf(w)!)
  const deadHealth = own(g).health
  const wAmmoAtEnd = own(w).ammo
  await sleep(400)
  const stillEnded = roundOf(w)!.phase

  await waitForPhase(g, 'countdown', 6000)
  await waitForPhase(w, 'countdown', 2000)
  await sleep(200)
  const next = roundPlain(roundOf(g)!)
  const gReset = own(g)
  const wReset = own(w)
  const fromLive = (e: RoundEvent[]) => e.slice(e.findIndex((x) => x.phase === 'live')).map((x) => [x.phase, x.roundNumber, x.winner, x.winReason])
  gEvents.stop()
  wEvents.stop()
  const events = [fromLive(gEvents.events), fromLive(wEvents.events)]
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(visibility, 'the Warden has a line to the Ghost on x = 0').not.toBe('hidden')
  expect(startAmmo).toBe(WARDEN.magazine)
  expect(deadHealth, 'the Ghost was killed').toBe(0)
  expect(wAmmoAtEnd, 'the Warden spent at least the shots needed').toBeLessThanOrEqual(WARDEN.magazine - HITS_TO_KILL_GHOST)
  for (const e of [gEnded, wEnded]) {
    expect(e).toMatchObject({ phase: 'ended', roundNumber: 1, winner: 'warden', winReason: 'ghosts_eliminated' })
    expect(e.secondsLeft).toBeLessThanOrEqual(ROUND_FAST.endedMs / 1000)
    expect(e.secondsLeft).toBeGreaterThanOrEqual(ROUND_FAST.endedMs / 1000 - 1)
  }
  expect(stillEnded).toBe('ended')
  expect(next).toMatchObject({ phase: 'countdown', roundNumber: 2, winner: '', winReason: '' })
  expect(gReset.health, 'the Ghost is revived').toBe(MAX_HEALTH.ghost)
  expect(gReset.ammo).toBe(GHOST.magazine)
  expect(wReset.health).toBe(MAX_HEALTH.warden)
  expect(wReset.ammo, 'the Warden has a full magazine again').toBe(WARDEN.magazine)
  expect(inArea(gReset, GRAYBOX_MAP.spawnAreas.ghost)).toBe(true)
  expect(inArea(wReset, GRAYBOX_MAP.spawnAreas.warden)).toBe(true)
  expect(events[0]).toEqual([['live', 1, '', ''], ['ended', 1, 'warden', 'ghosts_eliminated'], ['countdown', 2, '', '']])
  expect(events[1], 'both teams get the same events').toEqual(events[0])
})

test('the only Ghost leaving in live aborts to waiting with no winner; a new Ghost restarts the round', async () => {
  test.setTimeout(30_000)
  const g = await createRound(open)
  const w = await joinRound(g.roomId, open)
  const wEvents = collectRoundEvents(w)
  await waitForPhase(w, 'live', 5000)
  const wTerm = watchTerminal(w)
  await sleep(300)
  await leaveQuietly(g)
  await waitForPhase(w, 'waiting', 2000)
  const aborted = roundPlain(roundOf(w)!)
  const warden = own(w)
  await sleep(4000) // longer than ended: nothing may end or restart
  const stillWaiting = roundPlain(roundOf(w)!)

  const g2 = await joinRound(w.roomId, open)
  await waitForPhase(w, 'countdown', 2000)
  const restarted = roundPlain(roundOf(w)!)
  await waitForPhase(g2, 'live', 4000)
  const ghost2 = own(g2)
  wEvents.stop()
  const phases = wEvents.events.map((e) => [e.phase, e.winner, e.winReason])
  const statuses = [...wTerm.statuses]
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(aborted).toMatchObject({ phase: 'waiting', roundNumber: 1, secondsLeft: 0, winner: '', winReason: '' })
  expect(stillWaiting).toEqual(aborted)
  expect(warden.health).toBe(MAX_HEALTH.warden)
  expect(restarted).toMatchObject({ phase: 'countdown', roundNumber: 2, winner: '', winReason: '' })
  expect(ghost2.health, 'the new Ghost is alive').toBe(MAX_HEALTH.ghost)
  expect(phases, 'no ended event, no winner').toEqual([['countdown', '', ''], ['live', '', ''], ['waiting', '', ''], ['countdown', '', ''], ['live', '', '']])
  expect(statuses).toEqual(['idle'])
})

test('a Ghost who dies and rejoins sits out and gets no fresh life; its inputs are ignored while the round goes on', async () => {
  test.setTimeout(45_000)
  const g1 = await createRound(open)
  const g1Id = g1.sessionId
  const w = await joinRound(g1.roomId, open)
  const g2 = await joinRound(g1.roomId, open)
  quiet(g1, w, g2)
  const { visibility } = await faceOff(g1, w)
  await shootDown(w, g1, g1Id)
  const g1Dead = own(g1).health
  const phaseAfterKill = roundOf(g2)!.phase // g2 is still alive: the round goes on
  const g2Health = own(g2).health

  await leaveQuietly(g1)
  const g3 = await joinRound(w.roomId, open)
  quiet(g3)
  const joined = own(g3)
  const joinedTeam = pos(g3, g3.sessionId).team
  const before = own(g3)
  for (let i = 0; i < 4; i++) {
    g3.send(MOVE_MESSAGE, { dx: 1, dz: 1, yaw: 1 })
    g3.send(FIRE_MESSAGE, { yaw: 0, pitch: 0 })
    await sleep(60)
  }
  g3.send(INTERACT_MESSAGE, { active: true })
  await sleep(400)
  const after = own(g3)
  const phase = roundOf(g3)!.phase
  const round = roundPlain(roundOf(g3)!)
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(visibility).not.toBe('hidden')
  expect(g1Dead, 'the Ghost was killed').toBe(0)
  expect(phaseAfterKill, 'a living Ghost keeps the round live').toBe('live')
  expect(g2Health).toBe(MAX_HEALTH.ghost)
  expect(joinedTeam).toBe('ghost')
  expect(joined.health, 'rejoining gives no fresh life').toBe(0)
  expect(after, 'a sat-out joiner cannot move, turn or fire').toEqual(before)
  expect(phase).toBe('live')
  expect(round).toMatchObject({ roundNumber: 1, winner: '', winReason: '' })
})
