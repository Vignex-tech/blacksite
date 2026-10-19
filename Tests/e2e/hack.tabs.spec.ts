import { expect, test } from '@playwright/test'
import { HACK_ALERT_AFTER_MS, HACK_DURATION_MS } from '../../shared/protocol.js'
import { Walker, leaveQuietly } from './support/sdk.js'
import { Observer } from './support/observer.js'
import { terminalPlacement } from './support/terminal.js'
import { closeTabs, joined, openTab, type Tab } from './support/tabs.js'

// M6 hack feedback in real tabs (#61, covering #60). Unit tests
// (Tests/unit/hack.test.ts) hold the rules; this checks the browser:
//  1. Ghost tab: holding F (with auto-repeat) sends exactly one interact true
//     frame, the release one false.
//  2. Warden tab: F sends nothing.
//  3. A third client, an SDK Ghost, hacks the active terminal. The Warden tab
//     shows #hack-alert 'Terminal alarm' only from about 3 s in, and its
//     #hack-bar and #hack-prompt stay empty the whole time. When the terminal
//     is hacked both tabs show 'Terminal hacked'.
// The tabs do not move (the SDK client is the hacker): the Ghost tab's own
// prompt/bar need a walk to the terminal and are covered by the unit rules.
// Problems are collected and asserted once, after the SDK client has left.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const text = (tab: Tab, id: string) => tab.page.locator(`#${id}`).innerText()

test('hold F sends one interact true/false in a Ghost tab and nothing in a Warden tab; the Warden tab sees only the alarm after 3 s, never a bar, then Terminal hacked', async ({ browser }) => {
  test.setTimeout(90_000)
  let ghostTab: Tab | undefined
  let wardenTab: Tab | undefined
  let obs: Observer | undefined
  try {
    ghostTab = await openTab(browser, 'ghost tab')
    await joined(ghostTab, { ghosts: 1, wardens: 0 })
    wardenTab = await openTab(browser, 'warden tab')
    await joined(wardenTab, { ghosts: 1, wardens: 1 })

    // 1 and 2: the input, on the wire.
    await ghostTab.page.keyboard.down('KeyF')
    await ghostTab.page.keyboard.down('KeyF') // auto-repeat
    await sleep(300)
    await ghostTab.page.keyboard.up('KeyF')
    await wardenTab.page.keyboard.down('KeyF')
    await sleep(300)
    await wardenTab.page.keyboard.up('KeyF')
    await sleep(200)
    const ghostSent = ghostTab.sent.interacts.map((i) => [i.active, ...i.keys])
    const wardenSent = wardenTab.sent.interacts.length
    const idle = {
      alert: await text(wardenTab, 'hack-alert'),
      bar: await text(wardenTab, 'hack-bar'),
      prompt: await text(wardenTab, 'hack-prompt'),
    }

    // 3: the SDK Ghost hacks.
    obs = await Observer.join()
    await joined(ghostTab, { ghosts: 2, wardens: 1 })
    const gw = new Walker(obs.room, 'ghost')
    const { inside } = terminalPlacement()
    const z0 = gw.pos.z
    await gw.walkTo({ x: 0, z: z0 }, 'xz')
    await gw.walkTo({ x: 0, z: -5.5 }, 'zx')
    await gw.walkTo(inside, 'xz')

    const t0 = Date.now()
    obs.room.send('interact', { active: true })
    const seen: { t: number; alert: string; bar: string; prompt: string; ghostAlert: string }[] = []
    let hackedAt = 0
    while (Date.now() - t0 < HACK_DURATION_MS + 4000) {
      const s = {
        t: Date.now() - t0,
        alert: await text(wardenTab, 'hack-alert'),
        bar: await text(wardenTab, 'hack-bar'),
        prompt: await text(wardenTab, 'hack-prompt'),
        ghostAlert: await text(ghostTab, 'hack-alert'),
      }
      seen.push(s)
      if (s.alert === 'Terminal hacked' && s.ghostAlert === 'Terminal hacked') {
        hackedAt = s.t
        break
      }
      await sleep(100)
    }
    obs.room.send('interact', { active: false })
    const violations = [...gw.violations]
    const errors = [...ghostTab.errors, ...wardenTab.errors, ...ghostTab.sent.errors, ...wardenTab.sent.errors]
    await obs.leave()
    obs = undefined

    expect(violations).toEqual([])
    expect(errors).toEqual([])
    expect(ghostSent).toEqual([
      [true, 'active'],
      [false, 'active'],
    ])
    expect(wardenSent).toBe(0)
    expect(idle).toEqual({ alert: '', bar: '', prompt: '' })

    const alarms = seen.filter((s) => s.alert === 'Terminal alarm')
    expect(alarms.length, 'the Warden tab shows the alarm').toBeGreaterThan(0)
    expect(alarms[0].t, 'no alarm before about 3 s').toBeGreaterThanOrEqual(HACK_ALERT_AFTER_MS - 500)
    for (const s of seen) {
      expect(['', 'Terminal alarm', 'Terminal hacked'], `Warden alert text at ${s.t} ms`).toContain(s.alert)
      expect(s.bar, `Warden bar at ${s.t} ms`).toBe('')
      expect(s.prompt, `Warden prompt at ${s.t} ms`).toBe('')
    }
    expect(seen.filter((s) => s.t < HACK_ALERT_AFTER_MS - 500).every((s) => s.alert === ''), 'nothing in the first 3 s').toBe(true)
    expect(hackedAt, 'both tabs show Terminal hacked').toBeGreaterThan(HACK_DURATION_MS - 1000)
    await expect(wardenTab.page.locator('#hack-bar')).toHaveText('')
  } finally {
    if (obs) await leaveQuietly(obs.room)
    await closeTabs(ghostTab, wardenTab)
  }
})
