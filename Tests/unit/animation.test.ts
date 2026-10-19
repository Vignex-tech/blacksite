import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import { FreeCamera } from '../../client/node_modules/@babylonjs/core/Cameras/freeCamera.js'
import { Vector3 } from '../../client/node_modules/@babylonjs/core/Maths/math.vector.js'
import {
  chooseAnimation,
  createCharacterAnimator,
  locomotionSpeedRatio,
  poseTargets,
  MOVING_SPEED,
  RUN_SPEED,
  SHIMMY_MIN_SPEED,
  CLIMB_STILL_SPEED,
  type AnimObservation,
  type ObservedState,
  type OneShot,
} from '../../client/src/assets/animation.ts'
import type { LoadedModel } from '../../client/src/assets/assetLoader.ts'
import type { MovementMode, Team } from '../../shared/protocol.js'
import { createFileLoader } from './support/modelFiles.ts'

// #83: client/src/assets/animation.ts (#82). The pure choice function, then the
// controller driving the shipped models on NullEngine (AnimationGroup state).

const obs = (team: Team, mode: MovementMode, speed = 0, oneShot: OneShot | null = null): AnimObservation => ({ team, mode, speed, oneShot })

describe('chooseAnimation: ground locomotion', () => {
  it('Ghost: idle when still, walk when moving, run when fast', () => {
    expect(chooseAnimation(obs('ghost', 'ground', 0)).clip).toBe('idle')
    expect(chooseAnimation(obs('ghost', 'ground', MOVING_SPEED)).clip).toBe('idle') // threshold is exclusive
    expect(chooseAnimation(obs('ghost', 'ground', MOVING_SPEED + 0.01)).clip).toBe('walk')
    expect(chooseAnimation(obs('ghost', 'ground', RUN_SPEED)).clip).toBe('walk')
    expect(chooseAnimation(obs('ghost', 'ground', RUN_SPEED + 0.01)).clip).toBe('run')
  })

  it('Warden uses the rifle clips on the same thresholds', () => {
    expect(chooseAnimation(obs('warden', 'ground', 0)).clip).toBe('idle_rifle')
    expect(chooseAnimation(obs('warden', 'ground', 0.5)).clip).toBe('walk_rifle')
    expect(chooseAnimation(obs('warden', 'ground', RUN_SPEED + 0.01)).clip).toBe('run_rifle')
  })

  it('locomotion and idle loop; no procedural pose on the ground', () => {
    for (const team of ['ghost', 'warden'] as const) {
      for (const speed of [0, 1, 3]) {
        const c = chooseAnimation(obs(team, 'ground', speed))
        expect(c.loop).toBe(true)
        expect(c.pose).toBeNull()
      }
    }
  })
})

describe('chooseAnimation: air, climb and hang', () => {
  it('falling loops fall; a jump one-shot plays jump once, for both teams', () => {
    for (const team of ['ghost', 'warden'] as const) {
      expect(chooseAnimation(obs(team, 'falling', 0))).toEqual({ clip: 'fall', pose: null, loop: true })
      expect(chooseAnimation(obs(team, 'falling', 2, 'jump'))).toEqual({ clip: 'jump', pose: null, loop: false })
    }
  })

  it('while falling, a land or hit one-shot does not interrupt the fall clip', () => {
    expect(chooseAnimation(obs('ghost', 'falling', 0, 'land')).clip).toBe('fall')
    expect(chooseAnimation(obs('warden', 'falling', 0, 'hit')).clip).toBe('fall')
  })

  it('climbing is the climb pose with no clip, whatever the speed or one-shot', () => {
    for (const team of ['ghost', 'warden'] as const) {
      expect(chooseAnimation(obs(team, 'climbing', 0))).toEqual({ clip: null, pose: 'climb', loop: true })
      expect(chooseAnimation(obs(team, 'climbing', 3, 'hit')).pose).toBe('climb')
    }
  })

  it('hanging is hang when still and shimmy once sideways speed passes the threshold', () => {
    expect(chooseAnimation(obs('ghost', 'hanging', 0)).pose).toBe('hang')
    expect(chooseAnimation(obs('ghost', 'hanging', SHIMMY_MIN_SPEED)).pose).toBe('hang')
    expect(chooseAnimation(obs('ghost', 'hanging', SHIMMY_MIN_SPEED + 0.01)).pose).toBe('shimmy')
    expect(chooseAnimation(obs('ghost', 'hanging', 0)).clip).toBeNull()
  })
})

describe('chooseAnimation: one-shots', () => {
  const shots: OneShot[] = ['land', 'mantle', 'hit', 'fire', 'reload']
  it('each plays its own clip once on the ground', () => {
    for (const s of shots) {
      const c = chooseAnimation(obs('warden', 'ground', 0, s))
      expect(c, s).toEqual({ clip: s, pose: null, loop: false })
    }
  })

  it('a one-shot wins over running', () => {
    expect(chooseAnimation(obs('warden', 'ground', 4, 'fire')).clip).toBe('fire')
    expect(chooseAnimation(obs('ghost', 'ground', 4, 'land')).clip).toBe('land')
  })

  it('the Ghost can mantle and be hit', () => {
    expect(chooseAnimation(obs('ghost', 'ground', 0, 'mantle')).clip).toBe('mantle')
    expect(chooseAnimation(obs('ghost', 'ground', 1, 'hit')).clip).toBe('hit')
  })
})

describe('chooseAnimation: fall-backs for missing clips', () => {
  const has = (...names: string[]) => new Set(names)

  it('no clips at all gives no clip (the T-pose is the caller\'s problem, not a crash)', () => {
    expect(chooseAnimation(obs('ghost', 'ground', 2), has()).clip).toBeNull()
    expect(chooseAnimation(obs('warden', 'falling', 0), has()).clip).toBeNull()
  })

  it('walk falls back to idle, run to walk', () => {
    expect(chooseAnimation(obs('ghost', 'ground', 2), has('walk', 'idle')).clip).toBe('walk') // run missing -> walk
    expect(chooseAnimation(obs('ghost', 'ground', 2), has('idle')).clip).toBe('idle')
    expect(chooseAnimation(obs('ghost', 'ground', 0.5), has('idle')).clip).toBe('idle')
  })

  it('Warden rifle clips fall back to the plain clips, then to idle', () => {
    expect(chooseAnimation(obs('warden', 'ground', 0), has('idle')).clip).toBe('idle')
    expect(chooseAnimation(obs('warden', 'ground', 0.5), has('walk', 'idle')).clip).toBe('walk')
    expect(chooseAnimation(obs('warden', 'ground', 3), has('run', 'idle_rifle')).clip).toBe('run')
    expect(chooseAnimation(obs('warden', 'ground', 3), has('idle_rifle')).clip).toBe('idle_rifle')
  })

  it('fall falls back to jump, then idle; a missing one-shot clip falls back to locomotion', () => {
    expect(chooseAnimation(obs('ghost', 'falling', 0), has('jump', 'idle')).clip).toBe('jump')
    expect(chooseAnimation(obs('ghost', 'falling', 0), has('idle')).clip).toBe('idle')
    expect(chooseAnimation(obs('warden', 'falling', 0), has('idle_rifle', 'idle')).clip).toBe('idle_rifle')
    // The Ghost file has no fire or reload clips; the choice must still be sane.
    expect(chooseAnimation(obs('ghost', 'ground', 0, 'fire'), has('idle', 'walk')).clip).toBe('idle')
    expect(chooseAnimation(obs('ghost', 'ground', 2, 'reload'), has('idle', 'walk')).clip).toBe('walk')
  })

  it('procedural poses do not need clips', () => {
    expect(chooseAnimation(obs('ghost', 'climbing'), has()).pose).toBe('climb')
    expect(chooseAnimation(obs('ghost', 'hanging'), has()).pose).toBe('hang')
  })
})

describe('locomotionSpeedRatio', () => {
  it('scales walk and run with speed, clamped to 0.6..1.4', () => {
    expect(locomotionSpeedRatio('walk', 1.4)).toBeCloseTo(1)
    expect(locomotionSpeedRatio('walk_rifle', 0.1)).toBeCloseTo(0.6)
    expect(locomotionSpeedRatio('walk', 50)).toBeCloseTo(1.4)
    expect(locomotionSpeedRatio('run', 3)).toBeCloseTo(1)
    expect(locomotionSpeedRatio('run_rifle', 100)).toBeCloseTo(1.4)
    expect(locomotionSpeedRatio('run', 0)).toBeCloseTo(0.6)
  })
  it('is 1 for every other clip and for none', () => {
    for (const c of ['idle', 'fire', 'reload', 'hit', 'land', 'fall', 'mantle', null] as const) expect(locomotionSpeedRatio(c, 9)).toBe(1)
  })
})

describe('poseTargets (procedural climb, hang, shimmy)', () => {
  const bones = ['upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r'] as const

  it('every pose sets all eight limb bones to unit directions', () => {
    for (const pose of ['climb', 'hang', 'shimmy'] as const) {
      const t = poseTargets(pose, 0.7)
      for (const b of bones) {
        expect(t[b], `${pose} ${b}`).toBeInstanceOf(Vector3)
        expect(t[b]!.length()).toBeCloseTo(1, 5)
      }
    }
  })

  it('arms point up and legs point down in every pose', () => {
    for (const pose of ['climb', 'hang', 'shimmy'] as const) {
      for (const phase of [0, 1, 2, 4]) {
        const t = poseTargets(pose, phase)
        for (const b of ['upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r'] as const) expect(t[b]!.y, `${pose} ${b}`).toBeGreaterThan(0.5)
        for (const b of ['thigh_l', 'thigh_r', 'calf_l', 'calf_r'] as const) expect(t[b]!.y, `${pose} ${b}`).toBeLessThan(-0.5)
      }
    }
  })

  it('the climb alternates sides: the arms are out of phase', () => {
    const a = poseTargets('climb', 1.2)
    expect(a.upperarm_l!.z).not.toBeCloseTo(a.upperarm_r!.z, 3)
    const b = poseTargets('climb', 1.2 + Math.PI)
    expect(b.upperarm_l!.z).toBeCloseTo(a.upperarm_r!.z, 5)
  })

  it('a shimmy sways more than a hang', () => {
    const spread = (pose: 'hang' | 'shimmy') => {
      let max = 0
      for (let p = 0; p < 6.3; p += 0.3) max = Math.max(max, Math.abs(poseTargets(pose, p).thigh_l!.z))
      return max
    }
    expect(spread('shimmy')).toBeGreaterThan(spread('hang'))
  })
})

describe('character animator on the shipped models (NullEngine)', () => {
  let engine: NullEngine
  let scene: Scene
  beforeEach(() => {
    engine = new NullEngine()
    scene = new Scene(engine)
    new FreeCamera('cam', new Vector3(0, 1, -5), scene) // scene.render() needs a camera
  })
  afterEach(() => {
    scene.dispose()
    engine.dispose()
  })

  const state = (extra: Partial<ObservedState> = {}): ObservedState => ({ mode: 'ground', speed: 0, vy: 0, health: 100, reloading: false, ...extra })
  const load = async (team: Team): Promise<LoadedModel> => {
    const m = await createFileLoader(scene).loadModel(team === 'ghost' ? 'character-ghost' : 'character-warden')
    expect(m).not.toBeNull()
    return m!
  }
  const playingClips = (m: LoadedModel) => m.animationGroups.filter((g) => g.isPlaying).map((g) => g.name)
  /** Renders frames until the engine clock has moved `ms`, so animation groups advance. */
  const run = async (ms: number) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      scene.render()
      await new Promise((r) => setTimeout(r, 8))
    }
  }

  it('exposes exactly the clips in the file', async () => {
    const g = createCharacterAnimator(await load('ghost'), 'ghost')
    expect([...g.clips].sort()).toEqual(['crouch_idle', 'crouch_walk', 'fall', 'hit', 'idle', 'jump', 'land', 'mantle', 'run', 'walk'])
    const w = createCharacterAnimator(await load('warden'), 'warden')
    expect(w.clips.has('fire') && w.clips.has('reload') && w.clips.has('idle_rifle')).toBe(true)
  })

  it('plays a clip on the first update (never left in the T-pose) and loops it', async () => {
    const model = await load('warden')
    const a = createCharacterAnimator(model, 'warden')
    a.observe(state())
    a.update(0)
    expect(a.current()).toBe('idle_rifle')
    expect(playingClips(model)).toEqual(['idle_rifle'])
    expect(model.animationGroups.find((g) => g.name === 'idle_rifle')!.loopAnimation).toBe(true)
  })

  it('Ghost: idle, walk, run follow the speed, with only one clip playing at a time', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    for (const [speed, want] of [[0, 'idle'], [0.8, 'walk'], [3, 'run'], [0, 'idle']] as const) {
      a.observe(state({ speed }))
      a.update(0.016)
      expect(a.current()).toBe(want)
      expect(playingClips(model)).toEqual([want])
    }
  })

  it('Warden moving shows walk_rifle, then run_rifle', async () => {
    const model = await load('warden')
    const a = createCharacterAnimator(model, 'warden')
    a.observe(state({ speed: 0.9 }))
    a.update(0.016)
    expect(a.current()).toBe('walk_rifle')
    a.observe(state({ speed: 3 }))
    a.update(0.016)
    expect(a.current()).toBe('run_rifle')
  })

  it('walk speed ratio follows the speed', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state({ speed: 1 }))
    a.update(0.016)
    expect(model.animationGroups.find((g) => g.name === 'walk')!.speedRatio).toBeCloseTo(1 / 1.4)
    a.observe(state({ speed: 0.5 }))
    a.update(0.016)
    expect(model.animationGroups.find((g) => g.name === 'walk')!.speedRatio).toBeCloseTo(0.6) // clamped
  })

  it('fire plays on a shot event and returns to the idle clip after it ends (real clip, real time)', async () => {
    const model = await load('warden')
    const a = createCharacterAnimator(model, 'warden')
    a.observe(state())
    a.update(0.016)
    a.shot()
    a.update(0.016)
    expect(a.current()).toBe('fire')
    const fire = model.animationGroups.find((g) => g.name === 'fire')!
    expect(fire.isPlaying).toBe(true)
    expect(fire.loopAnimation).toBe(false)
    const ms = ((fire.to - fire.from) / 60) * 1000 + 600
    const deadline = Date.now() + ms + 1500
    while (a.current() === 'fire' && Date.now() < deadline) {
      scene.render()
      a.update(0.016)
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(a.current()).toBe('idle_rifle')
  })

  // Found in #83: startOneShot() calls stop() on the running group, whose end
  // observable clears the one-shot just set, so a shot fired while the fire clip
  // is still running falls back to idle_rifle for a frame instead of restarting
  // it. Marked as an expected failure so CI stays green; delete `.fails` once the
  // client is fixed (the test then passes and Vitest flags the stale marker).
  it.fails('a second shot while the fire clip runs restarts the clip', async () => {
    const model = await load('warden')
    const a = createCharacterAnimator(model, 'warden')
    a.observe(state())
    a.update(0.016)
    a.shot()
    a.update(0.016)
    a.shot()
    a.update(0.016)
    expect(a.current()).toBe('fire')
  })

  it('reload starts when reloading becomes true (once) and not while it stays true', async () => {
    const model = await load('warden')
    const a = createCharacterAnimator(model, 'warden')
    a.observe(state())
    a.update(0.016)
    a.observe(state({ reloading: true }))
    a.update(0.016)
    expect(a.current()).toBe('reload')
    expect(model.animationGroups.find((g) => g.name === 'reload')!.isPlaying).toBe(true)
  })

  it('hit plays when health drops, not when it rises or on the first observation', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state({ health: 100 })) // first state after Infinity: not a hit
    a.update(0.016)
    expect(a.current()).toBe('idle')
    a.observe(state({ health: 100 }))
    a.update(0.016)
    expect(a.current()).toBe('idle')
    a.observe(state({ health: 60 }))
    a.update(0.016)
    expect(a.current()).toBe('hit')
    expect(model.animationGroups.find((g) => g.name === 'hit')!.isPlaying).toBe(true)
  })

  it('a health increase (heal, respawn) is not a hit', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state({ health: 30 }))
    a.update(0.016)
    a.observe(state({ health: 100 }))
    a.update(0.016)
    expect(a.current()).toBe('idle')
  })

  it('jump on leaving the ground upward, land when falling meets the ground', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state())
    a.update(0.016)
    a.observe(state({ mode: 'falling', vy: 4 }))
    a.update(0.016)
    expect(a.current()).toBe('jump')
    // Past the apex the one-shot is still the jump; hitting the ground lands.
    a.observe(state({ mode: 'falling', vy: -3 }))
    a.update(0.016)
    a.observe(state({ mode: 'ground', vy: 0 }))
    a.update(0.016)
    expect(a.current()).toBe('land')
    expect(model.animationGroups.find((g) => g.name === 'land')!.isPlaying).toBe(true)
  })

  it('a drop with no upward speed plays fall, not jump', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state())
    a.update(0.016)
    a.observe(state({ mode: 'falling', vy: -2 }))
    a.update(0.016)
    expect(a.current()).toBe('fall')
  })

  it('mantle plays when hanging returns to the ground', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state({ mode: 'hanging' }))
    a.update(0.016)
    expect(a.current()).toBe('hang')
    a.observe(state({ mode: 'ground' }))
    a.update(0.016)
    expect(a.current()).toBe('mantle')
    expect(model.animationGroups.find((g) => g.name === 'mantle')!.isPlaying).toBe(true)
  })

  it('a one-shot ends by itself and locomotion resumes (land, real time)', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state({ mode: 'falling', vy: -2 }))
    a.update(0.016)
    a.observe(state())
    a.update(0.016)
    expect(a.current()).toBe('land')
    const deadline = Date.now() + 4000
    while (a.current() === 'land' && Date.now() < deadline) {
      scene.render()
      a.update(0.016)
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(a.current()).toBe('idle')
  })

  it('climb, hang and shimmy are procedural: no clip plays, the pose changes the bones', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state())
    a.update(0.016)
    expect(playingClips(model)).toEqual(['idle'])

    a.observe(state({ mode: 'climbing', vy: 1.5 }))
    a.update(0.016)
    expect(a.current()).toBe('climb')
    expect(playingClips(model)).toEqual([])
    const arm = model.nodes.get('upperarm_l')!
    const q1 = arm.rotationQuaternion!.clone()
    for (let i = 0; i < 20; i++) a.update(0.05)
    expect(arm.rotationQuaternion!.equals(q1), 'the arm moves while climbing').toBe(false)

    a.observe(state({ mode: 'hanging', speed: 0 }))
    a.update(0.016)
    expect(a.current()).toBe('hang')
    expect(playingClips(model)).toEqual([])

    a.observe(state({ mode: 'hanging', speed: 1 }))
    a.update(0.016)
    expect(a.current()).toBe('shimmy')
  })

  it('a climb held still does not advance the limb cycle', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state({ mode: 'climbing', vy: CLIMB_STILL_SPEED / 2 }))
    a.update(0.016)
    const leg = model.nodes.get('thigh_l')!
    const q = leg.rotationQuaternion!.clone()
    for (let i = 0; i < 20; i++) a.update(0.05)
    expect(leg.rotationQuaternion!.equals(q)).toBe(true)
  })

  it('leaving a pose resumes a clip', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state({ mode: 'hanging' }))
    a.update(0.016)
    a.observe(state({ mode: 'falling', vy: -1 })) // let go
    a.update(0.016)
    expect(a.current()).toBe('fall')
    expect(playingClips(model)).toEqual(['fall'])
  })

  it('dispose stops everything and later updates do nothing', async () => {
    const model = await load('warden')
    const a = createCharacterAnimator(model, 'warden')
    a.observe(state())
    a.update(0.016)
    a.dispose()
    expect(playingClips(model)).toEqual([])
    a.observe(state({ speed: 3 }))
    a.update(0.016)
    expect(playingClips(model)).toEqual([])
  })

  it('the Ghost, which has no fire clip, ignores a shot', async () => {
    const model = await load('ghost')
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state())
    a.update(0.016)
    a.shot()
    a.update(0.016)
    expect(a.current()).toBe('idle')
  })

  it('a model with no clips at all does not throw', async () => {
    const model = await load('ghost')
    for (const g of model.animationGroups) g.dispose()
    model.animationGroups.length = 0
    const a = createCharacterAnimator(model, 'ghost')
    a.observe(state({ speed: 2 }))
    expect(() => a.update(0.016)).not.toThrow()
    expect(a.current()).toBe('none')
    void run
  })
})
