import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { buildMap, type RenderedMap } from './map.ts'

const BOX_SIZE = 1
/** Camera tilt from straight down (radians) and distance from the map centre. */
const CAMERA_BETA = 0.4
const CAMERA_RADIUS = 56

export interface GameScene {
  engine: Engine
  scene: Scene
  /** The map built from shared data (id and number of solid meshes). */
  map: RenderedMap
  /**
   * Create the player's box if needed, then move it to (x, z) on the ground.
   * `isLocal` picks the local player's colour when the box is created.
   */
  upsertPlayer(id: string, x: number, z: number, isLocal?: boolean): void
  /** Remove the player's box. Does nothing if the id is unknown. */
  removePlayer(id: string): void
  dispose(): void
}

export function createGameScene(canvas: HTMLCanvasElement): GameScene {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true })
  const scene = new Scene(engine)
  scene.clearColor = new Color4(0.05, 0.06, 0.08, 1)

  // Mostly top-down so players stay visible over the 3-unit walls, both in the
  // south yard and inside the building; far enough out to frame the whole map.
  // Viewed from the south: +z is away from the camera, +x to its right.
  const camera = new ArcRotateCamera('camera', -Math.PI / 2, CAMERA_BETA, CAMERA_RADIUS, Vector3.Zero(), scene)
  camera.lowerRadiusLimit = 8
  camera.upperRadiusLimit = 60
  camera.upperBetaLimit = Math.PI / 2.2
  // Arrow keys move the player (see input.ts), so the camera keeps only mouse/touch input.
  camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput')
  camera.attachControl(canvas, true)

  const light = new HemisphericLight('light', new Vector3(0, 1, 0), scene)
  light.intensity = 0.9

  const map = buildMap(scene)

  const playerMat = new StandardMaterial('playerMat', scene)
  playerMat.diffuseColor = new Color3(0.9, 0.45, 0.15)
  playerMat.specularColor = Color3.Black() // no white glare on top faces seen from above
  const localPlayerMat = new StandardMaterial('localPlayerMat', scene)
  localPlayerMat.diffuseColor = new Color3(0.2, 0.75, 0.95)
  localPlayerMat.emissiveColor = new Color3(0.05, 0.2, 0.3)
  localPlayerMat.specularColor = Color3.Black()

  const players = new Map<string, Mesh>()

  const upsertPlayer = (id: string, x: number, z: number, isLocal = false): void => {
    let box = players.get(id)
    if (!box) {
      box = CreateBox(`player-${id}`, { size: BOX_SIZE }, scene)
      box.material = isLocal ? localPlayerMat : playerMat
      box.position.y = BOX_SIZE / 2
      players.set(id, box)
    }
    box.position.x = x
    box.position.z = z
  }

  const removePlayer = (id: string): void => {
    const box = players.get(id)
    if (!box) return
    box.dispose()
    players.delete(id)
  }

  const onResize = (): void => engine.resize()
  window.addEventListener('resize', onResize)

  engine.runRenderLoop(() => scene.render())

  return {
    engine,
    scene,
    map,
    upsertPlayer,
    removePlayer,
    dispose: () => {
      window.removeEventListener('resize', onResize)
      engine.dispose()
    },
  }
}
