import { expect, test, type Browser, type Page } from '@playwright/test'
import type { BlacksitePlayerSnapshot, BlacksiteSnapshot } from '../../shared/testhook.js'
import { BOUND } from '../../server/build/rooms/MyRoom.js'
import { PLAYER_HALF_SIZE, groundProblems, overlapping, solid, stopAlongZ } from './support/geometry.js'
import { TEAM_SPEED } from '../../shared/protocol.js'
import { stepFor } from './support/movement.js'
import { analyse, expectGroundRoute, expectNoOverlap, pathClear, track } from './support/legs.js'
import {
  closeTabs,
  turnTo,
  joined as joinedTab,
  local,
  lockPointer,
  openTab,
  pageNow,
  startSampler,
  guaranteedPlayers,
  type Tab,
} from './support/tabs.js'
import { angleDiff } from './support/intent.js'
import { expectTeamsAndYaws } from './support/hook.js'
import { Observer } from './support/observer.js'

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
// the snapshot's yaw is 0 before pressing W. The stop position doesn't depend
// on the team's speed. Since #22 (verified in #23) every snapshot must carry
// team, yaw and localTeam, and both tabs agree on A's team.
//
// Since #45 these hold with the M5 visibility filter (#46): tab B (a Warden)
// is not sent the Ghost unless it can see it, so "another client sees A flush
// with the wall" is checked by an SDK Ghost observer (support/observer.ts, the
// third joiner), which is sent every player. Tab B still runs the overlap watch
// on whatever it holds.

const VIEWPORT = { width: 800, height: 600 }
/** Upper bound for short waits. A failure, never a delay. */
const WAIT_MS = 10_000
/** Upper bound for the walk to the wall (at most about 14 units at 2 units/s from a spawn). */
const WALK_MS = 20_000
const EPS = 1e-4
/** Polls of the held key after reaching the wall during which the player must not move. */
const HOLD_POLLS = 10
/** How long the rotated test keeps W held after reaching the wall (ms). */
const SLIDE_MS = 600

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
  await page.goto('/?gfx=low')
  await expect(page.locator('#game-canvas')).toHaveAttribute('data-engine', /^Babylon\.js/)
  return page
}

async function joined(page: Page): Promise<string> {
  await expect
    .poll(
      async () => {
        const s = await snap(page)
        if (!(s.connected && s.sessionId !== null && s.localTeam !== null)) return false
        // A Ghost tab holds both players, a Warden tab at least itself (it may not be sent the Ghost).
        return s.players.length >= guaranteedPlayers(s.localTeam, { ghosts: 1, wardens: 1 })
      },
      { message: 'tab is connected and holds the players it must see', timeout: WAIT_MS },
    )
    .toBe(true)
  return (await snap(page)).sessionId!
}

test('holding W toward a wall stops the local player at the wall face, as seen by the other clients', async ({ browser }) => {
  test.setTimeout(90_000)
  const a = await openPlayer(browser)
  const b = await openPlayer(browser)
  let observer: Observer | undefined
  try {
    const idA = await joined(a)
    await joined(b)
    // The observer, an SDK Ghost (the third joiner), is the "other client" that sees A.
    observer = await Observer.join()
    await observer.waitForPlayers(3)

    const sa = await snap(a)
    const sb = await snap(b)
    expectTeamsAndYaws(sa)
    expectTeamsAndYaws(sb)
    const start = get(sa, idA)
    expect(observer.at(idA)?.team, "the observer agrees on A's team").toBe(start.team)
    expect(sa.localTeam).toBe(start.team)
    expect(overlapping(start).map((s) => s.id), 'A spawned clear of solids').toEqual([])
    // W is +z. The first solid face north of A's spawn (every spawn area has
    // one: the building's south wall or cover for ghosts, its north wall for
    // wardens), with A's centre half a box short of it. stopAlongZ fails if
    // the path meets a ramp, a covered pocket or a climb spot (#28).
    const face = stopAlongZ(start, 1, BOUND)
    expect(face, 'a solid, not the outer bound, is north of the spawn').toBeLessThan(BOUND - 1)

    const seen: string[] = []
    const watch = (s: BlacksiteSnapshot) => {
      for (const p of s.players) {
        const hit = overlapping(p)
        if (hit.length) seen.push(`${s.sessionId} saw ${p.id} at ${p.x},${p.z} overlap ${hit.map((h) => h.id).join(',')}`)
        for (const g of groundProblems(p)) seen.push(`${s.sessionId} saw ${p.id} at ${p.x},${p.z} off the ground: ${g}`)
      }
    }

    // Precondition for "W is +z": A faces +z (yaw 0), in both tabs.
    expect(angleDiff(start.yaw, 0), `A faces +z (yaw ${start.yaw})`).toBeLessThan(EPS)
    expect(angleDiff(observer.at(idA)!.yaw, 0), `the observer sees A facing +z`).toBeLessThan(EPS)

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

    // The observer sees A at the same place, flush with the wall; tab B holds its own player
    // (and is watched for overlaps) but is not required to be sent the Ghost.
    await expect
      .poll(
        async () => {
          watch(await snap(b))
          const p = observer!.at(idA)
          return !!p && Math.abs(p.z - face) < EPS && Math.abs(p.x - start.x) < EPS && p.team === start.team && angleDiff(p.yaw, 0) < EPS
        },
        { message: 'the observer sees A flush with the wall', timeout: WAIT_MS },
      )
      .toBe(true)
    expect(seen, 'no tab ever saw a player overlap a solid or leave the ground').toEqual([])
  } finally {
    await observer?.leave()
    await a.context().close()
    await b.context().close()
  }
})

// #25: the rotated variant. The ghost turns its camera (pointer lock and the
// mouse, as a player does) to roughly 45 degrees, holds W into the south wall
// of the building, and slides along it: z stays flush with the wall face
// while x keeps going, at the ghost's speed times sin(yaw). Nobody ever
// overlaps a solid in either tab.
//
// The yaw is aimed from the ghost's actual spawn: 45 degrees when that line
// meets the wall wall-s-e with room to slide, otherwise the angle to the
// nearest such point (about 23 to 58 degrees over the whole ghost spawn area).

test('rotated: a ghost turned about 45 degrees walks into a wall and slides along it, never overlapping, as seen in both tabs', async ({ browser }) => {
  test.setTimeout(90_000)
  let a: Tab | undefined
  let b: Tab | undefined
  let observer: Observer | undefined
  try {
    a = await openTab(browser, 'tab A')
    await joinedTab(a, { ghosts: 1, wardens: 0 })
    b = await openTab(browser, 'tab B')
    await joinedTab(b, { ghosts: 1, wardens: 1 })
    // The observer, an SDK Ghost (the third joiner), is the other client that sees the ghost.
    observer = await Observer.join()
    const sa = await joinedTab(a, { ghosts: 2, wardens: 1 })
    await observer.waitForPlayers(3)
    expect(sa.localTeam, 'the first tab of a fresh room is the ghost').toBe('ghost')
    const me = local(sa)
    const step = stepFor(me)

    const wall = solid('wall-s-e')
    const face = wall.min.z - PLAYER_HALF_SIZE
    const run = face - me.z
    expect(run, 'the ghost spawned south of the wall').toBeGreaterThan(3)
    // Contact x along 45 degrees, kept where the box is well on the wall and can slide for a while.
    const contactX = Math.min(Math.max(me.x + run, wall.min.x + 1), wall.max.x - 2)
    const aim = Math.atan2(contactX - me.x, run)
    expect(aim, 'a clearly rotated yaw').toBeGreaterThan(0.35)
    expect(aim).toBeLessThan(1.1)

    await lockPointer(a)
    const yaw = await turnTo(a, aim)
    expect(pathClear(me, yaw, run / Math.cos(yaw) - 0.1), `the path from ${me.x},${me.z} at yaw ${yaw} is clear up to the wall`).toBe(true)
    await expect
      .poll(async () => angleDiff(get(await snap(a!.page), me.id).yaw, yaw), { message: 'tab A sees the ghost turn', timeout: WAIT_MS })
      .toBeLessThan(0.0101)
    await expect
      .poll(() => angleDiff(observer!.at(me.id)?.yaw ?? Infinity, yaw), { message: 'the observer sees the ghost turn', timeout: WAIT_MS })
      .toBeLessThan(0.0101)

    const stopA = await startSampler(a.page)
    const stopB = await startSampler(b.page)
    const stopO = observer.record()
    let contact = NaN
    await a.page.keyboard.down('KeyW')
    try {
      await expect
        .poll(async () => Math.abs(get(await snap(a!.page), me.id).z - face), { message: `the ghost reaches the wall face z ${face}`, intervals: [20], timeout: 20_000 })
        .toBeLessThan(EPS)
      contact = await pageNow(a.page)
      await a.page.waitForTimeout(SLIDE_MS)
    } finally {
      await a.page.keyboard.up('KeyW')
    }
    await a.page.waitForTimeout(250)
    const samplesA = await stopA()
    const samplesB = await stopB()
    const samplesO = stopO()
    expectNoOverlap(samplesA, 'tab A')
    expectNoOverlap(samplesB, 'tab B')
    expectNoOverlap(samplesO, 'the observer')
    expectGroundRoute(samplesA, 'tab A')
    expectGroundRoute(samplesB, 'tab B')
    expectGroundRoute(samplesO, 'the observer')

    const all = track(samplesA, me.id).points
    // Approach: a straight line along (sin yaw, cos yaw) up to the face.
    const approach = analyse({ points: all.filter((p) => p.z < face - EPS) }, step)
    expect(angleDiff(approach.heading, yaw), `approach along the camera yaw (heading ${approach.heading})`).toBeLessThan(0.01)
    // Slide: flush with the face, x only increases, at the ghost's speed times sin(yaw).
    const slide = all.filter((p) => p.t >= contact)
    expect(slide.length, 'samples while sliding').toBeGreaterThan(10)
    for (const p of slide) expect(Math.abs(p.z - face), `flush with the wall while sliding (z ${p.z})`).toBeLessThan(EPS)
    for (let i = 1; i < slide.length; i++) expect(slide[i].x, 'x never goes back while sliding').toBeGreaterThanOrEqual(slide[i - 1].x)
    const s = analyse({ points: slide }, step * Math.sin(yaw))
    expect(s.end.x - s.start.x, 'the ghost slid along the wall').toBeGreaterThan(step * Math.sin(yaw) * 5)
    expect(s.end.x + PLAYER_HALF_SIZE, 'still against the wall at the end').toBeLessThan(wall.max.x)
    expect(Math.abs(s.moves - Math.round(s.moves)), `the slide is a whole number of x components (${s.moves})`).toBeLessThan(0.02)
    const slideSpeed = TEAM_SPEED.ghost * Math.sin(yaw)
    // Loose lower bound: the client's send timer slows down on a busy machine (see cameras.spec.ts).
    expect(s.sustainedSpeed, `slide speed about TEAM_SPEED.ghost * sin(yaw) = ${slideSpeed}`).toBeGreaterThan(slideSpeed * 0.6)
    expect(s.sustainedSpeed, `slide speed not above TEAM_SPEED.ghost * sin(yaw) = ${slideSpeed}`).toBeLessThan(slideSpeed * 1.1)

    const end = get(await snap(a.page), me.id)
    await expect
      .poll(() => {
        const p = observer!.at(me.id)
        return !!p && Math.abs(p.x - end.x) < EPS && Math.abs(p.z - face) < EPS && angleDiff(p.yaw, yaw) < EPS
      }, { message: 'the observer sees the ghost flush with the wall where it stopped', timeout: WAIT_MS })
      .toBe(true)
    for (const t of [a, b]) expect(t.errors, `${t.name}: no console errors`).toEqual([])
  } finally {
    await observer?.leave()
    await closeTabs(a, b)
  }
})
