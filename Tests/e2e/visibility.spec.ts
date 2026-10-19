import { expect, test } from '@playwright/test'
import { EPS, Walker, pos } from './support/sdk.js'
import { Observer } from './support/observer.js'
import { closeTabs, joined, local, openTab, snap, type Tab } from './support/tabs.js'
import { visibilityOf } from './support/visibility.js'

// The M5 visibility filter (#46) as the real Warden tab sees it (#47): the
// test hook (`window.__blacksite.snapshot()`) shows only what the client was
// sent, so its `players` list is the filtered state. The state and the wire are
// covered in visibility.integration.spec.ts; this is the one browser check.
//
// The SDK client that joins first is the Ghost (the observer helper, used here
// as the Ghost player); the tab joins second, as the Warden. The tab runs at
// 320x240 (tabs.ts VIEWPORT), the Ghost walks by SDK messages at the 20 Hz move
// rate. Assertions poll, because a patch takes about one 50 ms step to arrive.

test('Warden tab: snapshot().players lists only the Warden while the Ghost is behind the south wall, and lists the Ghost, at its real position, once it is in line of sight', async ({ browser }) => {
  test.setTimeout(60_000)
  const ghostClient = await Observer.join() // the first joiner of a fresh shared room: a Ghost
  let tab: Tab | undefined
  try {
    tab = await openTab(browser, 'warden')
    const s0 = await joined(tab, { ghosts: 1, wardens: 1 })
    const wardenId = s0.sessionId!
    const gid = ghostClient.id
    const warden = local(s0)
    expect(s0.localTeam).toBe('warden')

    const gw = new Walker(ghostClient.room, 'ghost', { ground: false })
    const behind = { x: 6.13, z: -14.21 } // behind the south wall for every Warden spawn
    // On the line from the Warden's eye through the middle of the south doorway (0, -7.75).
    const inSight = { x: -warden.x * ((14.21 - 7.75) / (warden.z + 7.75)), z: -14.21 }
    await gw.walkTo(behind)
    const hiddenClass = visibilityOf(warden, behind)
    await expect.poll(async () => (await snap(tab!.page)).players.map((p) => p.id), { message: 'the Warden tab holds only itself', timeout: 10_000 }).toEqual([wardenId])
    // Still only itself after a few more steps (not just before the first patch).
    await new Promise((r) => setTimeout(r, 300))
    const hidden = (await snap(tab.page)).players.map((p) => p.id)

    await gw.walkTo(inSight)
    const visibleClass = visibilityOf(warden, inSight)
    await expect.poll(async () => (await snap(tab!.page)).players.map((p) => p.id).sort(), { message: 'the Warden tab now lists the Ghost', timeout: 10_000 }).toEqual([wardenId, gid].sort())
    // Exact: the tab holds the Ghost where the Ghost's own client says it is.
    await expect
      .poll(
        async () => {
          const g = (await snap(tab!.page)).players.find((p) => p.id === gid)
          const own = pos(ghostClient.room, gid)
          return !!g && Math.abs(g.x - own.x) < EPS && Math.abs(g.z - own.z) < EPS && g.team === 'ghost'
        },
        { message: 'the tab holds the Ghost at its real position', timeout: 10_000 },
      )
      .toBe(true)
    const final = await snap(tab.page)

    expect(hiddenClass, 'placement behind the wall').toBe('hidden')
    expect(visibleClass, 'placement on the doorway line').toBe('visible')
    expect(hidden).toEqual([wardenId])
    expect(final.players.find((p) => p.id === wardenId)?.isLocal).toBe(true)
    expect(gw.violations).toEqual([])
  } finally {
    await ghostClient.leave()
    await closeTabs(tab)
  }
})
