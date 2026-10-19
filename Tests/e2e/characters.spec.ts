import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTabs, get, joined, local, lockPointer, snap, turnTo, type Tab } from './support/tabs.js'
import { captureMoves } from './support/frames.js'
import { hasLineOfSight, eyeOf } from './support/visibility.js'

// Character art in real tabs (#83, M8). A Ghost tab and a Warden tab, both on
// the `high` tier at 960x540, with the three character models loading from the
// server. The Ghost walks in through the south door; the Warden waits inside.
// It checks that:
//  - the models load (glb responses, same origin, no console errors);
//  - both players stay readable: screenshots of each character, close and far,
//    land in Tests/Reports/ (art-ghost-*, art-warden-*) for the owner, and a
//    pixel check says the frame around the Warden differs from the plain
//    background, i.e. a model is drawn there (rule 7);
//  - draw calls per frame stay inside the 120 budget with both characters in view.
// The hook has no per-player animation field yet (asked for in the closing
// comment of #83), so which clip plays is covered by tests/unit/animation.test.ts.
// Runs in browser-b; about 25 s.

const REPORTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'Reports')
const VIEW = { width: 960, height: 540 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function openHigh(browser: import('@playwright/test').Browser, name: string): Promise<Tab & { glb: string[] }> {
  const context = await browser.newContext({ viewport: VIEW })
  const page = await context.newPage()
  const errors: string[] = []
  const glb: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    // Driver performance notes (GPU stall due to ReadPixels) come from taking screenshots.
    if (m.type() === 'error' || (m.type() === 'warning' && !m.text().includes('GL Driver Message'))) errors.push(`${m.type()}: ${m.text()}`)
  })
  page.on('response', (r) => {
    if (r.url().endsWith('.glb')) glb.push(`${r.status()} ${new URL(r.url()).pathname}`)
  })
  const sent = captureMoves(page)
  await page.goto('/?gfx=high')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  return { page, name, errors, sent, glb }
}

/** Mean absolute colour difference between two rectangles of a PNG-decoded canvas read, via the page. */
async function regionContrast(page: Page, png: Buffer, box: { x: number; y: number; w: number; h: number }): Promise<number> {
  const b64 = png.toString('base64')
  return page.evaluate(
    async ({ b64, box }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(box.x, box.y, box.w, box.h).data
      // Standard deviation of luminance in the box: a flat background is near 0.
      let sum = 0
      let sum2 = 0
      const n = d.length / 4
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
        sum += l
        sum2 += l * l
      }
      const mean = sum / n
      return Math.sqrt(Math.max(0, sum2 / n - mean * mean))
    },
    { b64, box },
  )
}

test('character models: both teams load, stay readable and fit the draw-call budget (high tier)', async ({ browser }) => {
  test.setTimeout(150_000)
  mkdirSync(REPORTS, { recursive: true })
  let ghostTab: (Tab & { glb: string[] }) | undefined
  let wardenTab: (Tab & { glb: string[] }) | undefined
  try {
    ghostTab = await openHigh(browser, 'ghost tab')
    const g0 = await joined(ghostTab, { ghosts: 1, wardens: 0 })
    wardenTab = await openHigh(browser, 'warden tab')
    const w0 = await joined(wardenTab, { ghosts: 1, wardens: 1 })
    const gt = ghostTab
    const wt = wardenTab
    const ghostId = g0.sessionId!
    const wardenId = w0.sessionId!
    expect([g0.localTeam, w0.localTeam]).toEqual(['ghost', 'warden'])
    await lockPointer(gt)
    await lockPointer(wt)

    // Place both on x = 3: the Warden strafes there, the Ghost enters by the south door (x = 0) and strafes.
    // Closed loop: hold the key until the hook shows the target (frame rate on
    // CI's software GL at the high tier is low, so time-based holds undershoot).
    const goTo = async (tab: Tab, axis: 'x' | 'z', target: number, keyUp: string, keyDown: string) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const cur = local(await snap(tab.page))[axis]
        if (Math.abs(cur - target) <= 0.25) return
        const key = target > cur ? keyUp : keyDown
        await tab.page.keyboard.down(key)
        try {
          const started = Date.now()
          while (Date.now() - started < 10_000) {
            const v = local(await snap(tab.page))[axis]
            if (key === keyUp ? v >= target - 0.1 : v <= target + 0.1) break
            await sleep(30)
          }
        } finally {
          await tab.page.keyboard.up(key)
        }
        await sleep(250)
      }
    }
    // Camera yaw 0 faces +z (north): W walks north, D goes east.
    const strafe = (tab: Tab, x: number) => goTo(tab, 'x', x, 'KeyD', 'KeyA')
    const walkNorthTo = (tab: Tab, z: number) => goTo(tab, 'z', z, 'KeyW', 'KeyS')
    await strafe(wt, 3)
    await strafe(gt, 0)
    await walkNorthTo(gt, -5.5)
    await strafe(gt, 3)
    await sleep(300)

    const pos = async () => {
      const s = await snap(gt.page)
      return { g: get(s, ghostId), w: get(s, wardenId) }
    }
    let { g, w } = await pos()
    expect(Math.abs(g.x - w.x), `both near x = 3: ghost ${g.x}, ${g.z}; warden ${w.x}, ${w.z}`).toBeLessThan(0.8)

    // The Ghost faces the Warden (it does already, both look north), the Warden faces the Ghost.
    await turnTo(wt, Math.atan2(g.x - w.x, g.z - w.z))
    await expect
      .poll(async () => (await snap(wt.page)).players.some((p) => p.id === ghostId), { message: 'the Warden tab is sent the Ghost in sight', timeout: 10_000 })
      .toBe(true)
    expect(hasLineOfSight(eyeOf({ x: w.x, y: w.y, z: w.z }), { x: g.x, y: 1.2, z: g.z })).toBe(true)

    // Wait for the three models to be fetched and attached.
    await expect.poll(() => gt.glb.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3)
    await expect.poll(() => wt.glb.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    await sleep(2500)

    // Far: about 9 units apart.
    const far = Math.hypot(w.x - g.x, w.z - g.z)
    expect(far).toBeGreaterThan(5)
    await gt.page.screenshot({ path: join(REPORTS, 'art-warden-far-ghost-view.png') })
    await wt.page.screenshot({ path: join(REPORTS, 'art-ghost-far-warden-view.png') })

    // Draw calls per frame with both characters and the map in view.
    const perfG = (await snap(gt.page)).perf!
    const perfW = (await snap(wt.page)).perf!
    expect(perfG.drawCalls, 'Ghost view draw calls').toBeLessThanOrEqual(120)
    expect(perfW.drawCalls, 'Warden view draw calls').toBeLessThanOrEqual(120)
    expect(perfG.activeTriangles).toBeLessThanOrEqual(150_000)

    // Close: the Ghost walks up to about 3 units from the Warden.
    await walkNorthTo(gt, w.z - 3)
    await sleep(500)
    ;({ g, w } = await pos())
    await turnTo(wt, Math.atan2(g.x - w.x, g.z - w.z))
    await sleep(1500)
    const closeDist = Math.hypot(w.x - g.x, w.z - g.z)
    expect(closeDist).toBeLessThan(far - 2)
    const closeGhostView = await gt.page.screenshot({ path: join(REPORTS, 'art-warden-close-ghost-view.png') })
    const closeWardenView = await wt.page.screenshot({ path: join(REPORTS, 'art-ghost-close-warden-view.png') })

    // Rule 7: a model is drawn where each character stands. In the close shots
    // the character is centred, so the luminance spread inside a tight box
    // around it must beat a flat fill (a dark Ghost on a grey floor still has
    // straps, an armband and limbs; an empty floor measures under 2).
    const ghostSelf = await regionContrast(gt.page, closeGhostView, { x: 330, y: 255, w: 130, h: 270 })
    expect(ghostSelf, 'the Ghost is drawn in its own third-person view').toBeGreaterThan(5)
    const wardenAhead = await regionContrast(gt.page, closeGhostView, { x: 405, y: 200, w: 70, h: 135 })
    expect(wardenAhead, 'the Warden ahead is drawn').toBeGreaterThan(8)
    const ghostSeen = await regionContrast(wt.page, closeWardenView, { x: 430, y: 240, w: 110, h: 290 })
    expect(ghostSeen, 'the Ghost is drawn in the Warden view').toBeGreaterThan(5)

    // Same-origin glb files only, all 200, and no console errors or warnings.
    for (const t of [gt, wt]) {
      expect(t.glb.every((l) => l.startsWith('200 /assets/characters/mesh_')), `${t.name} glb responses: ${t.glb.join(', ')}`).toBe(true)
      expect(t.errors, `${t.name} console`).toEqual([])
    }
  } finally {
    await closeTabs(ghostTab, wardenTab)
  }
})
