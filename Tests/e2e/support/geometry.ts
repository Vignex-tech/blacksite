// Map geometry for e2e tests, computed independently of server/src/rules so
// the tests check the server's collision rather than reuse it. All map data,
// the player size and the vertical constants come from shared/; nothing here
// redefines them.
//
// Height-aware since #28 (contract in #27, shared/map.d.ts "Extending"): a
// box (a solid, a floor, or the wedge under a ramp) blocks a player when its
// y range overlaps the player's `y + STEP_HEIGHT .. y + PLAYER_HEIGHT`. A
// player's `y` is its feet height when the synced state has one, 0 otherwise
// (before #29 every player is on the ground, so nothing changes there).

import {
  GRAYBOX_MAP,
  PLAYER_HALF_SIZE,
  PLAYER_HEIGHT,
  type Floor,
  type Ramp,
  type Rect,
  type Solid,
} from '../../../shared/map.js'
import { ANCHOR_RANGE, STEP_HEIGHT } from '../../../shared/protocol.js'

export { GRAYBOX_MAP, PLAYER_HALF_SIZE }

export interface Point {
  x: number
  z: number
}

/** A position that may carry a feet height (`y`) and a movement mode, as synced state does since #29. */
export interface Placed extends Point {
  y?: unknown
  mode?: unknown
}

/**
 * Overlap tolerance (world units). Positions are flush with faces in the
 * server's float64 maths but can be rounded on the wire, so a box "touching"
 * a face may appear a hair inside it. Real overlaps are at least one step.
 */
export const OVERLAP_EPS = 1e-4

/** Something a player box can overlap: a solid, a floor slab or a ramp's wedge. */
export interface Obstacle {
  id: string
  kind: 'solid' | 'floor' | 'ramp'
  rect: Rect
  /** Box y range (for a ramp: 0 up to its high end; use `topOver` for the height under a box). */
  minY: number
  maxY: number
  ramp?: Ramp
}

const boxRect = (b: Solid | Floor): Rect => ({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z })
const rampRect = (r: Ramp): Rect => ({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ })

/** Every obstacle of the map: solids, then floors, then ramps. */
export const OBSTACLES: readonly Obstacle[] = [
  ...GRAYBOX_MAP.solids.map((s): Obstacle => ({ id: s.id, kind: 'solid', rect: boxRect(s), minY: s.min.y, maxY: s.max.y })),
  ...GRAYBOX_MAP.floors.map((f): Obstacle => ({ id: f.id, kind: 'floor', rect: boxRect(f), minY: f.min.y, maxY: f.max.y })),
  ...GRAYBOX_MAP.ramps.map((r): Obstacle => ({ id: r.id, kind: 'ramp', rect: rampRect(r), minY: 0, maxY: Math.max(r.low, r.high), ramp: r })),
]

/** The player's feet height: `y` when it is a finite number, else 0 (missing means 0, #27). */
export function feetY(p: Placed): number {
  return typeof p.y === 'number' && Number.isFinite(p.y) ? p.y : 0
}

/** The player's movement mode: `mode` when it is a string, else 'ground' (missing means 'ground', #27). */
export function modeOf(p: Placed): string {
  return typeof p.mode === 'string' ? p.mode : 'ground'
}

/** Walkable height of a ramp at (x, z), clamped to its rectangle (formula in shared/map.d.ts). */
export function rampHeightAt(r: Ramp, x: number, z: number): number {
  const cx = Math.min(Math.max(x, r.minX), r.maxX)
  const cz = Math.min(Math.max(z, r.minZ), r.maxZ)
  const t =
    r.rises === '+z'
      ? (cz - r.minZ) / (r.maxZ - r.minZ)
      : r.rises === '-z'
        ? (r.maxZ - cz) / (r.maxZ - r.minZ)
        : r.rises === '+x'
          ? (cx - r.minX) / (r.maxX - r.minX)
          : (r.maxX - cx) / (r.maxX - r.minX)
  return r.low + (r.high - r.low) * t
}

/** Strict overlap of two rectangles: touching edges is not an overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ
}

/** The highest point of a ramp's wedge over the part of `box` above it, or -Infinity if they don't overlap. */
export function rampTopOver(r: Ramp, box: Rect): number {
  if (!rectsOverlap(box, rampRect(r))) return -Infinity
  const x0 = Math.max(box.minX, r.minX)
  const x1 = Math.min(box.maxX, r.maxX)
  const z0 = Math.max(box.minZ, r.minZ)
  const z1 = Math.min(box.maxZ, r.maxZ)
  // The height is linear, so its maximum over the overlap is at a corner.
  return Math.max(rampHeightAt(r, x0, z0), rampHeightAt(r, x1, z0), rampHeightAt(r, x0, z1), rampHeightAt(r, x1, z1))
}

export function playerRect(p: Point, half = PLAYER_HALF_SIZE): Rect {
  return { minX: p.x - half, maxX: p.x + half, minZ: p.z - half, maxZ: p.z + half }
}

/**
 * True if obstacle `o` blocks a player box with footprint `box` and feet at
 * `y`: their footprints overlap and o's y range (for a ramp, 0 up to the
 * wedge's highest point over the box) overlaps y + STEP_HEIGHT .. y + PLAYER_HEIGHT,
 * by more than `eps` on every axis.
 */
export function blocks(o: Obstacle, box: Rect, y: number, eps = OVERLAP_EPS): boolean {
  const b = { minX: box.minX + eps, maxX: box.maxX - eps, minZ: box.minZ + eps, maxZ: box.maxZ - eps }
  if (!rectsOverlap(b, o.rect)) return false
  const top = o.ramp ? rampTopOver(o.ramp, b) : o.maxY
  return o.minY < y + PLAYER_HEIGHT - eps && top > y + STEP_HEIGHT + eps
}

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

/**
 * Obstacles that a player box centred at p, with its feet at p.y (default 0),
 * overlaps by more than `eps` (a negative eps adds margin). y-aware: walls,
 * cover and ramp sides block on the ground; floor slabs block only a player
 * whose band reaches them; a box above a wall's top is clear of it.
 */
export function overlapping(p: Placed, eps = OVERLAP_EPS): Obstacle[] {
  const box = playerRect(p)
  const y = feetY(p)
  return OBSTACLES.filter((o) => blocks(o, box, y, eps))
}

/** Obstacles that block a player standing on the ground (y 0): every solid and ramp, no upper-level floor. */
export const GROUND_OBSTACLES: readonly Obstacle[] = OBSTACLES.filter((o) => o.minY < PLAYER_HEIGHT && o.maxY > STEP_HEIGHT)

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

// ---------------------------------------------------------------------------
// Route hazards (#28). Scripted ground walks must keep away from the places
// where #29 and #31 change what a walk does:
// - ramp footprints: walking onto one climbs it, walking into its side stops;
// - covered pockets: the space under a floor beside a ramp's side (under the
//   mezzanine, between the west wall and the stairs): a low dead end;
// - climb anchor spots: within ANCHOR_RANGE of a climb anchor a climb can start.
// Floor undersides elsewhere (the catwalk spans the whole interior, and the
// west doorway opens under the mezzanine) can't all be avoided; walks may
// pass under them only on the ground, which the walkers assert (y 0, mode
// 'ground'), and the y-aware overlap counts the slab as an obstacle.
// Ledge anchors are at UPPER_LEVEL_Y and out of reach from the ground
// (invariant 16, unit/map.test.ts), and ground walks send no actions.
// ---------------------------------------------------------------------------

/** Margin (world units) that scripted routes keep between the player box and a hazard. */
export const ROUTE_MARGIN = 0.25

/** A hazard: a rectangle on the floor that the player's box (or, for anchors, its centre) must stay out of. */
export interface Hazard {
  id: string
  /** Rectangle the player's centre must not enter (already grown by the player's half size where it applies). */
  centres: Rect
}

function grow(r: Rect, by: number): Rect {
  return { minX: r.minX - by, maxX: r.maxX + by, minZ: r.minZ - by, maxZ: r.maxZ + by }
}

/** How far a ramp's side strip reaches out, looking for a covered pocket beside it. */
const POCKET_REACH = 2

/** Footprints of the covered pockets: a floor's footprint within POCKET_REACH of a ramp's sides. */
export const POCKETS: readonly { id: string; rect: Rect }[] = GRAYBOX_MAP.ramps.flatMap((r) => {
  const along = r.rises === '+z' || r.rises === '-z'
  const strip: Rect = along
    ? { minX: r.minX - POCKET_REACH, maxX: r.maxX + POCKET_REACH, minZ: r.minZ, maxZ: r.maxZ }
    : { minX: r.minX, maxX: r.maxX, minZ: r.minZ - POCKET_REACH, maxZ: r.maxZ + POCKET_REACH }
  return GRAYBOX_MAP.floors.flatMap((f) => {
    const fr = boxRect(f)
    if (!rectsOverlap(strip, fr)) return []
    const rect = {
      minX: Math.max(strip.minX, fr.minX),
      maxX: Math.min(strip.maxX, fr.maxX),
      minZ: Math.max(strip.minZ, fr.minZ),
      maxZ: Math.min(strip.maxZ, fr.maxZ),
    }
    return [{ id: `pocket-${r.id}-${f.id}`, rect }]
  })
})

/** Every hazard, with the player's centre rectangle grown by `margin`. */
export function hazards(margin = ROUTE_MARGIN): Hazard[] {
  const h = PLAYER_HALF_SIZE
  return [
    ...GRAYBOX_MAP.ramps.map((r) => ({ id: r.id, centres: grow(rampRect(r), h + margin) })),
    ...POCKETS.map((p) => ({ id: p.id, centres: grow(p.rect, h + margin) })),
    ...GRAYBOX_MAP.anchors.flatMap((a) =>
      a.kind === 'climb' ? [{ id: a.id, centres: grow({ minX: a.x, maxX: a.x, minZ: a.z, maxZ: a.z }, ANCHOR_RANGE + margin) }] : [],
    ),
  ]
}

/** Ids of the hazards a player centred at p is in (strictly inside the grown rectangle). */
export function hazardsAt(p: Point, margin = ROUTE_MARGIN): string[] {
  return hazards(margin)
    .filter((z) => p.x > z.centres.minX && p.x < z.centres.maxX && p.z > z.centres.minZ && p.z < z.centres.maxZ)
    .map((z) => z.id)
}

/**
 * Ids of the hazards that a player whose centre stays in the rectangle
 * spanned by `a` and `b` could enter (for a one-axis leg, the segment a..b).
 */
export function hazardsOnLeg(a: Point, b: Point, margin = ROUTE_MARGIN): string[] {
  const span: Rect = { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) }
  return hazards(margin)
    .filter((z) => span.minX < z.centres.maxX && span.maxX > z.centres.minX && span.minZ < z.centres.maxZ && span.maxZ > z.centres.minZ)
    .map((z) => z.id)
}

/** Fails (throws) if a walk leg from `a` to `b` could enter a hazard. */
export function assertLegClear(a: Point, b: Point, who: string, margin = ROUTE_MARGIN): void {
  const hit = hazardsOnLeg(a, b, margin)
  if (hit.length) {
    throw new Error(`${who}: the leg ${a.x},${a.z} -> ${b.x},${b.z} comes within ${margin} of ${hit.join(', ')} (ramps, pockets and climb spots are off limits to ground routes)`)
  }
}

/**
 * Problems with a player that must be walking on the ground: a feet height
 * other than 0 or a mode other than 'ground' (both optional until #29 and
 * #33; missing means 0 and 'ground'), or a bad type.
 */
export function groundProblems(p: Placed, eps = 1e-4): string[] {
  const out: string[] = []
  if (p.y !== undefined && !(typeof p.y === 'number' && Number.isFinite(p.y))) out.push(`y is ${JSON.stringify(p.y)}, not a finite number`)
  else if (Math.abs(feetY(p)) > eps) out.push(`y is ${feetY(p)}, not on the ground`)
  if (p.mode !== undefined && modeOf(p) !== 'ground') out.push(`mode is ${JSON.stringify(p.mode)}, not 'ground'`)
  return out
}

/**
 * Where a player centred at `from`, on the ground, ends up holding +z or -z
 * (dx = 0) forever: flush with the first ground obstacle face in its path, or
 * at the outer bound. Throws if the path crosses a ramp or a pocket, where
 * the stop would depend on how #29 climbs ramps.
 */
export function stopAlongZ(from: Point, sign: 1 | -1, bound: number): number {
  const h = PLAYER_HALF_SIZE
  let stop = sign * bound
  for (const s of GROUND_OBSTACLES) {
    if (!(from.x + h > s.rect.minX && from.x - h < s.rect.maxX)) continue
    if (sign > 0) {
      const face = s.rect.minZ - h
      if (face >= from.z && face < stop) stop = face
    } else {
      const face = s.rect.maxZ + h
      if (face <= from.z && face > stop) stop = face
    }
  }
  assertLegClear(from, { x: from.x, z: stop }, `stopAlongZ from ${from.x},${from.z}`, 0)
  const hit = OBSTACLES.find((o) => o.kind === 'ramp' && from.x + h > o.rect.minX && from.x - h < o.rect.maxX && (sign > 0 ? o.rect.minZ - h >= from.z && o.rect.minZ - h <= stop : o.rect.maxZ + h <= from.z && o.rect.maxZ + h >= stop))
  if (hit) throw new Error(`stopAlongZ from ${from.x},${from.z}: the path meets ramp ${hit.id}`)
  return stop
}
