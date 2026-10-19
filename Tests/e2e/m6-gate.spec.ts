import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP } from '../../shared/map.js'
import { EYE_HEIGHT, HACK_ALERT_AFTER_MS, HACK_DURATION_MS, HACK_RANGE, INTERACT_MESSAGE, MAX_HEALTH, WEAPONS } from '../../shared/protocol.js'
import { Observer } from './support/observer.js'
import { collectProgress, distanceTo } from './support/terminal.js'
import { closeTabs, get, joined, local, lockPointer, openTab, RAD_PER_PIXEL, snap, turnTo, type Tab } from './support/tabs.js'
import { eyeOf, hasLineOfSight, visibilityOf } from './support/visibility.js'

// The M6 gate in real tabs (#62, tracking #53). A Ghost tab and a Warden tab,
// driven by keys and the mouse only; a third SDK client only forges an
// interact from across the map. What each step proves is listed in the
// closing comment of #62:
//  1. out of range, F (Ghost tab) and a forged SDK interact from the spawn
//     area give no progress, no bar, no alarm;
//  2. in range `F: hold to hack` shows; holding F gives a rising bar and the
//     hook's hack.progress; the Warden tab never shows a bar, a number, a
//     prompt or a hook `hack`, no alarm in the first HACK_ALERT_AFTER_MS, then
//     `Terminal alarm`; a Warden's F sends no interact frame and changes nothing;
//  3. the Warden shoots the Ghost: the gain stops with F still held, progress
//     decays, the alarm clears, and only a fresh F press resumes;
//  4. the resumed hold reaches `hacked` within the configured time; both tabs
//     show `Terminal hacked`.
// Tabs are 320x240 and use the pointer-lock stand-in. Everything is read from
// the hook and the DOM; problems are collected and asserted after the SDK
// client has left.

const REPORTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'Reports')
const RIFLE = WEAPONS.warden
const TERMINAL = GRAYBOX_MAP.terminals.find((t) => t.id === ACTIVE_TERMINAL_ID)!
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const text = (tab: Tab, id: string) => tab.page.locator(`#${id}`).innerText()
const progressOf = async (tab: Tab) => (await snap(tab.page)).hack?.progress ?? null
const statusOf = async (tab: Tab) => (await snap(tab.page)).terminals?.find((t) => t.id === ACTIVE_TERMINAL_ID)

/** Holds `key` until `done` is true for the local player's position (closed loop), then releases it. */
async function holdUntil(tab: Tab, key: string, done: (p: { x: number; z: number }) => boolean): Promise<void> {
  await tab.page.keyboard.down(key)
  try {
    const started = Date.now()
    while (Date.now() - started < 15_000) {
      if (done(local(await snap(tab.page)))) return
      await sleep(15)
    }
    throw new Error(`${tab.name}: ${key} did not reach its goal in 15 s (at ${JSON.stringify(local(await snap(tab.page)))})`)
  } finally {
    await tab.page.keyboard.up(key)
    await sleep(120)
  }
}

/** Left-button event on the canvas, dispatched in the page (page.mouse does not reach it under the lock stand-in, #51). */
const mouseButton = (tab: Tab, type: 'mousedown' | 'mouseup') =>
  tab.page.evaluate((t) => {
    document.getElementById('game-canvas')!.dispatchEvent(new MouseEvent(t, { button: 0, bubbles: true, cancelable: true }))
  }, type)

async function click(tab: Tab, ms: number): Promise<void> {
  await mouseButton(tab, 'mousedown')
  try {
    await sleep(ms)
  } finally {
    await mouseButton(tab, 'mouseup')
  }
}

const tilt = (tab: Tab, pixels: number) =>
  tab.page.evaluate((py) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: py, bubbles: true })), pixels)

test('M6 gate: a Ghost tab hacks the terminal, the Warden tab hears the alarm and interrupts it, the hack resumes and completes', async ({ browser }) => {
  test.setTimeout(120_000)
  let ghostTab: Tab | undefined
  let wardenTab: Tab | undefined
  let obs: Observer | undefined
  try {
    ghostTab = await openTab(browser, 'ghost tab')
    const g0 = await joined(ghostTab, { ghosts: 1, wardens: 0 })
    wardenTab = await openTab(browser, 'warden tab')
    const w0 = await joined(wardenTab, { ghosts: 1, wardens: 1 })
    const gt = ghostTab
    const wt = wardenTab
    const ghostId = g0.sessionId!
    const wardenId = w0.sessionId!
    expect([g0.localTeam, w0.localTeam]).toEqual(['ghost', 'warden'])
    await lockPointer(wt)

    const ghostPos = async () => get(await snap(gt.page), ghostId)
    const wardenPos = async () => get(await snap(gt.page), wardenId)

    // The Warden walks to a spot with a clear line to the terminal's west side
    // while the Ghost walks out of range of the terminal (dist 2.5 or more).
    // Ghost: line up with the south door, walk in, then west along z -5.5.
    const ghostWalk = (async () => {
      const x = local(await snap(gt.page)).x
      if (Math.abs(x) > 0.25) await holdUntil(gt, x > 0 ? 'KeyA' : 'KeyD', (p) => Math.abs(p.x) <= 0.25)
      await holdUntil(gt, 'KeyW', (p) => p.z >= -5.5)
      await holdUntil(gt, 'KeyA', (p) => p.x <= -5.0)
    })()
    const wardenWalk = (async () => {
      await holdUntil(wt, 'KeyS', (p) => p.z <= -1)
      await holdUntil(wt, 'KeyA', (p) => p.x <= -8.3)
    })()
    await Promise.all([ghostWalk, wardenWalk])

    // 1. Out of range: F in the Ghost tab and a forged interact from the spawn
    // area (SDK Ghost, the room's third client) give nothing.
    const outPos = await ghostPos()
    const outDist = distanceTo(outPos, TERMINAL)
    obs = await Observer.join()
    const forged = collectProgress(obs.room)
    await joined(gt, { ghosts: 2, wardens: 1 })
    const obsAt = obs.at(obs.id)!
    const obsDist = distanceTo(obsAt, TERMINAL)
    await gt.page.keyboard.down('KeyF')
    obs.room.send(INTERACT_MESSAGE, { active: true })
    await sleep(1500)
    const out = {
      prompt: await text(gt, 'hack-prompt'),
      bar: await text(gt, 'hack-bar'),
      ghostProgress: await progressOf(gt),
      ghostTerminal: await statusOf(gt),
      wardenTerminal: await statusOf(wt),
      wardenAlert: await text(wt, 'hack-alert'),
    }
    await gt.page.keyboard.up('KeyF')
    obs.room.send(INTERACT_MESSAGE, { active: false })
    await sleep(350)
    const forgedProgress = forged.progress.map((m) => m.progress)
    await obs.leave()
    obs = undefined

    expect(outDist, 'the Ghost tab starts out of range').toBeGreaterThan(HACK_RANGE + 0.5)
    expect(obsDist, 'the SDK Ghost is across the map').toBeGreaterThan(HACK_RANGE + 5)
    expect(gt.sent.interacts.map((i) => i.active), 'F was really pressed out of range').toEqual([true, false])
    expect(out.prompt, 'no prompt out of range').toBe('')
    expect(out.bar, 'no bar out of range').toBe('')
    expect(out.ghostProgress ?? 0, 'no progress out of range').toBe(0)
    expect(out.ghostTerminal?.status).toBe('idle')
    expect(out.wardenTerminal?.status).toBe('idle')
    expect(out.wardenTerminal?.alert).toBe(false)
    expect(out.wardenAlert).toBe('')
    expect(forgedProgress.every((p) => p === 0), `a forged interact from across the map gained nothing (${forgedProgress})`).toBe(true)

    // 2. Into range. The prompt shows. The Warden aims at the Ghost first.
    await holdUntil(gt, 'KeyA', (p) => p.x <= -6.45)
    const target = await ghostPos()
    const warden = await wardenPos()
    expect(distanceTo(target, TERMINAL), 'in range').toBeLessThan(HACK_RANGE - 0.3)
    await expect(gt.page.locator('#hack-prompt')).toHaveText('F: hold to hack', { timeout: 5_000 })
    const aimY = 0.9
    expect(hasLineOfSight(eyeOf(warden), { x: target.x, y: aimY, z: target.z }), 'clear line from the Warden eye to the Ghost').toBe(true)
    expect(visibilityOf(warden, target), 'the Ghost is in the Warden sight').toBe('visible')
    await expect.poll(async () => (await snap(wt.page)).players.find((p) => p.id === ghostId)?.team, { timeout: 10_000 }).toBe('ghost')
    const yaw = Math.atan2(target.x - warden.x, target.z - warden.z)
    await turnTo(wt, yaw)
    const dist = Math.hypot(target.x - warden.x, target.z - warden.z)
    const wantPitch = Math.atan2(aimY - (warden.y + EYE_HEIGHT), dist) // wire: positive up
    // The starting pitch is not known (#63): clamp it at the limit (1.4, looking down), then tilt back to the wanted one.
    await tilt(wt, 1000)
    await tilt(wt, Math.round((-wantPitch - 1.4) / RAD_PER_PIXEL))
    mkdirSync(REPORTS, { recursive: true })

    const hits0 = (await snap(wt.page)).events.hits
    const t0 = Date.now()
    await gt.page.keyboard.down('KeyF')
    const timeline: { t: number; progress: number | null; bar: string; prompt: string; wAlert: string; wBar: string; wPrompt: string; wHack: unknown; wStatus: string; wFlag: boolean }[] = []
    const sample = async () => {
      const ws = await snap(wt.page)
      const wTerm = ws.terminals?.find((t) => t.id === ACTIVE_TERMINAL_ID)
      timeline.push({
        t: Date.now() - t0,
        progress: await progressOf(gt),
        bar: await text(gt, 'hack-bar'),
        prompt: await text(gt, 'hack-prompt'),
        wAlert: await text(wt, 'hack-alert'),
        wBar: await text(wt, 'hack-bar'),
        wPrompt: await text(wt, 'hack-prompt'),
        wHack: ws.hack ?? null,
        wStatus: wTerm?.status ?? 'missing',
        wFlag: wTerm?.alert ?? false,
      })
    }
    let shotAt = 0
    let screenshotted = false
    while (timeline.at(-1)?.wAlert !== 'Terminal alarm') {
      if (Date.now() - t0 > HACK_ALERT_AFTER_MS + 6000) throw new Error('the Warden tab never showed the alarm')
      await sample()
      if (!screenshotted && Date.now() - t0 > 1500) {
        screenshotted = true
        await gt.page.screenshot({ path: join(REPORTS, 'graybox-m6-ghost-hacking.png') })
      }
      await sleep(100)
    }
    // The Warden presses F by the alarm: nothing is sent, nothing changes.
    await wt.page.keyboard.down('KeyF')
    await sleep(300)
    await wt.page.keyboard.up('KeyF')
    await sample()
    const peakBeforeShot = timeline.at(-1)!.progress

    // 3. The Warden shoots the hacker with the mouse: rifle damage, F still held.
    await click(wt, 110)
    shotAt = Date.now()
    await expect
      .poll(async () => (await ghostPos()).health, { message: 'the Ghost lost rifle damage', timeout: 5_000 })
      .toBe(MAX_HEALTH.ghost - RIFLE.damage)
    const peak = (await progressOf(gt)) ?? 0
    await expect(wt.page.locator('#hack-alert')).toHaveText('', { timeout: 3_000 })
    const afterShot = await statusOf(wt)
    // Still held: the progress must not rise again; it decays.
    const heldSamples: number[] = []
    for (let i = 0; i < 12; i++) {
      heldSamples.push((await progressOf(gt)) ?? 0)
      await sleep(150)
    }
    const decayed = heldSamples.at(-1)!
    const barAfterDecay = await text(gt, 'hack-bar')
    const keyHeldInterrupt = await text(gt, 'hack-prompt')

    // A fresh press resumes (key up, a gap for the interact bucket, key down).
    await gt.page.keyboard.up('KeyF')
    await sleep(350)
    const beforeResume = (await progressOf(gt)) ?? 0
    const resumeAt = Date.now()
    await gt.page.keyboard.down('KeyF')
    const resumed = await gt.page
      .waitForFunction(
        (p) => (window.__blacksite.snapshot().hack?.progress ?? 0) > p + 0.02,
        beforeResume,
        { timeout: 4_000, polling: 50 },
      )
      .then(() => true, () => false)

    // 4. The uninterrupted hold completes within the configured time.
    const left = 1 - beforeResume
    await expect(gt.page.locator('#hack-alert')).toHaveText('Terminal hacked', { timeout: left * HACK_DURATION_MS + 3_000 })
    const hackedAfter = Date.now() - resumeAt
    await expect(wt.page.locator('#hack-alert')).toHaveText('Terminal hacked', { timeout: 3_000 })
    await gt.page.keyboard.up('KeyF')
    const end = {
      gTerm: await statusOf(gt),
      wTerm: await statusOf(wt),
      gBar: await text(gt, 'hack-bar'),
      wBar: await text(wt, 'hack-bar'),
      wHack: (await snap(wt.page)).hack ?? null,
      ghost: await ghostPos(),
      hits: (await snap(wt.page)).events.hits,
    }

    // Assertions, after the SDK client has left.
    const alarmSamples = timeline.filter((s) => s.wAlert === 'Terminal alarm')
    const early = timeline.filter((s) => s.t < HACK_ALERT_AFTER_MS - 500)
    const bars = timeline.filter((s) => s.progress !== null && s.progress > 0.05)
    expect(early.length, 'sampled the first 2.5 s').toBeGreaterThan(5)
    expect(early.every((s) => s.wAlert === '' && s.wStatus === 'idle' && !s.wFlag), 'the Warden tab gets no cue in the first seconds').toBe(true)
    expect(alarmSamples[0].t, 'the alarm comes after HACK_ALERT_AFTER_MS').toBeGreaterThanOrEqual(HACK_ALERT_AFTER_MS - 500)
    expect(timeline.every((s) => s.wBar === '' && s.wPrompt === '' && s.wHack === null), 'the Warden tab never shows a bar, a prompt or hack progress').toBe(true)
    expect(timeline.every((s) => s.wStatus !== 'hacking' || s.wFlag), 'the Warden tab sees hacking only with the alert').toBe(true)
    expect(wt.sent.interacts, 'a Warden F sends no interact frame').toHaveLength(0)
    expect(bars.length, 'the Ghost bar rose').toBeGreaterThan(3)
    expect(bars.every((s) => /^Hack \d+%$/.test(s.bar)), 'the Ghost tab shows a percent bar').toBe(true)
    const rising = timeline.filter((s) => s.progress !== null).map((s) => s.progress!)
    expect(rising.at(-1)!, 'progress rose during the hold').toBeGreaterThan(0.2)
    expect(rising.every((p, i) => i === 0 || p >= rising[i - 1] - 1e-6), 'progress never fell while hacking').toBe(true)
    expect(timeline.at(-1)!.progress!, 'about 3 s of hacking is about 30% (rate 1 / HACK_DURATION_MS)').toBeGreaterThan(0.2)
    expect(peakBeforeShot).not.toBeNull()
    expect(afterShot?.status, 'the alert clears when the hack is interrupted').toBe('idle')
    expect(afterShot?.alert).toBe(false)
    expect(Math.max(...heldSamples), 'the gain stopped while F stayed held').toBeLessThanOrEqual(peak + 0.005)
    expect(decayed, 'progress decays after the interrupt').toBeLessThan(peak - 0.03)
    expect(decayed, 'it is kept, not wiped').toBeGreaterThan(0)
    expect(barAfterDecay).toMatch(/^Hack \d+%$/)
    expect(keyHeldInterrupt).toBe('F: hold to hack')
    expect(shotAt).toBeGreaterThan(0)
    expect(resumed, 'a fresh F press resumes the hack').toBe(true)
    expect(hackedAfter, 'hacked within the configured time of the continuous hold').toBeLessThanOrEqual(left * HACK_DURATION_MS + 1000)
    expect(hackedAfter).toBeLessThanOrEqual(HACK_DURATION_MS + 1000)
    expect(hackedAfter, 'not faster than the configured rate').toBeGreaterThanOrEqual(left * HACK_DURATION_MS - 600)
    expect(end.gTerm?.status).toBe('hacked')
    expect(end.wTerm?.status).toBe('hacked')
    expect(end.gBar, 'no bar once hacked').toBe('')
    expect(end.wBar).toBe('')
    expect(end.wHack).toBeNull()
    expect(end.ghost.health, 'the Ghost took exactly one rifle shot').toBe(MAX_HEALTH.ghost - RIFLE.damage)
    expect(end.hits - hits0, 'one hit event').toBe(1)

    expect(gt.sent.interacts.map((i) => i.active), 'Ghost tab frames: out-of-range press, hold, fresh press').toEqual([true, false, true, false, true, false])
    expect(gt.sent.interacts.every((i) => i.keys.join() === 'active')).toBe(true)
    expect(gt.errors.filter((e) => !/onMessage\(\) not registered/.test(e)), 'ghost tab errors').toEqual([])
    expect(wt.errors.filter((e) => !/onMessage\(\) not registered/.test(e)), 'warden tab errors').toEqual([])
    expect(wardenId).not.toBe(ghostId)
  } finally {
    if (obs) await obs.leave().catch(() => {})
    await closeTabs(ghostTab, wardenTab)
  }
})
