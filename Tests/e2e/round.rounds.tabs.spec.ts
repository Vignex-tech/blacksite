import { expect, test, type Page } from '@playwright/test'
import { closeTabs, lockPointer, openTab, snap, type Tab } from './support/tabs.js'
import { ROUND_FAST, ownRoom } from './support/rounds.js'

// The round UI in real tabs (#73, covering #72), on the fast server (2568):
// 320x240, two tabs, no walking, one fresh room of their own (ownRoom).
//   waiting    the lone Ghost tab: banner, empty timer and result, frozen inputs
//   countdown  banner and timer in both tabs, nothing on the wire
//   live       the timer falls, inputs are sent again, the crosshair is back
//   ended      the Wardens win on time: result text and class per tab, You win /
//              You lose, timer and banner empty, no input frames (an F held when
//              the freeze began is released with exactly one false)
//   next round the result is gone, Round 2 counts down; a tab leaving aborts to
//              Waiting for players with no result screen
// Each phase is read from the hook (the client's own view of state.round), and
// the DOM text is compared with it. Problems are asserted after the loop.
//
// Added wall time: one test of about 45 s, running in the `rounds` project next
// to the 35 s time-out test, so the rounds shard gets about 8 to 10 s longer.
// The slowest shard (browser-a) is unchanged.

test.setTimeout(120_000)

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
    }, { message: `${tab.name} reaches ${phase}`, timeout, intervals: [40] })
    .toBe(phase)
}

/** Everything a tab has sent so far. */
const counts = (t: Tab) => ({
  moves: t.sent.moves.length,
  actions: t.sent.actions.length,
  fires: t.sent.fires.length,
  reloads: t.sent.reloads.length,
  interacts: t.sent.interacts.length,
})

const mouseButton = (tab: Tab, type: 'mousedown' | 'mouseup') =>
  tab.page.evaluate((t) => {
    document.getElementById('game-canvas')!.dispatchEvent(new MouseEvent(t, { button: 0, bubbles: true, cancelable: true }))
  }, type)

/** Tries every input a player has: movement, jump, climb, drop, reload, hack and fire. */
async function mash(tab: Tab, ms = 350, opts: { fire?: boolean; keepF?: boolean } = {}): Promise<void> {
  const p: Page = tab.page
  await mouseButton(tab, 'mousedown')
  for (const k of ['KeyW', 'KeyD', 'ArrowUp']) await p.keyboard.down(k)
  await p.keyboard.press('Space')
  await p.keyboard.press('KeyE')
  await p.keyboard.press('KeyC')
  await p.keyboard.press('KeyR')
  await p.keyboard.down('KeyF')
  await sleep(ms)
  for (const k of ['KeyW', 'KeyD', 'ArrowUp']) await p.keyboard.up(k)
  if (!opts.keepF) await p.keyboard.up('KeyF')
  await mouseButton(tab, 'mouseup')
}

const secondsOf = (t: string | null) => {
  const m = /^(\d+):(\d\d)$/.exec(t ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

test('waiting, countdown, live, ended and the next round in two real tabs; every input is frozen outside live', async ({ browser }) => {
  const own = ownRoom()
  let ghost: Tab | undefined
  let warden: Tab | undefined
  const problems: string[] = []
  const note = (ok: boolean, what: string) => {
    if (!ok) problems.push(what)
  }
  // The fast preset gives a 2 s countdown and a 3 s ended window. On a slow
  // software-GL runner (#85 textures) a check can run after its window closed;
  // such a check is skipped and recorded, not failed. The server side of these
  // windows is covered by the SDK rounds specs.
  const skipped: string[] = []
  const skip = (what: string) => skipped.push(what)
  try {
    // ---- waiting: the lone Ghost tab ----
    ghost = await openTab(browser, 'ghost tab', { beforeGoto: own.beforeGoto })
    await waitPhase(ghost, 'waiting', 10_000)
    note((await text(ghost, 'round-banner')) === 'Waiting for players', 'waiting: banner says Waiting for players')
    note((await text(ghost, 'round-timer')) === '', 'waiting: timer is empty')
    note((await text(ghost, 'round-result')) === '' && (await hidden(ghost, 'round-result')) === true, 'waiting: result is empty and hidden')
    note((await hidden(ghost, 'crosshair')) === true, 'waiting: crosshair hidden')
    note((await snap(ghost.page)).camera?.mode === 'third-person', 'waiting: the Ghost already has its team camera')
    const w0 = counts(ghost)
    await mash(ghost, 500, { keepF: false })
    await sleep(150)
    note(JSON.stringify(counts(ghost)) === JSON.stringify(w0), `waiting: no frames on the wire (before ${JSON.stringify(w0)}, after ${JSON.stringify(counts(ghost))})`)

    // ---- countdown: the Warden joins ----
    warden = await openTab(browser, 'warden tab', { beforeGoto: own.beforeGoto })
    await waitPhase(warden, 'countdown', 10_000, 1)
    const cd: string[] = []
    for (const t of [ghost, warden]) {
      const before = await round(t)
      const banner = (await text(t, 'round-banner')) ?? ''
      const timer = (await text(t, 'round-timer')) ?? ''
      const m = /^Round 1 starts in (\d)$/.exec(banner)
      if (before?.phase === 'countdown' && (await round(t))?.phase !== 'countdown') {
        skip(`countdown: ${t.name} left the countdown while it was read`)
      } else if (before?.phase === 'countdown') {
        note(!!m, `countdown: ${t.name} banner "${banner}"`)
        note(/^0:0[0-2]$/.test(timer), `countdown: ${t.name} timer "${timer}"`)
        note((await cls(t, 'round-banner')) === (m && Number(m[1]) >= 1 && Number(m[1]) <= 3 ? 'big' : ''), `countdown: ${t.name} banner class "${await cls(t, 'round-banner')}" for "${banner}"`)
      }
      cd.push(`${t.name}: ${banner} / ${timer}`)
    }
    await waitPhase(ghost, 'countdown', 2000, 1)
    const c0 = [counts(ghost), counts(warden)]
    await mash(ghost, 250)
    const still = [(await round(ghost))?.phase, (await round(warden))?.phase]
    await sleep(100)
    if (still[0] === 'countdown' && still[1] === 'countdown') {
      note(JSON.stringify(counts(ghost)) === JSON.stringify(c0[0]), `countdown: no frames from the Ghost tab (${JSON.stringify(counts(ghost))})`)
    } else {
      skip(`countdown: too slow to test (phase ${still}); ${cd.join('; ')}`)
    }
    // The Warden tab takes its pointer (stand-in) in what is left of the countdown or live.
    await waitPhase(warden, 'live', 6000, 1)

    // ---- live ----
    await lockPointer(warden)
    const timers: number[] = []
    for (let i = 0; i < 2; i++) {
      for (const t of [ghost, warden]) {
        const r = await round(t)
        const shown = await text(t, 'round-timer')
        note(secondsOf(shown) === r?.secondsLeft || Math.abs(secondsOf(shown) - (r?.secondsLeft ?? NaN)) <= 1, `live: ${t.name} timer "${shown}" follows secondsLeft ${r?.secondsLeft}`)
        if (t === warden) timers.push(secondsOf(shown))
        note((await text(t, 'round-banner')) === '' && (await text(t, 'round-result')) === '', `live: ${t.name} banner and result are empty`)
      }
      if (i === 0) await sleep(1300)
    }
    note(timers[1] < timers[0] && timers[1] > 0 && timers[0] <= ROUND_FAST.liveMs / 1000, `live: the timer falls (${timers})`)
    note((await hidden(warden, 'crosshair')) === false, 'live: the Warden crosshair is back')
    const l0 = [counts(ghost), counts(warden)]
    await mash(warden, 350)
    await mash(ghost, 350, { keepF: true }) // F stays down until the freeze
    await sleep(150)
    const l1 = [counts(ghost), counts(warden)]
    note(l1[1].moves > l0[1].moves && l1[1].actions > l0[1].actions && l1[1].fires > l0[1].fires && l1[1].reloads > l0[1].reloads, `live: the Warden tab sends move, action, fire and reload (${JSON.stringify(l1[1])})`)
    note(l1[0].moves > l0[0].moves && l1[0].interacts === l0[0].interacts + 1, `live: the Ghost tab sends moves and one interact (${JSON.stringify(l1[0])})`)
    note(ghost.sent.interacts.at(-1)?.active === true, 'live: the Ghost F frame is a press')
    const ghostInteractsLive = ghost.sent.interacts.length

    // ---- ended: the time runs out, Wardens win ----
    await waitPhase(ghost, 'ended', 40_000)
    await waitPhase(warden, 'ended', 5000)
    await sleep(250) // frames sent before the client knew can still be arriving
    const endedRound = [await round(ghost), await round(warden)]
    const lines = ['Wardens win: time ran out']
    for (const [i, t] of [ghost, warden].entries()) {
      const r = endedRound[i]
      note(r?.phase === 'ended' && r.winner === 'warden' && r.winReason === 'time_out' && r.roundNumber === 1, `ended: ${t.name} hook ${JSON.stringify(r)}`)
      const shown = (await text(t, 'round-result')) ?? ''
      const want = [...lines, t === warden ? 'You win' : 'You lose']
      note(shown.split('\n').slice(0, 2).join('\n') === want.join('\n') && /^Next round in [1-3]$/.test(shown.split('\n')[2] ?? ''), `ended: ${t.name} result "${shown}"`)
      note((await hidden(t, 'round-result')) === false && (await cls(t, 'round-result')) === 'warden', `ended: ${t.name} result is visible with class warden`)
      note((await text(t, 'round-timer')) === '' && (await text(t, 'round-banner')) === '', `ended: ${t.name} timer and banner are empty`)
      note((await hidden(t, 'crosshair')) === true, `ended: ${t.name} crosshair hidden`)
      note((await text(t, 'hack-prompt')) === '' && (await text(t, 'climb-prompt')) === '', `ended: ${t.name} prompts hidden`)
    }
    // The freeze already released the held F once (before or at this point).
    note(ghost.sent.interacts.length === ghostInteractsLive + 1 && ghost.sent.interacts.at(-1)?.active === false, `ended: the held F was released with exactly one false (${JSON.stringify(ghost.sent.interacts.map((i) => i.active))})`)
    const e1 = [counts(ghost), counts(warden)]
    const stillEnded = (await round(ghost))?.phase === 'ended' && (await round(warden))?.phase === 'ended'
    await mash(ghost, 300)
    await mash(warden, 300)
    const e2 = [counts(ghost), counts(warden)]
    const stillEnded2 = (await round(ghost))?.phase === 'ended' && (await round(warden))?.phase === 'ended'
    if (stillEnded && stillEnded2) {
      note(JSON.stringify(e2) === JSON.stringify(e1), `ended: no input frames after the freeze (before ${JSON.stringify(e1)}, after ${JSON.stringify(e2)})`)
    } else {
      skip('ended: the 3 s window passed before the key presses were done')
    }

    // ---- the next round, then an abort ----
    await waitPhase(ghost, 'countdown', 6000, 2)
    await waitPhase(warden, 'countdown', 2000, 2)
    for (const t of [ghost, warden]) {
      const r = await round(t)
      if (r?.phase !== 'countdown') continue
      const res = (await text(t, 'round-result')) === '' && (await hidden(t, 'round-result')) === true
      const banner = (await text(t, 'round-banner')) ?? ''
      const timer = (await text(t, 'round-timer')) ?? ''
      if ((await round(t))?.phase !== 'countdown') {
        skip(`round 2: ${t.name} left the countdown while it was read`)
        continue
      }
      note(res, `round 2: ${t.name} result is gone`)
      note(/^Round 2 starts in \d$/.test(banner), `round 2: ${t.name} banner "${banner}"`)
      note(/^0:0[0-2]$/.test(timer), `round 2: ${t.name} timer "${timer}"`)
    }
    await warden.page.context().close()
    await waitPhase(ghost, 'waiting', 5000)
    note((await text(ghost, 'round-banner')) === 'Waiting for players', 'abort: banner says Waiting for players')
    note((await text(ghost, 'round-result')) === '' && (await hidden(ghost, 'round-result')) === true, 'abort: no result screen')
    note((await text(ghost, 'round-timer')) === '', 'abort: timer empty')
    note((await round(ghost))?.winner === '', 'abort: no winner')

    for (const t of [ghost, warden]) note(t.errors.length === 0 && t.sent.errors.length === 0, `${t.name}: page errors ${JSON.stringify([...t.errors, ...t.sent.errors])}`)
  } finally {
    await closeTabs(ghost, warden)
  }
  if (skipped.length) test.info().annotations.push({ type: 'skipped checks (slow runner)', description: skipped.join(' | ') })
  expect(problems).toEqual([])
})
