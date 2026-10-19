import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import { createPlayerRenderer, type PlayerMeshMetadata, type PlayerRenderer } from '../../client/src/players.ts'
import { poseOf } from '../../client/src/net.ts'
import { installTestHook } from '../../client/src/testHook.ts'
import { ammoText, crosshairVisible, defaultVitals, healthText, isEliminated, type LocalVitals } from '../../client/src/vitals.ts'
import { MAX_HEALTH, WEAPONS, type PlayerState, type Team } from '../../shared/protocol.js'
import type { BlacksiteTestHook } from '../../shared/testhook.js'

// #49: the M5 weapon HUD rules (client/src/vitals.ts, #48), the eliminated body,
// remote-player mesh removal and re-adding (the visibility filter, #46), the
// fallbacks for bad health/ammo values, the hook's vitals fields, and the
// "no weapon numbers hard-coded in client/" source check.

const TEAMS_LIST: Team[] = ['ghost', 'warden']
const v = (team: Team, o: Partial<LocalVitals> = {}): LocalVitals => ({
  team,
  health: MAX_HEALTH[team],
  ammo: WEAPONS[team].magazine,
  reloading: false,
  ...o,
})

describe('health and ammo readouts (vitals.ts)', () => {
  for (const t of TEAMS_LIST) {
    it(`${t}: full health and magazine show the shared maximums`, () => {
      expect(healthText(v(t))).toBe(`HP ${MAX_HEALTH[t]}/${MAX_HEALTH[t]}`)
      expect(ammoText(v(t))).toBe(`Ammo ${WEAPONS[t].magazine}/${WEAPONS[t].magazine}`)
    })
  }

  it('damage lowers the health readout; fractions round; it never shows below 0', () => {
    expect(healthText(v('warden', { health: 125 }))).toBe(`HP 125/${MAX_HEALTH.warden}`)
    expect(healthText(v('ghost', { health: 70.6 }))).toBe(`HP 71/${MAX_HEALTH.ghost}`)
    expect(healthText(v('ghost', { health: 0.4 }))).toBe(`HP 0/${MAX_HEALTH.ghost}`)
  })

  it('a partly used magazine shows the rounds left', () => {
    expect(ammoText(v('warden', { ammo: 7 }))).toBe(`Ammo 7/${WEAPONS.warden.magazine}`)
  })

  it('reloading shows Reloading... whatever the ammo count', () => {
    expect(ammoText(v('warden', { reloading: true, ammo: 0 }))).toBe('Reloading...')
    expect(ammoText(v('ghost', { reloading: true, ammo: 5 }))).toBe('Reloading...')
  })

  it('an empty magazine prompts a reload', () => {
    expect(ammoText(v('ghost', { ammo: 0 }))).toBe('R: reload')
  })

  it('eliminated: health says Eliminated and the ammo line is empty, even while reloading or with rounds left', () => {
    for (const health of [0, -10]) {
      expect(healthText(v('warden', { health }))).toBe('Eliminated')
      expect(ammoText(v('warden', { health, reloading: true }))).toBe('')
      expect(ammoText(v('warden', { health }))).toBe('')
    }
    expect(isEliminated(0)).toBe(true)
    expect(isEliminated(0.5)).toBe(false)
  })

  it('both readouts are empty before local state arrives and after disconnect (null), and with no team', () => {
    expect(healthText(null)).toBe('')
    expect(ammoText(null)).toBe('')
    const noTeam = { ...v('ghost'), team: null }
    expect(healthText(noTeam)).toBe('')
    expect(ammoText(noTeam)).toBe('')
  })
})

describe('crosshair rule (vitals.ts)', () => {
  it('shows in first and third person, not in overhead', () => {
    expect(crosshairVisible('first-person', 150)).toBe(true)
    expect(crosshairVisible('third-person', 100)).toBe(true)
    expect(crosshairVisible('overhead', 100)).toBe(false)
    expect(crosshairVisible('overhead', null)).toBe(false)
  })

  it('is hidden once the local player is eliminated, in every mode', () => {
    for (const m of ['first-person', 'third-person', 'overhead'] as const) {
      expect(crosshairVisible(m, 0)).toBe(false)
      expect(crosshairVisible(m, -5)).toBe(false)
    }
  })

  it('before local state arrives (null health) the camera mode alone decides', () => {
    expect(crosshairVisible('first-person', null)).toBe(true)
  })
})

describe('poseOf fallbacks for bad health, ammo and reloading (net.ts)', () => {
  const state = (o: Record<string, unknown>) => o as unknown as PlayerState

  it('passes good values through', () => {
    const p = poseOf(state({ team: 'warden', health: 40, ammo: 3, reloading: true }))
    expect(p).toMatchObject({ team: 'warden', health: 40, ammo: 3, reloading: true })
  })

  it('missing or non-finite values fall back to full health, a full magazine and not reloading', () => {
    for (const t of TEAMS_LIST) {
      for (const bad of [{}, { health: NaN, ammo: Infinity, reloading: 'yes' }, { health: undefined, ammo: null, reloading: 1 }, { health: 'x', ammo: {} }]) {
        const p = poseOf(state({ team: t, ...bad }))
        expect(p.health, `${t} ${JSON.stringify(bad)}`).toBe(MAX_HEALTH[t])
        expect(p.ammo).toBe(WEAPONS[t].magazine)
        expect(p.reloading).toBe(false)
      }
    }
  })

  it('without a valid team the defaults are the Ghost maximum health and no ammo', () => {
    const p = poseOf(state({ team: 'spectator' }))
    expect(p.team).toBeNull()
    expect(p).toMatchObject(defaultVitals(null))
  })

  it('zero is a real value (an eliminated player), not a missing one', () => {
    expect(poseOf(state({ team: 'ghost', health: 0, ammo: 0 }))).toMatchObject({ health: 0, ammo: 0 })
  })
})

describe('eliminated body and remote-player meshes (players.ts)', () => {
  let engine: NullEngine
  let scene: Scene
  let r: PlayerRenderer
  beforeEach(() => {
    engine = new NullEngine()
    scene = new Scene(engine)
    r = createPlayerRenderer(scene)
  })
  afterEach(() => {
    scene.dispose()
    engine.dispose()
  })
  const alive = (team: Team) => ({ team, yaw: 0, health: MAX_HEALTH[team], ammo: 1, reloading: false })
  const playerMeshes = () => scene.meshes.filter((m) => m.name.startsWith('player-')).length

  function height(id: string): { minY: number; maxY: number } {
    const m = r.mesh(id)!
    m.computeWorldMatrix(true)
    const b = m.getBoundingInfo().boundingBox
    return { minY: b.minimumWorld.y, maxY: b.maximumWorld.y }
  }

  for (const t of TEAMS_LIST) {
    it(`${t}: health <= 0 draws a flat grey body (eliminatedMat, 0.3 high, on its feet) flagged in metadata; alive has neither`, () => {
      r.upsertPlayer('p', 1, 2, false, { ...alive(t), y: 3 })
      expect((r.mesh('p')!.metadata as PlayerMeshMetadata).eliminated).toBeUndefined()
      expect(r.mesh('p')!.material?.name).not.toBe('eliminatedMat')
      const tall = height('p')

      r.upsertPlayer('p', 1, 2, false, { ...alive(t), y: 3, health: 0 })
      const m = r.mesh('p')!
      expect(m.metadata).toEqual({ team: t, isLocal: false, eliminated: true })
      expect(m.material?.name).toBe('eliminatedMat')
      expect(scene.getMeshByName('player-p-nose')?.material?.name).toBe('eliminatedMat')
      const flat = height('p')
      expect(flat.minY).toBeCloseTo(3, 5)
      expect(flat.maxY - flat.minY).toBeCloseTo(0.3, 5)
      expect(flat.maxY).toBeLessThan(tall.maxY)
      expect(m.position.x).toBeCloseTo(1, 6)
      expect(m.position.z).toBeCloseTo(2, 6)
      expect(playerMeshes(), 'body and nose only, no leftover mesh').toBe(2)
    })
  }

  it('the eliminated look also applies to your own player and stays put on further updates', () => {
    r.upsertPlayer('me', 4, 5, true, { ...alive('warden'), health: 0 })
    const m = r.mesh('me')!
    expect(m.metadata).toEqual({ team: 'warden', isLocal: true, eliminated: true })
    r.upsertPlayer('me', 4, 5, true, { ...alive('warden'), health: -20 })
    expect(r.mesh('me')).toBe(m) // same mesh, not rebuilt every update
  })

  it('a remote player the filter removes is disposed at once and a returning one gets a fresh mesh', () => {
    const base = playerMeshes()
    r.upsertPlayer('w', 0, 0, true, alive('warden'))
    r.upsertPlayer('g', 5, 5, false, alive('ghost'))
    const first = r.mesh('g')!
    expect(playerMeshes()).toBe(base + 4)

    r.removePlayer('g')
    expect(r.mesh('g')).toBeUndefined()
    expect(first.isDisposed()).toBe(true)
    expect(scene.getMeshByName('player-g')).toBeNull()
    expect(scene.getMeshByName('player-g-nose')).toBeNull()
    expect(playerMeshes()).toBe(base + 2)

    r.upsertPlayer('g', 6, 7, false, alive('ghost'))
    const again = r.mesh('g')!
    expect(again).not.toBe(first)
    expect(again.isDisposed()).toBe(false)
    expect(again.position.x).toBeCloseTo(6, 6)
    expect(playerMeshes()).toBe(base + 4)

    // Removing a player that is not there is harmless; repeat cycles do not leak meshes.
    r.removePlayer('nobody')
    for (let i = 0; i < 5; i++) {
      r.removePlayer('g')
      r.upsertPlayer('g', i, i, false, alive('ghost'))
    }
    expect(playerMeshes()).toBe(base + 4)
  })

  it('a player removed while eliminated returns alive with a normal body', () => {
    r.upsertPlayer('g', 0, 0, false, { ...alive('ghost'), health: 0 })
    r.removePlayer('g')
    r.upsertPlayer('g', 0, 0, false, alive('ghost'))
    expect((r.mesh('g')!.metadata as PlayerMeshMetadata).eliminated).toBeUndefined()
    expect(r.mesh('g')!.material?.name).toBe('ghostMat')
  })
})

describe('test hook vitals fields and the filter adding and removing a remote player', () => {
  function setup() {
    const target = {} as Window
    const rec = installTestHook(target)
    const hook = (target as unknown as { __blacksite: BlacksiteTestHook }).__blacksite
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const renderer = createPlayerRenderer(scene)
    return {
      rec,
      hook,
      view: rec.wrapView(renderer),
      renderer,
      done: () => {
        scene.dispose()
        engine.dispose()
      },
    }
  }

  it('lists health, ammo and reloading for every player, with team defaults when the pose has none', () => {
    const { rec, hook, view, done } = setup()
    rec.setConnected('me')
    view.upsertPlayer('me', 0, 0, true, { team: 'warden', yaw: 0, health: 90, ammo: 4, reloading: true })
    view.upsertPlayer('g', 1, 1, false, { team: 'ghost', yaw: 0 })
    view.upsertPlayer('u', 2, 2, false)
    const byId = Object.fromEntries(hook.snapshot().players.map((p) => [p.id, p]))
    expect(byId.me).toMatchObject({ health: 90, ammo: 4, reloading: true })
    expect(byId.g).toMatchObject({ health: MAX_HEALTH.ghost, ammo: WEAPONS.ghost.magazine, reloading: false })
    expect(byId.u).toMatchObject({ health: MAX_HEALTH.ghost, ammo: 0, reloading: false })
    done()
  })

  it('hook list and meshes agree as a Ghost leaves and re-enters a Warden client', () => {
    const { rec, hook, view, renderer, done } = setup()
    rec.setConnected('w')
    const ids = () => hook.snapshot().players.map((p) => p.id)
    view.upsertPlayer('w', 0, 0, true, { team: 'warden', yaw: 0 })
    expect(ids()).toEqual(['w'])
    view.upsertPlayer('g', 3, 3, false, { team: 'ghost', yaw: 0 })
    expect(ids()).toEqual(['g', 'w'])
    expect(renderer.mesh('g')).toBeDefined()
    view.removePlayer('g')
    expect(ids()).toEqual(['w'])
    expect(renderer.mesh('g')).toBeUndefined()
    view.upsertPlayer('g', 4, 4, false, { team: 'ghost', yaw: 0 })
    expect(ids()).toEqual(['g', 'w'])
    expect(hook.snapshot().players.find((p) => p.id === 'g')).toMatchObject({ x: 4, z: 4 })
    expect(renderer.mesh('g')).toBeDefined()
    done()
  })

  it('an eliminated pose shows up in the hook as health <= 0 and in the body as eliminated', () => {
    const { rec, hook, view, renderer, done } = setup()
    rec.setConnected('w')
    view.upsertPlayer('w', 0, 0, true, { team: 'warden', yaw: 0, health: 0, ammo: 30, reloading: false })
    expect(hook.snapshot().players[0].health).toBe(0)
    expect((renderer.mesh('w')!.metadata as PlayerMeshMetadata).eliminated).toBe(true)
    done()
  })
})
