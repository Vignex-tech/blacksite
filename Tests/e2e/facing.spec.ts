import { expect, test, type Browser, type Page } from '@playwright/test'
import { Client } from '@colyseus/sdk'
import { MOVE_MESSAGE, ROOM_NAME } from '../../shared/protocol.js'
import type { BlacksitePlayerSnapshot, BlacksiteSnapshot } from '../../shared/testhook.js'
import { endpoint, pos, waitForState, type GameRoom } from './support/sdk.js'
import { angleDiff } from './support/intent.js'
import { expectOnGround, expectTeamsAndYaws } from './support/hook.js'

// #23: a player that turns with a yaw-only move is seen with the new yaw by
// the browser clients, and every tab's team and yaw match what the server
// synced. Until #24 the client never sends a yaw itself, so the turning
// player is a Node @colyseus/sdk client that joins the browser tabs' room.
//
// Room: browser pages joinOrCreate the one shared `my_room` (single worker,
// playwright.config.ts). The SDK client joinOrCreates it too, after both tabs
// are in, and the test fails unless both tabs see it, so it can't have landed
// in some other room. It leaves before the tabs close, so no later spec sees it.

const VIEWPORT = { width: 800, height: 600 }
const WAIT_MS = 10_000
/** float32 on the wire. */
const EPS = 1e-4
/** Gap between two moves from the SDK client, so the rate limit never drops one (1000 / MOVE_RATE_HZ is 50). */
const PACE_MS = 120

async function snap(page: Page): Promise<BlacksiteSnapshot> {
  return page.evaluate(() => window.__blacksite.snapshot())
}

function find(s: BlacksiteSnapshot, id: string): BlacksitePlayerSnapshot | undefined {
  return s.players.find((p) => p.id === id)
}

async function openPlayer(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  return page
}

async function seesPlayers(page: Page, n: number): Promise<BlacksiteSnapshot> {
  await expect
    .poll(
      async () => {
        const s = await snap(page)
        return s.connected && s.players.length === n && s.players.every((p) => p.team !== null)
      },
      { message: `tab sees ${n} players, each with a team`, timeout: WAIT_MS },
    )
    .toBe(true)
  return snap(page)
}

test('a yaw-only move from another client is seen in both tabs, and every team and yaw matches the server', async ({ browser }) => {
  test.setTimeout(90_000)
  const a = await openPlayer(browser)
  const b = await openPlayer(browser)
  let room: GameRoom | undefined
  try {
    const idA = (await seesPlayers(a, 2)).sessionId!
    const idB = (await seesPlayers(b, 2)).sessionId!

    // A third client joins the same room through the SDK.
    room = (await new Client(endpoint).joinOrCreate(ROOM_NAME)) as GameRoom
    const sdk = room
    const idC = sdk.sessionId
    await waitForState(sdk, 'the SDK client sees the two tabs and itself', (s) =>
      [idA, idB, idC].every((id) => s.players?.has(id)) && s.players.size === 3,
    )
    const sa = await seesPlayers(a, 3)
    const sb = await seesPlayers(b, 3)

    // Every tab's team and yaw for every player match the server's synced
    // state (as the SDK client received it), and both tabs agree.
    for (const s of [sa, sb]) {
      expectTeamsAndYaws(s)
      expectOnGround(s)
      for (const id of [idA, idB, idC]) {
        const server = pos(sdk, id)
        const seen = find(s, id)!
        expect(seen, `${s.sessionId} sees ${id}`).toBeDefined()
        expect(seen.team, `${s.sessionId} sees ${id}'s team as the server set it`).toBe(server.team)
        expect(angleDiff(seen.yaw, server.yaw), `${s.sessionId} sees ${id}'s yaw as the server set it`).toBeLessThan(EPS)
      }
    }
    expect(sa.localTeam).toBe(pos(sdk, idA).team)
    expect(sb.localTeam).toBe(pos(sdk, idB).team)
    // Balanced on join: the tabs are one of each team, and the third joiner
    // (a tie) is a ghost.
    expect([pos(sdk, idA).team, pos(sdk, idB).team].sort()).toEqual(['ghost', 'warden'])
    expect(pos(sdk, idC).team, '3rd joiner of a 1v1 is a ghost').toBe('ghost')
    expect(Math.abs(pos(sdk, idC).yaw), 'the SDK client spawned facing +z').toBeLessThan(EPS)

    // Yaw-only turns. pi may arrive as -pi, 3pi/2 as -pi/2 (the server wraps),
    // so yaws are compared modulo 2 pi.
    const start = pos(sdk, idC)
    const turns = [Math.PI / 2, -2.5, Math.PI, (3 * Math.PI) / 2, 1.234, 0]
    let last = 0
    for (const yaw of turns) {
      const wait = last + PACE_MS - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      last = Date.now()
      sdk.send(MOVE_MESSAGE, { dx: 0, dz: 0, yaw })
      await waitForState(sdk, `the server turns the SDK player to ${yaw}`, () => angleDiff(pos(sdk, idC).yaw, yaw) < EPS)
      const server = pos(sdk, idC)
      expect(Math.abs(server.x - start.x) + Math.abs(server.z - start.z), `turning to ${yaw} did not move`).toBeLessThan(EPS)

      for (const [page, name] of [
        [a, 'tab A'],
        [b, 'tab B'],
      ] as const) {
        await expect
          .poll(
            async () => {
              const p = find(await snap(page), idC)
              return !!p && angleDiff(p.yaw, yaw) < EPS && angleDiff(p.yaw, server.yaw) < EPS
            },
            { message: `${name} sees the SDK player turn to ${yaw}`, timeout: WAIT_MS },
          )
          .toBe(true)
        const s = await snap(page)
        expectTeamsAndYaws(s)
        expectOnGround(s)
        const p = find(s, idC)!
        expect(Math.abs(p.x - start.x) + Math.abs(p.z - start.z), `${name}: the turn did not move it`).toBeLessThan(EPS)
        expect(p.team, `${name}: turning keeps the team`).toBe('ghost')
        // The tabs' own players did not turn.
        for (const id of [idA, idB]) {
          expect(angleDiff(find(s, id)!.yaw, 0), `${name}: ${id} still faces +z`).toBeLessThan(EPS)
        }
      }
    }
  } finally {
    await room?.leave().catch(() => {})
    await a.context().close()
    await b.context().close()
  }
})
