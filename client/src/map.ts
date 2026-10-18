import type { Scene } from '@babylonjs/core/scene'
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { GRAYBOX_MAP } from '../../shared/map.js'
import type { GrayboxMap, SolidKind } from '../../shared/map.js'

/** Size of a terminal marker: a thin post from the floor up past the interaction point. */
const TERMINAL_MARKER_WIDTH = 0.35
const TERMINAL_MARKER_TOP = 0.3 // above the terminal's y

export interface RenderedMap {
  id: string
  /** Number of solid meshes created (one per entry in `map.solids`). */
  renderedSolids: number
}

/** Neutral greys, well away from the player colours (blue own box, orange others). */
const SOLID_COLOURS: Record<SolidKind, Color3> = {
  wall: new Color3(0.62, 0.62, 0.63),
  cover: new Color3(0.42, 0.42, 0.43),
}

function material(scene: Scene, name: string, diffuse: Color3, emissive = Color3.Black()): StandardMaterial {
  const mat = new StandardMaterial(name, scene)
  mat.diffuseColor = diffuse
  mat.emissiveColor = emissive
  mat.specularColor = Color3.Black()
  mat.freeze()
  return mat
}

/**
 * Builds the map's meshes from shared data: the ground sized from `bounds`,
 * one box per solid and one marker per terminal. Purely visual: nothing here
 * collides or affects movement (the server decides that).
 */
export function buildMap(scene: Scene, map: GrayboxMap = GRAYBOX_MAP): RenderedMap {
  const { bounds } = map
  const ground = CreateGround(
    'ground',
    { width: bounds.maxX - bounds.minX, height: bounds.maxZ - bounds.minZ },
    scene,
  )
  ground.position.set((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2)
  ground.material = material(scene, 'groundMat', new Color3(0.24, 0.24, 0.25))
  ground.freezeWorldMatrix()

  const solidMats: Record<SolidKind, StandardMaterial> = {
    wall: material(scene, 'wallMat', SOLID_COLOURS.wall),
    cover: material(scene, 'coverMat', SOLID_COLOURS.cover),
  }

  let renderedSolids = 0
  for (const s of map.solids) {
    const box = CreateBox(
      `solid-${s.id}`,
      { width: s.max.x - s.min.x, height: s.max.y - s.min.y, depth: s.max.z - s.min.z },
      scene,
    )
    box.position.set((s.min.x + s.max.x) / 2, (s.min.y + s.max.y) / 2, (s.min.z + s.max.z) / 2)
    box.material = solidMats[s.kind] ?? solidMats.wall
    box.isPickable = false
    box.freezeWorldMatrix()
    renderedSolids++
  }

  // Terminals: green glowing posts (no collision in Phase 1).
  const terminalMat = material(scene, 'terminalMat', new Color3(0.2, 0.8, 0.35), new Color3(0.1, 0.45, 0.15))
  for (const t of map.terminals) {
    const height = t.y + TERMINAL_MARKER_TOP
    const marker = CreateBox(
      `terminal-${t.id}`,
      { width: TERMINAL_MARKER_WIDTH, height, depth: TERMINAL_MARKER_WIDTH },
      scene,
    )
    marker.position.set(t.x, height / 2, t.z)
    marker.material = terminalMat
    marker.isPickable = false
    marker.freezeWorldMatrix()
  }

  return { id: map.id, renderedSolids }
}
