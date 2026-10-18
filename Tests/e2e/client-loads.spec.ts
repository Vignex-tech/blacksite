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
  await page.goto('/')

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
  await page.goto('/')
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
