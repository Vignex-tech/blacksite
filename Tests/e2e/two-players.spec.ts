import { expect, test, type Browser, type Page } from '@playwright/test'

// Milestone #1 (issue #5): two browser tabs join the shared room and each sees
// the other's box move.
//
// What each tab sees is read from the rendered canvas itself: a screenshot of
// #game-canvas is decoded in the page and split by colour. The client draws
// its own box blue and every other player's box orange (client/src/scene.ts),
// on a grey ground and a near-black background, so in each tab:
//   blue   = this tab's player
//   orange = the other tab's player
// Both tabs use the same viewport and the same fixed camera, so a box at the
// same world position lands on the same pixels in both tabs.
//
// Pages joinOrCreate the shared `my_room`, so the browser specs run on a
// single worker (playwright.config.ts) and no other spec's page can add boxes.

const VIEWPORT = { width: 800, height: 600 }
/** Upper bound for one wait. A failure, never a delay. */
const WAIT_MS = 10_000
/** Same position seen in two tabs: centroids agree within this (anti-aliased edges). */
const SAME_PX = 1.5
/** A box that must not move: its centroid changes by less than this. */
const STILL_PX = 0.75

interface Blob2D {
  /** Pixel count; 0 when the colour is not on screen. */
  n: number
  /** Centroid in canvas pixels (NaN when n is 0). */
  x: number
  y: number
}
interface Boxes {
  blue: Blob2D
  orange: Blob2D
}

/** Screenshots the canvas and returns the blue and orange box centroids. */
async function boxes(page: Page): Promise<Boxes> {
  const png = await page.locator('#game-canvas').screenshot()
  return page.evaluate(async (b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    const acc = { blue: { n: 0, sx: 0, sy: 0 }, orange: { n: 0, sx: 0, sy: 0 } }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        // Ground and background are near-grey (r ~ g ~ b); the HUD text is light grey.
        const key = b > 70 && b > r + 50 ? 'blue' : r > 70 && r > b + 50 && r > g + 25 ? 'orange' : null
        if (!key) continue
        acc[key].n++
        acc[key].sx += x
        acc[key].sy += y
      }
    }
    const blob = (a: { n: number; sx: number; sy: number }) => ({ n: a.n, x: a.sx / a.n, y: a.sy / a.n })
    return { blue: blob(acc.blue), orange: blob(acc.orange) }
  }, png.toString('base64'))
}

async function openPlayer(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  return page
}

const near = (a: Blob2D, b: Blob2D, px: number) => Math.abs(a.x - b.x) < px && Math.abs(a.y - b.y) < px

/**
 * Waits until A's box has stopped moving and is drawn at the same place in
 * both tabs (A's blue in page A matches A's orange in page B). Returns the
 * settled view of both tabs.
 */
async function settle(a: Page, b: Page): Promise<{ a: Boxes; b: Boxes }> {
  let prev: Boxes | null = null
  let last: { a: Boxes; b: Boxes } | null = null
  await expect
    .poll(
      async () => {
        const va = await boxes(a)
        const vb = await boxes(b)
        const still = prev !== null && near(prev.blue, va.blue, 0.25)
        prev = va
        last = { a: va, b: vb }
        return still && vb.orange.n > 0 && near(va.blue, vb.orange, SAME_PX)
      },
      { message: "A's box settles at the same place in both tabs", timeout: WAIT_MS },
    )
    .toBe(true)
  return last!
}

/** Holds `key` in page A until `done(viewOfA)` holds, then releases it. */
async function holdUntil(a: Page, key: string, what: string, done: (v: Boxes) => boolean): Promise<void> {
  await a.keyboard.down(key)
  try {
    await expect.poll(async () => done(await boxes(a)), { message: what, timeout: WAIT_MS }).toBe(true)
  } finally {
    await a.keyboard.up(key)
  }
}

test('two tabs share the room and each sees the other move', async ({ browser }) => {
  // Software WebGL plus a screenshot per reading: about 15 s locally.
  test.setTimeout(90_000)
  const a = await openPlayer(browser)
  const b = await openPlayer(browser)
  try {
    // Both tabs joined the same room and each counts two players.
    for (const page of [a, b]) {
      await expect(page.locator('#hud')).toHaveText('Blacksite - online, 2 players', { timeout: WAIT_MS })
      // Each tab draws its own (blue) box from server state.
      await expect.poll(async () => (await boxes(page)).blue.n, { timeout: WAIT_MS }).toBeGreaterThan(0)
    }

    // Phase 1: A walks sideways, away from B, so the two boxes are well apart
    // on screen (they spawn within +-3 and may overlap at first).
    const start = await boxes(a)
    const w = Math.sqrt(start.blue.n) // rough box size on screen, in pixels
    const right = !(start.orange.n > 0) || start.blue.x >= start.orange.x
    await holdUntil(
      a,
      right ? 'KeyD' : 'KeyA',
      `A's box moves ${right ? 'right' : 'left'}, clear of B's box`,
      (v) =>
        v.orange.n > 0 &&
        Math.abs(v.blue.x - start.blue.x) > 2 * w &&
        Math.abs(v.blue.x - v.orange.x) > 4 * w &&
        (right ? v.blue.x > v.orange.x : v.blue.x < v.orange.x),
    )
    const before = await settle(a, b)
    // Each tab draws both boxes, and B's box is in the same place in both.
    expect(before.a.orange.n).toBeGreaterThan(0)
    expect(before.b.blue.n).toBeGreaterThan(0)
    expect(near(before.a.orange, before.b.blue, SAME_PX), "B's box matches across tabs").toBe(true)

    // Phase 2: hold W in tab A. +z is away from the camera, so A's box moves up
    // the screen, in tab A and in tab B.
    await holdUntil(a, 'KeyW', "A's box moves up the screen in tab A", (v) => v.blue.y < before.a.blue.y - 2 * w)
    const after = await settle(a, b)
    expect(after.a.blue.y, "A's box moved in tab A").toBeLessThan(before.a.blue.y - 2 * w)
    expect(after.b.orange.y, "A's box moved in tab B").toBeLessThan(before.b.orange.y - 2 * w)
    // settle() already checked that A's box is drawn at the same place in both tabs.

    // B never pressed a key: its box has not moved in either tab.
    expect(Math.abs(after.b.blue.x - before.b.blue.x), "B's box x in tab B").toBeLessThan(STILL_PX)
    expect(Math.abs(after.b.blue.y - before.b.blue.y), "B's box y in tab B").toBeLessThan(STILL_PX)
    expect(Math.abs(after.a.orange.x - before.a.orange.x), "B's box x in tab A").toBeLessThan(STILL_PX)
    expect(Math.abs(after.a.orange.y - before.a.orange.y), "B's box y in tab A").toBeLessThan(STILL_PX)

    // Still exactly two players in each tab.
    for (const page of [a, b]) {
      await expect(page.locator('#hud')).toHaveText('Blacksite - online, 2 players')
    }
  } finally {
    await a.context().close()
    await b.context().close()
  }
})
