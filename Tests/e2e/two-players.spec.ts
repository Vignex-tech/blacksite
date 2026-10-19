import { expect, test, type Browser, type Page } from '@playwright/test'
import type { BlacksitePlayerSnapshot, BlacksiteSnapshot } from '../../shared/testhook.js'
import { angleDiff } from './support/intent.js'
import { expectOnGround, expectTeamsAndYaws } from './support/hook.js'
import { Observer } from './support/observer.js'
import { guaranteedPlayers, type Makeup } from './support/tabs.js'

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
// that the snapshot's yaw is 0.
//
// Teams and facing (#22, verified in #23): every snapshot must carry `team`,
// `yaw` and `localTeam`; both tabs agree on them; the first tab in a fresh
// room is a Ghost and the second a Warden; the HUD names the tab's own team.
// A yaw sent by another client is covered in facing.spec.ts.
//
// Since #45 these specs hold with the M5 visibility filter (#46): tab A (the
// Ghost) is sent every player, tab B (the Warden) itself and any Ghost it is
// near or can see, so tab B is never required to see A. "Another client sees A
// move" is checked by an SDK Ghost observer (support/observer.ts, the third
// joiner) next to tab A; tab B is checked for what it must hold (itself).
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
  await page.goto('/?gfx=low')
  // Sanity check that the scene started (not a pixel check).
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  return page
}

/** The room as the tests set it up: tab A (ghost) and tab B (warden); with the observer, a second ghost. */
const ROOM_1V1: Makeup = { ghosts: 1, wardens: 1 }
const ROOM_WITH_OBSERVER: Makeup = { ghosts: 2, wardens: 1 }

/**
 * Waits until the tab is connected, knows its team and sees the players it must
 * see in a room of `m` (a Ghost tab: all of them; a Warden tab: at least its
 * Wardens). Returns its sessionId.
 */
async function joined(page: Page, m: Makeup = ROOM_1V1): Promise<string> {
  await expect
    .poll(
      async () => {
        const s = await snap(page)
        if (!(s.connected && s.sessionId !== null && s.localTeam !== null)) return false
        const need = guaranteedPlayers(s.localTeam, m)
        return s.localTeam === 'ghost' ? s.players.length === need : s.players.length >= need
      },
      { message: `tab is connected and sees the players it must see (${m.ghosts} ghosts, ${m.wardens} wardens)`, timeout: WAIT_MS },
    )
    .toBe(true)
  return (await snap(page)).sessionId!
}

/** Every player the observer (an SDK Ghost, sent everyone) holds, with x and z. */
function observed(o: Observer): Record<string, { x: number; z: number }> {
  const out: Record<string, { x: number; z: number }> = {}
  o.room.state.players.forEach((p, id: string) => {
    out[id] = { x: (p as unknown as { x: number }).x, z: (p as unknown as { z: number }).z }
  })
  return out
}

/**
 * Waits until tab A, tab B and the observer agree on every player's position
 * wherever they hold it, and nothing changed since the previous poll (all moves
 * sent so far have been applied and synced). Tab A (a Ghost) and the observer
 * must hold every id; tab B (a Warden) must hold `idB` (itself) and may not
 * hold the Ghost. Returns both tabs' settled snapshots.
 */
async function settle(a: Page, b: Page, o: Observer, ids: string[], idB: string): Promise<{ a: BlacksiteSnapshot; b: BlacksiteSnapshot }> {
  let prev: BlacksiteSnapshot | null = null
  let last: { a: BlacksiteSnapshot; b: BlacksiteSnapshot } | null = null
  await expect
    .poll(
      async () => {
        const sa = await snap(a)
        const sb = await snap(b)
        const so = observed(o)
        const p = prev
        prev = sa
        last = { a: sa, b: sb }
        return ids.every((id) => {
          const pa = find(sa, id)
          const pb = find(sb, id)
          const po = so[id]
          const pp = p && find(p, id)
          if (id === idB && !pb) return false
          return !!pa && !!po && !!pp && same(pa, po) && same(pa, pp) && (!pb || same(pa, pb))
        })
      },
      { message: 'all views agree on every position and it is stable', intervals: [150], timeout: WAIT_MS },
    )
    .toBe(true)
  return last!
}

/**
 * The local player faces +z: its snapshot yaw is 0 (and every player has a
 * team and a yaw). A checked precondition for "W is +z, D is +x".
 */
async function expectLocalFacingPlusZ(page: Page) {
  const s = await snap(page)
  expectTeamsAndYaws(s)
  expectOnGround(s)
  const local = s.players.find((p) => p.isLocal)!
  expect(angleDiff(local.yaw, 0), `local player faces +z (yaw ${local.yaw})`).toBeLessThan(EPS)
}

/** Waits until the tab is connected and sees only its own player; returns that snapshot. */
async function alone(page: Page): Promise<BlacksiteSnapshot> {
  await expect
    .poll(
      async () => {
        const s = await snap(page)
        return s.connected && s.players.length === 1 && s.players[0].isLocal && s.localTeam !== null
      },
      { message: 'tab is connected, alone in the room, with a team', timeout: WAIT_MS },
    )
    .toBe(true)
  return snap(page)
}

const HUD_TEAM = { ghost: 'a Ghost', warden: 'a Warden' } as const

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
  let b: Page | undefined
  try {
    // A is alone in a fresh room: the server makes it a Ghost (ties go to ghost).
    const first = await alone(a)
    expectTeamsAndYaws(first)
    expect(first.localTeam, '1st joiner in a fresh room is a ghost').toBe('ghost')
    await expect(a.locator('#hud')).toHaveText(/online, 1 player, you are a Ghost$/, { timeout: WAIT_MS })
    b = await openPlayer(browser)
    const idA = await joined(a)
    const idB = await joined(b)
    expect(idA).not.toBe(idB)

    // Teams and facing: both tabs agree on every player's team and yaw, A is
    // the ghost and B the warden, everyone spawned facing +z, and localTeam is
    // the tab's own team.
    const wantTeam: Record<string, string> = { [idA]: 'ghost', [idB]: 'warden' }
    const sa = await snap(a)
    const sb = await snap(b)
    for (const s of [sa, sb]) {
      expectTeamsAndYaws(s)
      for (const p of s.players) {
        expect(p.team, `${s.sessionId} sees ${p.id} as ${wantTeam[p.id]}`).toBe(wantTeam[p.id])
        expect(angleDiff(p.yaw, 0), `${s.sessionId} sees ${p.id} facing +z (yaw ${p.yaw})`).toBeLessThan(EPS)
      }
    }
    expect(sa.localTeam).toBe('ghost')
    expect(sb.localTeam).toBe('warden')
    // Tab A (a Ghost) holds both players; tab B (a Warden) holds itself and may not hold the Ghost.
    expect(sa.players.map((p) => p.id)).toEqual([idA, idB].sort())
    expect(find(sb, idB), 'tab B holds itself').toBeDefined()
    for (const p of sa.players) {
      const q = find(sb, p.id)
      if (!q) continue
      expect(q.team, `both tabs agree on ${p.id}'s team`).toBe(p.team)
      expect(angleDiff(q.yaw, p.yaw), `both tabs agree on ${p.id}'s yaw`).toBeLessThan(EPS)
    }

    // The HUD names each tab's own team.
    await expect(a.locator('#hud')).toHaveText(/online, 2 players, you are a Ghost$/, { timeout: WAIT_MS })
    // The Warden's count is 1 (itself) or 2 (it also sees the Ghost): the filter decides.
    await expect(b.locator('#hud')).toHaveText(/online, [12] players?, you are a Warden$/, { timeout: WAIT_MS })
    for (const [page, s] of [
      [a, sa],
      [b, sb],
    ] as const) {
      await expect(page.locator('#hud')).toContainText(`you are ${HUD_TEAM[s.localTeam!]}`)
    }

    for (const [page, own] of [
      [a, idA],
      [b, idB],
    ] as const) {
      const s = await snap(page)
      // Version-1 fields: fields may be added in version 1, so the shape is
      // matched, not compared exactly. team, yaw and localTeam (#22) are required.
      expect(s).toMatchObject({ version: 1, connected: true, sessionId: own, localTeam: expect.any(String) })
      expect(s.version).toBe(1)
      for (const p of s.players) {
        expect(p).toMatchObject({
          id: expect.any(String),
          x: expect.any(Number),
          z: expect.any(Number),
          isLocal: expect.any(Boolean),
          team: expect.any(String),
          yaw: expect.any(Number),
        })
      }
      // The Ghost tab knows both players, sorted by id; the Warden tab itself and maybe the Ghost.
      if (own === idA) expect(s.players.map((p) => p.id)).toEqual([idA, idB].sort())
      else {
        expect(s.players.map((p) => p.id)).toContain(idB)
        for (const p of s.players) expect([idA, idB]).toContain(p.id)
      }
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
        first.players[0].team = first.players[0].team === 'ghost' ? 'warden' : 'ghost'
        first.players[0].yaw += 1
        first.localTeam = first.localTeam === 'ghost' ? 'warden' : 'ghost'
        first.players.push({ id: 'forged', x: 0, z: 0, isLocal: false, team: 'ghost', yaw: 1 })
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
    await b?.context().close()
  }
})

test('two tabs share the room and the other clients see A move', async ({ browser }) => {
  test.setTimeout(90_000)
  const a = await openPlayer(browser)
  const b = await openPlayer(browser)
  let observer: Observer | undefined
  try {
    // Both tabs joined the same room; tab A holds both players, tab B itself.
    const idA = await joined(a)
    const idB = await joined(b)
    expect(idA).not.toBe(idB)
    // The observer (an SDK Ghost, sent every player) is the third joiner: the "other client" that sees A.
    observer = await Observer.join()
    await observer.waitForPlayers(3)
    await joined(a, ROOM_WITH_OBSERVER)
    await joined(b, ROOM_WITH_OBSERVER)
    const ids = [idA, idB]
    expect(Object.keys(observed(observer)).sort()).toEqual([idA, idB, observer.id].sort())

    // The views agree on both positions.
    const start = await settle(a, b, observer, ids, idB)
    const b0 = get(start.b, idB)

    // Hold D in tab A: A's x rises in tab A and as the observer sees it.
    const a0 = get(start.a, idA)
    await holdUntil(a, 'KeyD', "A's x rises in tab A", (s) => get(s, idA).x > a0.x + MOVE_UNITS)
    const afterD = await settle(a, b, observer, ids, idB)
    expect(get(afterD.a, idA).x, "A's x rose in tab A").toBeGreaterThan(a0.x + MOVE_UNITS)
    expect(observed(observer)[idA].x, "A's x rose as the observer sees it").toBeGreaterThan(a0.x + MOVE_UNITS)

    // Hold W in tab A: A's z rises.
    const a1 = get(afterD.a, idA)
    await holdUntil(a, 'KeyW', "A's z rises in tab A", (s) => get(s, idA).z > a1.z + MOVE_UNITS)
    const afterW = await settle(a, b, observer, ids, idB)
    expect(get(afterW.a, idA).z, "A's z rose in tab A").toBeGreaterThan(a1.z + MOVE_UNITS)
    expect(observed(observer)[idA].z, "A's z rose as the observer sees it").toBeGreaterThan(a1.z + MOVE_UNITS)

    // settle() checked that the views agree. B never pressed a key: it has
    // not moved in any view.
    for (const s of [afterD.a, afterD.b, afterW.a, afterW.b]) {
      expect(same(get(s, idB), b0), `B did not move (seen by ${s.sessionId})`).toBe(true)
    }
    expect(same(observed(observer)[idB], b0), 'B did not move (seen by the observer)').toBe(true)

    // All players on the ground and clear of ramps, pockets and climb spots
    // after A's short walk (#28).
    for (const s of [afterD.a, afterD.b, afterW.a, afterW.b]) expectOnGround(s)
    expect(afterW.a.connected).toBe(true)
    expect(afterW.a.players, 'tab A holds A, B and the observer').toHaveLength(3)
    expect(afterW.b.connected).toBe(true)
    expect(find(afterW.b, idB), 'tab B holds itself').toBeDefined()
  } finally {
    await observer?.leave()
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
    // Tab A (a Ghost) holds both players, so it is the tab that can watch B leave
    // (tab B, a Warden, may never have been sent A).
    expect(find(await snap(a), idB), 'tab A holds B before it leaves').toBeDefined()
    await b.context().close()
    await expect
      .poll(
        async () => {
          const s = await snap(a)
          return s.players.map((p) => p.id).join(',')
        },
        { message: 'tab A sees only itself', timeout: WAIT_MS },
      )
      .toBe(idA)
    expect(find(await snap(a), idB)).toBeUndefined()
  } finally {
    await a.context().close().catch(() => {})
    await b.context().close().catch(() => {})
  }
})
