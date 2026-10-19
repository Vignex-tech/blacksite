import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { GRAYBOX_MAP } from '../../shared/map.js'
import type { BlacksiteSnapshot } from '../../shared/testhook.js'

// #16: each tab renders the graybox map from shared/map.js (#14). The check is
// the test hook's map report, not pixels. Since #25 there are three
// screenshots (overhead map, ghost view, warden view). They are saved for a human
// to look at (CI uploads Tests/Reports/ as the "graybox-map-screenshot"
// artifact on every run); nothing compares it, because GPU rendering differs
// between machines. Mesh names, sizes and colours are unit-tested on
// Babylon's NullEngine in unit/mapRender.test.ts.

const VIEWPORT = { width: 1280, height: 720 }
const WAIT_MS = 10_000
const REPORTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'Reports')
/** The whole map from the overhead camera (a tab that never joins, so it keeps that camera). */
const SCREENSHOT = join(REPORTS, 'graybox-map.png')
/** Since #24 the joined tabs use their team camera: the ghost's and the warden's own views (#25). */
const GHOST_VIEW = join(REPORTS, 'graybox-ghost-third-person.png')
const WARDEN_VIEW = join(REPORTS, 'graybox-warden-first-person.png')

const snap = (page: Page): Promise<BlacksiteSnapshot> => page.evaluate(() => window.__blacksite.snapshot())

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  return errors
}

async function open(browser: Browser): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  const errors = collectErrors(page)
  await page.goto('/')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  return { page, errors }
}

/** Waits until the tab is connected and knows `n` players. */
async function joined(page: Page, n: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await snap(page)
        return s.connected && s.sessionId !== null && s.players.length === n
      },
      { message: `tab is connected and sees ${n} players`, timeout: WAIT_MS },
    )
    .toBe(true)
}

/** Resolves after the page has rendered `n` more animation frames. */
const frames = (page: Page, n: number) =>
  page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      }),
    n,
  )

// Since #33 the map report also counts the upper level's floors, ramps and
// anchors (#34): every count equals the length of its shared list.
const EXPECTED_MAP = {
  id: GRAYBOX_MAP.id,
  renderedSolids: GRAYBOX_MAP.solids.length,
  renderedFloors: GRAYBOX_MAP.floors.length,
  renderedRamps: GRAYBOX_MAP.ramps.length,
  renderedAnchors: GRAYBOX_MAP.anchors.length,
}

test('each tab renders every solid of the shared map; screenshot for review', async ({ browser }, testInfo) => {
  test.setTimeout(60_000)
  const a = await open(browser)
  const b = await open(browser)
  try {
    await joined(a.page, 2)
    await joined(b.page, 2)

    // Matched, not compared exactly, so fields added later in version 1 don't
    // fail this; every count known today is pinned.
    for (const { page } of [a, b]) {
      const s = await snap(page)
      expect(s.version).toBe(1)
      expect(s.map).toMatchObject(EXPECTED_MAP)
    }
    expect(EXPECTED_MAP).toEqual({ id: 'graybox-1', renderedSolids: 16, renderedFloors: 4, renderedRamps: 1, renderedAnchors: 6 })

    // The joined tabs are in their team cameras (#24): tab A, the first
    // joiner, is the ghost in third person and tab B the warden in first
    // person. Save each view, then the overhead view of the whole map from a
    // third tab whose matchmaking request is refused, so it never joins and
    // keeps the overhead camera (it shows the map without players).
    const sa = await snap(a.page)
    const sb = await snap(b.page)
    expect(sa.camera?.mode, 'tab A (the ghost) is in third person').toBe('third-person')
    expect(sb.camera?.mode, 'tab B (the warden) is in first person').toBe('first-person')
    mkdirSync(REPORTS, { recursive: true })
    for (const [tab, path, name] of [
      [a, GHOST_VIEW, 'ghost-third-person'],
      [b, WARDEN_VIEW, 'warden-first-person'],
    ] as const) {
      await frames(tab.page, 10)
      const png = await tab.page.screenshot({ path })
      await testInfo.attach(name, { body: png, contentType: 'image/png' })
      // Lower bar than the map view: the warden faces a nearby wall, a mostly flat image.
      expect(png.length, `${name}: a rendered scene, not an empty page`).toBeGreaterThan(5_000)
    }

    const context = await browser.newContext({ viewport: VIEWPORT })
    try {
      const page = await context.newPage()
      await page.route('**/matchmake/**', (route) => route.abort())
      await page.goto('/')
      await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
      await expect(page.locator('#hud')).toContainText('offline')
      const s = await snap(page)
      expect(s.map).toMatchObject(EXPECTED_MAP)
      expect(s.camera, 'a tab that never joined keeps the overhead camera').toMatchObject({ mode: 'overhead', yaw: 0 })
      await frames(page, 10)
      const png = await page.screenshot({ path: SCREENSHOT })
      await testInfo.attach('graybox-map', { body: png, contentType: 'image/png' })
      expect(png.length).toBeGreaterThan(10_000) // a rendered scene, not an empty page
    } finally {
      await context.close()
    }

    expect(a.errors).toEqual([])
    expect(b.errors).toEqual([])
  } finally {
    await a.page.context().close()
    await b.page.context().close()
  }
})
