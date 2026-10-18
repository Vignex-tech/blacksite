import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Babylon is a dependency of client/, not of Tests/: load it from there so the
// test uses the same module instances as client/src/cameras.ts.
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import { ArcRotateCamera } from '../../client/node_modules/@babylonjs/core/Cameras/arcRotateCamera.js'
import { Vector3 } from '../../client/node_modules/@babylonjs/core/Maths/math.vector.js'
import type { TargetCamera } from '../../client/node_modules/@babylonjs/core/Cameras/targetCamera.js'
import { createCameraRig, wrapAngle, type CameraRig } from '../../client/src/cameras.ts'
import { installTestHook } from '../../client/src/testHook.ts'
import type { BlacksiteTestHook } from '../../shared/testhook.js'

// #25: the per-team camera rig (client/src/cameras.ts, #24) on Babylon's
// NullEngine. jsdom has no pointer lock, so `document.pointerLockElement` is
// stubbed, and mouse events carry movementX/Y as a locked pointer's do. The
// browser side (real pointer lock, the yaw on the wire) is e2e/cameras.spec.ts.

const RAD_PER_PIXEL = 0.0025

let engine: NullEngine
let scene: Scene
let canvas: HTMLCanvasElement
let overhead: ArcRotateCamera
let rig: CameraRig
let locked = false

function mouse(movementX: number, movementY = 0) {
  const e = new MouseEvent('mousemove')
  Object.defineProperty(e, 'movementX', { value: movementX })
  Object.defineProperty(e, 'movementY', { value: movementY })
  document.dispatchEvent(e)
}

const eye = () => scene.getCameraByName('playerCamera') as TargetCamera

beforeEach(() => {
  locked = false
  engine = new NullEngine()
  scene = new Scene(engine)
  canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => (locked ? canvas : null) })
  document.exitPointerLock = vi.fn(() => {
    locked = false
  })
  canvas.requestPointerLock = vi.fn(() => {
    locked = true
    return Promise.resolve()
  }) as unknown as typeof canvas.requestPointerLock
  overhead = new ArcRotateCamera('camera', -Math.PI / 2, 0.4, 56, Vector3.Zero(), scene)
  scene.activeCamera = overhead
  rig = createCameraRig(scene, canvas, overhead)
})
afterEach(() => {
  rig.dispose()
  scene.dispose()
  engine.dispose()
  canvas.remove()
})

describe('wrapAngle', () => {
  it.each([
    [0, 0],
    [1, 1],
    [-1, -1],
    [Math.PI / 2 + 2 * Math.PI, Math.PI / 2],
    [-Math.PI / 2 - 4 * Math.PI, -Math.PI / 2],
    [(3 * Math.PI) / 2, -Math.PI / 2],
  ])('wraps %f to %f', (a, want) => {
    expect(wrapAngle(a)).toBeCloseTo(want, 12)
  })

  it('always lands in -pi..pi and keeps the facing', () => {
    for (let a = -50; a <= 50; a += 0.37) {
      const w = wrapAngle(a)
      expect(w).toBeGreaterThanOrEqual(-Math.PI)
      expect(w).toBeLessThan(Math.PI)
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9)
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9)
    }
  })
})

describe('camera rig modes', () => {
  it('starts overhead at yaw 0, and stays there until the local team is known', () => {
    expect(rig.mode).toBe('overhead')
    expect(rig.yaw).toBe(0)
    expect(rig.localId).toBeNull()
    rig.setLocalPlayer('me', 1, -15, null, 0)
    expect(rig.mode).toBe('overhead')
    expect(scene.activeCamera).toBe(overhead)
  })

  it('a ghost gets the third-person camera behind, right of and above the player, looking along its yaw', () => {
    rig.setLocalPlayer('me', 2, -15, 'ghost', 0)
    expect(rig.mode).toBe('third-person')
    expect(rig.localId).toBe('me')
    expect(scene.activeCamera).toBe(eye())
    const p = eye().position
    // Facing +z: behind is lower z, right is +x.
    expect(p.z).toBeLessThan(-15 - 2)
    expect(p.x).toBeGreaterThan(2)
    expect(p.y).toBeGreaterThan(1)
    expect(eye().rotation.y).toBeCloseTo(0, 12)
  })

  it('a warden gets the first-person camera at eye height on the player, following its position', () => {
    rig.setLocalPlayer('me', -1.5, 3, 'warden', 0)
    expect(rig.mode).toBe('first-person')
    expect(scene.activeCamera).toBe(eye())
    const p = eye().position
    expect([p.x, p.z]).toEqual([-1.5, 3])
    expect(p.y).toBeGreaterThan(1.2)
    expect(p.y).toBeLessThan(1.8) // inside the player's box height
    rig.setLocalPlayer('me', 0.5, 4, 'warden', 0)
    expect([eye().position.x, eye().position.z]).toEqual([0.5, 4])
  })

  it('the team camera starts at the server yaw (wrapped), not 0', () => {
    rig.setLocalPlayer('me', 0, -15, 'ghost', 1.2 + 2 * Math.PI)
    expect(rig.yaw).toBeCloseTo(1.2, 12)
    expect(eye().rotation.y).toBeCloseTo(1.2, 12)
  })

  it('later server yaws do not move the camera yaw (the camera leads, the server follows)', () => {
    rig.setLocalPlayer('me', 0, -15, 'ghost', 0)
    rig.setLocalPlayer('me', 0, -14.9, 'ghost', 2)
    expect(rig.yaw).toBe(0)
  })

  it('a disconnect (reset) returns to overhead at yaw 0 and releases the pointer', () => {
    rig.setLocalPlayer('me', 0, -15, 'ghost', 0)
    canvas.click()
    expect(locked).toBe(true)
    mouse(200)
    expect(rig.yaw).toBeCloseTo(0.5, 12)
    rig.reset()
    expect(rig.mode).toBe('overhead')
    expect(rig.yaw).toBe(0)
    expect(rig.localId).toBeNull()
    expect(scene.activeCamera).toBe(overhead)
    expect(document.exitPointerLock).toHaveBeenCalled()
    expect(locked).toBe(false)
    // A later join switches to the new team's camera.
    rig.setLocalPlayer('me2', 0, 3, 'warden', 0)
    expect(rig.mode).toBe('first-person')
  })
})

describe('camera rig mouse turning', () => {
  it('turns only while the pointer is locked: 0.0025 rad per pixel, positive movementX turns toward +x', () => {
    rig.setLocalPlayer('me', 0, 3, 'warden', 0)
    mouse(400)
    expect(rig.yaw, 'no pointer lock, no turn').toBe(0)
    canvas.click()
    expect(canvas.requestPointerLock).toHaveBeenCalledTimes(1)
    mouse(400)
    expect(rig.yaw).toBeCloseTo(400 * RAD_PER_PIXEL, 12)
    mouse(-100)
    expect(rig.yaw).toBeCloseTo(300 * RAD_PER_PIXEL, 12)
    expect(eye().rotation.y).toBeCloseTo(rig.yaw, 12)
    // Releasing the lock (what Esc does) stops turning.
    locked = false
    mouse(400)
    expect(rig.yaw).toBeCloseTo(300 * RAD_PER_PIXEL, 12)
  })

  it('yaw wraps into -pi..pi when turning past pi', () => {
    rig.setLocalPlayer('me', 0, 3, 'warden', 3)
    canvas.click()
    mouse(200) // +0.5 rad: 3.5 wraps to 3.5 - 2 pi
    expect(rig.yaw).toBeCloseTo(3.5 - 2 * Math.PI, 12)
  })

  it('vertical movement tilts pitch within limits and never changes yaw', () => {
    rig.setLocalPlayer('me', 0, 3, 'warden', 0)
    canvas.click()
    mouse(0, 100000)
    expect(rig.yaw).toBe(0)
    expect(eye().rotation.x).toBeLessThan(Math.PI / 2)
    expect(eye().rotation.x).toBeGreaterThan(1)
    mouse(0, -200000)
    expect(eye().rotation.x).toBeGreaterThan(-Math.PI / 2)
    expect(eye().rotation.x).toBeLessThan(-1)
  })

  it('the mouse does nothing in overhead mode, and clicking there does not take the pointer', () => {
    canvas.click()
    expect(canvas.requestPointerLock).not.toHaveBeenCalled()
    locked = true
    mouse(400)
    expect(rig.yaw).toBe(0)
    expect(rig.mode).toBe('overhead')
  })

  it('the third-person camera orbits with the yaw: still behind and right of the player after a quarter turn', () => {
    rig.setLocalPlayer('me', 0, -15, 'ghost', 0)
    canvas.click()
    mouse(Math.round(Math.PI / 2 / RAD_PER_PIXEL)) // face about +x
    const p = eye().position
    expect(p.x, 'behind the player is -x').toBeLessThan(-2)
    expect(p.z, 'its right is -z').toBeLessThan(-15)
  })
})

describe('test hook camera field', () => {
  it('reports the rig mode and yaw once registered, as a copy', () => {
    const target = {} as Window
    const rec = installTestHook(target)
    const hook = (target as unknown as { __blacksite: BlacksiteTestHook }).__blacksite
    rec.setCamera(() => ({ mode: rig.mode, yaw: rig.yaw }))
    expect(hook.snapshot().camera).toEqual({ mode: 'overhead', yaw: 0 })
    rig.setLocalPlayer('me', 0, -15, 'ghost', 0.75)
    const s = hook.snapshot()
    expect(s.camera).toEqual({ mode: 'third-person', yaw: 0.75 })
    s.camera!.yaw = 9
    expect(hook.snapshot().camera).toEqual({ mode: 'third-person', yaw: 0.75 })
  })
})
