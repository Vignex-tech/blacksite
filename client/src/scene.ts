import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { buildMap, buildTraversal, type RenderedMap, type RenderedTraversal } from './map.ts'
import type { PlayerPose } from './net.ts'
import { createPlayerRenderer } from './players.ts'
import { createCameraRig, type CameraRig } from './cameras.ts'
import { createTerminalView, type TerminalView } from './terminalView.ts'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { createAssetLoader, type AssetLoader } from './assets/assetLoader.ts'
import { gfxSettingsFor, type GfxSettings } from './graphics.ts'
import { buildPerimeter, texturizeSurfaces } from './surfaces.ts'
import { createLoadingScreen } from './loadingScreen.ts'
import { createLighting, type Lighting } from './lighting.ts'
import { createPerfMeter, type PerfMeter } from './perfOverlay.ts'

/** Camera tilt from straight down (radians) and distance from the map centre. */
const CAMERA_BETA = 0.4
const CAMERA_RADIUS = 56

export interface GameScene {
  engine: Engine
  scene: Scene
  /** The map built from shared data (id and number of solid meshes). */
  map: RenderedMap
  /** The upper level built from shared data (floors, ramps and anchors, M4). */
  traversal: RenderedTraversal
  /** Terminal post colours: active, dim, hacked (M6). */
  terminals: TerminalView
  /** Graphics tier settings from `?gfx=` (rendering only, see graphics.ts). */
  gfx: GfxSettings
  /** Reads fps, draw calls and active triangles (the F3 overlay and the test hook). */
  perf: PerfMeter
  /** Overhead, Ghost third-person or Warden first-person camera (cameras.ts). */
  camera: CameraRig
  /**
   * Create the player's shape if needed (per team, see players.ts), then move
   * it to (x, z) with its feet at `pose.y` and turn it to `pose.yaw`. `isLocal` picks the
   * local player's tint when the shape is created.
   */
  upsertPlayer(id: string, x: number, z: number, isLocal?: boolean, pose?: PlayerPose): void
  /** Remove the player's shape. Does nothing if the id is unknown. */
  removePlayer(id: string): void
  /** A `shot` event arrived for this shooter: play the fire animation (visual only). */
  playerShot(id: string): void
  /** What a player's model is playing (clip or procedural pose), if a model is attached. */
  playerAnimation(id: string): string | undefined
  dispose(): void
}

export interface GameSceneOptions {
  /** Model loader; defaults to the real one (shown on the loading screen). Tests inject their own. */
  loader?: AssetLoader
  /** Query string to read `?gfx=` from; defaults to `location.search`. */
  search?: string
}

export function createGameScene(canvas: HTMLCanvasElement, options: GameSceneOptions = {}): GameScene {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true })
  const scene = new Scene(engine)

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

  const map = buildMap(scene)
  const traversal = buildTraversal(scene)
  const terminals = createTerminalView(scene)

  const gfx = gfxSettingsFor(options.search ?? window.location.search)
  const overlayParent = canvas.parentElement ?? document.body
  const loadingScreen = createLoadingScreen(overlayParent)
  const loader = options.loader ?? loadingScreen.track(createAssetLoader(scene))
  buildPerimeter(scene)
  texturizeSurfaces(scene, gfx, loadingScreen)
  // After the map and its surfaces exist (it reads their bounds), before characters are created.
  const lighting: Lighting = createLighting(scene, gfx)
  const perf = createPerfMeter(engine, scene, overlayParent)

  const players = createPlayerRenderer(scene, loader)
  const { upsertPlayer, removePlayer } = players
  const camera = createCameraRig(scene, canvas, overheadCamera)
  lighting.attachPostEffects(scene.cameras)

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
    traversal,
    terminals,
    gfx,
    perf,
    camera,
    upsertPlayer,
    removePlayer,
    playerShot: players.shot,
    playerAnimation: players.animation,
    dispose: () => {
      window.removeEventListener('resize', onResize)
      camera.dispose()
      perf.dispose()
      lighting.dispose()
      loadingScreen.dispose()
      engine.dispose()
    },
  }
}
