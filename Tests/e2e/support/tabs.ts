// Browser-tab helpers for the camera specs (#25). State is read only through
// window.__blacksite.snapshot(); turning goes through the real input path
// (click the canvas for pointer lock, then mouse movement), as a player would.

import { expect, type Browser, type Page } from '@playwright/test'
import type { CameraMode, BlacksitePlayerSnapshot, BlacksiteSnapshot } from '../../../shared/testhook.js'
import type { Team } from '../../../shared/protocol.js'
import { captureMoves } from './frames.js'

/** Mouse turn rate of the client's camera rig (client/src/cameras.ts, #24): radians per pixel. */
export const RAD_PER_PIXEL = 0.0025
export const WAIT_MS = 10_000
export const VIEWPORT = { width: 320, height: 240 }
/** float32 on the wire. */
export const EPS = 1e-4

export const MODE_FOR_TEAM: Record<Team, CameraMode> = { ghost: 'third-person', warden: 'first-person' }

export interface Tab {
  page: Page
  name: string
  errors: string[]
  sent: ReturnType<typeof captureMoves>
}

export const snap = (page: Page): Promise<BlacksiteSnapshot> => page.evaluate(() => window.__blacksite.snapshot())

export function get(s: BlacksiteSnapshot, id: string): BlacksitePlayerSnapshot {
  const p = s.players.find((v) => v.id === id)
  if (!p) throw new Error(`player ${id} missing from ${s.sessionId}'s snapshot`)
  return p
}

export function local(s: BlacksiteSnapshot): BlacksitePlayerSnapshot {
  const p = s.players.find((v) => v.isLocal)
  if (!p) throw new Error(`${s.sessionId} has no local player`)
  return p
}

/** Opens a tab in its own browser context, records its errors and sent moves, and waits for the canvas. */
export async function openTab(
  browser: Browser,
  name: string,
  opts: { viewport?: { width: number; height: number }; beforeGoto?: (page: Page) => Promise<void> } = {},
): Promise<Tab> {
  const viewport = opts.viewport ?? VIEWPORT
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await opts.beforeGoto?.(page)
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  const sent = captureMoves(page)
  await page.goto('/')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  return { page, name, errors, sent }
}

/**
 * Waits until the tab is connected, sees `n` players each with a team, and
 * its camera has left 'overhead' (the team camera is on). Returns the snapshot.
 */
export async function joined(tab: Tab, n: number): Promise<BlacksiteSnapshot> {
  await expect
    .poll(
      async () => {
        const s = await snap(tab.page)
        return (
          s.connected &&
          s.sessionId !== null &&
          s.players.length === n &&
          s.players.every((p) => p.team !== null) &&
          s.camera !== undefined &&
          s.camera.mode !== 'overhead'
        )
      },
      { message: `${tab.name} is connected, sees ${n} players with teams, and has its team camera`, timeout: WAIT_MS },
    )
    .toBe(true)
  return snap(tab.page)
}

/**
 * Takes pointer lock by clicking the canvas, as a player does, and checks the
 * browser granted it to the canvas. Then hands the lock over to a stand-in
 * (see below) that the rest of the test drives.
 *
 * Why a stand-in: in headless Chromium on Linux (CI), a real pointer lock
 * makes the browser fire a mousemove on every frame with no input, the
 * first carrying a bogus movementX (a 400 px turn landed at 0.6 rad instead
 * of 1.0), and the extra events (each runs Babylon's pointer picking) cut
 * the page from 60 to about 35 frames per second and the client's 20 Hz move
 * timer to about 13 Hz. Found with a diagnostic run in #25; on Windows the
 * real lock behaves. Real players don't see this: it is the headless
 * browser's synthetic cursor.
 *
 * The stand-in: the real lock is released, then `document.pointerLockElement`
 * reports the canvas until `document.exitPointerLock()` is called (which the
 * client calls on disconnect, and a test calls for "Esc"). The client code
 * is unchanged and is driven through the exact checks and events it uses.
 */
export async function lockPointer(tab: Tab): Promise<void> {
  // Before the lock, mouse movement doesn't turn the camera (checked by the specs).
  const centre = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 }
  await tab.page.mouse.move(centre.x, centre.y)
  await tab.page.locator('#game-canvas').click({ position: centre })
  await expect
    .poll(() => tab.page.evaluate(() => document.pointerLockElement?.id ?? null), {
      message: `${tab.name}: clicking the canvas takes pointer lock`,
      timeout: WAIT_MS,
    })
    .toBe('game-canvas')
  await tab.page.evaluate(() => {
    const canvas = document.getElementById('game-canvas')!
    const realExit = Document.prototype.exitPointerLock
    realExit.call(document)
    let held = true
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => (held ? canvas : null) })
    Object.defineProperty(document, 'exitPointerLock', {
      configurable: true,
      value: () => {
        held = false
        realExit.call(document)
      },
    })
  })
}

/**
 * Mouse movement as the client's camera sees it: `pixels` of movementX (right
 * if positive), in steps of at most 20, dispatched as mousemove events on the
 * document, which is exactly what client/src/cameras.ts listens to. The
 * client still decides whether to turn (only while it sees the pointer
 * locked to the canvas; see lockPointer for why that is a stand-in).
 * page.mouse.move isn't used under the lock because headless Chromium on
 * Linux gives it unreliable movementX (doubled, or carrying the cursor
 * offset). Returns the yaw change the client should apply
 * (pixels * RAD_PER_PIXEL).
 */
export async function moveMouse(tab: Tab, pixels: number): Promise<number> {
  await tab.page.evaluate((total) => {
    const n = Math.max(1, Math.ceil(Math.abs(total) / 20))
    let done = 0
    for (let i = 1; i <= n; i++) {
      const to = Math.round((total * i) / n)
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: to - done, movementY: 0, bubbles: true }))
      done = to
    }
  }, pixels)
  return pixels * RAD_PER_PIXEL
}

/**
 * Turns the camera to about `target` (radians) with mouse movement
 * (moveMouse) and checks the rig turned exactly 0.0025 rad per pixel.
 * Returns the reached yaw (within half a pixel's turn of the target).
 */
export async function turnTo(tab: Tab, target: number): Promise<number> {
  const camYaw = async () => (await snap(tab.page)).camera!.yaw
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
  const from = await camYaw()
  const pixels = Math.round(wrap(target - from) / RAD_PER_PIXEL)
  const turned = await moveMouse(tab, pixels)
  const yaw = await camYaw()
  const want = wrap(from + turned)
  expect(Math.abs(wrap(yaw - want)), `${tab.name}: ${pixels} px turned the camera by ${turned} rad at once (from ${from} to ${yaw})`).toBeLessThan(1e-9)
  return yaw
}

/** Per-sample local and watched player positions recorded inside the page. */
export interface Sample {
  t: number
  /** y and mode are copied only when the snapshot has them (from #33); missing means 0 and 'ground'. */
  players: { id: string; x: number; z: number; yaw: number; y?: unknown; mode?: unknown }[]
}

/**
 * Starts recording snapshots inside the page every `everyMs`, with the page's
 * performance.now() time. Not a client change: the test adds a timer to the
 * page and reads the public hook. Returns a function that stops and returns
 * the samples.
 */
export async function startSampler(page: Page, everyMs = 10): Promise<() => Promise<Sample[]>> {
  await page.evaluate((ms) => {
    const w = window as unknown as { __qaSamples: unknown[]; __qaTimer: number; __qaSample: () => void }
    w.__qaSamples = []
    w.__qaSample = () => {
      const s = window.__blacksite.snapshot()
      w.__qaSamples.push({
        t: performance.now(),
        players: s.players.map((p) => {
          const extra = p as { y?: unknown; mode?: unknown }
          return { id: p.id, x: p.x, z: p.z, yaw: p.yaw, ...('y' in extra ? { y: extra.y } : {}), ...('mode' in extra ? { mode: extra.mode } : {}) }
        }),
      })
    }
    w.__qaTimer = window.setInterval(w.__qaSample, ms)
  }, everyMs)
  // Stopping takes one last sample: in a loaded headless page the interval
  // can go a second or more without firing (#36 saw a record end one state
  // short of what the hook had already shown), so the final state is always in.
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __qaSamples: unknown[]; __qaTimer: number; __qaSample: () => void }
      window.clearInterval(w.__qaTimer)
      w.__qaSample()
      return w.__qaSamples as Sample[]
    })
}

export const pageNow = (page: Page): Promise<number> => page.evaluate(() => performance.now())

/** Holds `key` for about `ms`, returning the page times just before key down and just after key up. */
export async function holdKey(page: Page, key: string, ms: number): Promise<{ down: number; up: number }> {
  const down = await pageNow(page)
  await page.keyboard.down(key)
  try {
    await page.waitForTimeout(ms)
  } finally {
    await page.keyboard.up(key)
  }
  const up = await pageNow(page)
  return { down, up }
}

export async function closeTabs(...tabs: (Tab | undefined)[]): Promise<void> {
  for (const t of tabs) await t?.page.context().close().catch(() => {})
}
