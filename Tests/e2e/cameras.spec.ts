import { expect, test } from '@playwright/test'
import { MOVE_BURST, MOVE_RATE_HZ } from '../../server/build/rooms/MyRoom.js'
import { TEAM_SPEED, type Team } from '../../shared/protocol.js'
import type { BlacksiteSnapshot } from '../../shared/testhook.js'
import { expectTeamsAndYaws } from './support/hook.js'
import { angleDiff, stepFor, worldStep } from './support/movement.js'
import { analyse, expectGroundRoute, expectNeverFasterThanLimit, expectNoOverlap, pathClear, track } from './support/legs.js'
import {
  EPS,
  MODE_FOR_TEAM,
  RAD_PER_PIXEL,
  WAIT_MS,
  closeTabs,
  turnTo,
  get,
  holdKey,
  joined,
  local,
  lockPointer,
  moveMouse,
  openTab,
  snap,
  startSampler,
  type Tab,
} from './support/tabs.js'
import type { SentMove } from './support/frames.js'

// #25, the milestone 3 gate, in real browser tabs: one player is a Ghost in
// third person and one a Warden in first person; W/D move relative to the
// camera; the server enforces each team's speed; a leaver's team is refilled
// by the next joiner. State is read only through window.__blacksite and the
// move messages the tab sends (support/frames.ts); turning goes through the
// real input path: click the canvas for pointer lock, then move the mouse
// (headless Chromium grants pointer lock, so no workaround is needed).
//
// Room: browser pages joinOrCreate the one shared my_room (single worker).
// Tab A must see itself alone before tab B opens, so A is the first joiner of
// a fresh room and so a ghost (ties go to ghost).

/** How long W is held for the speed measurement (ms). */
const W_MS = 1_500
/** How long D is held for the strafe check (ms). */
const D_MS = 500
/** How long W is held before any mouse input (ms). */
const UNTURNED_MS = 500
/** The client sends a yaw-only move once the camera turned more than this (client/src/main.ts, #24). */
const YAW_SEND_EPSILON = 0.01
/** Client send rate while a key is held (#24): 20 Hz. */
const SEND_HZ = 20
/**
 * Sustained speed vs TEAM_SPEED[team]. Never above SPEED_HIGH. The lower
 * bound is loose because the client's 20 Hz send timer shares the main thread
 * with rendering, and headless Chromium renders in software: on a busy
 * machine it ticks slower, so the player is slower (the server never makes
 * up for missed ticks). The exact check of the server's per-team speed is
 * per move: distance / moves sent = TEAM_SPEED[team] / MOVE_RATE_HZ.
 */
const SPEED_LOW = 0.75
const SPEED_HIGH = 1.1
/** Sustained speed vs what the tab's actual send rate allows (sent per second * step). */
const RATE_SPEED_LOW = 0.85
/** Heading of a straight, unobstructed leg vs the camera's facing (radians). */
const HEADING_TOL = 0.01

/**
 * Turns to try, per team, in radians from the spawn facing; the first whose
 * W leg and D leg are clear of solids and route hazards (ramps,
 * covered pockets, climb spots; #28) from the player's actual position is
 * used. None is axis-aligned, so both sin and cos of the yaw matter.
 * Ghosts spawn outside, south (x -4..4, z -18..-14); wardens inside the
 * building (x -3..3, z 2..5).
 */
const TURNS: Record<Team, number[]> = {
  ghost: [1.0, 1.5, -1.0, 0.6],
  warden: [2.8, -2.8, 2.5, -2.5],
}

function expectMoves(moves: SentMove[], want: { dx: number; dz: number; yaw: number }, who: string) {
  for (const m of moves) {
    expect(m.keys, `${who}: a move carries dx, dz and yaw only`).toEqual(['dx', 'dz', 'yaw'])
    expect({ dx: m.dx, dz: m.dz }, `${who}: keys map to strafe dx and forward dz`).toEqual({ dx: want.dx, dz: want.dz })
    expect(m.yaw, `${who}: the yaw sent is the camera yaw`).toBe(want.yaw)
  }
}

/** Sent-move count of a key held for `ms`: the 20 Hz tick, never faster, and not much slower. */
function expectSendRate(count: number, ms: number, who: string, atLeast = true) {
  const ticks = (ms / 1000) * SEND_HZ
  expect(count, `${who}: at most one move per 50 ms tick (${count} in ${ms.toFixed(0)} ms)`).toBeLessThanOrEqual(Math.ceil(ticks) + 1)
  if (atLeast) expect(count, `${who}: about one move per 50 ms tick (${count} in ${ms.toFixed(0)} ms)`).toBeGreaterThanOrEqual(Math.floor(ticks * 0.7))
}

/** Waits until `tab` sees player `id` at the position and yaw `want` (within float32 slack). */
async function seesAt(tab: Tab, id: string, want: { x: number; z: number; yaw: number }, what: string) {
  await expect
    .poll(
      async () => {
        const p = get(await snap(tab.page), id)
        return Math.abs(p.x - want.x) < EPS && Math.abs(p.z - want.z) < EPS && angleDiff(p.yaw, want.yaw) < EPS
      },
      { message: `${tab.name} sees ${what}`, timeout: WAIT_MS },
    )
    .toBe(true)
}

/** With no mouse input, the camera faces +z and W moves the local player straight +z, as both tabs see it. */
async function unturnedW(tab: Tab, other: Tab) {
  const s = await snap(tab.page)
  const me = local(s)
  expect(s.camera?.yaw, `${tab.name}: camera yaw is 0 with no mouse input`).toBe(0)
  expect(angleDiff(me.yaw, 0), `${tab.name}: server yaw is 0 at spawn`).toBeLessThan(EPS)
  expect(tab.sent.moves, `${tab.name}: nothing is sent before any input`).toEqual([])
  const step = stepFor(me)

  const t0 = Date.now()
  const stop = await startSampler(tab.page)
  const hold = await holdKey(tab.page, 'KeyW', UNTURNED_MS)
  await tab.page.waitForTimeout(250)
  const samples = await stop()
  expectNoOverlap(samples, `${tab.name} unturned W`)
  expectGroundRoute(samples, `${tab.name} unturned W`)
  const leg = analyse(track(samples, me.id), step)
  const sent = tab.sent.since(t0)
  expectMoves(sent, { dx: 0, dz: 1, yaw: 0 }, `${tab.name} unturned W`)
  expectSendRate(sent.length, hold.up - hold.down, `${tab.name} unturned W`)

  expect(Math.abs(leg.end.x - leg.start.x), `${tab.name}: unturned W does not move x`).toBeLessThan(EPS)
  expect(leg.end.z - leg.start.z, `${tab.name}: unturned W moves +z`).toBeGreaterThan(step * 5)
  expect(Math.abs(leg.moves - Math.round(leg.moves)), `${tab.name}: a whole number of ${me.team} steps (${leg.moves})`).toBeLessThan(0.02)
  await seesAt(other, me.id, { ...leg.end, yaw: 0 }, `${tab.name}'s player after the unturned W`)
}

/**
 * Turns the camera with the mouse under pointer lock, waits for the server
 * yaw to follow in both tabs, then holds W (and D): the player moves along
 * (sin yaw, cos yaw) (and (cos yaw, -sin yaw)) at its team's speed, as both
 * tabs see it. Returns the W leg's sustained speed and distance per sent move.
 */
async function turnAndWalk(tab: Tab, other: Tab): Promise<{ speed: number; perMove: number }> {
  const s0 = await snap(tab.page)
  const me = local(s0)
  const team = me.team!
  const step = stepFor(me)
  const camYaw0 = s0.camera!.yaw

  // A turn whose W and D legs are clear from where the player is.
  const reach = (ms: number) => TEAM_SPEED[team] * (ms / 1000) * SPEED_HIGH + step * (MOVE_BURST + 1)
  const turn = TURNS[team].find((t) => {
    const yaw = camYaw0 + t
    if (!pathClear(me, yaw, reach(W_MS))) return false
    const afterW = { x: me.x + Math.sin(yaw) * reach(W_MS), z: me.z + Math.cos(yaw) * reach(W_MS) }
    // The D leg starts somewhere along the W path; check from both ends.
    return pathClear(afterW, yaw + Math.PI / 2, reach(D_MS)) && pathClear(
      { x: me.x + Math.sin(yaw) * TEAM_SPEED[team] * (W_MS / 1000) * SPEED_LOW, z: me.z + Math.cos(yaw) * TEAM_SPEED[team] * (W_MS / 1000) * SPEED_LOW },
      yaw + Math.PI / 2,
      reach(D_MS),
    )
  })
  expect(turn, `${tab.name}: one of the planned turns has a clear path from ${me.x},${me.z}`).toBeDefined()

  // Before pointer lock, the mouse doesn't turn the camera or send anything.
  const tIdle = Date.now()
  await tab.page.mouse.move(100, 100)
  await tab.page.mouse.move(300, 200, { steps: 10 })
  await moveMouse(tab, 400)
  await tab.page.waitForTimeout(150)
  expect((await snap(tab.page)).camera?.yaw, `${tab.name}: no turn without pointer lock`).toBe(camYaw0)
  expect(tab.sent.since(tIdle), `${tab.name}: nothing sent for mouse movement without pointer lock`).toEqual([])
  await expect(tab.page.locator('#camera-hint'), `${tab.name}: the hint asks for a click`).toContainText('Click to look around')

  await lockPointer(tab)
  await expect(tab.page.locator('#camera-hint'), `${tab.name}: the hint is hidden while locked`).toHaveText('')
  const tTurn = Date.now()
  const wantYaw = Math.atan2(Math.sin(camYaw0 + turn!), Math.cos(camYaw0 + turn!))
  await turnTo(tab, wantYaw)
  const cam = (await snap(tab.page)).camera!
  expect(angleDiff(cam.yaw, wantYaw), `${tab.name}: the mouse turned the camera to ${wantYaw} (at ${cam.yaw})`).toBeLessThan(RAD_PER_PIXEL)
  expect(cam.mode).toBe(MODE_FOR_TEAM[team])

  // The server yaw follows (yaw-only moves), within the client's send threshold, in both tabs.
  for (const t of [tab, other]) {
    await expect
      .poll(async () => angleDiff(get(await snap(t.page), me.id).yaw, cam.yaw), {
        message: `${t.name} sees ${tab.name}'s server yaw follow the camera`,
        timeout: WAIT_MS,
      })
      .toBeLessThan(YAW_SEND_EPSILON + EPS)
  }
  await tab.page.waitForTimeout(200)
  const turnMoves = tab.sent.since(tTurn)
  expect(turnMoves.length, `${tab.name}: turning sent yaw-only moves`).toBeGreaterThan(0)
  for (const m of turnMoves) {
    expect(m.keys).toEqual(['dx', 'dz', 'yaw'])
    expect({ dx: m.dx, dz: m.dz }, `${tab.name}: a turn with no key held is yaw-only`).toEqual({ dx: 0, dz: 0 })
    expect(typeof m.yaw === 'number' && Number.isFinite(m.yaw)).toBe(true)
  }
  expect(angleDiff(turnMoves[turnMoves.length - 1].yaw as number, cam.yaw)).toBeLessThan(YAW_SEND_EPSILON + 1e-9)
  expectSendRate(turnMoves.length, Date.now() - tTurn, `${tab.name} turning`, false)
  // Standing still after the turn sends nothing.
  const tStill = Date.now()
  await tab.page.waitForTimeout(300)
  expect(tab.sent.since(tStill), `${tab.name}: nothing sent while idle after the turn`).toEqual([])

  // Hold W: along (sin yaw, cos yaw) at the team's speed.
  const tW = Date.now()
  const stopA = await startSampler(tab.page)
  const stopB = await startSampler(other.page)
  const holdW = await holdKey(tab.page, 'KeyW', W_MS)
  await tab.page.waitForTimeout(250)
  const samplesA = await stopA()
  const samplesB = await stopB()
  const sentW = tab.sent.since(tW)
  expectMoves(sentW, { dx: 0, dz: 1, yaw: cam.yaw }, `${tab.name} W`)
  expectSendRate(sentW.length, holdW.up - holdW.down, `${tab.name} W`)
  expectNoOverlap(samplesA, tab.name)
  expectNoOverlap(samplesB, other.name)
  expectGroundRoute(samplesA, tab.name)
  expectGroundRoute(samplesB, other.name)

  const legTrack = track(samplesA, me.id)
  const w = analyse(legTrack, step)
  const forward = worldStep(0, 1, cam.yaw, 1)
  expect(Math.hypot(forward.x - Math.sin(cam.yaw), forward.z - Math.cos(cam.yaw)), 'forward is (sin yaw, cos yaw)').toBeLessThan(1e-12)
  expect(angleDiff(w.heading, cam.yaw), `${tab.name}: W moved along (sin yaw, cos yaw) for yaw ${cam.yaw} (heading ${w.heading})`).toBeLessThan(HEADING_TOL)
  expect(Math.abs(w.moves - Math.round(w.moves)), `${tab.name}: W moved a whole number of ${team} steps (${w.moves})`).toBeLessThan(0.02)
  expect(Math.round(w.moves), `${tab.name}: no more accepted moves than sent`).toBeLessThanOrEqual(sentW.length)
  // Every sent move was accepted and moved exactly one team step: the server's per-team speed.
  expect(Math.round(w.moves), `${tab.name}: every W move sent was accepted (${w.moves} steps, ${sentW.length} sent)`).toBe(sentW.length)
  const perMove = w.distance / sentW.length
  expect(Math.abs(perMove - TEAM_SPEED[team] / MOVE_RATE_HZ), `${tab.name}: ${perMove} per move is TEAM_SPEED.${team} / MOVE_RATE_HZ`).toBeLessThan(1e-4)
  const sendRate = sentW.length / ((holdW.up - holdW.down) / 1000)
  expect(w.sustainedSpeed, `${tab.name}: ${team} speed matches the tab's send rate (${sendRate.toFixed(1)}/s)`).toBeGreaterThan(Math.min(sendRate, MOVE_RATE_HZ) * step * RATE_SPEED_LOW)
  expect(w.sustainedSpeed, `${tab.name}: ${team} sustained speed about TEAM_SPEED.${team} (${TEAM_SPEED[team]})`).toBeGreaterThan(TEAM_SPEED[team] * SPEED_LOW)
  expect(w.sustainedSpeed, `${tab.name}: ${team} sustained speed not above TEAM_SPEED.${team} (${TEAM_SPEED[team]})`).toBeLessThan(TEAM_SPEED[team] * SPEED_HIGH)
  expectNeverFasterThanLimit(legTrack, step, `${tab.name} (${team})`)
  // The server yaw is now exactly the camera yaw (float32), and the other tab agrees.
  const afterW = get(await snap(tab.page), me.id)
  expect(angleDiff(afterW.yaw, cam.yaw), `${tab.name}: server yaw equals the camera yaw after W`).toBeLessThan(EPS)
  await seesAt(other, me.id, { x: afterW.x, z: afterW.z, yaw: cam.yaw }, `${tab.name}'s player where W took it, facing the camera yaw`)
  // The other tab saw the same straight walk.
  const wB = analyse(track(samplesB, me.id), step)
  expect(angleDiff(wB.heading, cam.yaw), `${other.name} saw ${tab.name}'s W along (sin yaw, cos yaw)`).toBeLessThan(HEADING_TOL)

  // Hold D: along (cos yaw, -sin yaw).
  const tD = Date.now()
  const stopD = await startSampler(tab.page)
  const holdD = await holdKey(tab.page, 'KeyD', D_MS)
  await tab.page.waitForTimeout(250)
  const samplesD = await stopD()
  const sentD = tab.sent.since(tD)
  expectMoves(sentD, { dx: 1, dz: 0, yaw: cam.yaw }, `${tab.name} D`)
  expectSendRate(sentD.length, holdD.up - holdD.down, `${tab.name} D`)
  expectNoOverlap(samplesD, tab.name)
  expectGroundRoute(samplesD, tab.name)
  const d = analyse(track(samplesD, me.id), step)
  expect(d.distance, `${tab.name}: D moved`).toBeGreaterThan(step * 3)
  const right = Math.atan2(Math.cos(cam.yaw), -Math.sin(cam.yaw))
  expect(angleDiff(d.heading, right), `${tab.name}: D moved along (cos yaw, -sin yaw) (heading ${d.heading})`).toBeLessThan(HEADING_TOL)
  const afterD = get(await snap(tab.page), me.id)
  await seesAt(other, me.id, { x: afterD.x, z: afterD.z, yaw: cam.yaw }, `${tab.name}'s player where D took it`)

  return { speed: w.sustainedSpeed, perMove }
}

test('M3 gate: Ghost third person and Warden first person; W and D follow the camera at each team speed; a rejoin refills the team', async ({ browser }) => {
  test.setTimeout(90_000)
  let a: Tab | undefined
  let b: Tab | undefined
  let c: Tab | undefined
  try {
    // Tab A alone in a fresh room: the ghost, in third person.
    a = await openTab(browser, 'tab A')
    const sa1 = await joined(a, 1)
    expect(sa1.localTeam, 'the first tab is a ghost').toBe('ghost')
    expect(sa1.camera, 'the ghost tab is in third person facing +z').toEqual({ mode: 'third-person', yaw: 0 })

    b = await openTab(browser, 'tab B')
    const sb = await joined(b, 2)
    const sa = await joined(a, 2)
    expect(sb.localTeam, 'the second tab is a warden').toBe('warden')
    expect(sb.camera, 'the warden tab is in first person facing +z').toEqual({ mode: 'first-person', yaw: 0 })
    expect(sa.camera?.mode, 'the ghost stays in third person when the warden joins').toBe('third-person')
    for (const s of [sa, sb]) expectTeamsAndYaws(s)
    const idA = sa.sessionId!
    const idB = sb.sessionId!
    expect(get(sb, idA).team, 'tab B sees A as a ghost').toBe('ghost')
    expect(get(sa, idB).team, 'tab A sees B as a warden').toBe('warden')
    await expect(a.page.locator('#hud')).toContainText('you are a Ghost')
    await expect(b.page.locator('#hud')).toContainText('you are a Warden')

    // No mouse input yet: W is +z in both tabs (the old precondition).
    await unturnedW(a, b)
    await unturnedW(b, a)

    // Camera-relative W and D, and per-team speed, for the ghost and the warden.
    const ghost = await turnAndWalk(a, b)
    const warden = await turnAndWalk(b, a)
    const report = `ghost ${ghost.speed.toFixed(3)}, warden ${warden.speed.toFixed(3)} units/s`
    test.info().annotations.push({ type: 'sustained speed', description: report })
    console.log(`sustained speed: ${report}`)
    expect(ghost.perMove / warden.perMove, 'per move, the ghost goes TEAM_SPEED.ghost / TEAM_SPEED.warden as far as the warden').toBeCloseTo(
      TEAM_SPEED.ghost / TEAM_SPEED.warden,
      3,
    )

    // Releasing pointer lock (what Esc does) stops mouse turning.
    const before = (await snap(a.page)).camera!
    await a.page.evaluate(() => document.exitPointerLock())
    await expect.poll(() => a!.page.evaluate(() => document.pointerLockElement)).toBeNull()
    await expect(a.page.locator('#camera-hint')).toContainText('Click to look around')
    const tFree = Date.now()
    await moveMouse(a, 300)
    await a.page.waitForTimeout(300)
    expect((await snap(a.page)).camera, 'tab A: no turn after the pointer lock is released').toEqual(before)
    expect(a.sent.since(tFree), 'tab A: nothing sent for mouse movement after the lock is released').toEqual([])

    // The warden leaves; the next joiner is a warden in first person facing +z.
    await b.page.context().close()
    b = undefined
    await expect.poll(async () => (await snap(a!.page)).players.length, { message: 'tab A sees the warden leave', timeout: WAIT_MS }).toBe(1)
    c = await openTab(browser, 'tab C')
    const sc = await joined(c, 2)
    expect(sc.localTeam, 'the rejoiner fills the warden slot').toBe('warden')
    expect(sc.camera).toEqual({ mode: 'first-person', yaw: 0 })
    const sa2 = await joined(a, 2)
    expect(get(sa2, sc.sessionId!).team, 'tab A sees the rejoiner as a warden').toBe('warden')
    expect(local(sa2).team, 'tab A is still the ghost').toBe('ghost')

    for (const t of [a, c]) {
      expect(t.errors, `${t.name}: no console errors`).toEqual([])
      expect(t.sent.errors, `${t.name}: every sent move decodes`).toEqual([])
    }
  } finally {
    await closeTabs(a, b, c)
  }
})

test('a disconnect returns the camera to overhead at yaw 0 and releases the pointer', async ({ browser }) => {
  test.setTimeout(60_000)
  let tab: Tab | undefined
  try {
    tab = await openTab(browser, 'tab D')
    const s = await joined(tab, 1)
    const team = s.localTeam!
    expect(s.camera).toEqual({ mode: MODE_FOR_TEAM[team], yaw: 0 })
    await lockPointer(tab)
    await turnTo(tab, 0.5)

    // Network loss: the browser drops the room socket.
    await tab.page.context().setOffline(true)
    await expect
      .poll(
        async () => {
          const v: BlacksiteSnapshot = await snap(tab!.page)
          return { connected: v.connected, players: v.players.length, camera: v.camera }
        },
        { message: 'after the disconnect: not connected, no players, overhead camera at yaw 0', timeout: WAIT_MS },
      )
      .toEqual({ connected: false, players: 0, camera: { mode: 'overhead', yaw: 0 } })
    expect(await tab.page.evaluate(() => document.pointerLockElement), 'the pointer is released').toBeNull()
    await expect(tab.page.locator('#hud')).toContainText('disconnected')
    await expect(tab.page.locator('#camera-hint')).toHaveText('')
    // The mouse no longer turns anything.
    await moveMouse(tab, 200)
    expect((await snap(tab.page)).camera).toEqual({ mode: 'overhead', yaw: 0 })
  } finally {
    await closeTabs(tab)
  }
})
