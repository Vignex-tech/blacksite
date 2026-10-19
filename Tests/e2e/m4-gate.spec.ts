import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { Client } from '@colyseus/sdk'
import { ACTION_MESSAGE, ANCHOR_RANGE, ROOM_NAME, type Action, type MovementMode } from '../../shared/protocol.js'
import { GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT, UPPER_LEVEL_Y, type ClimbAnchor, type LedgeAnchor } from '../../shared/map.js'
import type { BlacksitePlayerSnapshot, BlacksiteSnapshot } from '../../shared/testhook.js'
import { MANTLE_DISTANCE } from '../../server/build/rooms/MyRoom.js'
import { inRect } from './support/geometry.js'
import { endpoint, leaveQuietly, waitForState, type GameRoom } from './support/sdk.js'
import { track } from './support/track.js'
import { closeTabs, joined, local, openTab, snap, startSampler, VIEWPORT, type Sample, type Tab } from './support/tabs.js'

// #36, the M4 gate, in real browser tabs driven only by the player's keys
// (WASD to walk, E to climb, grab and mantle, C to drop, Space to jump):
// - Ghost tab: E far from an anchor and E flush against a plain wall do
//   nothing. Walk to climb-west, E climbs, hold W to hang from
//   ledge-west-wall, C drops to the ground. E climbs again, W hangs, D
//   shimmies along the ledge, E mantles onto the mezzanine at UPPER_LEVEL_Y.
//   The HUD's #mode line shows the mode while attached, and #climb-prompt
//   shows "E: climb" only near the anchor while not attached. The Ghost's
//   only way above the ground is the anchor: it is never seen standing or in
//   the air above jump height except straight after a hang.
// - Warden tab: walks to the same climb-west spot, where E, Space and C
//   change nothing and no prompt is ever shown; then walks back inside and
//   up the stairs to UPPER_LEVEL_Y, in ground mode the whole way.
// - Wire: every action the tabs send is decoded (support/frames.ts). Each
//   key press sends exactly one { action } frame (auto-repeat and Ctrl
//   combinations send none), with no position, anchor or other field.
// - SDK: a Ghost and a Warden join the same room and, from their spawns far
//   from every anchor, send a plain climb and climbs with forged anchor, x,
//   y, z, mode, ledge and team fields. None changes their state (#32's
//   check, repeated here so the whole gate is in one spec).
//
// Timing (Docs/handoff.md): the client's 20 Hz send timer shares the main
// thread with rendering and runs at about 11-14 Hz in headless tabs, so every
// wait is closed-loop on the hook (hold a key until the hook shows the
// target, then let the position settle), never a fixed hold. The only fixed
// waits are ACTION_GAP between presses, which keeps a tab inside the server's
// action budget (5 per second, burst 2), and NO_SEND_MS, which gives a key
// that must send nothing time to show it would have.
//
// Problems found in per-sample records are collected and asserted once, after
// the SDK clients have left (thousands of expect() calls block the worker
// long enough for the server's ping to drop SDK clients, #34).
//
// Since #45 this holds with the M5 visibility filter (#46): every assertion reads
// a client's own player, or waits only for the players that client must be sent.
//
// Room: browser pages joinOrCreate the shared `my_room`, and the chromium
// project runs on one worker, so the room is fresh: tab A is the Ghost, tab B
// the Warden, then the SDK Ghost and SDK Warden.

const REPORTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'Reports')
const HANGING_SHOT = join(REPORTS, 'graybox-m4-ghost-hanging.png')
const SHOT_VIEWPORT = { width: 1280, height: 720 }

/** float32 on the wire. */
const EPS = 1e-4
/** A walk or climb hold may take this long in a slow headless tab; a failure, never a delay. */
const HOLD_MS = 30_000
const WAIT_MS = 10_000
/** Spacing between action presses in one tab: the server allows 5 per second with a burst of 2. */
const ACTION_GAP = 450
/** How long a key that must send nothing is given to show it would have. */
const NO_SEND_MS = 400
const POLL = { intervals: [30] }

const HANG_Y = UPPER_LEVEL_Y - PLAYER_HEIGHT
const CLIMB_WEST = GRAYBOX_MAP.anchors.find((a): a is ClimbAnchor => a.id === 'climb-west')!
const LEDGE_WEST = GRAYBOX_MAP.anchors.find((a): a is LedgeAnchor => a.id === CLIMB_WEST.ledgeId)!
const MEZZ = GRAYBOX_MAP.floors.find((f) => f.id === 'mezz-west')!
const LANDING = GRAYBOX_MAP.floors.find((f) => f.id === 'landing-nw')!
const STAIRS = GRAYBOX_MAP.ramps.find((r) => r.id === 'stairs-west')!
/** The west wall's outer face (x = -10). A player flush against it from outside is at -10.5. */
const WEST_FACE_X = GRAYBOX_MAP.solids.find((s) => s.id === 'wall-w-s')!.min.x
const FLUSH_X = WEST_FACE_X - PLAYER_HALF_SIZE
/** A spot flush against the west wall (wall-w-s), far from every anchor. */
const PLAIN_WALL_Z = -4.5
/** Walking north outside the west wall, clear of it and of cover-yard-w. */
const YARD_X = FLUSH_X - 0.3
/** The warden's lane through the west door and along the stairs' south edge, under the catwalk. */
const LANE_Z = -0.5
const STAIRS_X = (STAIRS.minX + STAIRS.maxX) / 2

const MODE_TEXT: Record<MovementMode, string> = {
  ground: 'On the ground',
  falling: 'In the air',
  climbing: 'Climbing: W/S climb up or down, C drop',
  hanging: 'Hanging: E climb up, C drop, A/D move',
}
const PROMPT = 'E: climb'

/** What the hook and the HUD show for the local player at one moment. */
interface View {
  me: BlacksitePlayerSnapshot
  mode: string
  prompt: string
}

async function view(page: Page): Promise<View> {
  const [s, hud] = await Promise.all([
    snap(page),
    page.evaluate(() => ({
      mode: document.getElementById('mode')?.textContent ?? '<no #mode>',
      prompt: document.getElementById('climb-prompt')?.textContent ?? '<no #climb-prompt>',
    })),
  ])
  return { me: local(s), ...hud }
}

const at = (p: { x: number; y: number; z: number; mode: string }) => `${p.mode} at ${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`

/** Polls the tab until `ok(view)` holds; the message shows the last view. */
async function until(tab: Tab, what: string, ok: (v: View) => boolean, timeout = WAIT_MS): Promise<View> {
  let last: View | undefined
  await expect
    .poll(
      async () => {
        last = await view(tab.page)
        return ok(last)
      },
      { message: `${tab.name}: ${what} (last: ${last ? `${at(last.me)}, #mode "${last.mode}", prompt "${last.prompt}"` : 'none'})`, timeout, ...POLL },
    )
    .toBe(true)
  return last!
}

/** Waits until the local player's x, y, z and mode stop changing (two reads 150 ms apart agree). */
async function settle(tab: Tab): Promise<View> {
  let prev = ''
  return until(tab, 'the local player comes to rest', (v) => {
    const key = at(v.me)
    const same = key === prev
    prev = key
    return same
  })
}

/** Holds `key` until `done(view)` holds, then releases it and lets the player settle. */
async function holdUntil(tab: Tab, key: string, what: string, done: (v: View) => boolean): Promise<View> {
  await tab.page.keyboard.down(key)
  try {
    await until(tab, what, done, HOLD_MS)
  } finally {
    await tab.page.keyboard.up(key)
  }
  return settle(tab)
}

/**
 * Walks the local player along one world axis to `target` (within `tol`) with
 * the movement keys only. The camera is never turned, so yaw is 0: W is +z, S
 * -z, D +x, A -x. Closed loop: hold toward the target until the hook shows it
 * reached, settle, and step back if the release overshot.
 */
async function walkAxis(tab: Tab, axis: 'x' | 'z', target: number, tol: number): Promise<View> {
  const keys = axis === 'x' ? { plus: 'KeyD', minus: 'KeyA' } : { plus: 'KeyW', minus: 'KeyS' }
  let v = await settle(tab)
  for (let i = 0; i < 6; i++) {
    const off = v.me[axis] - target
    if (Math.abs(off) <= tol) return v
    const sign = off < 0 ? 1 : -1
    // Release a little early on long walks: what is already sent still lands.
    const lead = Math.min(tol / 2, Math.abs(off) / 2)
    v = await holdUntil(tab, sign > 0 ? keys.plus : keys.minus, `walk ${axis} toward ${target}`, (w) => sign * (w.me[axis] - target) >= -lead)
  }
  expect(Math.abs(v.me[axis] - target), `${tab.name}: walked ${axis} to ${target} within ${tol} (at ${at(v.me)})`).toBeLessThanOrEqual(tol)
  return v
}

/** Records every action key press the test makes in one tab, paced inside the server's action budget. */
class Presser {
  readonly presses: { key: string; action: Action; t: number }[] = []
  private last = 0
  constructor(private readonly tab: Tab) {}

  private async pace(): Promise<void> {
    const wait = this.last + ACTION_GAP - Date.now()
    if (wait > 0) await this.tab.page.waitForTimeout(wait)
  }

  /** One press of `key`; `repeats` extra keydowns while it is held are auto-repeat (Playwright sets repeat). */
  async press(key: 'Space' | 'KeyE' | 'KeyC', action: Action, repeats = 0): Promise<void> {
    await this.pace()
    this.presses.push({ key, action, t: Date.now() })
    await this.tab.page.keyboard.down(key)
    for (let i = 0; i < repeats; i++) await this.tab.page.keyboard.down(key)
    await this.tab.page.keyboard.up(key)
    this.last = Date.now()
  }

  /** A press that must send nothing (a Ctrl combination). Checked on the wire after NO_SEND_MS. */
  async pressIgnored(combo: string): Promise<void> {
    await this.pace()
    const before = this.tab.sent.actions.length
    await this.tab.page.keyboard.press(combo)
    await this.tab.page.waitForTimeout(NO_SEND_MS)
    expect(this.tab.sent.actions.length, `${this.tab.name}: ${combo} sends no action`).toBe(before)
    this.last = Date.now()
  }
}

/**
 * Records every text the HUD's #mode and #climb-prompt take, in the page, as
 * they change (a MutationObserver; not a client change). Returns a function
 * that stops and returns the records, starting with the texts at start.
 */
async function recordHud(page: Page): Promise<() => Promise<{ mode: string; prompt: string }[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __qaHud: { mode: string; prompt: string }[]; __qaHudObs: MutationObserver }
    const read = () => ({ mode: document.getElementById('mode')!.textContent ?? '', prompt: document.getElementById('climb-prompt')!.textContent ?? '' })
    w.__qaHud = [read()]
    w.__qaHudObs = new MutationObserver(() => {
      const r = read()
      const last = w.__qaHud[w.__qaHud.length - 1]
      if (r.mode !== last.mode || r.prompt !== last.prompt) w.__qaHud.push(r)
    })
    for (const id of ['mode', 'climb-prompt']) {
      w.__qaHudObs.observe(document.getElementById(id)!, { childList: true, characterData: true, subtree: true })
    }
  })
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __qaHud: { mode: string; prompt: string }[]; __qaHudObs: MutationObserver }
      w.__qaHudObs.disconnect()
      return w.__qaHud
    })
}

/** The local player's distinct (x, y, z, mode) states from a tab's sampler. */
function ownTrack(samples: Sample[], id: string, bad: string[]): { x: number; y: number; z: number; mode: string }[] {
  const out: { x: number; y: number; z: number; mode: string }[] = []
  for (const s of samples) {
    const p = s.players.find((v) => v.id === id)
    if (!p) {
      bad.push(`local player ${id} missing from a sample`)
      continue
    }
    if (typeof p.y !== 'number' || typeof p.mode !== 'string') {
      bad.push(`hook y/mode for ${id}: ${String(p.y)}/${String(p.mode)}`)
      continue
    }
    const v = { x: p.x, y: p.y, z: p.z, mode: p.mode }
    const last = out[out.length - 1]
    if (!last || last.x !== v.x || last.y !== v.y || last.z !== v.z || last.mode !== v.mode) out.push(v)
  }
  return out
}

const dedupe = <T>(a: T[]) => a.filter((v, i) => i === 0 || a[i - 1] !== v)

/** Each sent action frame lines up with one press, in order, between it and the next press. */
function wireProblems(tab: Tab, p: Presser): string[] {
  const out: string[] = []
  const sent = tab.sent.actions
  if (sent.length !== p.presses.length) {
    out.push(`${sent.length} action frames for ${p.presses.length} presses: sent ${JSON.stringify(sent.map((s) => s.action))}, pressed ${JSON.stringify(p.presses.map((q) => q.action))}`)
  }
  p.presses.forEach((q, i) => {
    const s = sent[i]
    if (!s) return
    if (s.action !== q.action) out.push(`press ${i + 1} (${q.key}) sent ${JSON.stringify(s.action)}, not ${q.action}`)
    if (s.keys.join(',') !== 'action') out.push(`press ${i + 1} (${q.key}) sent fields ${s.keys.join(',')}: an action carries only "action"`)
    const next = p.presses[i + 1]
    if (s.t < q.t || (next && s.t >= next.t)) out.push(`press ${i + 1} (${q.key}) frame at ${s.t} is outside its press window ${q.t}..${next?.t ?? 'end'}`)
  })
  return out
}

test('M4 gate: by keys, a Ghost climbs climb-west, hangs, drops and mantles to the upper level; a Warden is refused at the anchor and takes the stairs; one action frame per press; forged SDK climbs are rejected', async ({ browser }) => {
  test.setTimeout(150_000)
  const rooms: GameRoom[] = []
  let a: Tab | undefined
  let b: Tab | undefined
  try {
    a = await openTab(browser, 'tab A (ghost)')
    const sa = await joined(a, { ghosts: 1, wardens: 0 })
    b = await openTab(browser, 'tab B (warden)')
    const sb = await joined(b, { ghosts: 1, wardens: 1 })
    const ghostTab = a
    const wardenTab = b
    expect(sa.localTeam, 'the 1st joiner of the fresh room is a Ghost').toBe('ghost')
    expect(sb.localTeam, 'the 2nd joiner is a Warden').toBe('warden')
    const idA = sa.sessionId!
    const idB = sb.sessionId!
    for (const t of [ghostTab, wardenTab]) {
      const v = await view(t.page)
      expect(v.me.yaw, `${t.name} spawns facing +z, so W is +z and D is +x`).toBe(0)
      expect((await snap(t.page)).camera?.yaw, `${t.name}'s camera starts at yaw 0`).toBe(0)
      expect(v.me.mode).toBe('ground')
      expect(v.mode, `${t.name}: #mode on the ground`).toBe(MODE_TEXT.ground)
      expect(v.prompt, `${t.name}: no climb prompt at the spawn`).toBe('')
    }
    const stopA = await startSampler(ghostTab.page, 25)
    const stopB = await startSampler(wardenTab.page, 25)
    const hudA = await recordHud(ghostTab.page)
    const hudB = await recordHud(wardenTab.page)
    const keysA = new Presser(ghostTab)
    const keysB = new Presser(wardenTab)

    // SDK: a Ghost and a Warden join the same room and send forged climbs from
    // their spawns, which are more than 2 units from every anchor. Runs while
    // the tabs walk; both leave before the tabs' records are checked.
    const forged = (async () => {
      const g = (await new Client(endpoint).joinOrCreate(ROOM_NAME)) as GameRoom
      rooms.push(g)
      await waitForState(g, 'the SDK ghost joins the tabs’ room', (s) => s.players.size === 3 && s.players.has(idA) && s.players.has(idB))
      const w = (await new Client(endpoint).joinOrCreate(ROOM_NAME)) as GameRoom
      rooms.push(w)
      // A Warden client is sent only itself and its teammates (tab B), not the Ghosts (#45).
      await waitForState(w, 'the SDK warden joins the tabs’ room', (s) => s.players.has(w.sessionId) && s.players.has(idB))
      const seen = [g, w].map((r) => ({ r, tr: track(r, r.sessionId), team: (r.state.players.get(r.sessionId) as unknown as { team: string }).team }))
      const problems: string[] = []
      if (seen[0].team !== 'ghost' || seen[1].team !== 'warden') problems.push(`SDK teams are ${seen[0].team} and ${seen[1].team}`)
      for (const { r } of seen) {
        const p = r.state.players.get(r.sessionId) as unknown as { x: number; z: number }
        const near = GRAYBOX_MAP.anchors.some((an) =>
          an.kind === 'climb' ? Math.hypot(an.x - p.x, an.z - p.z) < 2 : Math.min(Math.hypot(an.x0 - p.x, an.z0 - p.z), Math.hypot(an.x1 - p.x, an.z1 - p.z)) < 2,
        )
        if (near) problems.push(`${r.sessionId} spawned within 2 of an anchor`)
      }
      const payloads: object[] = [
        { action: 'climb' },
        { action: 'climb', anchorId: CLIMB_WEST.id },
        { action: 'climb', x: CLIMB_WEST.x, y: 0, z: CLIMB_WEST.z },
        { action: 'climb', anchorId: CLIMB_WEST.id, x: CLIMB_WEST.x, y: HANG_Y, z: CLIMB_WEST.z, mode: 'hanging' },
        { action: 'climb', ledgeId: LEDGE_WEST.id, mode: 'climbing' },
        { action: 'climb', team: 'ghost', anchorId: 'climb-east' },
      ]
      for (const payload of payloads) {
        for (const { r } of seen) r.send(ACTION_MESSAGE, payload)
        await new Promise((res) => setTimeout(res, 300)) // inside the 5/s action budget, so none is dropped for rate
      }
      // Give the last one time to show any effect (several 20 Hz patches).
      await new Promise((res) => setTimeout(res, 300))
      for (const { r, tr } of seen) {
        if (tr.samples.length !== 1) problems.push(`${r.sessionId}: forged climbs changed its state: ${tr.samples.map(at).join('; ')}`)
        if (tr.samples[0]?.mode !== 'ground' || Math.abs(tr.samples[0]?.y ?? 1) > EPS) problems.push(`${r.sessionId}: not on the ground at y 0: ${tr.samples.map(at).join('; ')}`)
        problems.push(...tr.bad)
        if (!r.connection.isOpen) problems.push(`${r.sessionId} was disconnected`)
      }
      for (const r of rooms.splice(0)) await leaveQuietly(r)
      return problems
    })()
    forged.catch(() => {}) // awaited below

    const ghost = async () => {
      // E far from every anchor: nothing happens, no prompt.
      await keysA.press('KeyE', 'climb')
      await ghostTab.page.waitForTimeout(NO_SEND_MS)
      let v = await settle(ghostTab)
      expect(v.me.mode, 'E at the spawn, far from every anchor, does nothing').toBe('ground')
      expect(Math.abs(v.me.y)).toBeLessThan(EPS)
      // Out to the yard west of the building, then north to a plain stretch of the west wall.
      await walkAxis(ghostTab, 'x', YARD_X, 0.2)
      await walkAxis(ghostTab, 'z', PLAIN_WALL_Z, 0.3)
      v = await holdUntil(ghostTab, 'KeyD', 'push flush against the west wall', (w) => w.me.x >= FLUSH_X - EPS)
      expect(Math.abs(v.me.x - FLUSH_X), `flush against the west wall at x ${FLUSH_X}`).toBeLessThan(EPS)
      expect(v.prompt, 'no climb prompt at a plain wall').toBe('')
      // E against a plain wall: no climb (rule 5, authored anchors only).
      await keysA.press('KeyE', 'climb')
      await ghostTab.page.waitForTimeout(NO_SEND_MS)
      v = await settle(ghostTab)
      expect(v.me.mode, 'E flush against a plain wall does nothing').toBe('ground')
      expect(Math.abs(v.me.y), 'and the ghost stays at y 0').toBeLessThan(EPS)
      // Space: a jump goes up and comes back down to the ground (checked in the record).
      await keysA.press('Space', 'jump')
      await until(ghostTab, 'the jump lands', (w) => w.me.mode === 'ground' && Math.abs(w.me.y) < EPS)
      // North along the wall (flush, yaw 0, so x stays put) to climb-west.
      const want = CLIMB_WEST.z
      v = await walkAxis(ghostTab, 'z', want, 0.3)
      expect(Math.abs(v.me.x - FLUSH_X), 'walked north flush along the wall').toBeLessThan(EPS)
      expect(Math.hypot(v.me.x - CLIMB_WEST.x, v.me.z - CLIMB_WEST.z), 'in range of climb-west').toBeLessThan(ANCHOR_RANGE)
      v = await until(ghostTab, 'the climb prompt shows at climb-west', (w) => w.prompt === PROMPT)
      expect(v.mode).toBe(MODE_TEXT.ground)

      // E (held, with two auto-repeat keydowns): one climb, attached to the anchor.
      await keysA.press('KeyE', 'climb', 2)
      v = await until(ghostTab, 'E attaches to climb-west', (w) => w.me.mode === 'climbing')
      expect(Math.abs(v.me.x - CLIMB_WEST.x) + Math.abs(v.me.z - CLIMB_WEST.z), `climbing on the anchor (${at(v.me)})`).toBeLessThan(EPS)
      await until(ghostTab, 'the HUD shows climbing and no prompt', (w) => w.mode === MODE_TEXT.climbing && w.prompt === '')
      // Hold W until hanging from ledge-west-wall.
      v = await holdUntil(ghostTab, 'KeyW', 'W climbs to hanging', (w) => w.me.mode === 'hanging')
      expect(v.me.mode).toBe('hanging')
      expect(Math.abs(v.me.y - HANG_Y), `hanging at feet ${HANG_Y} (${at(v.me)})`).toBeLessThan(EPS)
      expect(Math.abs(v.me.x - CLIMB_WEST.x) + Math.abs(v.me.z - CLIMB_WEST.z), 'hanging at the top of the anchor').toBeLessThan(EPS)
      await until(ghostTab, 'the HUD shows hanging and no prompt', (w) => w.mode === MODE_TEXT.hanging && w.prompt === '')
      // Ctrl+C is a browser shortcut, not a drop.
      await keysA.pressIgnored('Control+KeyC')
      v = await view(ghostTab.page)
      expect(v.me.mode, 'still hanging after Ctrl+C').toBe('hanging')

      // C: drop. Falling, then on the ground below the ledge at a lower y.
      const hangY = v.me.y
      await keysA.press('KeyC', 'drop')
      v = await until(ghostTab, 'C drops to the ground', (w) => w.me.mode === 'ground')
      expect(v.me.y, 'landed lower than it hung').toBeLessThan(hangY - 1)
      expect(Math.abs(v.me.y), 'landed on the ground at y 0').toBeLessThan(EPS)
      await until(ghostTab, 'the HUD shows the ground and the prompt again', (w) => w.mode === MODE_TEXT.ground && w.prompt === PROMPT)

      // E and W again, then D shimmies along the ledge (toward -z: dx follows the ledge's facing, east).
      await keysA.press('KeyE', 'climb')
      await until(ghostTab, 'E attaches to climb-west again', (w) => w.me.mode === 'climbing')
      v = await holdUntil(ghostTab, 'KeyW', 'W climbs to hanging again', (w) => w.me.mode === 'hanging')
      const z0 = v.me.z
      v = await holdUntil(ghostTab, 'KeyD', 'D shimmies along the ledge', (w) => w.me.z <= z0 - 0.4)
      expect(v.me.mode, 'still hanging after the shimmy').toBe('hanging')
      expect(Math.abs(v.me.y - HANG_Y) + Math.abs(v.me.x - LEDGE_WEST.x0), `shimmied along the ledge (${at(v.me)})`).toBeLessThan(EPS)
      expect(v.me.z, 'still on the ledge segment').toBeGreaterThanOrEqual(Math.min(LEDGE_WEST.z0, LEDGE_WEST.z1) - EPS)
      expect(v.mode).toBe(MODE_TEXT.hanging)

      // For humans: the ghost's third-person view while hanging (no pixel comparison).
      mkdirSync(REPORTS, { recursive: true })
      await ghostTab.page.setViewportSize(SHOT_VIEWPORT)
      try {
        await ghostTab.page.evaluate(() => new Promise<void>((r) => { let n = 10; const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) }))
        const png = await ghostTab.page.screenshot({ path: HANGING_SHOT })
        await test.info().attach('m4-ghost-hanging', { body: png, contentType: 'image/png' })
        expect(png.length, 'a rendered scene, not an empty page').toBeGreaterThan(10_000)
      } finally {
        await ghostTab.page.setViewportSize(VIEWPORT)
      }

      // E mantles onto the mezzanine: the upper level, in ground mode.
      const hz = v.me.z
      await keysA.press('KeyE', 'climb')
      v = await until(ghostTab, 'E mantles onto the upper level', (w) => w.me.mode === 'ground')
      v = await settle(ghostTab)
      expect(Math.abs(v.me.y - UPPER_LEVEL_Y), `standing on the upper level (${at(v.me)})`).toBeLessThan(EPS)
      expect(Math.abs(v.me.x - (LEDGE_WEST.x0 + MANTLE_DISTANCE * Math.sin(LEDGE_WEST.facing))) + Math.abs(v.me.z - hz), `mantled ${MANTLE_DISTANCE} east of the hang point`).toBeLessThan(EPS)
      expect(inRect(v.me, { minX: MEZZ.min.x, maxX: MEZZ.max.x, minZ: MEZZ.min.z, maxZ: MEZZ.max.z }), 'over the mezzanine').toBe(true)
      expect(v.mode).toBe(MODE_TEXT.ground)
      expect(v.prompt).toBe('')
    }

    const warden = async () => {
      // Out through the west door and north to climb-west.
      await walkAxis(wardenTab, 'z', LANE_Z, 0.3)
      await walkAxis(wardenTab, 'x', YARD_X, 0.2)
      await walkAxis(wardenTab, 'z', CLIMB_WEST.z, 0.3)
      let v = await holdUntil(wardenTab, 'KeyD', 'push flush against the west wall at climb-west', (w) => w.me.x >= FLUSH_X - EPS)
      expect(Math.hypot(v.me.x - CLIMB_WEST.x, v.me.z - CLIMB_WEST.z), `the warden is in range of climb-west (${at(v.me)})`).toBeLessThan(ANCHOR_RANGE)
      expect(v.prompt, 'a Warden never sees the climb prompt').toBe('')
      const spot = v.me
      // E (with auto-repeat), Space and C at the anchor: nothing changes.
      await keysB.press('KeyE', 'climb', 2)
      await keysB.press('Space', 'jump')
      await keysB.press('KeyC', 'drop')
      await keysB.press('KeyE', 'climb')
      await wardenTab.page.waitForTimeout(NO_SEND_MS)
      v = await settle(wardenTab)
      expect(v.me.mode, 'the warden stays in ground mode at the anchor').toBe('ground')
      expect(at(v.me), 'the warden did not move or rise at the anchor').toBe(at(spot))
      expect(v.prompt).toBe('')
      expect(v.mode).toBe(MODE_TEXT.ground)

      // Back inside through the west door and up the stairs.
      await walkAxis(wardenTab, 'z', LANE_Z, 0.3)
      await walkAxis(wardenTab, 'x', STAIRS_X, 0.25)
      v = await holdUntil(wardenTab, 'KeyW', 'W walks up the stairs to the landing', (w) => w.me.y >= UPPER_LEVEL_Y - EPS && w.me.z >= LANDING.min.z + PLAYER_HALF_SIZE)
      expect(v.me.mode).toBe('ground')
      expect(Math.abs(v.me.y - UPPER_LEVEL_Y), `the warden is on the upper level (${at(v.me)})`).toBeLessThan(EPS)
      expect(inRect(v.me, { minX: LANDING.min.x, maxX: LANDING.max.x, minZ: LANDING.min.z, maxZ: LANDING.max.z }), `on landing-nw (${at(v.me)})`).toBe(true)
      expect(v.prompt).toBe('')
    }

    await Promise.all([ghost(), warden()])
    const forgedProblems = await forged

    // Records, checked once the SDK clients are gone.
    const samples = { ghost: await stopA(), warden: await stopB() }
    const huds = { ghost: await hudA(), warden: await hudB() }
    const bad: string[] = [...forgedProblems.map((p) => `SDK: ${p}`)]

    // The Ghost: above jump height only after hanging from the anchor.
    const gv = ownTrack(samples.ghost, idA, bad)
    const gModes = dedupe(gv.map((v) => v.mode))
    expect(gModes, `the ghost's modes: ${gv.map(at).join('; ')}`).toEqual([
      'ground', 'falling', 'ground', // the jump at the plain wall
      'climbing', 'hanging', 'falling', 'ground', // climb, hang, drop
      'climbing', 'hanging', 'ground', // climb, hang, shimmy, mantle
    ])
    const firstClimb = gv.findIndex((v) => v.mode === 'climbing')
    const jumpTop = Math.max(...gv.slice(0, firstClimb).filter((v) => v.mode === 'falling').map((v) => v.y))
    expect(jumpTop, 'the jump left the ground').toBeGreaterThan(0.2)
    gv.forEach((v, i) => {
      const prev = gv[i - 1]
      if (v.mode === 'ground' && Math.abs(v.y) > EPS && Math.abs(v.y - UPPER_LEVEL_Y) > EPS) bad.push(`ghost ${at(v)}: standing in mid-air`)
      if (v.mode === 'ground' && Math.abs(v.y - UPPER_LEVEL_Y) < EPS && prev && prev.y < UPPER_LEVEL_Y - EPS && prev.mode !== 'hanging') bad.push(`ghost ${at(v)}: reached the upper level from ${at(prev)}, not from a hang`)
      if (v.mode === 'falling' && v.y > HANG_Y + EPS) bad.push(`ghost ${at(v)}: in the air above the hang height`)
      if (v.mode === 'climbing' && (Math.abs(v.x - CLIMB_WEST.x) + Math.abs(v.z - CLIMB_WEST.z) > EPS || v.y < CLIMB_WEST.minY - EPS || v.y > CLIMB_WEST.maxY + EPS)) bad.push(`ghost ${at(v)}: climbing off climb-west`)
      if (v.mode === 'hanging' && (Math.abs(v.y - HANG_Y) > EPS || Math.abs(v.x - LEDGE_WEST.x0) > EPS)) bad.push(`ghost ${at(v)}: hanging off ledge-west-wall`)
      if (prev && v.mode === 'climbing' && prev.mode === 'climbing' && v.y < prev.y - EPS) bad.push(`ghost ${at(v)}: W climbed down`)
    })
    const dropFall = gv.filter((v, i) => v.mode === 'falling' && gv.slice(0, i).some((u) => u.mode === 'hanging'))
    if (dropFall.some((v, i) => i > 0 && v.y > dropFall[i - 1].y + EPS)) bad.push(`ghost: the drop went up: ${dropFall.map(at).join('; ')}`)

    // The ghost's HUD followed the same modes, and the prompt showed only near the anchor while not attached.
    const gHudModes = dedupe(huds.ghost.map((h) => h.mode))
    expect(gHudModes, 'the ghost HUD’s #mode texts').toEqual(gModes.map((m) => MODE_TEXT[m as MovementMode]))
    for (const h of huds.ghost) {
      if (h.prompt !== '' && h.prompt !== PROMPT) bad.push(`ghost prompt "${h.prompt}"`)
      if (h.prompt === PROMPT && h.mode !== MODE_TEXT.ground && h.mode !== MODE_TEXT.falling) bad.push(`ghost prompt shown with #mode "${h.mode}"`)
    }
    expect(dedupe(huds.ghost.map((h) => h.prompt)), 'the ghost’s prompt: none, at climb-west, none while attached, after the drop, none').toEqual(['', PROMPT, '', PROMPT, ''])

    // The Warden: in ground mode the whole way, never above the stairs' surface, ending on the upper level.
    const wv = ownTrack(samples.warden, idB, bad)
    expect(dedupe(wv.map((v) => v.mode)), `the warden's modes: ${wv.filter((v) => v.mode !== 'ground').map(at).join('; ')}`).toEqual(['ground'])
    wv.forEach((v, i) => {
      const onStairs = inRect(v, { minX: STAIRS.minX - PLAYER_HALF_SIZE, maxX: STAIRS.maxX + PLAYER_HALF_SIZE, minZ: STAIRS.minZ - PLAYER_HALF_SIZE, maxZ: STAIRS.maxZ + PLAYER_HALF_SIZE })
      if (Math.abs(v.y) > EPS && !onStairs && Math.abs(v.y - UPPER_LEVEL_Y) > EPS) bad.push(`warden ${at(v)}: off the ground away from the stairs`)
      if (i > 0 && v.y < wv[i - 1].y - EPS) bad.push(`warden ${at(v)}: y dropped`)
    })
    expect(wv.some((v) => v.y > 0.5 && v.y < UPPER_LEVEL_Y - 0.5), 'the warden was seen part way up the stairs').toBe(true)
    expect(Math.abs(wv[wv.length - 1].y - UPPER_LEVEL_Y), 'the warden ends on the upper level').toBeLessThan(EPS)
    const wHud = huds.warden
    expect([...new Set(wHud.map((h) => h.prompt))], 'the warden never sees a climb prompt').toEqual([''])
    expect([...new Set(wHud.map((h) => h.mode))], 'the warden’s #mode is always on the ground').toEqual([MODE_TEXT.ground])

    // The wire: one { action } per press, in press order, nothing else.
    bad.push(...wireProblems(ghostTab, keysA).map((p) => `ghost wire: ${p}`))
    bad.push(...wireProblems(wardenTab, keysB).map((p) => `warden wire: ${p}`))
    expect(keysA.presses.map((p) => p.action)).toEqual(['climb', 'climb', 'jump', 'climb', 'drop', 'climb', 'climb'])
    expect(keysB.presses.map((p) => p.action)).toEqual(['climb', 'jump', 'drop', 'climb'])
    for (const t of [ghostTab, wardenTab]) {
      bad.push(...t.sent.errors.map((e) => `${t.name} frame: ${e}`))
      for (const m of t.sent.moves) if (m.keys.join(',') !== 'dx,dz,yaw') bad.push(`${t.name} sent a move with fields ${m.keys.join(',')}`)
    }
    expect(bad, 'every recorded problem').toEqual([])
    expect(ghostTab.errors).toEqual([])
    expect(wardenTab.errors).toEqual([])
  } finally {
    for (const r of rooms) await leaveQuietly(r)
    await closeTabs(a, b)
  }
})
