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
  /** Where Playwright's virtual mouse is (moveMouse moves relative to it). */
  cursor: { x: number; y: number }
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
  return { page, name, errors, sent, cursor: { x: 0, y: 0 } }
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

/** Takes pointer lock by clicking the canvas, as a player does. */
export async function lockPointer(tab: Tab): Promise<void> {
  // Before the lock, mouse movement doesn't turn the camera (checked by the specs).
  tab.cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 }
  await tab.page.mouse.move(tab.cursor.x, tab.cursor.y)
  await tab.page.locator('#game-canvas').click({ position: tab.cursor })
  await expect
    .poll(() => tab.page.evaluate(() => document.pointerLockElement?.id ?? null), {
      message: `${tab.name}: clicking the canvas takes pointer lock`,
      timeout: WAIT_MS,
    })
    .toBe('game-canvas')
}

/**
 * Moves the mouse right by `pixels` (left if negative) from where it is, in
 * steps of at most 20 px, keeping y. Under pointer lock only movementX
 * matters, so the virtual cursor may leave the viewport. Returns the yaw
 * change the client rig should apply (pixels * RAD_PER_PIXEL).
 */
export async function moveMouse(tab: Tab, pixels: number): Promise<number> {
  const steps = Math.max(1, Math.ceil(Math.abs(pixels) / 20))
  tab.cursor = { x: tab.cursor.x + pixels, y: tab.cursor.y }
  await tab.page.mouse.move(tab.cursor.x, tab.cursor.y, { steps })
  return pixels * RAD_PER_PIXEL
}

/** Per-sample local and watched player positions recorded inside the page. */
export interface Sample {
  t: number
  players: { id: string; x: number; z: number; yaw: number }[]
}

/**
 * Starts recording snapshots inside the page every `everyMs`, with the page's
 * performance.now() time. Not a client change: the test adds a timer to the
 * page and reads the public hook. Returns a function that stops and returns
 * the samples.
 */
export async function startSampler(page: Page, everyMs = 10): Promise<() => Promise<Sample[]>> {
  await page.evaluate((ms) => {
    const w = window as unknown as { __qaSamples: unknown[]; __qaTimer: number }
    w.__qaSamples = []
    w.__qaTimer = window.setInterval(() => {
      const s = window.__blacksite.snapshot()
      w.__qaSamples.push({ t: performance.now(), players: s.players.map((p) => ({ id: p.id, x: p.x, z: p.z, yaw: p.yaw })) })
    }, ms)
  }, everyMs)
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __qaSamples: unknown[]; __qaTimer: number }
      window.clearInterval(w.__qaTimer)
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
