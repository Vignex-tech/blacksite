import { expect, test, type Browser, type Page } from '@playwright/test'
import type { BlacksitePlayerSnapshot, BlacksiteSnapshot } from '../../shared/testhook.js'
import { yawOf } from './support/intent.js'

// Milestone #1 (issue #5), moved onto the client test hook in #12: two browser
// tabs join the shared room and each sees the other player move.
//
// What each tab knows is read from `window.__blacksite.snapshot()` (types in
// shared/testhook.d.ts, implemented in client/src/testHook.ts). Nothing here
// depends on colours, the camera, the HUD text or pixels, so rendering the map
// (#14) and new spawn rules (#13) don't affect it. Players are looked up by
// sessionId, never by list order or by where they spawned.
//
// Movement thresholds are small (MOVE_UNITS) so a held key can't carry a
// player from any spawn point into a wall before the key is released.
//
// Camera-relative movement (#18): D is +x and W is +z only while the local
// player faces +z (yaw 0). These tests never move the mouse or click the
// canvas, so nothing turns the camera, and before each key press they check
// that the snapshot's yaw is 0 when the field exists (#22 adds it).
//
// Pages joinOrCreate the shared `my_room`, so the browser specs run on a
// single worker (playwright.config.ts) and no other spec's page can join.

const VIEWPORT = { width: 800, height: 600 }
/** Upper bound for one wait. A failure, never a delay. */
const WAIT_MS = 10_000
/** Synced numbers are float32 on the wire; the same value in two tabs agrees within this. */
const EPS = 1e-4
/** How far a held key must move A (world units; 0.1 to 0.12 per move by team, about 20 moves/s). */
const MOVE_UNITS = 0.3
/** Short, fixed poll intervals so a held key is released soon after the goal is reached. */
const FAST_POLL = { intervals: [50], timeout: WAIT_MS }

async function snap(page: Page): Promise<BlacksiteSnapshot> {
  return page.evaluate(() => window.__blacksite.snapshot())
}

function find(s: BlacksiteSnapshot, id: string): BlacksitePlayerSnapshot | undefined {
  return s.players.find((p) => p.id === id)
}

function get(s: BlacksiteSnapshot, id: string): BlacksitePlayerSnapshot {
  const p = find(s, id)
  if (!p) throw new Error(`player ${id} missing from ${s.sessionId}'s snapshot`)
  return p
}

const same = (p: { x: number; z: number }, q: { x: number; z: number }) =>
  Math.abs(p.x - q.x) < EPS && Math.abs(p.z - q.z) < EPS

async function openPlayer(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  await page.goto('/')
  // Sanity check that the scene started (not a pixel check).
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  return page
}

/** Waits until the tab is connected and knows two players; returns its sessionId. */
async function joined(page: Page): Promise<string> {
  await expect
    .poll(
      async () => {
        const s = await snap(page)
        return s.connected && s.sessionId !== null && s.players.length === 2
      },
      { message: 'tab is connected and sees 2 players', timeout: WAIT_MS },
    )
    .toBe(true)
  return (await snap(page)).sessionId!
}

/**
 * Waits until both tabs agree on every player's position and nothing changed
 * since the previous poll (all moves sent so far have been applied and synced).
 * Returns both settled snapshots.
 */
async function settle(a: Page, b: Page, ids: string[]): Promise<{ a: BlacksiteSnapshot; b: BlacksiteSnapshot }> {
  let prev: BlacksiteSnapshot | null = null
  let last: { a: BlacksiteSnapshot; b: BlacksiteSnapshot } | null = null
  await expect
    .poll(
      async () => {
        const sa = await snap(a)
        const sb = await snap(b)
        const p = prev
        prev = sa
        last = { a: sa, b: sb }
        return ids.every((id) => {
          const pa = find(sa, id)
          const pb = find(sb, id)
          const pp = p && find(p, id)
          return !!pa && !!pb && !!pp && same(pa, pb) && same(pa, pp)
        })
      },
      { message: 'both tabs agree on every position and it is stable', intervals: [150], timeout: WAIT_MS },
    )
    .toBe(true)
  return last!
}

/**
 * The local player faces +z: its snapshot yaw is 0, or the field doesn't exist
 * yet. A checked precondition for "W is +z, D is +x".
 */
async function expectLocalFacingPlusZ(page: Page) {
  const s = await snap(page)
  const local = s.players.find((p) => p.isLocal)
  expect(local, `${s.sessionId} has a local player`).toBeDefined()
  const yaw = (local as { yaw?: unknown }).yaw
  expect(Math.abs(yawOf({ yaw })), `local player faces +z (yaw ${String(yaw)})`).toBeLessThan(EPS)
  if (yaw !== undefined) expect(typeof yaw, 'yaw is a number when present').toBe('number')
}

/**
 * Holds `key` in `page` until `done(snapshot of page)` holds, then releases it.
 * First checks that the local player faces +z, so the key's world direction is known.
 */
async function holdUntil(page: Page, key: string, what: string, done: (s: BlacksiteSnapshot) => boolean) {
  await expectLocalFacingPlusZ(page)
  await page.keyboard.down(key)
  try {
    await expect.poll(async () => done(await snap(page)), { message: what, ...FAST_POLL }).toBe(true)
  } finally {
    await page.keyboard.up(key)
  }
}

test('test hook: snapshot shape, one local player, and a copy per call', async ({ browser }) => {
  test.setTimeout(60_000)
  const a = await openPlayer(browser)
  const b = await openPlayer(browser)
  try {
    const idA = await joined(a)
    const idB = await joined(b)
    expect(idA).not.toBe(idB)

    for (const [page, own] of [
      [a, idA],
      [b, idB],
    ] as const) {
      const s = await snap(page)
      // Version-1 fields only: fields may be added in version 1 (#22 adds team
      // and yaw), so the shape is matched, not compared exactly.
      expect(s).toMatchObject({ version: 1, connected: true, sessionId: own })
      expect(s.version).toBe(1)
      for (const p of s.players) {
        expect(p).toMatchObject({
          id: expect.any(String),
          x: expect.any(Number),
          z: expect.any(Number),
          isLocal: expect.any(Boolean),
        })
      }
      // Both tabs know the same two players, sorted by id.
      expect(s.players.map((p) => p.id)).toEqual([idA, idB].sort())
      // Exactly one player is local, and it is this tab's sessionId.
      const local = s.players.filter((p) => p.isLocal)
      expect(local).toHaveLength(1)
      expect(local[0].id).toBe(own)
      for (const p of s.players) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.z), `finite position for ${p.id}`).toBe(true)
      }

      // snapshot() returns a fresh copy: changing one doesn't change the next.
      const untouched = await page.evaluate(() => {
        const first = window.__blacksite.snapshot()
        const before = JSON.stringify(first)
        first.connected = false
        first.sessionId = 'forged'
        first.players[0].x += 1000
        first.players[0].isLocal = !first.players[0].isLocal
        first.players.push({ id: 'ghost', x: 0, z: 0, isLocal: false })
        first.map.renderedSolids = 99
        const next = window.__blacksite.snapshot()
        return {
          sameObject: next === first,
          sharedPlayers: next.players === first.players,
          // Positions can change between the calls only if a state update
          // arrived; nobody pressed a key, so they don't.
          equal: JSON.stringify(next) === before,
        }
      })
      expect(untouched).toEqual({ sameObject: false, sharedPlayers: false, equal: true })

      // The hook itself can't be replaced by page scripts.
      const replaced = await page.evaluate(() => {
        try {
          ;(window as unknown as { __blacksite: unknown }).__blacksite = null
        } catch {
          // Throws in strict mode; ignored in sloppy mode. Either way it stays.
        }
        return typeof window.__blacksite?.snapshot === 'function'
      })
      expect(replaced).toBe(true)
    }
  } finally {
    await a.context().close()
    await b.context().close()
  }
})

test('two tabs share the room and each sees the other move', async ({ browser }) => {
  test.setTimeout(90_000)
  const a = await openPlayer(browser)
  const b = await openPlayer(browser)
  try {
    // Both tabs joined the same room and each knows both players.
    const idA = await joined(a)
    const idB = await joined(b)
    expect(idA).not.toBe(idB)
    const ids = [idA, idB]

    // Both tabs agree on both positions.
    const start = await settle(a, b, ids)
    for (const id of ids) {
      expect(same(get(start.a, id), get(start.b, id)), `${id} agrees across tabs`).toBe(true)
    }
    const b0 = get(start.b, idB)

    // Hold D in tab A: A's x rises.
    const a0 = get(start.a, idA)
    await holdUntil(a, 'KeyD', "A's x rises in tab A", (s) => get(s, idA).x > a0.x + MOVE_UNITS)
    const afterD = await settle(a, b, ids)
    for (const s of [afterD.a, afterD.b]) {
      expect(get(s, idA).x, `A's x rose in ${s.sessionId === idA ? 'tab A' : 'tab B'}`).toBeGreaterThan(
        a0.x + MOVE_UNITS,
      )
    }

    // Hold W in tab A: A's z rises.
    const a1 = get(afterD.a, idA)
    await holdUntil(a, 'KeyW', "A's z rises in tab A", (s) => get(s, idA).z > a1.z + MOVE_UNITS)
    const afterW = await settle(a, b, ids)
    for (const s of [afterW.a, afterW.b]) {
      expect(get(s, idA).z, `A's z rose in ${s.sessionId === idA ? 'tab A' : 'tab B'}`).toBeGreaterThan(
        a1.z + MOVE_UNITS,
      )
    }

    // settle() checked that both tabs agree on both positions. B never
    // pressed a key: it has not moved in either tab.
    for (const s of [afterD.a, afterD.b, afterW.a, afterW.b]) {
      expect(same(get(s, idB), b0), `B did not move (seen by ${s.sessionId})`).toBe(true)
    }

    // Still exactly two players in each tab.
    for (const s of [afterW.a, afterW.b]) {
      expect(s.connected).toBe(true)
      expect(s.players).toHaveLength(2)
    }
  } finally {
    await a.context().close()
    await b.context().close()
  }
})

test('closing a tab drops the other tab to 1 player', async ({ browser }) => {
  test.setTimeout(60_000)
  const a = await openPlayer(browser)
  const b = await openPlayer(browser)
  try {
    const idA = await joined(a)
    const idB = await joined(b)
    await a.context().close()
    await expect
      .poll(
        async () => {
          const s = await snap(b)
          return s.players.map((p) => p.id).join(',')
        },
        { message: 'tab B sees only itself', timeout: WAIT_MS },
      )
      .toBe(idB)
    expect(find(await snap(b), idA)).toBeUndefined()
  } finally {
    await a.context().close().catch(() => {})
    await b.context().close()
  }
})
