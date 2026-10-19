import { expect, test, type Browser, type Page } from '@playwright/test'
import { Client } from '@colyseus/sdk'
import { MOVE_MESSAGE, ROOM_NAME } from '../../shared/protocol.js'
import type { BlacksitePlayerSnapshot, BlacksiteSnapshot } from '../../shared/testhook.js'
import { endpoint, leaveQuietly, pos, waitForState, type GameRoom } from './support/sdk.js'
import { angleDiff } from './support/intent.js'
import { expectOnGround, expectTeamsAndYaws } from './support/hook.js'
import { guaranteedPlayers, type Makeup } from './support/tabs.js'

// #23: a player that turns with a yaw-only move is seen with the new yaw by
// the browser clients, and every tab's team and yaw match what the server
// synced. Until #24 the client never sends a yaw itself, so the turning
// player is a Node @colyseus/sdk client that joins the browser tabs' room.
//
// Since #45 this holds with the M5 visibility filter (#46): the Warden tab is
// not sent a Ghost it can't see, so the Ghost's turns are checked in the Ghost
// tab and the SDK Warden's turns in both tabs.
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

/** Room as the specs set it up. */
const ROOM_1V1: Makeup = { ghosts: 1, wardens: 1 }

/**
 * Waits until the tab is connected, knows its team and holds the players it must
 * hold in a room of `m` (a Ghost tab all of them, a Warden tab at least its
 * Wardens: the M5 filter may hide Ghosts from it, #45), each with a team.
 */
async function seesPlayers(page: Page, m: Makeup): Promise<BlacksiteSnapshot> {
  await expect
    .poll(
      async () => {
        const s = await snap(page)
        if (!(s.connected && s.localTeam !== null)) return false
        const need = guaranteedPlayers(s.localTeam, m)
        return (s.localTeam === 'ghost' ? s.players.length === need : s.players.length >= need) && s.players.every((p) => p.team !== null)
      },
      { message: `tab holds the players it must hold (${m.ghosts} ghosts, ${m.wardens} wardens), each with a team`, timeout: WAIT_MS },
    )
    .toBe(true)
  return snap(page)
}

test('a yaw-only move from another client is seen in the tabs that are sent it, and every team and yaw matches the server', async ({ browser }) => {
  test.setTimeout(90_000)
  const a = await openPlayer(browser)
  const b = await openPlayer(browser)
  let ghostSdk: GameRoom | undefined
  let wardenSdk: GameRoom | undefined
  try {
    const idA = (await seesPlayers(a, ROOM_1V1)).sessionId!
    const idB = (await seesPlayers(b, ROOM_1V1)).sessionId!

    // Two more clients join the same room through the SDK: a Ghost (a tie goes
    // to ghost) and then a Warden. Tab A (a Ghost) is sent all four; tab B (a
    // Warden) itself and the SDK Warden, but a Ghost only when it can see it.
    ghostSdk = (await new Client(endpoint).joinOrCreate(ROOM_NAME)) as GameRoom
    const sdk = ghostSdk
    const idC = sdk.sessionId
    await waitForState(sdk, 'the SDK ghost sees the two tabs and itself', (s) =>
      [idA, idB, idC].every((id) => s.players?.has(id)) && s.players.size === 3,
    )
    wardenSdk = (await new Client(endpoint).joinOrCreate(ROOM_NAME)) as GameRoom
    const wsdk = wardenSdk
    const idD = wsdk.sessionId
    await waitForState(sdk, 'the SDK ghost sees all four', (s) => [idA, idB, idC, idD].every((id) => s.players?.has(id)) && s.players.size === 4)
    await waitForState(wsdk, 'the SDK warden sees the tab warden and itself', (s) => [idB, idD].every((id) => s.players?.has(id)))
    const ROOM_OF_FOUR: Makeup = { ghosts: 2, wardens: 2 }
    const sa = await seesPlayers(a, ROOM_OF_FOUR)
    const sb = await seesPlayers(b, ROOM_OF_FOUR)

    // Every player a tab holds has the team and yaw the server synced (as the
    // SDK ghost, which is sent everyone, received them), and a tab holds the
    // players it must.
    const team = (id: string) => pos(sdk, id).team
    expect(sa.players.map((p) => p.id).sort(), 'tab A (a Ghost) holds all four').toEqual([idA, idB, idC, idD].sort())
    for (const id of [idB, idD]) expect(find(sb, id), `tab B (a Warden) holds ${id}`).toBeDefined()
    for (const s of [sa, sb]) {
      expectTeamsAndYaws(s)
      expectOnGround(s)
      for (const seen of s.players) {
        const server = pos(sdk, seen.id)
        expect(seen.team, `${s.sessionId} sees ${seen.id}'s team as the server set it`).toBe(server.team)
        expect(angleDiff(seen.yaw, server.yaw), `${s.sessionId} sees ${seen.id}'s yaw as the server set it`).toBeLessThan(EPS)
      }
    }
    expect(sa.localTeam).toBe(team(idA))
    expect(sb.localTeam).toBe(team(idB))
    // Balanced on join: the tabs are one of each team, the third joiner (a tie)
    // is a ghost and the fourth a warden.
    expect([team(idA), team(idB)].sort()).toEqual(['ghost', 'warden'])
    expect(team(idC), '3rd joiner of a 1v1 is a ghost').toBe('ghost')
    expect(team(idD), '4th joiner of a 2v1 is a warden').toBe('warden')
    expect(Math.abs(pos(sdk, idC).yaw), 'the SDK ghost spawned facing +z').toBeLessThan(EPS)
    expect(Math.abs(pos(sdk, idD).yaw), 'the SDK warden spawned facing +z').toBeLessThan(EPS)

    // Yaw-only turns. pi may arrive as -pi, 3pi/2 as -pi/2 (the server wraps),
    // so yaws are compared modulo 2 pi. The SDK Ghost is seen by tab A only
    // (tab B is not required to see a Ghost); the SDK Warden by both tabs.
    const subjects = [
      { client: sdk, id: idC, tabs: [[a, 'tab A']] as const, team: 'ghost' },
      { client: wsdk, id: idD, tabs: [[a, 'tab A'], [b, 'tab B']] as const, team: 'warden' },
    ]
    const turns = [Math.PI / 2, -2.5, Math.PI, (3 * Math.PI) / 2, 1.234, 0]
    for (const subject of subjects) {
      const start = pos(subject.client, subject.id)
      let last = 0
      for (const yaw of turns) {
        const wait = last + PACE_MS - Date.now()
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        last = Date.now()
        subject.client.send(MOVE_MESSAGE, { dx: 0, dz: 0, yaw })
        await waitForState(subject.client, `the server turns the SDK ${subject.team} to ${yaw}`, () => angleDiff(pos(subject.client, subject.id).yaw, yaw) < EPS)
        const server = pos(subject.client, subject.id)
        expect(Math.abs(server.x - start.x) + Math.abs(server.z - start.z), `turning to ${yaw} did not move`).toBeLessThan(EPS)

        for (const [page, name] of subject.tabs) {
          await expect
            .poll(
              async () => {
                const p = find(await snap(page), subject.id)
                return !!p && angleDiff(p.yaw, yaw) < EPS && angleDiff(p.yaw, server.yaw) < EPS
              },
              { message: `${name} sees the SDK ${subject.team} turn to ${yaw}`, timeout: WAIT_MS },
            )
            .toBe(true)
          const s = await snap(page)
          expectTeamsAndYaws(s)
          expectOnGround(s)
          const p = find(s, subject.id)!
          expect(Math.abs(p.x - start.x) + Math.abs(p.z - start.z), `${name}: the turn did not move it`).toBeLessThan(EPS)
          expect(p.team, `${name}: turning keeps the team`).toBe(subject.team)
          // The tabs' own players did not turn (a tab holds the ones it holds).
          for (const id of [idA, idB]) {
            const q = find(s, id)
            if (q) expect(angleDiff(q.yaw, 0), `${name}: ${id} still faces +z`).toBeLessThan(EPS)
          }
        }
      }
    }
  } finally {
    if (ghostSdk) await leaveQuietly(ghostSdk)
    if (wardenSdk) await leaveQuietly(wardenSdk)
    await a.context().close()
    await b.context().close()
  }
})
