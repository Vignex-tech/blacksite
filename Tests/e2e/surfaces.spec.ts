import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test'
import { SURFACE_STYLE } from '../../client/src/surfaceStyle.ts'

// #86: the textured surfaces of #85 in a real browser. Medium and high are very
// slow under software GL, so each of these tabs is small, joins nothing where it
// can, and stays open for as short a time as it can. fps is never asserted.
//   texture swap     medium loads 3 maps per surface set, high the same, low only the albedo
//   blocked texture  one blocked tex_*.webp leaves that set on flat colours, the rest textured
//   readability      the surface albedos, tinted, stay mid-tone and calm (rule 7)
//   pixels           the saved screenshots are not blank or near-uniform
// Screenshots (the owner's look at the textured map) go to Tests/Reports/ and
// are attached; CI uploads that folder as an artifact.

const REPORTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'Reports')
const VIEWPORT = { width: 800, height: 450 }
const SETS = [...new Set(Object.values(SURFACE_STYLE).map((s) => s.material))]
const MAPS_PER_TIER = { low: 1, medium: 3, high: 3 } as const

interface Opened {
  page: Page
  errors: string[]
  warnings: string[]
  loaded: string[]
  failed: string[]
}

/** A tab that never joins (matchmaking refused), so it keeps the overhead camera and costs the server nothing. */
async function open(browser: Browser, gfx: 'low' | 'medium' | 'high', opts: { block?: RegExp; join?: boolean } = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  const o: Opened = { page, errors: [], warnings: [], loaded: [], failed: [] }
  page.on('pageerror', (e) => o.errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) o.errors.push(m.text())
    if (m.type() === 'warning') o.warnings.push(m.text())
  })
  page.on('response', (r) => {
    const f = /tex_[a-z_]+\.webp$/.exec(new URL(r.url()).pathname)
    if (f && r.ok()) o.loaded.push(f[0])
  })
  page.on('requestfailed', (r) => {
    const f = /tex_[a-z_]+\.webp$/.exec(new URL(r.url()).pathname)
    if (f) o.failed.push(f[0])
  })
  if (opts.block) await page.route(opts.block, (route) => route.abort())
  if (!opts.join) await page.route('**/matchmake/**', (route) => route.abort())
  await page.goto(`/?gfx=${gfx}`)
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  return o
}

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

/** Luminance statistics of a PNG, decoded in the page (no image library needed). */
async function pixelStats(page: Page, png: Buffer): Promise<{ mean: number; std: number; dark: number; bright: number; distinct: number }> {
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = 200
    c.height = Math.round((200 * img.height) / img.width)
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0, c.width, c.height)
    const d = g.getImageData(0, 0, c.width, c.height).data
    const n = d.length / 4
    let sum = 0
    let sq = 0
    let dark = 0
    let bright = 0
    const seen = new Set<number>()
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255
      sum += l
      sq += l * l
      if (l < 0.02) dark++
      if (l > 0.98) bright++
      seen.add(((d[i] >> 2) << 12) | ((d[i + 1] >> 2) << 6) | (d[i + 2] >> 2))
    }
    const mean = sum / n
    return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), dark: dark / n, bright: bright / n, distinct: seen.size }
  }, png.toString('base64'))
}

async function shoot(o: Opened, name: string, testInfo: TestInfo) {
  mkdirSync(REPORTS, { recursive: true })
  // The loading bar covers the picture while models and textures arrive.
  await expect(o.page.locator('#loading')).toBeHidden({ timeout: 40_000 })
  await frames(o.page, 5)
  const png = await o.page.screenshot({ path: join(REPORTS, `${name}.png`) })
  await testInfo.attach(name, { body: png, contentType: 'image/png' })
  const stats = await pixelStats(o.page, png)
  expect(stats.distinct, `${name}: a scene with many colours, not blank (${stats.distinct} distinct, std ${stats.std.toFixed(3)})`).toBeGreaterThan(80)
  expect(stats.std, `${name}: not near-uniform`).toBeGreaterThan(0.02)
  expect(stats.dark, `${name}: darkness does not crush the picture`).toBeLessThan(0.5)
  expect(stats.bright, `${name}: no blown-out picture`).toBeLessThan(0.5)
  return stats
}

const waitLoaded = (o: Opened, n: number) =>
  expect.poll(() => o.loaded.length + o.failed.length, { message: 'texture files requested and answered', timeout: 30_000 }).toBeGreaterThanOrEqual(n)

for (const tier of ['medium', 'high'] as const) {
  test(`?gfx=${tier} loads every texture map once and renders the textured map`, async ({ browser }, testInfo) => {
    test.setTimeout(90_000)
    const o = await open(browser, tier)
    try {
      const want = SETS.length * MAPS_PER_TIER[tier]
      await waitLoaded(o, want)
      expect(o.failed).toEqual([])
      expect([...new Set(o.loaded)].sort()).toEqual(SETS.flatMap((s) => ['albedo', 'normal', 'orm'].map((m) => `tex_${s}_${m}.webp`)).sort())
      expect(o.loaded.length, 'each file is fetched once').toBe(want)
      expect(o.warnings.filter((w) => /Surface textures/.test(w))).toEqual([])
      await shoot(o, `surfaces-${tier}-overhead`, testInfo)
      const perf = await o.page.evaluate(() => (window as any).__blacksite.snapshot().perf)
      expect(perf.drawCalls, 'textured surfaces stay inside the draw call budget').toBeLessThanOrEqual(120)
      expect(o.errors).toEqual([])
    } finally {
      await o.page.context().close()
    }
  })
}

test('?gfx=low loads the albedo of each set only, without normal or ORM maps', async ({ browser }) => {
  const o = await open(browser, 'low')
  try {
    await waitLoaded(o, SETS.length)
    await o.page.waitForTimeout(500) // a late normal or ORM request would show up here
    expect([...new Set(o.loaded)].sort()).toEqual(SETS.map((s) => `tex_${s}_albedo.webp`).sort())
    expect(o.errors).toEqual([])
  } finally {
    await o.page.context().close()
  }
})

test('one blocked texture keeps that set on its flat colour and the rest textured', async ({ browser }, testInfo) => {
  test.setTimeout(90_000)
  const blocked = 'steel_painted' // the cover boxes
  const o = await open(browser, 'medium', { block: new RegExp(`tex_${blocked}_[a-z]+[.]webp`) })
  try {
    const maps = MAPS_PER_TIER.medium
    await waitLoaded(o, SETS.length * maps)
    expect(o.failed.sort()).toEqual(['albedo', 'normal', 'orm'].map((m) => `tex_${blocked}_${m}.webp`).sort())
    expect(o.loaded.length).toBe((SETS.length - 1) * maps)
    await expect.poll(() => o.warnings.filter((w) => w.includes(`"${blocked}"`) && /flat material/.test(w)).length, { timeout: 10_000 }).toBe(1)
    expect(o.warnings.filter((w) => /Surface textures/.test(w) && !w.includes(`"${blocked}"`))).toEqual([])
    await shoot(o, 'surfaces-medium-blocked-cover', testInfo)
    expect(o.errors, 'a blocked file is a warning, not an error').toEqual([])
  } finally {
    await o.page.context().close()
  }
})

test('every surface texture stays mid-tone and calm, so a player stays readable against it', async ({ page }) => {
  await page.goto('/?gfx=low')
  const rows = await page.evaluate(
    async ({ sets, tints }) => {
      const out: { set: string; kind: string; mean: number; std: number }[] = []
      for (const [kind, set, tint] of tints as [string, string, number[]][]) {
        if (!(sets as string[]).includes(set)) continue
        const blob = await (await fetch(`/assets/textures/tex_${set}_albedo.webp`)).blob()
        const bmp = await createImageBitmap(blob)
        const c = document.createElement('canvas')
        c.width = c.height = 64
        const g = c.getContext('2d')!
        g.drawImage(bmp, 0, 0, 64, 64)
        const d = g.getImageData(0, 0, 64, 64).data
        let sum = 0
        let sq = 0
        for (let i = 0; i < d.length; i += 4) {
          // sRGB to linear is skipped: this is a relative check on display values, tinted as the material does.
          const l = Math.min(1, ((0.2126 * d[i] * tint[0] + 0.7152 * d[i + 1] * tint[1] + 0.0722 * d[i + 2] * tint[2]) / 255))
          sum += l
          sq += l * l
        }
        const n = d.length / 4
        out.push({ set, kind, mean: sum / n, std: Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) })
      }
      return out
    },
    { sets: SETS, tints: Object.entries(SURFACE_STYLE).map(([k, s]) => [k, s.material, s.tint]) },
  )
  expect(rows.length).toBe(Object.keys(SURFACE_STYLE).length)
  for (const r of rows) {
    // A dark or bright player model must separate from the surface it stands on: not near black, not near white.
    expect(r.mean, `${r.kind} (${r.set}) mean luminance ${r.mean.toFixed(2)}`).toBeGreaterThan(0.12)
    expect(r.mean, `${r.kind} (${r.set}) mean luminance ${r.mean.toFixed(2)}`).toBeLessThan(0.8)
    // Calm: a texture with a very high contrast would camouflage a silhouette.
    expect(r.std, `${r.kind} (${r.set}) luminance spread ${r.std.toFixed(2)}`).toBeLessThan(0.25)
  }
  // The colour language holds after texturing: walls lighter than cover.
  const mean = (k: string) => rows.find((r) => r.kind === k)!.mean
  expect(mean('wall')).toBeGreaterThan(mean('cover'))
})

test('the Ghost in its third-person view is on a calm textured scene (medium); screenshot for review', async ({ browser }, testInfo) => {
  test.setTimeout(90_000)
  const o = await open(browser, 'medium', { join: true })
  try {
    await expect
      .poll(() => o.page.evaluate(() => (window as any).__blacksite.snapshot().camera?.mode), { timeout: 20_000 })
      .toBe('third-person')
    await waitLoaded(o, SETS.length * MAPS_PER_TIER.medium)
    await shoot(o, 'surfaces-medium-ghost-third-person', testInfo)
    expect(o.errors).toEqual([])
  } finally {
    await o.page.context().close()
  }
})
