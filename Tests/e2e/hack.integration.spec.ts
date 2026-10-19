import { expect, test } from '@playwright/test'
import { ACTIVE_TERMINAL_ID } from '../../shared/map.js'
import { HACK_DECAY_RATIO, HACK_DURATION_MS, INTERACT_MESSAGE } from '../../shared/protocol.js'
import { Walker, joinInOrder, leaveQuietly, type GameRoom } from './support/sdk.js'
import { collectProgress, collectProgressTimed, terminalOf, terminalPlacement, watchTerminal, type TimedProgress } from './support/terminal.js'

// M6 server hack (#56, verified in #57) through real @colyseus/sdk clients,
// three fresh rooms in parallel:
//  A. the one full-length hack: duration, rising hackProgress, hacked is final,
//     15 invalid payloads spend no token, every client sees the same terminal,
//     and a Warden is never sent hackProgress.
//  B. range edge (a Ghost 0.1 outside gets nothing, a held key does not
//     resume), Warden at the terminal, forged interact from across the map,
//     release / decay / resume, no stacking of two Ghosts, interact flood.
//  C. the inactive terminal (terminal-b) cannot be hacked.
// Geometry and the finer rules are covered by Mocha (server/test/MyRoomHack.test.ts).
// Not asserted here, on purpose: what a Warden sees while the hack runs (the
// 3 s withholding comes in #58), and interrupts by moving or damage (#58).
//
// Per Docs/handoff.md: problems are collected and asserted once, after the SDK
// clients have left; truth about a Ghost is read from a Ghost client.

test.describe.configure({ mode: 'parallel' })

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls `cond` every 20 ms; throws after `ms` (a failure, never a delay). */
async function until(what: string, ms: number, cond: () => boolean): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${what}`)
    await sleep(20)
  }
}

const interact = (r: GameRoom, active: boolean) => r.send(INTERACT_MESSAGE, { active })

/** Progress gained per second between the first and last sample (0 if fewer than 3). */
function slope(s: TimedProgress[]): number {
  if (s.length < 3) return 0
  return ((s[s.length - 1].progress - s[0].progress) / (s[s.length - 1].t - s[0].t)) * 1000
}

/** Per-second gain rate of the hack, from shared constants. */
const GAIN = 1000 / HACK_DURATION_MS

/** 15 payloads the server must ignore without spending a token. */
const INVALID: unknown[] = [
  null,
  undefined,
  [],
  [true],
  'interact',
  '',
  7,
  true,
  {},
  { active: 1 },
  { active: 'true' },
  { active: null },
  { active: [] },
  { active: {} },
  { Active: true },
]

// Routes (clear of every solid; Walker checks hazards). A Ghost spawns outside
// to the south and goes through door-south; the Warden goes round the west side.
const ghostToInsideDoor = async (w: Walker) => {
  const z0 = w.pos.z
  await w.walkTo({ x: 0, z: z0 }, 'xz')
  await w.walkTo({ x: 0, z: -5.5 }, 'zx')
}

test('a Ghost in range hacks the active terminal in HACK_DURATION_MS; invalid payloads spend no token; a Warden is told nothing', async () => {
  const rooms = await joinInOrder(2, open)
  const [g, w] = rooms
  const { inside } = terminalPlacement()
  const gw = new Walker(g, 'ghost')
  const progress = collectProgressTimed(g)
  const wardenProgress = collectProgress(w)
  const gTerm = watchTerminal(g)
  const wTerm = watchTerminal(w)

  await ghostToInsideDoor(gw)
  await gw.walkTo(inside, 'xz')

  // 15 invalid payloads spend nothing, so the valid start right after is accepted.
  for (const p of INVALID) g.send(INTERACT_MESSAGE, p)
  const t0 = Date.now()
  interact(g, true)
  await until('the Ghost sees the terminal hacked', 14_000, () => gTerm.hackedAt !== null)
  const elapsed = gTerm.hackedAt! - t0
  await until('the Warden sees the terminal hacked', 2_000, () => wTerm.hackedAt !== null)

  // Further interacts change nothing once hacked.
  const countAtHacked = progress.samples.length
  interact(g, false)
  await sleep(300)
  interact(g, true)
  await sleep(300)
  interact(g, false)
  await sleep(500)
  const result = {
    elapsed,
    samples: [...progress.samples],
    countAtHacked,
    countAfter: progress.samples.length,
    wardenMessages: wardenProgress.progress.length,
    ghostSees: terminalOf(g)?.status,
    wardenSees: terminalOf(w)?.status,
    otherTerminal: [terminalOf(g, 'terminal-b')?.status, terminalOf(w, 'terminal-b')?.status],
    gAlert: terminalOf(g)?.alert,
    violations: [...gw.violations],
  }
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(result.violations).toEqual([])
  expect(result.elapsed, 'hack length from the start press to the hacked state').toBeGreaterThanOrEqual(HACK_DURATION_MS - 200)
  expect(result.elapsed).toBeLessThanOrEqual(HACK_DURATION_MS + 1000)
  expect(result.samples.length, 'hackProgress arrives repeatedly').toBeGreaterThan(20)
  const values = result.samples.map((s) => s.progress)
  for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] - 1e-9)
  expect(values[values.length - 1]).toBeCloseTo(1, 5)
  // Each value matches the time since the press, within 0.12 (message jitter, one 50 ms step).
  const off = result.samples.filter((s) => Math.abs(s.progress - Math.min(1, (s.t - t0) / HACK_DURATION_MS)) > 0.12)
  expect(off, 'progress follows server time').toEqual([])
  expect(result.countAfter, 'no progress message after hacked').toBe(result.countAtHacked)
  expect(result.ghostSees).toBe('hacked')
  expect(result.wardenSees, 'terminal state is the same on every client').toBe('hacked')
  expect(result.otherTerminal).toEqual(['idle', 'idle'])
  expect(result.wardenMessages, 'a Warden never gets hackProgress').toBe(0)
})

test('range edge, Warden, forged interact, release and decay, no stacking, interact flood', async () => {
  const rooms = await joinInOrder(3, open) // ghost, warden, ghost
  const [g1, w, g2] = rooms
  const { inside, outside } = terminalPlacement()
  const w1 = new Walker(g1, 'ghost1')
  const w2 = new Walker(g2, 'ghost2')
  const ww = new Walker(w, 'warden')
  const progress = collectProgressTimed(g1)
  const wardenProgress = collectProgress(w)
  const term = watchTerminal(g1)
  collectProgress(g2) // a listener, so the SDK doesn't warn for every message

  // Forged: a Ghost at its spawn, across the map, presses.
  interact(g2, true)
  await sleep(700)
  interact(g2, false)
  const forged = { samples: progress.samples.length, statuses: [...term.statuses] }

  // Everyone walks to the terminal: the Ghosts to just outside the range, the Warden into it.
  await Promise.all([
    (async () => {
      await ghostToInsideDoor(w1)
      await w1.walkTo(outside, 'xz')
    })(),
    (async () => {
      await ghostToInsideDoor(w2)
      await w2.walkTo(outside, 'xz')
    })(),
    (async () => {
      await ww.walkTo({ x: ww.pos.x, z: -1 }, 'zx')
      await ww.walkTo({ x: -8.3, z: -1 }, 'xz')
      await ww.walkTo({ x: -8.3, z: -4.4 }, 'zx')
    })(),
  ])

  // Phase 1: both Ghosts just outside and the Warden at the terminal press. Nothing happens.
  interact(g1, true)
  interact(g2, true)
  interact(w, true)
  await sleep(800)
  // A held key does not start a hack when a Ghost steps in later (the press was refused).
  await w1.walkTo(inside, 'xz')
  await sleep(700)
  const phase1 = { samples: progress.samples.length, statuses: [...term.statuses], status: terminalOf(g1)?.status }
  interact(w, false)
  interact(g2, false)
  interact(g1, false)
  await sleep(300)

  // Phase 2: 15 invalid payloads, then a valid press starts the hack at once; hold, release, decay, resume.
  for (const p of INVALID) g1.send(INTERACT_MESSAGE, p)
  const pressedAt = Date.now()
  interact(g1, true)
  await until('first hackProgress after the press', 1_500, () => progress.samples.length > phase1.samples)
  const firstDelay = progress.samples[phase1.samples].t - pressedAt
  await until('progress 0.25', 5_000, () => (progress.samples.at(-1)?.progress ?? 0) >= 0.25)
  const holdSamples = progress.samples.slice(phase1.samples)
  interact(g1, false)
  await sleep(300)
  const releaseIdx = progress.samples.length
  const keptAtRelease = progress.samples.at(-1)!.progress
  await sleep(1800)
  const decaySamples = progress.samples.slice(releaseIdx)
  const kept = progress.samples.at(-1)!.progress
  const resumeIdx = progress.samples.length
  interact(g1, true)
  await until('resumed progress rises', 3_000, () => (progress.samples.at(-1)?.progress ?? 0) > kept + 0.05)
  const resumed = progress.samples.slice(resumeIdx)
  interact(g1, false)
  await sleep(300)

  // Phase 3: both Ghosts hold; progress does not go faster than for one.
  await w2.walkTo(inside, 'xz')
  interact(g1, true)
  interact(g2, true)
  await sleep(400)
  const bothIdx = progress.samples.length
  await sleep(1500)
  const both = progress.samples.slice(bothIdx)
  interact(g1, false)
  interact(g2, false)

  // Phase 4: a flood of 21 alternating messages (true first and last) is capped by the bucket
  // (4/s, burst 2): only true then false get through, so nobody ends up hacking.
  await sleep(1000)
  for (let i = 0; i < 21; i++) interact(g1, i % 2 === 0)
  await sleep(400)
  const floodIdx = progress.samples.length
  await sleep(800)
  const afterFlood = progress.samples.slice(floodIdx)
  const result = {
    forged,
    phase1,
    firstDelay,
    holdSlope: slope(holdSamples),
    decaySlope: slope(decaySamples),
    decay: decaySamples.map((s) => s.progress),
    keptAtRelease,
    kept,
    resumed: resumed.map((s) => s.progress),
    bothSlope: slope(both),
    afterFlood: afterFlood.map((s) => s.progress),
    finalStatus: terminalOf(g1)?.status,
    wardenMessages: wardenProgress.progress.length,
    violations: [...w1.violations, ...w2.violations, ...ww.violations],
  }
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(result.violations).toEqual([])
  expect(result.forged.samples, 'a forged interact from across the map is ignored').toBe(0)
  expect(result.forged.statuses).toEqual(['idle'])
  expect(result.phase1.samples, 'out of range and a Warden in range: no progress').toBe(0)
  expect(result.phase1.statuses, 'out of range and a Warden in range: never hacking').toEqual(['idle'])
  expect(result.phase1.status).toBe('idle')
  expect(result.firstDelay, 'a valid press right after 15 invalid payloads is accepted').toBeLessThan(1000)
  // Tolerances: message jitter over 1.8 s is small; rates must be within 30% of the constants.
  expect(result.holdSlope).toBeGreaterThan(GAIN * 0.7)
  expect(result.holdSlope).toBeLessThan(GAIN * 1.3)
  expect(result.decaySlope, 'progress falls after release').toBeLessThan(0)
  expect(Math.abs(result.decaySlope) / GAIN, `decay is about HACK_DECAY_RATIO (${HACK_DECAY_RATIO}) of the gain`).toBeGreaterThan(HACK_DECAY_RATIO * 0.7)
  expect(Math.abs(result.decaySlope) / GAIN).toBeLessThan(HACK_DECAY_RATIO * 1.3)
  for (let i = 1; i < result.decay.length; i++) expect(result.decay[i], 'release stops the gain').toBeLessThanOrEqual(result.decay[i - 1] + 1e-9)
  expect(result.kept, 'progress is kept, not reset').toBeGreaterThan(0.1)
  expect(result.kept).toBeLessThan(result.keptAtRelease)
  expect(result.resumed[0], 'a second press continues from the kept progress').toBeGreaterThanOrEqual(result.kept - 0.03)
  expect(result.bothSlope, 'two Ghosts hold: not faster than one').toBeGreaterThan(GAIN * 0.7)
  expect(result.bothSlope).toBeLessThan(GAIN * 1.3)
  for (let i = 1; i < result.afterFlood.length; i++) expect(result.afterFlood[i], 'a capped flood leaves nobody hacking').toBeLessThanOrEqual(result.afterFlood[i - 1] + 1e-9)
  expect(result.finalStatus).toBe('idle')
  expect(result.wardenMessages, 'a Warden never gets hackProgress').toBe(0)
})

test('the inactive terminal cannot be hacked', async () => {
  const rooms = await joinInOrder(1, open)
  const [g] = rooms
  const other = 'terminal-b'
  expect(other).not.toBe(ACTIVE_TERMINAL_ID)
  const { inside } = terminalPlacement(other)
  const gw = new Walker(g, 'ghost')
  const progress = collectProgress(g)
  const b = watchTerminal(g, other)
  const a = watchTerminal(g)

  const z0 = gw.pos.z
  await gw.walkTo({ x: 0, z: z0 }, 'xz')
  await gw.walkTo({ x: 0, z: -6 }, 'zx')
  await gw.walkTo({ x: 3.25, z: -6 }, 'xz')
  await gw.walkTo({ x: 3.25, z: inside.z }, 'zx')
  await gw.walkTo(inside, 'xz')
  interact(g, true)
  await sleep(1200)
  const result = { progress: progress.progress.map((m) => m.progress), b: [...b.statuses], a: [...a.statuses], violations: [...gw.violations] }
  await leaveQuietly(g)

  expect(result.violations).toEqual([])
  // The one message a Ghost gets on joining (progress 0) may land after the listener is set; nothing may rise.
  expect(result.progress.every((p) => p === 0)).toBe(true)
  expect(result.b).toEqual(['idle'])
  expect(result.a).toEqual(['idle'])
})
