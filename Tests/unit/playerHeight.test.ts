import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Babylon is a dependency of client/, not of Tests/: load it from there so the
// test uses the same module instances as client/src.
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import { ArcRotateCamera } from '../../client/node_modules/@babylonjs/core/Cameras/arcRotateCamera.js'
import { Vector3 } from '../../client/node_modules/@babylonjs/core/Maths/math.vector.js'
import type { TargetCamera } from '../../client/node_modules/@babylonjs/core/Cameras/targetCamera.js'
import type { AbstractMesh } from '../../client/node_modules/@babylonjs/core/Meshes/abstractMesh.js'
import { createPlayerRenderer, type PlayerRenderer } from '../../client/src/players.ts'
import { createCameraRig, type CameraRig } from '../../client/src/cameras.ts'
import { poseOf } from '../../client/src/net.ts'
import { installTestHook } from '../../client/src/testHook.ts'
import { GRAYBOX_MAP, PLAYER_HEIGHT, UPPER_LEVEL_Y } from '../../shared/map.js'
import { MOVEMENT_MODES, type MovementMode, type PlayerState, type Team } from '../../shared/protocol.js'
import type { BlacksiteTestHook } from '../../shared/testhook.js'

// #34: players at height (#33). On Babylon's NullEngine: a player body's
// feet (its bounding box's min y) sit at the synced y in every mode, for
// every shape; the Warden's eye is 1.6 above the feet and the Ghost's
// shoulder point (the third-person camera's pivot) 1.7 above them, so both
// move up with y. Also net.ts's poseOf (what the renderer and the hook get
// from room state) and the hook's y, mode and map counts.

const EPS = 1e-6
/** Hanging: feet PLAYER_HEIGHT below the ledge (1.2 on the graybox). */
const HANG_Y = UPPER_LEVEL_Y - PLAYER_HEIGHT
/** Feet heights to try: the ground, part way up the stairs, hanging, the upper level. */
const HEIGHTS = [0, 0.75, HANG_Y, UPPER_LEVEL_Y]
/** Camera offsets above the feet (client/src/cameras.ts, #33's write-up). */
const EYE_HEIGHT = 1.6
const SHOULDER_HEIGHT = 1.7
const THIRD_PERSON_DISTANCE = 3.2

let engine: NullEngine
let scene: Scene

beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
})

function worldBox(mesh: AbstractMesh) {
  mesh.computeWorldMatrix(true)
  const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox
  return { min, max }
}

describe('player meshes at height (client/src/players.ts)', () => {
  let r: PlayerRenderer
  beforeEach(() => {
    r = createPlayerRenderer(scene)
  })

  const shapes: [string, Team | null][] = [
    ['ghost', 'ghost'],
    ['warden', 'warden'],
    ['the neutral cube (no team yet)', null],
  ]
  for (const [what, team] of shapes) {
    it(`${what}: the body's feet are at the synced y in every mode, and the nose rises with it`, () => {
      const noseY: number[] = []
      for (const y of HEIGHTS) {
        for (const mode of MOVEMENT_MODES) {
          r.upsertPlayer('p', 2, -3, false, { team, yaw: 0.4, y, mode })
          const body = r.mesh('p')!
          const box = worldBox(body)
          expect(Math.abs(box.min.y - y), `${what} ${mode} at y ${y}: feet at ${box.min.y}`).toBeLessThan(EPS)
          // x, z and yaw are unchanged by height.
          expect(body.position.x).toBeCloseTo(2, 6)
          expect(body.position.z).toBeCloseTo(-3, 6)
          expect(body.rotation.y).toBeCloseTo(0.4, 6)
          if (team && mode === 'ground') {
            const nose = scene.getMeshByName('player-p-nose')!
            nose.computeWorldMatrix(true)
            noseY.push(nose.getAbsolutePosition().y - y)
          }
        }
      }
      // The nose keeps its place relative to the feet at every height.
      for (const d of noseY) expect(d).toBeCloseTo(noseY[0], 6)
    })
  }

  it('the body is as tall as the player at every height, and hanging puts it just under the ledge', () => {
    for (const team of ['ghost', 'warden'] as const) {
      r.upsertPlayer(team, 0, 0, false, { team, yaw: 0, y: HANG_Y, mode: 'hanging' })
      const box = worldBox(r.mesh(team)!)
      expect(box.min.y).toBeCloseTo(1.2, 6)
      expect(box.max.y - box.min.y).toBeCloseTo(PLAYER_HEIGHT, 6)
      expect(box.max.y, `${team} hanging: top at the ledge`).toBeCloseTo(UPPER_LEVEL_Y, 6)
    }
  })

  it('without y in the pose the feet are on the ground (y 0)', () => {
    r.upsertPlayer('a', 1, 1, false, { team: 'ghost', yaw: 0 })
    expect(Math.abs(worldBox(r.mesh('a')!).min.y)).toBeLessThan(EPS)
    r.upsertPlayer('b', 1, 1, false)
    expect(Math.abs(worldBox(r.mesh('b')!).min.y)).toBeLessThan(EPS)
  })

  it('a later update at another height moves the same body (no rebuild) and a team change keeps the height', () => {
    r.upsertPlayer('a', 1, 1, true, { team: 'warden', yaw: 0, y: 0, mode: 'ground' })
    const body = r.mesh('a')!
    r.upsertPlayer('a', 1, 1, true, { team: 'warden', yaw: 0, y: UPPER_LEVEL_Y, mode: 'ground' })
    expect(r.mesh('a')).toBe(body)
    expect(worldBox(body).min.y).toBeCloseTo(UPPER_LEVEL_Y, 6)
    r.upsertPlayer('a', 1, 1, true, { team: 'ghost', yaw: 0, y: UPPER_LEVEL_Y, mode: 'ground' })
    expect(r.mesh('a')).not.toBe(body)
    expect(worldBox(r.mesh('a')!).min.y).toBeCloseTo(UPPER_LEVEL_Y, 6)
  })
})

describe('cameras at height (client/src/cameras.ts)', () => {
  let canvas: HTMLCanvasElement
  let rig: CameraRig
  beforeEach(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => null })
    document.exitPointerLock = vi.fn()
    const overhead = new ArcRotateCamera('camera', -Math.PI / 2, 0.4, 56, Vector3.Zero(), scene)
    scene.activeCamera = overhead
    rig = createCameraRig(scene, canvas, overhead)
  })
  afterEach(() => {
    rig.dispose()
    canvas.remove()
  })
  const eye = () => scene.getCameraByName('playerCamera') as TargetCamera

  it("the Warden's eye is EYE_HEIGHT above its feet: 1.6 on the ground, 4.6 on the upper level", () => {
    for (const y of HEIGHTS) {
      rig.setLocalPlayer('me', -6.6, 7, 'warden', 0, y)
      expect(rig.mode).toBe('first-person')
      const p = eye().position
      expect(p.y, `eye at y ${y}`).toBeCloseTo(y + EYE_HEIGHT, 9)
      expect([p.x, p.z]).toEqual([-6.6, 7])
    }
    rig.setLocalPlayer('me', -6.6, 7, 'warden', 0, UPPER_LEVEL_Y)
    expect(eye().position.y).toBeCloseTo(4.6, 9)
  })

  it("the Ghost's shoulder point (the camera's pivot) is SHOULDER_HEIGHT above its feet, and the camera rises with y", () => {
    const at = (y: number) => {
      rig.setLocalPlayer('me', 9, -1.5, 'ghost', 0, y)
      expect(rig.mode).toBe('third-person')
      const cam = eye()
      const p = cam.position.clone()
      // The camera looks along (yaw, pitch) at the shoulder point THIRD_PERSON_DISTANCE ahead.
      const pitch = cam.rotation.x
      const yaw = cam.rotation.y
      const look = new Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
      return { p, pivot: p.add(look.scale(THIRD_PERSON_DISTANCE)) }
    }
    const ground = at(0)
    for (const y of HEIGHTS) {
      const { p, pivot } = at(y)
      expect(pivot.y, `shoulder at y ${y}`).toBeCloseTo(y + SHOULDER_HEIGHT, 9)
      // Same orbit, shifted up by y.
      expect(p.x).toBeCloseTo(ground.p.x, 9)
      expect(p.z).toBeCloseTo(ground.p.z, 9)
      expect(p.y - ground.p.y, `camera rises by ${y}`).toBeCloseTo(y, 9)
    }
  })

  it('a missing or non-finite y keeps the cameras at ground height', () => {
    rig.setLocalPlayer('me', 0, 3, 'warden', 0)
    expect(eye().position.y).toBeCloseTo(EYE_HEIGHT, 9)
    rig.setLocalPlayer('me', 0, 3, 'warden', 0, Number.NaN)
    expect(eye().position.y).toBeCloseTo(EYE_HEIGHT, 9)
  })
})

describe('poseOf (client/src/net.ts): y and mode from room state', () => {
  const state = (over: Partial<Record<keyof PlayerState, unknown>>) => ({ x: 0, z: 0, team: 'ghost', yaw: 0, y: 0, mode: 'ground', ...over }) as PlayerState

  it('passes y and every movement mode through', () => {
    for (const mode of MOVEMENT_MODES) {
      expect(poseOf(state({ y: 1.2, mode }))).toMatchObject({ team: 'ghost', yaw: 0, y: 1.2, mode })
    }
  })

  it('a missing or non-finite y gives 0, and an unknown mode gives ground', () => {
    for (const y of [undefined, Number.NaN, Infinity, '3', null]) expect(poseOf(state({ y })).y, `y ${String(y)}`).toBe(0)
    for (const mode of [undefined, 'flying', 'GROUND', 1, null]) expect(poseOf(state({ mode })).mode, `mode ${String(mode)}`).toBe('ground')
  })
})

describe('test hook: y, mode and map counts (client/src/testHook.ts)', () => {
  function setup() {
    const target = {} as Window
    const rec = installTestHook(target)
    const hook = (target as unknown as { __blacksite: BlacksiteTestHook }).__blacksite
    const view = rec.wrapView({ upsertPlayer: vi.fn(), removePlayer: vi.fn() })
    return { rec, hook, view }
  }

  it("copies each player's y and mode as received; 0 and ground without a pose", () => {
    const { rec, hook, view } = setup()
    rec.setConnected('b')
    const modes: MovementMode[] = ['hanging', 'climbing']
    view.upsertPlayer('a', -10.5, 4.5, false, { team: 'ghost', yaw: Math.PI / 2, y: HANG_Y, mode: modes[0] })
    view.upsertPlayer('b', -6.625, 7, true, { team: 'warden', yaw: 0, y: UPPER_LEVEL_Y, mode: 'ground' })
    view.upsertPlayer('c', 1, 1, false)
    const s = hook.snapshot()
    expect(s.version).toBe(1)
    expect(s.players.map((p) => [p.id, p.y, p.mode])).toEqual([
      ['a', HANG_Y, 'hanging'],
      ['b', UPPER_LEVEL_Y, 'ground'],
      ['c', 0, 'ground'],
    ])
    view.upsertPlayer('a', -10.5, 4.5, false, { team: 'ghost', yaw: Math.PI / 2, y: 0.6, mode: modes[1] })
    expect(hook.snapshot().players[0]).toMatchObject({ y: 0.6, mode: 'climbing' })
  })

  it('reports the floor, ramp and anchor counts with the map; all 0 before it is rendered or when omitted', () => {
    const { rec, hook } = setup()
    expect(hook.snapshot().map).toEqual({ id: null, renderedSolids: 0, renderedFloors: 0, renderedRamps: 0, renderedAnchors: 0 })
    rec.setMap('graybox-1', 16)
    expect(hook.snapshot().map).toEqual({ id: 'graybox-1', renderedSolids: 16, renderedFloors: 0, renderedRamps: 0, renderedAnchors: 0 })
    rec.setMap(GRAYBOX_MAP.id, GRAYBOX_MAP.solids.length, { renderedFloors: 4, renderedRamps: 1, renderedAnchors: 6 })
    const m = hook.snapshot().map
    expect(m).toEqual({ id: 'graybox-1', renderedSolids: 16, renderedFloors: 4, renderedRamps: 1, renderedAnchors: 6 })
    // A fresh copy: editing it changes nothing.
    ;(m as { renderedAnchors: number }).renderedAnchors = 0
    expect(hook.snapshot().map.renderedAnchors).toBe(6)
  })
})
