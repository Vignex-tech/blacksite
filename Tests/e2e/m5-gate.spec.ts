import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EYE_HEIGHT, MAX_HEALTH, WEAPONS } from '../../shared/protocol.js'
import { closeTabs, get, holdKey, joined, local, lockPointer, openTab, RAD_PER_PIXEL, snap, turnTo, type Tab } from './support/tabs.js'
import { eyeOf, hasLineOfSight, visibilityOf } from './support/visibility.js'
import { hookVitals } from './support/vitals.js'

// The M5 gate in real tabs (#51, tracking #38). A Ghost tab and a Warden tab,
// driven by keys and the mouse only (no SDK client): the Warden aims with the
// mouse, fires with the left button and reloads with R, and the Ghost tab is
// the target. What each step proves is listed in the closing comment of #51:
//  - the locking click fires nothing; a shot with a wall in between changes
//    nothing but the Warden's own ammo;
//  - the wire carries { yaw, pitch } only, pitch positive up;
//  - one press fires one shot, rifle damage in both tabs' state, the hit and
//    damaged event counters appear in the hook (pixels are not compared);
//  - R reloads once: the HUD shows Reloading... then full ammo;
//  - holding the button cannot exceed the weapon's fire rate;
//  - the Warden kills the Ghost with the mouse; the Ghost tab shows
//    Eliminated and its keys and mouse do nothing; the Warden tab still
//    holds the body (health <= 0), and a further shot at it changes nothing.
// Tabs are 320x240 (tabs.ts VIEWPORT) and use the pointer-lock stand-in
// (lockPointer / mouse events on the document). Every position is read from
// the Ghost tab, which is sent everyone (the visibility filter hides a Ghost
// from the Warden tab unless it is near or in sight).

const REPORTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'Reports')
const RIFLE = WEAPONS.warden
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** Holds A or D (camera-relative, yaw 0) until the local player's x is within 0.25 of `target`, in a closed loop. */
async function strafeTo(tab: Tab, target: number): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const x = local(await snap(tab.page)).x
    if (Math.abs(x - target) <= 0.25) return x
    const key = target > x ? 'KeyD' : 'KeyA'
    await tab.page.keyboard.down(key)
    try {
      const started = Date.now()
      while (Date.now() - started < 6000) {
        const cur = local(await snap(tab.page)).x
        if (key === 'KeyD' ? cur >= target - 0.1 : cur <= target + 0.1) break
        await sleep(15)
      }
    } finally {
      await tab.page.keyboard.up(key)
    }
    await sleep(120)
  }
  return local(await snap(tab.page)).x
}

/**
 * Left-button event on the canvas, bubbling to the window like the browser's own.
 * Playwright's page.mouse never reached the page's window listeners once the
 * pointer-lock stand-in was in place (probed in #51), so, like moveMouse, the
 * event is dispatched in the page; the client's handlers are the real ones.
 */
const mouseButton = (tab: Tab, type: 'mousedown' | 'mouseup') =>
  tab.page.evaluate((t) => {
    document.getElementById('game-canvas')!.dispatchEvent(new MouseEvent(t, { button: 0, bubbles: true, cancelable: true }))
  }, type)

/** Presses the left button for `ms`, with the pointer at the canvas centre. */
async function holdFire(tab: Tab, ms: number, during?: () => Promise<void>): Promise<{ t0: number; t1: number }> {
  await mouseButton(tab, 'mousedown')
  const t0 = Date.now()
  try {
    await sleep(Math.min(ms, 400))
    if (during) await during()
    const rest = ms - (Date.now() - t0)
    if (rest > 0) await sleep(rest)
  } finally {
    await mouseButton(tab, 'mouseup')
  }
  return { t0, t1: Date.now() }
}

/** Mouse-Y movement of `pixels` (positive looks down), as a locked mouse would send. */
const tilt = (tab: Tab, pixels: number) =>
  tab.page.evaluate((py) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: py, bubbles: true })), pixels)

test('M5 gate: the Warden shoots, reloads and eliminates the Ghost with the mouse; the Ghost tab goes dead', async ({ browser }) => {
  test.setTimeout(120_000)
  let ghostTab: Tab | undefined
  let wardenTab: Tab | undefined
  try {
    ghostTab = await openTab(browser, 'ghost tab')
    const g0 = await joined(ghostTab, { ghosts: 1, wardens: 0 })
    wardenTab = await openTab(browser, 'warden tab')
    const w0 = await joined(wardenTab, { ghosts: 1, wardens: 1 })
    const gt = ghostTab
    const wt = wardenTab
    const ghostId = g0.sessionId!
    const wardenId = w0.sessionId!
    expect([g0.localTeam, w0.localTeam]).toEqual(['ghost', 'warden'])

    const ghostAs = async () => get(await snap(gt.page), ghostId)
    const wardenAs = async () => get(await snap(gt.page), wardenId)
    const ghostSeenByWarden = async () => (await snap(wt.page)).players.find((p) => p.id === ghostId)

    // 1. The click that locks the pointer fires nothing.
    await lockPointer(wt)
    await lockPointer(gt)
    await sleep(300)
    expect(wt.sent.fires, 'the locking click fired').toHaveLength(0)
    expect(gt.sent.fires).toHaveLength(0)
    expect((await ghostAs()).health).toBe(MAX_HEALTH.ghost)

    // 2. Ghost behind the wall (x about 5.5), Warden on x = 0, then a shot aimed
    // through the wall with the camera looking up: wire pitch is positive.
    await strafeTo(gt, 5.5)
    await strafeTo(wt, 0)
    const wallGhost = await ghostAs()
    const wallWarden = await wardenAs()
    const wallClass = visibilityOf({ x: wallWarden.x, y: wallWarden.y, z: wallWarden.z }, { x: wallGhost.x, y: wallGhost.y, z: wallGhost.z })
    expect(wallClass, 'the Ghost is hidden behind the wall from the Warden').toBe('hidden')
    await sleep(300)
    expect(await ghostSeenByWarden(), 'the Warden tab is not sent a hidden Ghost').toBeUndefined()
    const wallYaw = Math.atan2(wallGhost.x - wallWarden.x, wallGhost.z - wallWarden.z)
    await turnTo(wt, wallYaw)
    await tilt(wt, -100) // look up 0.25 rad
    const ammoBeforeWall = hookVitals(await snap(wt.page), wardenId)!.ammo!
    const eventsBeforeWall = (await snap(wt.page)).events
    await holdFire(wt, 120)
    await sleep(500)
    const afterWall = {
      ghostHealth: (await ghostAs()).health,
      warden: await snap(wt.page),
      ghostTab: await snap(gt.page),
      fires: wt.sent.fires.slice(),
    }
    await tilt(wt, 100) // level again
    expect(afterWall.ghostHealth, 'a shot through the wall hurt nobody').toBe(MAX_HEALTH.ghost)
    expect(afterWall.warden.events.hits).toBe(eventsBeforeWall.hits)
    expect(hookVitals(afterWall.warden, wardenId)!.ammo, 'the shot still spent a round').toBeLessThan(ammoBeforeWall)
    expect(afterWall.ghostTab.events.damaged).toBe(0)
    expect(afterWall.fires).toHaveLength(1)
    expect(afterWall.fires[0].keys, 'a fire message carries only yaw and pitch').toEqual(['pitch', 'yaw'])
    expect(afterWall.fires[0].pitch as number, 'looking up is a positive pitch on the wire').toBeCloseTo(100 * RAD_PER_PIXEL, 6)
    expect(Math.abs(wrap((afterWall.fires[0].yaw as number) - wallYaw))).toBeLessThan(RAD_PER_PIXEL)

    // 3. The Ghost steps into the doorway line; the Warden aims at its upper body.
    await strafeTo(gt, 0)
    await sleep(200)
    const target = await ghostAs()
    const warden = await wardenAs()
    const aimY = 1.2
    const eye = eyeOf({ x: warden.x, y: warden.y, z: warden.z })
    expect(hasLineOfSight(eye, { x: target.x, y: aimY, z: target.z }), 'clear line from the Warden eye to the Ghost').toBe(true)
    expect(visibilityOf(warden, target)).not.toBe('hidden')
    await expect
      .poll(async () => (await ghostSeenByWarden())?.team, { message: 'the Warden tab is now sent the Ghost', timeout: 10_000 })
      .toBe('ghost')
    const yaw = Math.atan2(target.x - warden.x, target.z - warden.z)
    await turnTo(wt, yaw)
    const dist = Math.hypot(target.x - warden.x, target.z - warden.z)
    const wantPitch = Math.atan2(aimY - (warden.y + EYE_HEIGHT), dist) // wire convention: positive up
    await tilt(wt, Math.round(-wantPitch / RAD_PER_PIXEL))
    const firesBefore = wt.sent.fires.length

    // 4. One press, one shot: rifle damage in both tabs' state, the hit and damage events in the hook.
    await holdFire(wt, 110)
    await expect
      .poll(async () => (await ghostAs()).health, { message: 'the Ghost lost rifle damage', timeout: 5_000 })
      .toBe(MAX_HEALTH.ghost - RIFLE.damage)
    await expect.poll(async () => (await ghostSeenByWarden())?.health, { timeout: 5_000 }).toBe(MAX_HEALTH.ghost - RIFLE.damage)
    await expect.poll(async () => (await snap(gt.page)).events.damaged, { timeout: 5_000 }).toBe(1)
    const oneShot = {
      warden: await snap(wt.page),
      ghostTab: await snap(gt.page),
      newFires: wt.sent.fires.slice(firesBefore),
      ghostOwn: hookVitals(await snap(gt.page), ghostId),
    }
    expect(oneShot.warden.events.hits, 'the shooter got a hit event').toBe(1)
    expect(oneShot.warden.events.kills).toBe(0)
    expect(oneShot.ghostTab.events.damaged, 'the victim got a damage notice').toBe(1)
    expect(oneShot.ghostTab.events.shots, 'a rifle shot is announced to the Ghost').toBeGreaterThanOrEqual(1)
    expect(oneShot.ghostOwn!.health).toBe(MAX_HEALTH.ghost - RIFLE.damage)
    expect(oneShot.newFires.length, 'one press of about 110 ms sent one fire message').toBe(1)
    expect(oneShot.newFires[0].pitch as number, 'aiming down at a lower target is a negative wire pitch').toBeCloseTo(wantPitch, 2)
    expect(oneShot.newFires[0].pitch as number).toBeLessThan(0)
    expect(oneShot.newFires[0].keys).toEqual(['pitch', 'yaw'])
    const ammoAfterShot = hookVitals(oneShot.warden, wardenId)!.ammo!
    expect(ammoAfterShot, 'one round spent since the wall shot').toBe(ammoBeforeWall - 2)

    // 5. R reloads once: the HUD shows Reloading... then full ammo.
    const reloadsBefore = wt.sent.reloads.length
    await wt.page.keyboard.down('KeyR')
    await sleep(120)
    await wt.page.keyboard.up('KeyR')
    await expect(wt.page.locator('#ammo')).toHaveText('Reloading...', { timeout: 3_000 })
    await expect(wt.page.locator('#ammo')).toHaveText(`Ammo ${RIFLE.magazine}/${RIFLE.magazine}`, { timeout: RIFLE.reloadMs + 3_000 })
    expect(wt.sent.reloads.length - reloadsBefore, 'one press, one reload message').toBe(1)
    expect(wt.sent.reloads[reloadsBefore].keys).toEqual([])

    // 6. Holding the button cannot beat the weapon's fire rate; the held fire kills the Ghost.
    const firesBeforeHold = wt.sent.fires.length
    const ammoBeforeHold = hookVitals(await snap(wt.page), wardenId)!.ammo!
    mkdirSync(REPORTS, { recursive: true })
    const held = await holdFire(wt, 1500, async () => {
      await wt.page.screenshot({ path: join(REPORTS, 'graybox-m5-warden-firing.png') })
    })
    await expect(gt.page.locator('#health')).toHaveText('Eliminated', { timeout: 5_000 })
    await sleep(400)
    const heldMs = held.t1 - held.t0
    const cap = Math.floor((heldMs + 150) / RIFLE.intervalMs) + 1
    const afterHold = {
      ammo: hookVitals(await snap(wt.page), wardenId)!.ammo!,
      warden: await snap(wt.page),
      ghostTab: await snap(gt.page),
      sent: wt.sent.fires.length - firesBeforeHold,
      seen: await ghostSeenByWarden(),
    }
    const spent = ammoBeforeHold - afterHold.ammo
    const needed = (MAX_HEALTH.ghost - RIFLE.damage) / RIFLE.damage
    expect(spent, `rounds spent in a ${heldMs} ms hold`).toBeLessThanOrEqual(cap)
    expect(spent, 'the hold fired steadily').toBeGreaterThanOrEqual(needed)
    expect(afterHold.sent, 'fire messages are paced to the weapon').toBeLessThanOrEqual(cap)
    expect(afterHold.warden.events.hits).toBe(1 + needed)
    expect(afterHold.warden.events.kills, 'one kill').toBe(1)
    expect(afterHold.ghostTab.events.damaged).toBe(1 + needed)
    expect(hookVitals(afterHold.ghostTab, ghostId)!.health).toBeLessThanOrEqual(0)
    expect(afterHold.seen?.health, 'the Warden tab holds the dead body').toBeLessThanOrEqual(0)
    expect(afterHold.ghostTab.events.shots).toBeGreaterThanOrEqual(1 + needed)

    // 7. The Ghost tab is dead: keys and mouse do nothing.
    const dead = await ghostAs()
    const ghostFires = gt.sent.fires.length
    const ghostReloads = gt.sent.reloads.length
    const ghostActions = gt.sent.actions.length
    await holdKey(gt.page, 'KeyW', 400)
    await holdKey(gt.page, 'KeyD', 300)
    await holdFire(gt, 300)
    await gt.page.keyboard.press('KeyR', { delay: 80 })
    await gt.page.keyboard.press('Space', { delay: 80 })
    await sleep(300)
    const deadAfter = await ghostAs()
    expect(gt.sent.fires.length, 'a dead Ghost sent no fire').toBe(ghostFires)
    expect(gt.sent.reloads.length, 'a dead Ghost sent no reload').toBe(ghostReloads)
    expect(gt.sent.actions.length).toBe(ghostActions + 1) // the Space press is only a message; the server ignores it
    expect(deadAfter.x).toBeCloseTo(dead.x, 4)
    expect(deadAfter.z).toBeCloseTo(dead.z, 4)
    expect(deadAfter.y).toBeCloseTo(dead.y, 4)
    await expect(gt.page.locator('#health')).toHaveText('Eliminated')
    await expect(gt.page.locator('#ammo')).toHaveText('')

    // 8. A further shot at the body changes nothing.
    const hitsBefore = (await snap(wt.page)).events.hits
    await holdFire(wt, 150)
    await sleep(400)
    const final = await snap(wt.page)
    expect(final.events.hits, 'a dead Ghost cannot be shot').toBe(hitsBefore)
    expect(final.events.kills).toBe(1)

    expect(gt.errors, 'ghost tab errors').toEqual([])
    expect(wt.errors, 'warden tab errors').toEqual([])
  } finally {
    await closeTabs(ghostTab, wardenTab)
  }
})
