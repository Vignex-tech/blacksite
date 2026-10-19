import { expect, test, type Page } from '@playwright/test'

/** Collects page errors and console errors. Warnings (e.g. Babylon GPU stalls) are ignored. */
function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  return errors
}

test('Babylon scene renders into #game-canvas without console errors', async ({ page }) => {
  const errors = collectErrors(page)
  await page.goto('/?gfx=low')

  const canvas = page.locator('#app > canvas#game-canvas')
  await expect(canvas).toBeVisible()
  // Babylon's Engine sets data-engine="Babylon.js v<version>" on its canvas.
  await expect(canvas).toHaveAttribute('data-engine', /^Babylon\.js/)
  await expect(page.locator('.webgl-error')).toHaveCount(0)

  // The canvas has a WebGL context and a non-zero drawing buffer.
  const info = await canvas.evaluate((el: HTMLCanvasElement) => ({
    width: el.width,
    height: el.height,
    webgl: !!(el.getContext('webgl2') ?? el.getContext('webgl')),
  }))
  expect(info.webgl).toBe(true)
  expect(info.width).toBeGreaterThan(0)
  expect(info.height).toBeGreaterThan(0)

  // Let a few frames render before checking for errors.
  await page.waitForTimeout(500)
  expect(errors).toEqual([])
})

test('canvas fills the window and resizes with it', async ({ page }) => {
  const errors = collectErrors(page)
  await page.setViewportSize({ width: 1024, height: 700 })
  await page.goto('/?gfx=low')
  const canvas = page.locator('#game-canvas')
  await expect(canvas).toHaveAttribute('data-engine', /^Babylon\.js/)

  const size = () =>
    canvas.evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect()
      return { cssW: Math.round(r.width), cssH: Math.round(r.height), bufW: el.width, bufH: el.height }
    })

  const before = await size()
  expect(before.cssW).toBe(1024)
  expect(before.cssH).toBe(700)

  await page.setViewportSize({ width: 640, height: 480 })
  await expect.poll(size).toMatchObject({ cssW: 640, cssH: 480 })
  const after = await size()
  // engine.resize() updates the drawing buffer, not only the CSS box.
  expect(after.bufW).toBeLessThan(before.bufW)
  expect(after.bufH).toBeLessThan(before.bufH)
  expect(after.bufW).toBeGreaterThan(0)

  expect(errors).toEqual([])
})

// #80: with no ?gfx= the client runs on the player default tier (medium). A
// full page load, joining the room and a few seconds of rendering must make no
// request to any host but the page's own (no CDN, rule: no runtime CDN
// fetches; Babylon's KTX and tools chunks mention cdn.babylonjs.com but must
// never fetch it), and the hook's additive `perf` field must report real
// numbers. Counts only; fps is never asserted (software GL). Adds about 4 s to
// the browser-a shard.
test('default tier loads with no external requests and reports perf', async ({ page, baseURL }) => {
  const errors = collectErrors(page)
  const origin = new URL(baseURL ?? 'http://localhost:2567').origin
  const foreign: string[] = []
  page.on('request', (req) => {
    const url = req.url()
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return
    if (new URL(url).origin !== origin) foreign.push(url)
  })
  page.on('websocket', (ws) => {
    if (new URL(ws.url()).host !== new URL(origin).host) foreign.push(ws.url())
  })

  await page.goto('/')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  await expect
    .poll(() => page.evaluate(() => (window as any).__blacksite?.snapshot().connected), { timeout: 15_000 })
    .toBe(true)

  // The 500 ms sampler fills `perf` with counts of the frames drawn so far.
  await expect
    .poll(() => page.evaluate(() => (window as any).__blacksite.snapshot().perf?.drawCalls ?? 0), { timeout: 15_000 })
    .toBeGreaterThan(0)
  const perf = await page.evaluate(() => (window as any).__blacksite.snapshot().perf)
  expect(Number.isFinite(perf.fps) && perf.fps >= 0).toBe(true)
  // The art budget is 120 draw calls and 150k triangles (art-plan section 9). The hook reports
  // one frame's draw calls (fixed in #82; before that it accumulated, which is why #80 saw 376).
  // Measured about 33 with the characters in view and 5 in the Warden's first person, so the
  // 120 budget leaves wide margin for the props and surfaces to come (#85, #89).
  expect(perf.drawCalls).toBeLessThanOrEqual(120)
  expect(perf.activeTriangles).toBeGreaterThan(0)
  expect(perf.activeTriangles).toBeLessThanOrEqual(150_000)

  // F3 shows and hides the overlay without touching gameplay.
  await expect(page.locator('#perf')).toBeHidden()
  await page.keyboard.press('F3')
  await expect(page.locator('#perf')).toBeVisible()
  await page.keyboard.press('F3')
  await expect(page.locator('#perf')).toBeHidden()

  expect(foreign, 'requests to hosts other than the page origin').toEqual([])
  expect(errors).toEqual([])
})
