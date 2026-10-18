// Map geometry for e2e tests, computed independently of server/src/rules so
// the tests check the server's collision rather than reuse it. All map data
// and the player size come from shared/map.js; nothing here redefines them.

import { GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT, type Rect, type Solid } from '../../../shared/map.js'

export { GRAYBOX_MAP, PLAYER_HALF_SIZE }

export interface Point {
  x: number
  z: number
}

/**
 * Overlap tolerance (world units). Positions are flush with faces in the
 * server's float64 maths but can be rounded on the wire, so a box "touching"
 * a face may appear a hair inside it. Real overlaps are at least one step.
 */
export const OVERLAP_EPS = 1e-4

/** Solids that block ground-floor movement: y range overlaps 0..PLAYER_HEIGHT. */
export const GROUND_SOLIDS: readonly Solid[] = GRAYBOX_MAP.solids.filter(
  (s) => s.min.y < PLAYER_HEIGHT && s.max.y > 0,
)

export function solid(id: string): Solid {
  const s = GRAYBOX_MAP.solids.find((v) => v.id === id)
  if (!s) throw new Error(`no solid ${id} in GRAYBOX_MAP`)
  return s
}

export function entrance(id: string): Point {
  const e = GRAYBOX_MAP.entrances.find((v) => v.id === id)
  if (!e) throw new Error(`no entrance ${id} in GRAYBOX_MAP`)
  return { x: e.x, z: e.z }
}

/** Ground solids that a player box centred at p overlaps by more than OVERLAP_EPS. */
export function overlapping(p: Point, eps = OVERLAP_EPS): Solid[] {
  const h = PLAYER_HALF_SIZE
  return GROUND_SOLIDS.filter(
    (s) => p.x + h - eps > s.min.x && p.x - h + eps < s.max.x && p.z + h - eps > s.min.z && p.z - h + eps < s.max.z,
  )
}

export function inRect(p: Point, r: Rect, eps = 1e-4): boolean {
  return p.x >= r.minX - eps && p.x <= r.maxX + eps && p.z >= r.minZ - eps && p.z <= r.maxZ + eps
}

/** True if p is inside the central building's outer walls (by the walls' extent). */
export function insideBuilding(p: Point): boolean {
  const walls = GRAYBOX_MAP.solids.filter((s) => s.id.startsWith('wall-'))
  const minX = Math.min(...walls.map((s) => s.min.x))
  const maxX = Math.max(...walls.map((s) => s.max.x))
  const minZ = Math.min(...walls.map((s) => s.min.z))
  const maxZ = Math.max(...walls.map((s) => s.max.z))
  return p.x > minX && p.x < maxX && p.z > minZ && p.z < maxZ
}

/**
 * Where a player centred at `from` ends up holding +z or -z (dx = 0) forever:
 * flush with the first ground solid face in its path, or at the outer bound.
 */
export function stopAlongZ(from: Point, sign: 1 | -1, bound: number): number {
  const h = PLAYER_HALF_SIZE
  let stop = sign * bound
  for (const s of GROUND_SOLIDS) {
    if (!(from.x + h > s.min.x && from.x - h < s.max.x)) continue
    if (sign > 0) {
      const face = s.min.z - h
      if (face >= from.z && face < stop) stop = face
    } else {
      const face = s.max.z + h
      if (face <= from.z && face > stop) stop = face
    }
  }
  return stop
}
