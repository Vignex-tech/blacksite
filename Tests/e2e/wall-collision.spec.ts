import { expect, test, type Browser, type Page } from '@playwright/test'
import type { BlacksitePlayerSnapshot, BlacksiteSnapshot } from '../../shared/testhook.js'
import { BOUND } from '../../server/build/rooms/MyRoom.js'
import { overlapping, stopAlongZ } from './support/geometry.js'
import { yawOf } from './support/intent.js'

// #15: in the browser, holding a key toward a wall stops the local player
// flush with the wall, as seen in both tabs. State is read only through
// `window.__blacksite.snapshot()`. The server alone collides (the client never
// blocks movement locally), so this checks the real game end to end.
//
// Where the wall is depends on where the server spawned the player, so the
// expected stop is computed from shared/map.js (support/geometry.ts) for the
// player's actual spawn point rather than assumed from join order.
//
// Camera-relative movement (#18): W is +z only while the local player faces
// +z (yaw 0). This test never moves the mouse or clicks the canvas, and checks
// the snapshot's yaw is 0 (when the field exists) before pressing W. The stop
// position doesn't depend on the team's speed.

const VIEWPORT = { width: 800, height: 600 }
/** Upper bound for short waits. A failure, never a delay. */
const WAIT_MS = 10_000
/** Upper bound for the walk to the wall (at most about 14 units at 2 units/s from a spawn). */
const WALK_MS = 20_000
const EPS = 1e-4
/** Polls of the held key after reaching the wall during which the player must not move. */
const HOLD_POLLS = 10

async function snap(page: Page): Promise<BlacksiteSnapshot> {
  return page.evaluate(() => window.__blacksite.snapshot())
}

function get(s: BlacksiteSnapshot, id: string): BlacksitePlayerSnapshot {
  const p = s.players.find((v) => v.id === id)
  if (!p) throw new Error(`player ${id} missing from ${s.sessionId}'s snapshot`)
  return p
}

async function openPlayer(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  return page
}

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

test('holding W toward a wall stops the local player at the wall face, as seen in both tabs', async ({ browser }) => {
  test.setTimeout(90_000)
  const a = await openPlayer(browser)
  const b = await openPlayer(browser)
  try {
    const idA = await joined(a)
    await joined(b)

    const start = get(await snap(a), idA)
    expect(overlapping(start).map((s) => s.id), 'A spawned clear of solids').toEqual([])
    // W is +z. The first solid face north of A's spawn (every spawn area has
    // one: the building's south wall or cover for ghosts, its north wall for
    // wardens), with A's centre half a box short of it.
    const face = stopAlongZ(start, 1, BOUND)
    expect(face, 'a solid, not the outer bound, is north of the spawn').toBeLessThan(BOUND - 1)

    const seen: string[] = []
    const watch = (s: BlacksiteSnapshot) => {
      for (const p of s.players) {
        const hit = overlapping(p)
        if (hit.length) seen.push(`${s.sessionId} saw ${p.id} at ${p.x},${p.z} overlap ${hit.map((h) => h.id).join(',')}`)
      }
    }

    // Precondition for "W is +z": A faces +z (yaw 0, or no yaw field yet).
    const yaw = (start as { yaw?: unknown }).yaw
    if (yaw !== undefined) expect(typeof yaw, 'yaw is a number when present').toBe('number')
    expect(Math.abs(yawOf({ yaw })), `A faces +z (yaw ${String(yaw)})`).toBeLessThan(EPS)

    await a.keyboard.down('KeyW')
    try {
      await expect
        .poll(
          async () => {
            const s = await snap(a)
            watch(s)
            return Math.abs(get(s, idA).z - face) < EPS
          },
          { message: `A reaches the wall face at z ${face}`, intervals: [50], timeout: WALK_MS },
        )
        .toBe(true)
      // Still holding W: A stays flush with the face and x never changes.
      for (let i = 0; i < HOLD_POLLS; i++) {
        await a.waitForTimeout(50)
        const s = await snap(a)
        watch(s)
        const p = get(s, idA)
        expect(Math.abs(p.z - face), `A stays at the face while W is held (z ${p.z})`).toBeLessThan(EPS)
        expect(Math.abs(p.x - start.x)).toBeLessThan(EPS)
      }
    } finally {
      await a.keyboard.up('KeyW')
    }

    // Tab B sees A at the same place, flush with the wall.
    await expect
      .poll(
        async () => {
          const s = await snap(b)
          watch(s)
          const p = get(s, idA)
          return Math.abs(p.z - face) < EPS && Math.abs(p.x - start.x) < EPS
        },
        { message: 'tab B sees A flush with the wall', timeout: WAIT_MS },
      )
      .toBe(true)
    expect(seen, 'no tab ever saw a player overlap a solid').toEqual([])
  } finally {
    await a.context().close()
    await b.context().close()
  }
})
