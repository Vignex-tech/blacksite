import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { buildMap, type RenderedMap } from './map.ts'
import type { PlayerPose } from './net.ts'
import { createPlayerRenderer } from './players.ts'
import { createCameraRig, type CameraRig } from './cameras.ts'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'

/** Camera tilt from straight down (radians) and distance from the map centre. */
const CAMERA_BETA = 0.4
const CAMERA_RADIUS = 56

export interface GameScene {
  engine: Engine
  scene: Scene
  /** The map built from shared data (id and number of solid meshes). */
  map: RenderedMap
  /** Overhead, Ghost third-person or Warden first-person camera (cameras.ts). */
  camera: CameraRig
  /**
   * Create the player's shape if needed (per team, see players.ts), then move
   * it to (x, z) on the ground and turn it to `pose.yaw`. `isLocal` picks the
   * local player's tint when the shape is created.
   */
  upsertPlayer(id: string, x: number, z: number, isLocal?: boolean, pose?: PlayerPose): void
  /** Remove the player's shape. Does nothing if the id is unknown. */
  removePlayer(id: string): void
  dispose(): void
}

export function createGameScene(canvas: HTMLCanvasElement): GameScene {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true })
  const scene = new Scene(engine)
  scene.clearColor = new Color4(0.05, 0.06, 0.08, 1)

  // Overhead camera, used until your team is known and while disconnected.
  // Mostly top-down so players stay visible over the 3-unit walls, both in the
  // south yard and inside the building; far enough out to frame the whole map.
  // Viewed from the south: +z is away from the camera, +x to its right.
  const overheadCamera = new ArcRotateCamera('camera', -Math.PI / 2, CAMERA_BETA, CAMERA_RADIUS, Vector3.Zero(), scene)
  overheadCamera.lowerRadiusLimit = 8
  overheadCamera.upperRadiusLimit = 60
  overheadCamera.upperBetaLimit = Math.PI / 2.2
  // Arrow keys move the player (see input.ts), so the camera keeps only mouse/touch input.
  overheadCamera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput')
  overheadCamera.attachControl(canvas, true)

  const light = new HemisphericLight('light', new Vector3(0, 1, 0), scene)
  light.intensity = 0.9

  const map = buildMap(scene)

  const players = createPlayerRenderer(scene)
  const { upsertPlayer, removePlayer } = players
  const camera = createCameraRig(scene, canvas, overheadCamera)

  // First person: hide your own body (and its nose) from the camera. The mesh
  // keeps existing under its usual name; it is only made invisible, and is
  // rebuilt when the team changes, so this is checked every frame.
  let hidden: Mesh | null = null
  const setVisible = (mesh: Mesh, visible: boolean): void => {
    mesh.isVisible = visible
    for (const child of mesh.getChildMeshes()) child.isVisible = visible
  }
  scene.onBeforeRenderObservable.add(() => {
    const id = camera.mode === 'first-person' ? camera.localId : null
    const target = id ? (players.mesh(id) ?? null) : null
    if (target === hidden) return
    if (hidden && !hidden.isDisposed()) setVisible(hidden, true)
    if (target) setVisible(target, false)
    hidden = target
  })

  const onResize = (): void => engine.resize()
  window.addEventListener('resize', onResize)

  engine.runRenderLoop(() => scene.render())

  return {
    engine,
    scene,
    map,
    camera,
    upsertPlayer,
    removePlayer,
    dispose: () => {
      window.removeEventListener('resize', onResize)
      camera.dispose()
      engine.dispose()
    },
  }
}
