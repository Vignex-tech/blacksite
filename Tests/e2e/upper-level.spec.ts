import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { Client } from '@colyseus/sdk'
import { ACTION_MESSAGE, ROOM_NAME, STEP_HEIGHT } from '../../shared/protocol.js'
import { GRAYBOX_MAP, PLAYER_HEIGHT, UPPER_LEVEL_Y, type ClimbAnchor, type LedgeAnchor } from '../../shared/map.js'
import type { BlacksiteSnapshot } from '../../shared/testhook.js'
import { MANTLE_DISTANCE } from '../../server/build/rooms/MyRoom.js'
import { feetY, modeOf, rectsOverlap, playerRect, type Point } from './support/geometry.js'
import { Walker, waitForState, endpoint, type GameRoom } from './support/sdk.js'
import { track } from './support/track.js'
import { closeTabs, joined, lockPointer, openTab, snap, startSampler, turnTo, VIEWPORT, WAIT_MS, type Sample, type Tab } from './support/tabs.js'

// #34: both browser tabs see players at their server height (#33). Two
// @colyseus/sdk clients join the shared room: a Ghost that climbs climb-east,
// hangs from ledge-east-platform and mantles onto the east platform, and a
// Warden that walks up the stairs to the upper level. While they walk to the
// foot of their routes, two browser tabs join (a Ghost and a Warden, in their
// team cameras, at the 320x240 camera-spec viewport) and start recording
// their hooks; only then do the SDK players go up. Both tabs' hooks must report each SDK player's y and mode as
// the server synced them, and the map counts must equal the shared lists.
//
// Every wait is closed-loop on state (the SDK's or a tab's hook), never a
// fixed duration: the 20 Hz send timer shares the main thread with rendering
// and runs at about 11-14 Hz in headless tabs (Docs/handoff.md).
//
// Room: browser pages joinOrCreate the one shared `my_room` (the chromium
// project runs on one worker, so it is empty when this spec starts). The SDK
// clients joinOrCreate it first, and the test fails unless both tabs and both
// SDK clients see all four players. The SDK clients leave before the tabs
// close, so no later spec sees them.
//
// Screenshots (for humans, no pixel comparison; CI uploads Tests/Reports/ as
// "graybox-map-screenshot"): the Warden tab's first-person view of the Ghost
// hanging under the cyan ledge bar, and of the SDK Warden on the upper level
// above the stairs.

const REPORTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'Reports')
const HANGING_SHOT = join(REPORTS, 'graybox-upper-level-hanging.png')
const STAIRS_SHOT = join(REPORTS, 'graybox-upper-level-stairs.png')
/** Screenshots are taken at this size, once every check that depends on the send rate is done. */
const SHOT_VIEWPORT = { width: 1280, height: 720 }

/** float32 on the wire. */
const EPS = 1e-4
const HANG_Y = UPPER_LEVEL_Y - PLAYER_HEIGHT

const EXPECTED_MAP = {
  id: GRAYBOX_MAP.id,
  renderedSolids: GRAYBOX_MAP.solids.length,
  renderedFloors: GRAYBOX_MAP.floors.length,
  renderedRamps: GRAYBOX_MAP.ramps.length,
  renderedAnchors: GRAYBOX_MAP.anchors.length,
}

const CLIMB_EAST = GRAYBOX_MAP.anchors.find((a): a is ClimbAnchor => a.id === 'climb-east')!
const LEDGE_EAST = GRAYBOX_MAP.anchors.find((a): a is LedgeAnchor => a.id === CLIMB_EAST.ledgeId)!
/** Where the mantle lands: MANTLE_DISTANCE along the ledge's facing from the hang point. */
const MANTLE_AT = {
  x: CLIMB_EAST.x + MANTLE_DISTANCE * Math.sin(LEDGE_EAST.facing),
  z: CLIMB_EAST.z + MANTLE_DISTANCE * Math.cos(LEDGE_EAST.facing),
}
const STAIRS = GRAYBOX_MAP.ramps.find((r) => r.id === 'stairs-west')!
const STAIRS_X = (STAIRS.minX + STAIRS.maxX) / 2
/** Just south of the stairs' low edge: the player box touches it. */
const STAIRS_FOOT: Point = { x: STAIRS_X, z: STAIRS.minZ - 0.5 }
/** Fully on landing-nw (z 6..7.5), flush with the north wall. */
const LANDING_Z = 7

interface Expected {
  x: number
  y: number
  z: number
  mode: string
}

function onRamp(p: Point): boolean {
  return GRAYBOX_MAP.ramps.some((r) => rectsOverlap(playerRect(p), { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ }))
}

/** The SDK client's own synced player as (x, y, z, mode). */
function own(room: GameRoom): Expected {
  const p = room.state.players.get(room.sessionId) as unknown as Record<string, unknown>
  return { x: p.x as number, y: feetY(p as never), z: p.z as number, mode: modeOf(p as never) }
}

function waitMode(room: GameRoom, mode: string, what: string): Promise<void> {
  return waitForState(room, what, () => own(room).mode === mode)
}

/** Polls the tab's hook until it shows player `id` at `want` (within EPS) in `want.mode`. */
async function tabSees(tab: Tab, id: string, want: Expected, what: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const p = (await snap(tab.page)).players.find((v) => v.id === id)
        if (!p) return 'missing'
        const off = Math.max(Math.abs(p.x - want.x), Math.abs(p.y - want.y), Math.abs(p.z - want.z))
        return p.mode === want.mode && off < EPS ? 'ok' : `${p.mode} at ${p.x},${p.y},${p.z}`
      },
      { message: `${tab.name} sees ${what}`, timeout: WAIT_MS },
    )
    .toBe('ok')
}

/**
 * Fails unless every player in the tab's snapshot has exactly the team, x, y,
 * z and mode the server synced (as the SDK client `room` received them).
 * Polls until it holds (the tab may be a patch behind), then asserts.
 */
async function expectTabMatchesServer(tab: Tab, room: GameRoom): Promise<BlacksiteSnapshot> {
  const diff = (s: BlacksiteSnapshot): string[] => {
    const out: string[] = []
    const server = room.state.players
    if (s.players.length !== server.size) out.push(`${s.players.length} players, server has ${server.size}`)
    for (const p of s.players) {
      const q = server.get(p.id) as unknown as Record<string, unknown> | undefined
      if (!q) {
        out.push(`${p.id} unknown to the server`)
        continue
      }
      const qy = feetY(q as never)
      const qm = modeOf(q as never)
      if (p.team !== q.team) out.push(`${p.id} team ${p.team} vs ${String(q.team)}`)
      if (p.mode !== qm) out.push(`${p.id} mode ${p.mode} vs ${qm}`)
      for (const [k, a, b] of [['x', p.x, q.x], ['y', p.y, qy], ['z', p.z, q.z]] as const) {
        if (typeof a !== 'number' || Math.abs(a - (b as number)) > EPS) out.push(`${p.id} ${k} ${String(a)} vs ${String(b)}`)
      }
    }
    return out
  }
  await expect.poll(async () => diff(await snap(tab.page)), { message: `${tab.name} matches the server`, timeout: WAIT_MS }).toEqual([])
  return snap(tab.page)
}

/**
 * One player's track from a tab's sampler: (x, y, z, mode) as the hook
 * reported them, deduplicated. Problems are collected, not asserted one by
 * one: thousands of expect() calls block the test process for seconds, long
 * enough for the server's WebSocket ping to drop the SDK clients.
 */
function seenBy(samples: Sample[], id: string, bad: string[]): { x: number; y: number; z: number; mode: string }[] {
  const out: { x: number; y: number; z: number; mode: string }[] = []
  for (const s of samples) {
    const p = s.players.find((v) => v.id === id)
    if (!p) continue
    if (typeof p.y !== 'number' || !Number.isFinite(p.y)) bad.push(`hook y for ${id} is ${String(p.y)}`)
    if (typeof p.mode !== 'string') bad.push(`hook mode for ${id} is ${String(p.mode)}`)
    const v = { x: p.x, y: p.y as number, z: p.z, mode: p.mode as string }
    const last = out[out.length - 1]
    if (!last || last.x !== v.x || last.y !== v.y || last.z !== v.z || last.mode !== v.mode) out.push(v)
  }
  return out
}

const modeSequence = (s: { mode: string }[]) => s.map((v) => v.mode).filter((m, i, a) => i === 0 || a[i - 1] !== m)

/** Resolves after the page has rendered `n` more animation frames. */
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

/** Tilts the first-person camera by mouse Y (positive looks down), as cameras.ts reads it under the lock. */
const tilt = (tab: Tab, pixels: number) =>
  tab.page.evaluate((py) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: py, bubbles: true })), pixels)

/** Turns the tab's camera toward (x, z), takes a screenshot at SHOT_VIEWPORT, and restores the viewport. */
async function shoot(tab: Tab, at: Point, path: string, name: string, pitchPixels: number): Promise<void> {
  const me = (await snap(tab.page)).players.find((p) => p.isLocal)!
  await turnTo(tab, Math.atan2(at.x - me.x, at.z - me.z))
  await tilt(tab, pitchPixels)
  await tab.page.setViewportSize(SHOT_VIEWPORT)
  try {
    await frames(tab.page, 10)
    const png = await tab.page.screenshot({ path })
    await test.info().attach(name, { body: png, contentType: 'image/png' })
    expect(png.length, `${name}: a rendered scene, not an empty page`).toBeGreaterThan(10_000)
  } finally {
    await tilt(tab, -pitchPixels)
    await tab.page.setViewportSize(VIEWPORT)
  }
}

test('both tabs see an SDK Ghost climb, hang and mantle and an SDK Warden take the stairs, at their server y and mode; map counts match the shared lists', async ({ browser }) => {
  test.setTimeout(120_000)
  const rooms: GameRoom[] = []
  let a: Tab | undefined
  let b: Tab | undefined
  try {
    // Two SDK clients join the shared room first: a Ghost, then a Warden.
    const g = (await new Client(endpoint).joinOrCreate(ROOM_NAME)) as GameRoom
    rooms.push(g)
    await waitForState(g, 'the SDK ghost sees itself', (s) => s.players.size === 1)
    const wd = (await new Client(endpoint).joinOrCreate(ROOM_NAME)) as GameRoom
    rooms.push(wd)
    await waitForState(wd, 'the SDK warden sees the ghost and itself', (s) => s.players.size === 2 && s.players.has(g.sessionId))
    const ghost = new Walker(g, 'sdk ghost', { ground: false })
    const warden = new Walker(wd, 'sdk warden', { ground: false })
    expect(ghost.state.team).toBe('ghost')
    expect(warden.state.team).toBe('warden')
    const wSeen = track(wd, wd.sessionId)
    const gSeen = track(g, g.sessionId)

    // While the SDK players walk to the foot of their routes (on the ground),
    // the two tabs join (a Ghost and a Warden again, ties going to ghost) and
    // start recording their hooks. Nobody leaves the ground before both tabs
    // are recording, so the tabs see every step up.
    const toStarts = Promise.all([
      (async () => {
        await ghost.walkTo({ x: 0, z: -5 }, 'xz')
        await ghost.walkTo({ x: CLIMB_EAST.x, z: -5 }, 'xz')
        await ghost.walkTo({ x: CLIMB_EAST.x, z: CLIMB_EAST.z }, 'xz')
      })(),
      warden.walkTo(STAIRS_FOOT, 'zx'),
    ])
    toStarts.catch(() => {}) // awaited below; this only stops an early failure being reported as unhandled
    a = await openTab(browser, 'tab A')
    const sa = await joined(a, 3)
    b = await openTab(browser, 'tab B')
    const sb = await joined(b, 4)
    const tabA = a
    const tabB = b
    const idA = sa.sessionId!
    const idB = sb.sessionId!
    expect(sa.localTeam).toBe('ghost')
    expect(sb.localTeam).toBe('warden')
    await joined(a, 4)
    // Both tabs rendered every floor, ramp and anchor of the shared map.
    for (const s of [sa, sb]) expect(s.map, `${s.sessionId}'s map counts`).toEqual(EXPECTED_MAP)
    expect(EXPECTED_MAP).toEqual({ id: 'graybox-1', renderedSolids: 16, renderedFloors: 4, renderedRamps: 1, renderedAnchors: 6 })
    const bothTabsSee = (id: string, want: Expected, what: string) => Promise.all([tabSees(tabA, id, want, what), tabSees(tabB, id, want, what)])
    const stopA = await startSampler(a.page, 40)
    const stopB = await startSampler(b.page, 40)
    await toStarts
    for (const r of [g, wd]) await waitForState(r, `${r.sessionId} sees both tabs`, (s) => s.players.size === 4 && [idA, idB].every((id) => s.players.has(id)))
    for (const r of [g, wd]) {
      const p = own(r)
      // y within EPS: walk residue (ARRIVE) can leave the warden's box a hair over the stairs' low edge.
      expect(p.mode, `${r.sessionId} still in ground mode at the foot of its route`).toBe('ground')
      expect(Math.abs(p.y), `${r.sessionId} still on the ground at the foot of its route (y ${p.y})`).toBeLessThan(EPS)
    }

    // Both at once: the Ghost up climb-east until it hangs, the Warden up the stairs.
    const ghostUp = async () => {
      g.send(ACTION_MESSAGE, { action: 'climb' })
      await waitMode(g, 'climbing', 'the ghost grabs climb-east')
      // Each climb step is held until both tabs show the ghost at that y, so
      // the tabs are seen to follow the whole climb, not only its ends.
      await bothTabsSee(g.sessionId, own(g), 'the SDK ghost on climb-east at the bottom')
      for (let i = 0; i < 40 && own(g).mode === 'climbing'; i++) {
        const r = await ghost.attachedStep(0, 1)
        if (r.moved) await bothTabsSee(g.sessionId, own(g), `the SDK ghost climbing, step ${i + 1}`)
      }
      expect(own(g)).toEqual({ x: CLIMB_EAST.x, y: expect.closeTo(HANG_Y, 4), z: CLIMB_EAST.z, mode: 'hanging' })
    }
    const wardenUp = async () => {
      // Held once part way up, until both tabs show the warden on the stairs at that y.
      let held = false
      for (let i = 0; i < 200 && warden.pos.z < LANDING_Z - 1e-6; i++) {
        await warden.step(0, 1)
        if (!held && own(wd).y > UPPER_LEVEL_Y / 2) {
          held = true
          await bothTabsSee(wd.sessionId, own(wd), `the SDK warden half way up the stairs`)
        }
      }
      expect(held, 'the warden passed half way up').toBe(true)
      const top = own(wd)
      expect(top.mode).toBe('ground')
      expect(Math.abs(top.y - UPPER_LEVEL_Y), `warden at y ${top.y} on landing-nw`).toBeLessThan(EPS)
    }
    await Promise.all([ghostUp(), wardenUp()])

    // Both tabs see the hanger at the ledge and the Warden on the upper level.
    const hang = { x: CLIMB_EAST.x, y: HANG_Y, z: CLIMB_EAST.z, mode: 'hanging' }
    const landing = own(wd)
    for (const tab of [tabA, tabB]) {
      await tabSees(tab, g.sessionId, hang, `the SDK ghost hanging from ${LEDGE_EAST.id} at feet ${HANG_Y}`)
      await tabSees(tab, wd.sessionId, landing, `the SDK warden on the upper level at y ${UPPER_LEVEL_Y}`)
      await expectTabMatchesServer(tab, wd)
    }

    // For humans: the Warden tab looks at the hanger, then at the Warden at the top of the stairs.
    mkdirSync(REPORTS, { recursive: true })
    await lockPointer(tabB)
    await shoot(tabB, { x: CLIMB_EAST.x, z: CLIMB_EAST.z }, HANGING_SHOT, 'upper-level-hanging', 0)
    await shoot(tabB, { x: landing.x, z: landing.z }, STAIRS_SHOT, 'upper-level-stairs', -80)

    // Mantle: both tabs see the Ghost standing on the east platform at UPPER_LEVEL_Y.
    g.send(ACTION_MESSAGE, { action: 'climb' })
    await waitMode(g, 'ground', 'the ghost mantles')
    const top = { x: MANTLE_AT.x, y: UPPER_LEVEL_Y, z: MANTLE_AT.z, mode: 'ground' }
    expect(Math.abs(own(g).x - top.x) + Math.abs(own(g).y - top.y) + Math.abs(own(g).z - top.z), `mantled to ${JSON.stringify(own(g))}`).toBeLessThan(EPS)
    for (const tab of [tabA, tabB]) {
      await tabSees(tab, g.sessionId, top, `the SDK ghost standing on the east platform`)
      // Every player (the two tabs' own, the SDK ghost and warden) matches the server in both tabs.
      for (const room of [g, wd]) await expectTabMatchesServer(tab, room)
    }

    const samples = { 'tab A': await stopA(), 'tab B': await stopB() }
    expect(ghost.violations, 'the ghost overlap watch').toEqual([])
    expect(warden.violations, 'the warden overlap watch').toEqual([])
    expect(gSeen.bad.concat(wSeen.bad)).toEqual([])
    const serverGhostModes = modeSequence(gSeen.samples)
    expect(serverGhostModes, 'the server: grab, climb, hang, mantle').toEqual(['ground', 'climbing', 'hanging', 'ground'])

    // The tabs' records, checked once the SDK clients are gone (see seenBy).
    for (const r of rooms.splice(0)) await r.leave().catch(() => {})
    for (const [name, s] of Object.entries(samples)) {
      const bad: string[] = []
      const at = (v: { x: number; y: number; z: number; mode: string }) => `${v.mode} at ${v.x},${v.y},${v.z}`
      // The SDK ghost: ground, climbing on the anchor, hanging at the ledge, ground on the platform.
      const gv = seenBy(s, g.sessionId, bad)
      expect(modeSequence(gv), `${name} saw the ghost grab, climb, hang and mantle: ${gv.map(at).join('; ')}`).toEqual(['ground', 'climbing', 'hanging', 'ground'])
      const climbing = gv.filter((v) => v.mode === 'climbing')
      expect(climbing.some((v) => v.y > STEP_HEIGHT && v.y < HANG_Y - STEP_HEIGHT), `${name} saw the ghost part way up the climb`).toBe(true)
      climbing.forEach((v, i) => {
        if (Math.abs(v.x - CLIMB_EAST.x) + Math.abs(v.z - CLIMB_EAST.z) > EPS) bad.push(`ghost ${at(v)}: climbing off the anchor`)
        if (v.y < CLIMB_EAST.minY - EPS || v.y > CLIMB_EAST.maxY + EPS) bad.push(`ghost ${at(v)}: climbing outside minY..maxY`)
        if (i > 0 && v.y < climbing[i - 1].y - EPS) bad.push(`ghost ${at(v)}: the climb went down`)
      })
      for (const v of gv) {
        if (v.mode === 'hanging' && (Math.abs(v.y - HANG_Y) > EPS || Math.abs(v.x - CLIMB_EAST.x) + Math.abs(v.z - CLIMB_EAST.z) > EPS)) bad.push(`ghost ${at(v)}: not hanging at the top of climb-east`)
        if (v.mode === 'ground' && Math.abs(v.y) > EPS && Math.abs(v.y - UPPER_LEVEL_Y) > EPS) bad.push(`ghost ${at(v)}: standing in mid-air`)
      }

      // The SDK warden: ground the whole time, going only up, seen part way up the stairs.
      const wv = seenBy(s, wd.sessionId, bad)
      expect(modeSequence(wv), `${name}: the warden stays in ground mode: ${wv.filter((v) => v.mode !== 'ground').map(at).join('; ')}`).toEqual(['ground'])
      expect(wv.some((v) => v.y > STEP_HEIGHT && v.y < UPPER_LEVEL_Y - STEP_HEIGHT && onRamp(v)), `${name} saw the warden part way up, on the stairs`).toBe(true)
      wv.forEach((v, i) => {
        if (i > 0 && v.y < wv[i - 1].y - EPS) bad.push(`warden ${at(v)}: y dropped`)
        if (v.y > EPS && !onRamp(v) && Math.abs(v.y - UPPER_LEVEL_Y) > EPS) bad.push(`warden ${at(v)}: off the stairs between levels`)
      })
      expect(Math.abs(wv[wv.length - 1].y - UPPER_LEVEL_Y), `${name}: the warden ends on the upper level`).toBeLessThan(EPS)

      // The tabs' own players never left the ground.
      for (const id of [idA, idB]) {
        for (const v of seenBy(s, id, bad)) if (v.mode !== 'ground' || Math.abs(v.y) > EPS) bad.push(`tab player ${id} ${at(v)}: left the ground`)
      }
      expect(bad, `${name}'s record of every player`).toEqual([])
    }

    // The map counts never changed, and nothing went wrong in either tab.
    for (const tab of [tabA, tabB]) expect((await snap(tab.page)).map).toEqual(EXPECTED_MAP)
    expect(tabA.errors).toEqual([])
    expect(tabB.errors).toEqual([])
  } finally {
    for (const r of rooms) await r.leave().catch(() => {})
    await closeTabs(a, b)
  }
})
