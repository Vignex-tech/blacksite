import { expect, test } from '@playwright/test'
import { ACTION_MESSAGE, EYE_HEIGHT, FIRE_MESSAGE, HACK_ALERT_AFTER_MS, HACK_PROGRESS_MESSAGE, INTERACT_MESSAGE, MOVE_MESSAGE } from '../../shared/protocol.js'
import { PLAYER_HEIGHT } from '../../shared/map.js'
import { feetY } from './support/geometry.js'
import { Walker, joinInOrder, leaveQuietly, pos, type GameRoom } from './support/sdk.js'
import { scanFrames, searchable } from './support/scan.js'
import { collectProgress, collectProgressTimed, terminalOf, terminalPlacement, watchTerminal } from './support/terminal.js'
import { vitalsOf } from './support/vitals.js'
import { visibilityOf } from './support/visibility.js'
import { framesOf, joinWire } from './support/wire.js'

// M6 hack interruptions and the Warden information limit (#58, verified in
// #59), through real @colyseus/sdk clients, three fresh rooms in parallel:
//  A. interrupts: a Warden with a clear view shoots the hacking Ghost, which
//     stops gaining at once and does not resume on a held key until a new
//     press; a turn-only move does not interrupt, a move with intent does
//     (and walks out of range), a jump does, eliminating the hacker does.
//     Progress decays and a re-press resumes from the kept value. What the
//     Warden's state shows: idle / no alert for the first HACK_ALERT_AFTER_MS,
//     then hacking + alert, and the alert clears on the interrupt.
//  B. the wire: a Warden who cannot see the hacking Ghost receives no
//     hackProgress frame, no Ghost id and no Ghost coordinates (scan windows
//     start 250 ms after the press, as in #47), with a positive control on the
//     Ghost's frames.
//  C. forged data: a Warden's interact is ignored, and an unregistered message
//     type disconnects only the forger (code 4002).
// Finer rules (timer restart, second Ghost, range edge) are in Mocha
// (server/test/MyRoomHackInterrupt.test.ts).
//
// Per Docs/handoff.md: problems are collected and asserted once, after the SDK
// clients have left; truth about a Ghost is read from a Ghost client.

test.describe.configure({ mode: 'parallel' })

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(what: string, ms: number, cond: () => boolean): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${what}`)
    await sleep(20)
  }
}

const interact = (r: GameRoom, active: boolean) => r.send(INTERACT_MESSAGE, { active })
/** The interact bucket refills 4/s: keep presses and releases this far apart. */
const GAP = 300
/** Samples are judged from this long after the cause (as in #47). */
const SETTLE = 250

const ghostToInsideDoor = async (w: Walker) => {
  const z0 = w.pos.z
  await w.walkTo({ x: 0, z: z0 }, 'xz')
  await w.walkTo({ x: 0, z: -5.5 }, 'zx')
}

interface Seen {
  t: number
  status: string
  alert: boolean
}

/** Every (status, alert) pair of the active terminal that `room` received, with arrival times. */
function watchPairs(room: GameRoom): Seen[] {
  const out: Seen[] = []
  const look = () => {
    const t = terminalOf(room)
    if (t) out.push({ t: Date.now(), status: t.status, alert: t.alert })
  }
  room.onStateChange(look)
  look()
  return out
}

// The Warden stands in the west column of the building (the route test B of
// hack.integration.spec.ts also walks), with a clear line to the hacker.
const WARDEN_SPOT = { x: -8.3, z: -1 }
const wardenToSpot = async (w: Walker) => {
  await w.walkTo({ x: w.pos.x, z: -1 }, 'zx')
  await w.walkTo(WARDEN_SPOT, 'xz')
}

test('a shot, a move, a jump and an elimination stop the hack; a turn does not; progress decays and a re-press resumes; the Warden sees the alert only after 3 s and loses it on the interrupt', async () => {
  test.setTimeout(120_000)
  const [g, w] = await joinInOrder(2, open)
  const gid = g.sessionId
  const wid = w.sessionId
  const { inside, outside } = terminalPlacement()
  // A jump leaves the ground on purpose (and both walkers see it), so the ground check is off.
  const gw = new Walker(g, 'ghost', { ground: false })
  const ww = new Walker(w, 'warden', { ground: false })
  const progress = collectProgressTimed(g)
  const wardenProgress = collectProgress(w)
  const wSees = watchPairs(w)

  const aim = () => {
    const s = pos(g, wid)
    const t = pos(g, gid)
    const dx = t.x - s.x
    const dz = t.z - s.z
    const dy = feetY(t) + PLAYER_HEIGHT / 2 - (feetY(s) + EYE_HEIGHT)
    return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
  }
  const shoot = () => w.send(FIRE_MESSAGE, aim())
  const last = () => progress.samples.at(-1)?.progress ?? 0
  /** Presses and waits until progress has risen by `by`. */
  const press = async (by: number) => {
    const from = last()
    const t = Date.now()
    interact(g, true)
    await until(`progress rises by ${by}`, 6_000, () => last() >= from + by)
    return { t, from }
  }
  const release = async () => {
    interact(g, false)
    await sleep(GAP)
  }

  await Promise.all([
    (async () => {
      await ghostToInsideDoor(gw)
      await gw.walkTo(inside, 'xz')
    })(),
    wardenToSpot(ww),
  ])
  const placement = visibilityOf(pos(g, wid), pos(g, gid))

  // 1. The first 3 s: nothing for the Warden. Then the alert.
  const t0 = Date.now()
  interact(g, true)
  await until('the Warden sees the alert', 6_000, () => terminalOf(w)?.alert === true)
  const alertAfter = Date.now() - t0
  const aboutToShoot = last()

  // 2. A shot: the gain stops at once. The key stays down and does not resume.
  const shotAt = Date.now()
  shoot()
  await until('the Warden loses the alert', 2_000, () => terminalOf(w)?.alert === false)
  const alertOffAfter = Date.now() - shotAt
  await sleep(1000)
  const afterShot = progress.samples.filter((s) => s.t >= shotAt + SETTLE)
  const keptAfterShot = last()
  const healthAfterShot = vitalsOf(g, gid)?.health
  // A new press resumes from the kept value.
  await release()
  const resume = await press(0.05)
  const resumedFirst = progress.samples.find((s) => s.t >= resume.t)!.progress

  // 3. A turn-only move does not interrupt.
  const turnFrom = last()
  g.send(MOVE_MESSAGE, { dx: 0, dz: 0, yaw: 0.7 })
  await until('progress keeps rising after a turn', 3_000, () => last() >= turnFrom + 0.04)
  const alertAfterTurn = terminalOf(w)?.alert // under 3 s since the re-press: no alert either way

  // 4. A move with intent stops it (and walks out of range).
  const moveAt = Date.now()
  const beforeMove = last()
  await gw.walkTo(outside, 'xz')
  await sleep(700)
  const afterMove = progress.samples.filter((s) => s.t >= moveAt + SETTLE)
  await release()

  // 5. A jump stops it.
  await gw.walkTo(inside, 'xz')
  await press(0.05)
  const beforeJump = last()
  const jumpAt = Date.now()
  g.send(ACTION_MESSAGE, { action: 'jump' })
  await sleep(1000)
  const afterJump = progress.samples.filter((s) => s.t >= jumpAt + SETTLE)
  await release()

  // 6. Eliminating the hacker stops it.
  await press(0.05)
  const beforeKill = last()
  for (let i = 0; i < 8 && (vitalsOf(g, gid)?.health ?? 1) > 0; i++) {
    shoot()
    await sleep(200)
  }
  await sleep(200)
  const killedAt = Date.now()
  const healthEnd = vitalsOf(g, gid)?.health
  await sleep(800)
  const afterKill = progress.samples.filter((s) => s.t >= killedAt + SETTLE)
  const wardenEnd = terminalOf(w)

  const result = {
    placement,
    alertAfter,
    alertOffAfter,
    healthAfterShot,
    pairs: [...wSees],
    t0,
    aboutToShoot,
    keptAfterShot,
    afterShot: afterShot.map((s) => s.progress),
    resumeFrom: resume.from,
    resumedFirst,
    alertAfterTurn,
    afterMove: afterMove.map((s) => s.progress),
    beforeMove,
    beforeJump,
    afterJump: afterJump.map((s) => s.progress),
    beforeKill,
    afterKill: afterKill.map((s) => s.progress),
    healthEnd,
    wardenEnd: [wardenEnd?.status, wardenEnd?.alert],
    wardenMessages: wardenProgress.progress.length,
    violations: [...gw.violations, ...ww.violations],
  }
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(result.violations).toEqual([])
  expect(result.placement, 'the Warden has a legal shot').toBe('visible')
  // Withholding: idle and no alert before HACK_ALERT_AFTER_MS, then hacking + alert.
  expect(result.alertAfter, 'no alert before 3 s').toBeGreaterThanOrEqual(HACK_ALERT_AFTER_MS - 300)
  expect(result.alertAfter).toBeLessThanOrEqual(HACK_ALERT_AFTER_MS + 1200)
  for (const p of result.pairs) {
    if (p.t < result.t0 + HACK_ALERT_AFTER_MS - 300) expect([p.status, p.alert], 'no cue in the first 3 s').toEqual(['idle', false])
    if (p.status === 'hacking') expect(p.alert, 'hacking only while the alert is on').toBe(true)
    expect(['idle', 'hacking']).toContain(p.status)
  }
  expect(result.pairs.some((p) => p.status === 'hacking' && p.alert)).toBe(true)
  expect(result.alertOffAfter, 'the alert clears on the interrupt').toBeLessThan(1000)
  // A shot.
  expect(result.healthAfterShot, 'the shot hit').toBeLessThan(100)
  expect(result.aboutToShoot).toBeGreaterThan(0.2)
  expect(result.afterShot.length).toBeGreaterThan(0)
  expect(Math.max(...result.afterShot), 'no gain after the shot, key still down').toBeLessThanOrEqual(result.aboutToShoot + 0.011)
  expect(result.keptAfterShot, 'progress decays and is kept, not reset').toBeLessThan(result.aboutToShoot)
  expect(result.keptAfterShot).toBeGreaterThan(0.05)
  expect(result.resumedFirst, 'a new press resumes from the kept value').toBeGreaterThanOrEqual(result.resumeFrom - 0.03)
  // A turn is no interrupt; a move is.
  expect(result.alertAfterTurn).toBe(false)
  expect(result.afterMove.length).toBeGreaterThan(0)
  expect(Math.max(...result.afterMove), 'no gain after a move').toBeLessThanOrEqual(result.beforeMove + 0.011)
  // A jump.
  expect(result.afterJump.length).toBeGreaterThan(0)
  expect(Math.max(...result.afterJump), 'no gain after a jump').toBeLessThanOrEqual(result.beforeJump + 0.011)
  // Elimination.
  expect(result.healthEnd, 'the hacker was eliminated').toBeLessThanOrEqual(0)
  expect(Math.max(0, ...result.afterKill), 'no gain after the hacker is eliminated').toBeLessThanOrEqual(result.beforeKill + 0.011)
  expect(result.wardenEnd).toEqual(['idle', false])
  expect(result.wardenMessages, 'a Warden never gets hackProgress').toBe(0)
})

test('a Warden who cannot see the hacker receives no hackProgress, no Ghost id and no Ghost coordinates, and no cue in the first 3 s', async () => {
  test.setTimeout(120_000)
  const [g, w] = await joinWire(2, open)
  const gid = g.sessionId
  const { inside } = terminalPlacement()
  const gw = new Walker(g, 'ghost')
  const ww = new Walker(w, 'warden')
  const wardenProgress = collectProgress(w)
  const wSees = watchPairs(w)
  const wTerm = watchTerminal(w)

  // Outside the west wall: a wall between the Warden and everything near the terminal.
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
  await sleep(400)
  const placement = visibilityOf(pos(g, w.sessionId), pos(g, gid))
  const heldGhost = w.state.players.has(gid)
  const ghostAt = { ...pos(g, gid) }

  const t0 = Date.now()
  interact(g, true)
  await sleep(1500)
  const early = terminalOf(w)
  await until('the Warden sees the alert', 6_000, () => terminalOf(w)?.alert === true)
  const alerted = terminalOf(w)
  await sleep(500)
  interact(g, false)
  await until('the alert clears', 2_000, () => terminalOf(w)?.alert === false)
  await sleep(300)

  const values = [ghostAt.x, ghostAt.z].filter(searchable)
  const window = { from: t0 + SETTLE, to: Date.now() }
  const wardenHits = scanFrames(framesOf(w), { ids: [gid, HACK_PROGRESS_MESSAGE], values, ...window })
  const ghostHits = scanFrames(framesOf(g), { ids: [HACK_PROGRESS_MESSAGE], ...window })
  const control = scanFrames(framesOf(g), { ids: [gid], values })
  const result = {
    placement,
    heldGhost,
    values: values.length,
    early: [early?.status, early?.alert],
    alerted: [alerted?.status, alerted?.alert],
    earlyPairs: wSees.filter((p) => p.t < t0 + HACK_ALERT_AFTER_MS - 300).map((p) => [p.status, p.alert]),
    statuses: [...wTerm.statuses],
    wardenHits: wardenHits.slice(0, 5).map((h) => `${h.what} at ${h.t - t0} ms`),
    ghostHits: ghostHits.length,
    controlIds: control.some((h) => h.what.startsWith('session id')),
    controlValues: control.filter((h) => !h.what.startsWith('session id')).length,
    messages: wardenProgress.progress.length,
    violations: [...gw.violations, ...ww.violations],
  }
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(result.violations).toEqual([])
  expect(result.placement, 'the Warden cannot see the hacker').toBe('hidden')
  expect(result.heldGhost, 'the Warden state does not hold the Ghost').toBe(false)
  expect(result.values, 'the scan searched for coordinates').toBeGreaterThan(0)
  expect(result.controlIds, 'positive control: the Ghost client frames hold its id').toBe(true)
  expect(result.controlValues, 'positive control: the Ghost client frames hold its coordinates').toBeGreaterThan(0)
  expect(result.ghostHits, 'positive control: the Ghost is sent hackProgress').toBeGreaterThan(0)
  expect(result.early, 'no cue in the first seconds').toEqual(['idle', false])
  expect(result.earlyPairs.every((p) => p[0] === 'idle' && p[1] === false)).toBe(true)
  expect(result.alerted).toEqual(['hacking', true])
  expect([...result.statuses].sort()).toEqual(['hacking', 'idle'])
  expect(result.messages, 'a Warden never gets hackProgress').toBe(0)
  expect(result.wardenHits, 'no hackProgress frame, hacker id or coordinates in the Warden frames').toEqual([])
})

test('a Warden interact is ignored; an unregistered message type disconnects only the forger (4002)', async () => {
  const [g, w, g2] = await joinInOrder(3, open)
  collectProgress(g)
  collectProgress(g2)
  const wardenProgress = collectProgress(w)
  const gTerm = watchTerminal(g)
  const closes: number[] = []
  const closesOthers: number[] = []
  w.onLeave((code) => closes.push(code))
  g.onLeave((code) => closesOthers.push(code))
  g2.onLeave((code) => closesOthers.push(code))

  // A Warden pressing interact: nothing starts.
  interact(w, true)
  await sleep(600)
  interact(w, false)
  await sleep(GAP)
  const statuses = [...gTerm.statuses]

  // The forger.
  w.send('definitelyNotAMessage', { x: 1 })
  await until('the forger is disconnected', 5_000, () => !w.connection.isOpen)
  await sleep(500)
  const result = {
    statuses,
    closes: [...closes],
    closesOthers: [...closesOthers],
    othersOpen: [g.connection.isOpen, g2.connection.isOpen],
    othersSee: g.state.players.size,
    wardenMessages: wardenProgress.progress.length,
    terminal: terminalOf(g)?.status,
  }
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(result.statuses, 'a Warden interact starts nothing').toEqual(['idle'])
  expect(result.wardenMessages).toBe(0)
  expect(result.closes, 'the forger is closed with 4002').toEqual([4002])
  expect(result.othersOpen, 'other clients are unaffected').toEqual([true, true])
  expect(result.closesOthers).toEqual([])
  expect(result.othersSee).toBe(2)
  expect(result.terminal).toBe('idle')
})
