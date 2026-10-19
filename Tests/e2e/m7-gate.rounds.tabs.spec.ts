import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACTIVE_TERMINAL_ID } from '../../shared/map.js'
import { EYE_HEIGHT, MAX_HEALTH, WEAPONS, type RoundWinReason, type Team } from '../../shared/protocol.js'
import { ROUND_FAST, ownRoom } from './support/rounds.js'
import { closeTabs, get, joined, local, lockPointer, openTab, RAD_PER_PIXEL, snap, turnTo, type Tab } from './support/tabs.js'
import { eyeOf, hasLineOfSight } from './support/visibility.js'
import { hookVitals } from './support/vitals.js'

// The M7 gate in real tabs (#74, tracking #64). One Ghost tab and one Warden
// tab on the fast server (2568, 320x240), in a room of their own (ownRoom),
// driven by keys and the mouse only. One serial test runs three full rounds
// and checks the clients' view after each:
//   waiting    the lone Ghost tab: "Waiting for players", no timer
//   countdown  banner and timer in both tabs
//   round 1    the Ghost walks to the terminal and holds F: both tabs show
//              "Ghosts win: terminal hacked", You win / You lose
//   round 2    the Warden shoots the Ghost with the mouse: "Wardens win: all
//              Ghosts eliminated"
//   round 3    nobody does anything: "Wardens win: time ran out"
//   after each result: "Round N+1" counts down, the result is gone, the
//   terminal is idle again with the alert off, and health and ammo are full
//   in both tabs.
// The Warden tab hears only the M6 alarm while the Ghost hacks (no bar, no
// progress). Round settings forged on the wire, the abort and every edge case
// are proven by the SDK specs (#69, #71) and the tab spec (#73); the mapping is
// in the closing comment of #74.
//
// Added wall time: one test of about 80 s in the `rounds` shard (the live
// window is 30 s; the walk and hack take about 21 s of it).

test.setTimeout(240_000)

const REPORTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'Reports')
const RIFLE = WEAPONS.warden
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const text = (tab: Tab, id: string) => tab.page.evaluate((i) => document.getElementById(i)?.textContent ?? null, id)
const hidden = (tab: Tab, id: string) => tab.page.evaluate((i) => document.getElementById(i)?.hidden ?? null, id)
const cls = (tab: Tab, id: string) => tab.page.evaluate((i) => document.getElementById(i)?.className ?? null, id)
const round = async (tab: Tab) => (await snap(tab.page)).round

async function waitPhase(tab: Tab, phase: string, timeout: number, n?: number): Promise<void> {
  await expect
    .poll(async () => {
      const r = await round(tab)
      return r && r.phase === phase && (n === undefined || r.roundNumber === n) ? phase : `${r?.phase ?? 'no round'} #${r?.roundNumber}`
    }, { message: `${tab.name} reaches ${phase}${n ? ` of round ${n}` : ''}`, timeout, intervals: [40] })
    .toBe(phase)
}

/** Holds `key` until `done` is true for the local player's position (closed loop), then releases it. */
async function holdUntil(tab: Tab, key: string, done: (p: { x: number; z: number }) => boolean): Promise<void> {
  await tab.page.keyboard.down(key)
  try {
    const started = Date.now()
    while (Date.now() - started < 12_000) {
      if (done(local(await snap(tab.page)))) return
      await sleep(15)
    }
    throw new Error(`${tab.name}: ${key} did not reach its goal in 12 s (at ${JSON.stringify(local(await snap(tab.page)))})`)
  } finally {
    await tab.page.keyboard.up(key)
  }
}

/** Closed-loop strafe (A or D at yaw 0) until x is within 0.25 of `target`. */
async function strafeTo(tab: Tab, target: number): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const x = local(await snap(tab.page)).x
    if (Math.abs(x - target) <= 0.25) return
    const key = target > x ? 'KeyD' : 'KeyA'
    await holdUntil(tab, key, (p) => (key === 'KeyD' ? p.x >= target - 0.1 : p.x <= target + 0.1))
    await sleep(120)
  }
}

/** Left-button event on the canvas, dispatched in the page (page.mouse does not reach it under the lock stand-in, #51). */
const mouseButton = (tab: Tab, type: 'mousedown' | 'mouseup') =>
  tab.page.evaluate((t) => {
    document.getElementById('game-canvas')!.dispatchEvent(new MouseEvent(t, { button: 0, bubbles: true, cancelable: true }))
  }, type)

const tilt = (tab: Tab, pixels: number) =>
  tab.page.evaluate((py) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: py, bubbles: true })), pixels)

const REASON_LINE: Record<RoundWinReason, string> = {
  hacked: 'Ghosts win: terminal hacked',
  ghosts_eliminated: 'Wardens win: all Ghosts eliminated',
  time_out: 'Wardens win: time ran out',
}

test('M7 gate: three full rounds in two real tabs, hack, elimination and time out, each result shown and the next round reset', async ({ browser }) => {
  const own = ownRoom()
  let ghost: Tab | undefined
  let warden: Tab | undefined
  const problems: string[] = []
  const note = (ok: boolean, what: string) => {
    if (!ok) problems.push(what)
  }

  /** The result screen of both tabs, read at once. Only the first two lines are compared (the third counts down). */
  async function checkResult(n: number, winner: Team, reason: RoundWinReason): Promise<void> {
    for (const t of [ghost!, warden!]) {
      const r = await round(t)
      const shown = (await text(t, 'round-result')) ?? ''
      const lines = shown.split('\n')
      note(r?.phase === 'ended' && r.roundNumber === n && r.winner === winner && r.winReason === reason, `round ${n}: ${t.name} hook ${JSON.stringify(r)}`)
      note(lines[0] === REASON_LINE[reason], `round ${n}: ${t.name} headline "${lines[0]}"`)
      const mine: Team = t === ghost ? 'ghost' : 'warden'
      note(lines[1] === (mine === winner ? 'You win' : 'You lose'), `round ${n}: ${t.name} verdict "${lines[1]}"`)
      note(/^Next round in [1-3]$/.test(lines[2] ?? ''), `round ${n}: ${t.name} "${lines[2]}"`)
      note((await hidden(t, 'round-result')) === false && (await cls(t, 'round-result')) === winner, `round ${n}: ${t.name} result visible with class ${winner}`)
      note((await text(t, 'round-timer')) === '' && (await text(t, 'round-banner')) === '', `round ${n}: ${t.name} timer and banner empty at the result`)
    }
  }

  /** The reset at the next countdown: Round N banner, result gone, terminal idle, full health and ammo in both tabs. */
  async function checkReset(n: number, ghostId: string, wardenId: string): Promise<void> {
    await waitPhase(ghost!, 'countdown', 6000, n)
    await waitPhase(warden!, 'countdown', 2500, n)
    const gs = await snap(ghost!.page)
    const ws = await snap(warden!.page)
    for (const [t, s] of [[ghost!, gs], [warden!, ws]] as const) {
      if (s.round?.phase !== 'countdown') continue
      note((await text(t, 'round-result')) === '' && (await hidden(t, 'round-result')) === true, `round ${n}: ${t.name} result is gone`)
      note(new RegExp(`^Round ${n} starts in \\d$`).test((await text(t, 'round-banner')) ?? ''), `round ${n}: ${t.name} banner "${await text(t, 'round-banner')}"`)
      const term = s.terminals?.find((x) => x.id === ACTIVE_TERMINAL_ID)
      note(term?.status === 'idle' && term.alert === false, `round ${n}: ${t.name} terminal ${JSON.stringify(term)}`)
    }
    const full = (s: typeof gs, id: string, team: Team) => {
      const v = hookVitals(s, id)
      return v?.health === MAX_HEALTH[team] && v.ammo === WEAPONS[team].magazine && v.reloading === false
    }
    note(full(gs, ghostId, 'ghost'), `round ${n}: ghost tab sees the Ghost at full vitals ${JSON.stringify(hookVitals(gs, ghostId))}`)
    note(full(gs, wardenId, 'warden'), `round ${n}: ghost tab sees the Warden at full vitals ${JSON.stringify(hookVitals(gs, wardenId))}`)
    note(full(ws, wardenId, 'warden'), `round ${n}: warden tab sees itself at full vitals ${JSON.stringify(hookVitals(ws, wardenId))}`)
  }

  try {
    // ---- waiting, then countdown ----
    ghost = await openTab(browser, 'ghost tab', { beforeGoto: own.beforeGoto })
    await waitPhase(ghost, 'waiting', 10_000)
    note((await text(ghost, 'round-banner')) === 'Waiting for players', 'waiting: banner says Waiting for players')
    note((await text(ghost, 'round-timer')) === '', 'waiting: timer is empty')
    warden = await openTab(browser, 'warden tab', { beforeGoto: own.beforeGoto })
    await waitPhase(warden, 'countdown', 10_000, 1)
    for (const t of [ghost, warden]) {
      const before = await round(t)
      const banner = (await text(t, 'round-banner')) ?? ''
      const timer = (await text(t, 'round-timer')) ?? ''
      if (before?.phase === 'countdown') {
        note(/^Round 1 starts in \d$/.test(banner) && /^0:0[0-2]$/.test(timer), `countdown: ${t.name} banner "${banner}" timer "${timer}"`)
      }
    }
    const g0 = await joined(ghost, { ghosts: 1, wardens: 1 })
    const w0 = await joined(warden, { ghosts: 1, wardens: 1 })
    expect([g0.localTeam, w0.localTeam]).toEqual(['ghost', 'warden'])
    const ghostId = g0.sessionId!
    const wardenId = w0.sessionId!
    const gt = ghost
    const wt = warden

    // ---- round 1: the Ghost hacks the terminal ----
    await waitPhase(gt, 'live', 6000, 1)
    await waitPhase(wt, 'live', 2000, 1)
    const liveText = await text(gt, 'round-timer')
    note(/^0:(2\d|30)$/.test(liveText ?? ''), `round 1: live timer "${liveText}"`)
    const wardenLocked = lockPointer(wt) // in parallel with the walk
    const x = local(await snap(gt.page)).x
    if (Math.abs(x) > 0.25) await holdUntil(gt, x > 0 ? 'KeyA' : 'KeyD', (p) => Math.abs(p.x) <= 0.25)
    await holdUntil(gt, 'KeyW', (p) => p.z >= -5.5)
    await holdUntil(gt, 'KeyA', (p) => p.x <= -6.45)
    await wardenLocked
    await expect(gt.page.locator('#hack-prompt')).toHaveText('F: hold to hack', { timeout: 5000 })
    await gt.page.keyboard.down('KeyF')
    await expect(wt.page.locator('#hack-alert')).toHaveText('Terminal alarm', { timeout: 8000 })
    note((await snap(wt.page)).hack == null && (await text(wt, 'hack-bar')) === '', 'round 1: the Warden tab shows no hack progress, only the alarm')
    await waitPhase(gt, 'ended', 12_000, 1)
    await waitPhase(wt, 'ended', 2000, 1)
    await checkResult(1, 'ghost', 'hacked')
    for (const t of [gt, wt]) {
      const term = (await snap(t.page)).terminals?.find((v) => v.id === ACTIVE_TERMINAL_ID)
      note(term?.status === 'hacked', `round 1: ${t.name} terminal at the result ${JSON.stringify(term)}`)
    }
    mkdirSync(REPORTS, { recursive: true })
    await gt.page.screenshot({ path: join(REPORTS, 'graybox-m7-result.png') })
    await gt.page.keyboard.up('KeyF')
    await checkReset(2, ghostId, wardenId)

    // ---- round 2: the Warden shoots the Ghost ----
    await waitPhase(gt, 'live', 6000, 2)
    await waitPhase(wt, 'live', 2000, 2)
    await Promise.all([strafeTo(gt, 0), strafeTo(wt, 0)])
    await sleep(250)
    const s2 = await snap(gt.page)
    const target = get(s2, ghostId)
    const shooter = get(s2, wardenId)
    const aimY = 1.2
    expect(hasLineOfSight(eyeOf({ x: shooter.x, y: shooter.y, z: shooter.z }), { x: target.x, y: aimY, z: target.z }), 'clear line from the Warden eye to the Ghost').toBe(true)
    await expect.poll(async () => (await snap(wt.page)).players.find((p) => p.id === ghostId)?.team, { message: 'the Warden tab is sent the Ghost', timeout: 10_000 }).toBe('ghost')
    await turnTo(wt, Math.atan2(target.x - shooter.x, target.z - shooter.z))
    const dist = Math.hypot(target.x - shooter.x, target.z - shooter.z)
    const wantPitch = Math.atan2(aimY - (shooter.y + EYE_HEIGHT), dist) // wire: positive up
    // The starting pitch is not known (#63): clamp at the limit (1.4, looking down), then tilt back to the wanted one.
    await tilt(wt, 1000)
    await tilt(wt, Math.round((-wantPitch - 1.4) / RAD_PER_PIXEL))
    await mouseButton(wt, 'mousedown')
    try {
      await expect
        .poll(async () => (await round(wt))?.phase, { message: 'the Warden kills the Ghost and the round ends', timeout: 8000, intervals: [40] })
        .toBe('ended')
    } finally {
      await mouseButton(wt, 'mouseup')
    }
    await waitPhase(gt, 'ended', 2000, 2)
    await checkResult(2, 'warden', 'ghosts_eliminated')
    const dead = hookVitals(await snap(gt.page), ghostId)
    note(dead?.health === 0, `round 2: the Ghost is eliminated (${JSON.stringify(dead)})`)
    note(wt.sent.fires.length >= Math.ceil(MAX_HEALTH.ghost / RIFLE.damage), `round 2: the Warden tab fired ${wt.sent.fires.length} shots`)
    await checkReset(3, ghostId, wardenId)

    // ---- round 3: nobody does anything and the timer ends it ----
    await waitPhase(gt, 'live', 6000, 3)
    await waitPhase(wt, 'live', 2000, 3)
    await waitPhase(gt, 'ended', ROUND_FAST.liveMs + 10_000, 3)
    await waitPhase(wt, 'ended', 2000, 3)
    await checkResult(3, 'warden', 'time_out')
    await checkReset(4, ghostId, wardenId)

    for (const t of [gt, wt]) note(t.errors.filter((e) => !/onMessage\(\) not registered/.test(e)).length === 0 && t.sent.errors.length === 0, `${t.name}: page errors ${JSON.stringify([...t.errors, ...t.sent.errors])}`)
  } finally {
    await closeTabs(ghost, warden)
  }
  expect(problems).toEqual([])
})
