import type { Scene } from '@babylonjs/core/scene'
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT } from '../../shared/map.js'
import type { ClimbAnchor, GrayboxMap, LedgeAnchor, Ramp, SolidKind } from '../../shared/map.js'

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

/** What `buildTraversal` rendered: one mesh per floor, ramp and anchor. */
export interface RenderedTraversal {
  renderedFloors: number
  renderedRamps: number
  renderedAnchors: number
}

/** Upper-level slabs: a cool blue-grey, set apart from the neutral walls and cover. */
const FLOOR_COLOUR = new Color3(0.4, 0.46, 0.55)
/** Stairs: a warm tan, so the Warden route reads at a glance. */
const RAMP_COLOUR = new Color3(0.55, 0.47, 0.34)
/** Anchors: bright emissive cyan, readable in the dark (rule 7). */
const ANCHOR_COLOUR = new Color3(0.1, 0.95, 1)
const ANCHOR_GLOW = new Color3(0.05, 0.6, 0.65)

/** Climb strip: width along the wall, and how far it stands out of the face. */
const CLIMB_STRIP_WIDTH = 0.3
const ANCHOR_DEPTH = 0.06
/** Ledge bar: its height, just under the edge. */
const LEDGE_BAR_HEIGHT = 0.12

/**
 * Builds a ramp as a solid wedge over its rectangle, from the ground up to
 * its walkable surface (low at the low edge, high at the high edge), the same
 * shape the server collides with. Flat-shaded (each face has its own vertices).
 */
function buildRampMesh(scene: Scene, r: Ramp): Mesh {
  const { minX: x0, maxX: x1, minZ: z0, maxZ: z1 } = r
  // Surface height at each corner of the rectangle.
  const h = (x: number, z: number): number => {
    const t =
      r.rises === '+z' ? (z - z0) / (z1 - z0)
      : r.rises === '-z' ? (z1 - z) / (z1 - z0)
      : r.rises === '+x' ? (x - x0) / (x1 - x0)
      : (x1 - x) / (x1 - x0)
    return r.low + (r.high - r.low) * t
  }
  const b = [
    [x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1],
  ]
  const t = b.map(([x, , z]) => [x, h(x, z), z])
  // Quads as corner lists (each counter-clockwise seen from outside; the
  // indices below flip that into Babylon's front-face winding, so the normals
  // point outward).
  const quads = [
    [b[0], b[1], b[2], b[3]], // bottom
    [t[0], t[3], t[2], t[1]], // top (the sloped surface)
    [b[0], t[0], t[1], b[1]], // -z side
    [b[2], t[2], t[3], b[3]], // +z side
    [b[3], t[3], t[0], b[0]], // -x side
    [b[1], t[1], t[2], b[2]], // +x side
  ]
  const positions: number[] = []
  const indices: number[] = []
  for (const q of quads) {
    // An end of height 0 (a ramp starting on the ground) has no face.
    if (q.every((v) => v[1] === 0) && q !== quads[0]) continue
    const base = positions.length / 3
    for (const v of q) positions.push(v[0], v[1], v[2])
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
  }
  const normals: number[] = []
  VertexData.ComputeNormals(positions, indices, normals)
  const data = new VertexData()
  data.positions = positions
  data.indices = indices
  data.normals = normals
  const mesh = new Mesh(`ramp-${r.id}`, scene)
  data.applyToMesh(mesh)
  return mesh
}

/** A vertical strip on the wall face the climber holds, from minY up to the ledge. */
function buildClimbMarker(scene: Scene, a: ClimbAnchor): Mesh {
  const bottom = a.minY
  const top = a.maxY + PLAYER_HEIGHT
  const strip = CreateBox(
    `anchor-${a.id}`,
    { width: CLIMB_STRIP_WIDTH, height: top - bottom, depth: ANCHOR_DEPTH },
    scene,
  )
  // The climber's box touches the face half a player width along `facing`;
  // the strip sits on that face, between the climber and the wall.
  const out = PLAYER_HALF_SIZE - ANCHOR_DEPTH / 2
  strip.position.set(a.x + Math.sin(a.facing) * out, (bottom + top) / 2, a.z + Math.cos(a.facing) * out)
  strip.rotation.y = a.facing
  return strip
}

/** A bar along the edge the hanger holds, on its outer face just below the top. */
function buildLedgeMarker(scene: Scene, a: LedgeAnchor): Mesh {
  const length = Math.hypot(a.x1 - a.x0, a.z1 - a.z0)
  const bar = CreateBox(
    `anchor-${a.id}`,
    { width: Math.max(length, CLIMB_STRIP_WIDTH), height: LEDGE_BAR_HEIGHT, depth: ANCHOR_DEPTH },
    scene,
  )
  // The segment is half a player width out from the edge, on the hang side.
  const out = PLAYER_HALF_SIZE - ANCHOR_DEPTH / 2
  bar.position.set(
    (a.x0 + a.x1) / 2 + Math.sin(a.facing) * out,
    a.y - LEDGE_BAR_HEIGHT / 2,
    (a.z0 + a.z1) / 2 + Math.cos(a.facing) * out,
  )
  bar.rotation.y = a.facing
  return bar
}

/**
 * Builds the upper level from shared data (M4): one box per floor
 * (`floor-<id>`), one wedge per ramp (`ramp-<id>`) and one cyan marker per
 * anchor (`anchor-<id>`): a vertical strip on the wall for a climb anchor, a
 * bar along the edge for a ledge. Purely visual, like `buildMap`.
 */
export function buildTraversal(scene: Scene, map: GrayboxMap = GRAYBOX_MAP): RenderedTraversal {
  const floorMat = material(scene, 'floorMat', FLOOR_COLOUR)
  const rampMat = material(scene, 'rampMat', RAMP_COLOUR)
  const anchorMat = material(scene, 'anchorMat', ANCHOR_COLOUR, ANCHOR_GLOW)
  const finish = (mesh: Mesh, mat: StandardMaterial): void => {
    mesh.material = mat
    mesh.isPickable = false
    mesh.freezeWorldMatrix()
  }

  let renderedFloors = 0
  for (const f of map.floors) {
    const box = CreateBox(
      `floor-${f.id}`,
      { width: f.max.x - f.min.x, height: f.max.y - f.min.y, depth: f.max.z - f.min.z },
      scene,
    )
    box.position.set((f.min.x + f.max.x) / 2, (f.min.y + f.max.y) / 2, (f.min.z + f.max.z) / 2)
    finish(box, floorMat)
    renderedFloors++
  }

  let renderedRamps = 0
  for (const r of map.ramps) {
    finish(buildRampMesh(scene, r), rampMat)
    renderedRamps++
  }

  let renderedAnchors = 0
  for (const a of map.anchors) {
    finish(a.kind === 'climb' ? buildClimbMarker(scene, a) : buildLedgeMarker(scene, a), anchorMat)
    renderedAnchors++
  }

  return { renderedFloors, renderedRamps, renderedAnchors }
}
