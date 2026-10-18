import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'

const GROUND_SIZE = 40
const BOX_SIZE = 1

export interface GameScene {
  engine: Engine
  scene: Scene
  /** Create the player's box if needed, then move it to (x, z) on the ground. */
  upsertPlayer(id: string, x: number, z: number): void
  /** Remove the player's box. Does nothing if the id is unknown. */
  removePlayer(id: string): void
  dispose(): void
}

export function createGameScene(canvas: HTMLCanvasElement): GameScene {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true })
  const scene = new Scene(engine)
  scene.clearColor = new Color4(0.05, 0.06, 0.08, 1)

  const camera = new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 3, 30, Vector3.Zero(), scene)
  camera.lowerRadiusLimit = 8
  camera.upperRadiusLimit = 60
  camera.upperBetaLimit = Math.PI / 2.2
  camera.attachControl(canvas, true)

  const light = new HemisphericLight('light', new Vector3(0, 1, 0), scene)
  light.intensity = 0.9

  const ground = CreateGround('ground', { width: GROUND_SIZE, height: GROUND_SIZE }, scene)
  const groundMat = new StandardMaterial('groundMat', scene)
  groundMat.diffuseColor = new Color3(0.25, 0.28, 0.3)
  groundMat.specularColor = Color3.Black()
  ground.material = groundMat

  const playerMat = new StandardMaterial('playerMat', scene)
  playerMat.diffuseColor = new Color3(0.9, 0.45, 0.15)

  const players = new Map<string, Mesh>()

  const upsertPlayer = (id: string, x: number, z: number): void => {
    let box = players.get(id)
    if (!box) {
      box = CreateBox(`player-${id}`, { size: BOX_SIZE }, scene)
      box.material = playerMat
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
    upsertPlayer,
    removePlayer,
    dispose: () => {
      window.removeEventListener('resize', onResize)
      engine.dispose()
    },
  }
}
