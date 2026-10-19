import { expect, test } from '@playwright/test'
import { EYE_HEIGHT, FIRE_MESSAGE, MAX_HEALTH, SHOT_EVENT, HIT_EVENT, DAMAGED_EVENT, WEAPONS } from '../../shared/protocol.js'
import { Walker, leaveQuietly, pos } from './support/sdk.js'
import { Observer } from './support/observer.js'
import { closeTabs, get, holdKey, joined, local, openTab, snap, type Tab } from './support/tabs.js'
import { eyeOf, hasLineOfSight, visibilityOf } from './support/visibility.js'
import { hookVitals } from './support/vitals.js'

// M5 weapon HUD, crosshair, hook vitals, visibility in the Warden tab and the
// eliminated look in two real tabs (#49, covering #48 and #46/#47). Unit tests
// (Tests/unit/hud.test.ts) cover the rules and the meshes; this is the browser
// check. Tabs run at 320x240 (tabs.ts VIEWPORT).
//
// What it cannot do: the page exposes no scene or mesh list (only the test hook
// snapshot), so "the meshes do not contain the Ghost" is checked through the
// hook, which the client updates in the same call as the renderer
// (testHook.wrapView), and the mesh removal / fresh mesh / grey body themselves
// are unit-tested on the real renderer. The "grey body drawn in the other tab"
// is checked as that tab's hook showing the player at health <= 0.
//
// Players: a Ghost tab joins first, a Warden tab second, then an SDK Ghost
// (the observer helper) joins third. The SDK Ghost walks in from behind the
// south wall (hidden from the Warden tab), reaches a spot with a clear shot and
// shoots the Warden tab's player until eliminated (no key binding fires yet,
// #50). The Warden tab does not move on its own. Problems are collected and
// asserted once, after the SDK client has left (Docs/handoff.md).

test('overhead: with no connection the crosshair is hidden and both readouts are empty', async ({ browser }) => {
  let tab: Tab | undefined
  try {
    tab = await openTab(browser, 'offline', {
      // Matchmaking fails, so the client never joins and stays on the overhead camera.
      beforeGoto: async (page) => {
        await page.route('**/matchmake/**', (route) => route.abort())
      },
    })
    await expect.poll(async () => (await snap(tab!.page)).camera?.mode, { timeout: 10_000 }).toBe('overhead')
    await expect(tab.page.locator('#hud')).toContainText('offline', { timeout: 10_000 })
    const result = await tab.page.evaluate(() => ({
      crosshairHidden: (document.getElementById('crosshair') as HTMLElement).hidden,
      health: document.getElementById('health')!.textContent,
      ammo: document.getElementById('ammo')!.textContent,
    }))
    expect(result).toEqual({ crosshairHidden: true, health: '', ammo: '' })
  } finally {
    await closeTabs(tab)
  }
})

test('two tabs: full HUD and crosshair per team, the Warden tab sees the Ghost only in sight, and an eliminated Warden shows Eliminated and a dead body', async ({ browser }) => {
  test.setTimeout(90_000)
  let ghostTab: Tab | undefined
  let wardenTab: Tab | undefined
  let obs: Observer | undefined
  try {
    ghostTab = await openTab(browser, 'ghost tab')
    const g0 = await joined(ghostTab, { ghosts: 1, wardens: 0 })
    wardenTab = await openTab(browser, 'warden tab')
    const w0 = await joined(wardenTab, { ghosts: 1, wardens: 1 })
    expect(g0.localTeam).toBe('ghost')
    expect(w0.localTeam).toBe('warden')
    const wardenId = w0.sessionId!
    const ghostTabId = g0.sessionId!

    // 1. Full health and ammo with the right maximums, crosshair present (third and first person).
    const readout = (tab: Tab) =>
      tab.page.evaluate(() => ({
        health: document.getElementById('health')!.textContent,
        ammo: document.getElementById('ammo')!.textContent,
        crosshairHidden: (document.getElementById('crosshair') as HTMLElement).hidden,
      }))
    await expect.poll(() => readout(ghostTab!), { timeout: 10_000 }).toEqual({
      health: `HP ${MAX_HEALTH.ghost}/${MAX_HEALTH.ghost}`,
      ammo: `Ammo ${WEAPONS.ghost.magazine}/${WEAPONS.ghost.magazine}`,
      crosshairHidden: false,
    })
    await expect.poll(() => readout(wardenTab!), { timeout: 10_000 }).toEqual({
      health: `HP ${MAX_HEALTH.warden}/${MAX_HEALTH.warden}`,
      ammo: `Ammo ${WEAPONS.warden.magazine}/${WEAPONS.warden.magazine}`,
      crosshairHidden: false,
    })
    const modes = [(await snap(ghostTab.page)).camera?.mode, (await snap(wardenTab.page)).camera?.mode]
    const hooks0 = [hookVitals(g0, ghostTabId), hookVitals(w0, wardenId)]

    // 2. The SDK Ghost joins third, behind the south wall.
    obs = await Observer.join()
    const oid = obs.id
    for (const t of [SHOT_EVENT, HIT_EVENT, DAMAGED_EVENT]) obs.room.onMessage(t, () => {})
    await obs.waitForPlayers(3)
    const walker = new Walker(obs.room, 'sdk ghost', { ground: false })
    const wardenAt = pos(obs.room, wardenId)
    const behind = { x: 6.13, z: -14.21 }
    await walker.walkTo(behind)
    const hiddenClass = visibilityOf(wardenAt, behind)
    // Let a few patches arrive before looking (a Ghost leaves a view within one 50 ms step).
    await new Promise((r) => setTimeout(r, 400))
    const whileHidden = (await snap(wardenTab.page)).players.map((p) => p.id)
    const ghostTabSeesGhost = (await snap(ghostTab.page)).players.some((p) => p.id === oid)

    // 3. Into the building on the doorway line, with a clear head-height shot at the Warden.
    const shooter = { x: 0, z: -6 }
    await walker.walkTo(shooter)
    const head = { x: wardenAt.x, y: 1.7, z: wardenAt.z }
    const clearShot = hasLineOfSight(eyeOf({ ...shooter, y: 0 }), head)
    const shooterClass = visibilityOf(wardenAt, shooter)
    await expect
      .poll(async () => (await snap(wardenTab!.page)).players.some((p) => p.id === oid), { message: 'the Warden tab now holds the SDK Ghost', timeout: 10_000 })
      .toBe(true)
    const nowVisible = (await snap(wardenTab.page)).players.find((p) => p.id === oid)!
    const ownPos = pos(obs.room, oid)

    // 4. Shoot the Warden tab's player until it is eliminated.
    const aim = () => {
      const s = pos(obs!.room, oid)
      const t = pos(obs!.room, wardenId)
      const dx = t.x - s.x
      const dz = t.z - s.z
      return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(1.7 - EYE_HEIGHT, Math.hypot(dx, dz)) }
    }
    const shotsNeeded = Math.ceil(MAX_HEALTH.warden / WEAPONS.ghost.damage)
    let fired = 0
    const started = Date.now()
    while (healthSeenBy(obs, wardenId) > 0 && Date.now() - started < 12_000) {
      obs.room.send(FIRE_MESSAGE, aim())
      fired++
      await new Promise((r) => setTimeout(r, WEAPONS.ghost.intervalMs + 60))
    }
    await expect.poll(async () => (await snap(wardenTab!.page)).players.find((p) => p.isLocal)?.health, { timeout: 5_000 }).toBeLessThanOrEqual(0)
    await expect(wardenTab.page.locator('#health')).toHaveText('Eliminated')
    const afterDeath = await readout(wardenTab)
    const deadAt = local(await snap(wardenTab.page))
    const camYaw = (await snap(wardenTab.page)).camera!.yaw
    const otherTabView = get(await snap(ghostTab.page), wardenId)

    // 5. Nothing moves: held movement keys change neither the position nor the camera.
    await holdKey(wardenTab.page, 'KeyW', 500)
    await holdKey(wardenTab.page, 'KeyD', 300)
    await new Promise((r) => setTimeout(r, 300))
    const after = local(await snap(wardenTab.page))
    const camAfter = (await snap(wardenTab.page)).camera!.yaw
    const otherAfter = get(await snap(ghostTab.page), wardenId)
    const ownVitals = hookVitals(await snap(wardenTab.page), wardenId)

    await leaveQuietly(obs.room)
    obs = undefined

    // Assertions, once, after the SDK client has left.
    expect(modes).toEqual(['third-person', 'first-person'])
    expect(hooks0).toEqual([
      { health: MAX_HEALTH.ghost, ammo: WEAPONS.ghost.magazine, reloading: false },
      { health: MAX_HEALTH.warden, ammo: WEAPONS.warden.magazine, reloading: false },
    ])
    expect(hiddenClass, 'placement behind the wall').toBe('hidden')
    expect(whileHidden, 'the Warden tab holds no SDK Ghost while it is behind the wall').not.toContain(oid)
    expect(ghostTabSeesGhost, 'the Ghost tab sees the SDK Ghost').toBe(true)
    expect(clearShot, 'head-height line from the shooter to the Warden is clear').toBe(true)
    expect(shooterClass).not.toBe('hidden')
    expect(nowVisible.team).toBe('ghost')
    expect(Math.abs(nowVisible.x - ownPos.x)).toBeLessThan(1e-4)
    expect(Math.abs(nowVisible.z - ownPos.z)).toBeLessThan(1e-4)
    expect(fired, 'fired about as many shots as needed').toBeGreaterThanOrEqual(shotsNeeded)
    expect(fired).toBeLessThan(shotsNeeded + 4)
    expect(afterDeath).toEqual({ health: 'Eliminated', ammo: '', crosshairHidden: true })
    expect(deadAt.health).toBeLessThanOrEqual(0)
    expect(otherTabView.health, 'the Ghost tab sees the Warden eliminated').toBeLessThanOrEqual(0)
    expect(after.x).toBeCloseTo(deadAt.x, 4)
    expect(after.z).toBeCloseTo(deadAt.z, 4)
    expect(camAfter).toBeCloseTo(camYaw, 6)
    expect(otherAfter.x).toBeCloseTo(otherTabView.x, 4)
    expect(otherAfter.z).toBeCloseTo(otherTabView.z, 4)
    expect(ownVitals?.health).toBeLessThanOrEqual(0)
    expect(ghostTab.errors, 'ghost tab errors').toEqual([])
    expect(wardenTab.errors, 'warden tab errors').toEqual([])
  } finally {
    if (obs) await obs.leave()
    await closeTabs(ghostTab, wardenTab)
  }
})

/** Health of `id` as the observer (a Ghost: sent every player) received it. */
function healthSeenBy(o: Observer, id: string): number {
  const p = o.room.state.players.get(id) as unknown as { health: number } | undefined
  return p ? p.health : 0
}
