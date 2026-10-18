import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { GRAYBOX_MAP } from '../../shared/map.js'
import type { BlacksiteSnapshot } from '../../shared/testhook.js'

// #16: each tab renders the graybox map from shared/map.js (#14). The check is
// the test hook's map report, not pixels. The screenshot is saved for a human
// to look at (CI uploads Tests/Reports/ as the "graybox-map-screenshot"
// artifact on every run); nothing compares it, because GPU rendering differs
// between machines. Mesh names, sizes and colours are unit-tested on
// Babylon's NullEngine in unit/mapRender.test.ts.

const VIEWPORT = { width: 1280, height: 720 }
const WAIT_MS = 10_000
const SCREENSHOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'Reports', 'graybox-map.png')

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

const EXPECTED_MAP = { id: GRAYBOX_MAP.id, renderedSolids: GRAYBOX_MAP.solids.length }

test('each tab renders every solid of the shared map; screenshot for review', async ({ browser }, testInfo) => {
  test.setTimeout(60_000)
  const a = await open(browser)
  const b = await open(browser)
  try {
    await joined(a.page, 2)
    await joined(b.page, 2)

    // Version-1 fields matched, not compared exactly, so fields added in
    // version 1 don't fail this.
    for (const { page } of [a, b]) {
      const s = await snap(page)
      expect(s.version).toBe(1)
      expect(s.map).toMatchObject(EXPECTED_MAP)
    }
    expect(EXPECTED_MAP).toEqual({ id: 'graybox-1', renderedSolids: 16 })

    // Let a few frames draw with both player boxes in place, then save the view.
    await frames(a.page, 10)
    mkdirSync(dirname(SCREENSHOT), { recursive: true })
    const png = await a.page.screenshot({ path: SCREENSHOT })
    await testInfo.attach('graybox-map', { body: png, contentType: 'image/png' })
    expect(png.length).toBeGreaterThan(10_000) // a rendered scene, not an empty page

    expect(a.errors).toEqual([])
    expect(b.errors).toEqual([])
  } finally {
    await a.page.context().close()
    await b.page.context().close()
  }
})
