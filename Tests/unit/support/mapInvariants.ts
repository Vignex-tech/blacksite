// Independent checker for the invariants of the graybox map contract
// (shared/map.d.ts, #10). Written from the documented contract, not from the
// map data, so it can be pointed at broken copies of the map to prove that
// each check really fails when its invariant is broken (map.test.ts).
//
// Each check returns a list of human-readable violations; [] means it holds.

import type { GrayboxMap, Rect, Solid } from '../../../shared/map.js'

export interface MapLimits {
  /** Half the player's box on x and z. */
  playerHalfSize: number
  /** Side length of the ground (bounds must be +- groundSize / 2). */
  groundSize: number
}

/** Minimum thickness of a solid on x and z (more than a 0.1 move step). */
export const MIN_THICKNESS = 0.5
/** Clearance between a spawn area and any solid on every side. */
export const SPAWN_CLEARANCE = 1
/** Minimum width of a doorway. */
export const MIN_DOOR_WIDTH = 2
/** Minimum number of entrances. */
export const MIN_ENTRANCES = 3

/** Strict overlap of two floor rectangles: touching edges is not an overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ
}

export function solidRect(s: Solid): Rect {
  return { minX: s.min.x, maxX: s.max.x, minZ: s.min.z, maxZ: s.max.z }
}

export function grow(r: Rect, by: number): Rect {
  return { minX: r.minX - by, maxX: r.maxX + by, minZ: r.minZ - by, maxZ: r.maxZ + by }
}

export function playerBox(x: number, z: number, half: number): Rect {
  return { minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half }
}

function rectWithin(r: Rect, outer: Rect): boolean {
  return r.minX >= outer.minX && r.maxX <= outer.maxX && r.minZ >= outer.minZ && r.maxZ <= outer.maxZ
}

function pointWithin(x: number, z: number, r: Rect): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ
}

/**
 * The central building: the outer box spanned by the full-height outer walls
 * (ids "wall-*") and the inner box, shrunk by the wall thickness. Derived from
 * the data rather than copied from the comments in map.js.
 */
export function building(map: GrayboxMap): { outer: Rect; inner: Rect } | null {
  const walls = map.solids.filter((s) => s.kind === 'wall' && s.id.startsWith('wall-'))
  if (walls.length === 0) return null
  const outer: Rect = {
    minX: Math.min(...walls.map((s) => s.min.x)),
    maxX: Math.max(...walls.map((s) => s.max.x)),
    minZ: Math.min(...walls.map((s) => s.min.z)),
    maxZ: Math.max(...walls.map((s) => s.max.z)),
  }
  // Wall thickness: the thinnest horizontal extent of any outer wall.
  const t = Math.min(...walls.map((s) => Math.min(s.max.x - s.min.x, s.max.z - s.min.z)))
  return { outer, inner: grow(outer, -t) }
}

/** 1. min < max on x, y and z; at least MIN_THICKNESS thick on x and z. */
export function checkSolidShapes(map: GrayboxMap): string[] {
  const out: string[] = []
  for (const s of map.solids) {
    for (const axis of ['x', 'y', 'z'] as const) {
      if (!(Number.isFinite(s.min[axis]) && Number.isFinite(s.max[axis]))) out.push(`${s.id}: non-finite ${axis}`)
      else if (!(s.min[axis] < s.max[axis])) out.push(`${s.id}: min.${axis} ${s.min[axis]} >= max.${axis} ${s.max[axis]}`)
    }
    for (const axis of ['x', 'z'] as const) {
      const t = s.max[axis] - s.min[axis]
      if (t < MIN_THICKNESS) out.push(`${s.id}: ${t} thick on ${axis} (< ${MIN_THICKNESS})`)
    }
    if (s.kind !== 'wall' && s.kind !== 'cover') out.push(`${s.id}: unknown kind ${String(s.kind)}`)
  }
  return out
}

/** Bounds are +- groundSize / 2 and every rect's min < max. */
export function checkBounds(map: GrayboxMap, limits: MapLimits): string[] {
  const out: string[] = []
  const h = limits.groundSize / 2
  const b = map.bounds
  if (b.minX !== -h || b.maxX !== h || b.minZ !== -h || b.maxZ !== h) {
    out.push(`bounds ${JSON.stringify(b)} != +-${h}`)
  }
  for (const [name, r] of [['bounds', b], ...Object.entries(map.spawnAreas)] as [string, Rect][]) {
    if (!(r.minX < r.maxX && r.minZ < r.maxZ)) out.push(`${name}: min >= max`)
  }
  return out
}

/** 2. Every solid, spawn area, entrance and terminal is within bounds. */
export function checkWithinBounds(map: GrayboxMap): string[] {
  const out: string[] = []
  const b = map.bounds
  for (const s of map.solids) if (!rectWithin(solidRect(s), b)) out.push(`solid ${s.id} outside bounds`)
  for (const [k, r] of Object.entries(map.spawnAreas)) if (!rectWithin(r, b)) out.push(`spawn ${k} outside bounds`)
  for (const e of map.entrances) if (!pointWithin(e.x, e.z, b)) out.push(`entrance ${e.id} outside bounds`)
  for (const t of map.terminals) if (!pointWithin(t.x, t.z, b)) out.push(`terminal ${t.id} outside bounds`)
  return out
}

/**
 * 3. Each spawn area grown by SPAWN_CLEARANCE overlaps no solid.
 * 4. The spawn areas don't overlap each other.
 * Plus: the Ghost area is outside the building and the Warden area inside it.
 */
export function checkSpawnAreas(map: GrayboxMap): string[] {
  const out: string[] = []
  const { ghost, warden } = map.spawnAreas
  for (const [k, r] of Object.entries(map.spawnAreas)) {
    for (const s of map.solids) {
      if (rectsOverlap(grow(r, SPAWN_CLEARANCE), solidRect(s))) out.push(`spawn ${k} within ${SPAWN_CLEARANCE} of ${s.id}`)
    }
  }
  if (rectsOverlap(ghost, warden)) out.push('spawn areas overlap')
  const bld = building(map)
  if (!bld) out.push('no building walls')
  else {
    if (rectsOverlap(ghost, bld.outer)) out.push('ghost spawn is not outside the building')
    if (!rectWithin(warden, bld.inner)) out.push('warden spawn is not inside the building')
  }
  return out
}

/**
 * Width of the free gap through (x, z) along one axis: the distance between
 * the nearest solid faces (or bounds) on either side, looking at solids that
 * cross the line through the point.
 */
function gapAlong(map: GrayboxMap, x: number, z: number, axis: 'x' | 'z'): number {
  const b = map.bounds
  let lo = axis === 'x' ? b.minX : b.minZ
  let hi = axis === 'x' ? b.maxX : b.maxZ
  const p = axis === 'x' ? x : z
  for (const s of map.solids) {
    const r = solidRect(s)
    const crosses = axis === 'x' ? z > r.minZ && z < r.maxZ : x > r.minX && x < r.maxX
    if (!crosses) continue
    const sMin = axis === 'x' ? r.minX : r.minZ
    const sMax = axis === 'x' ? r.maxX : r.maxZ
    if (sMax <= p) lo = Math.max(lo, sMax)
    else if (sMin >= p) hi = Math.min(hi, sMin)
    else return 0 // the point is inside a solid
  }
  return hi - lo
}

/**
 * 5. At least MIN_ENTRANCES entrances. A player box centred on each overlaps no
 * solid, each lies in the building's wall ring, and its doorway (the narrower
 * free gap through it) is at least MIN_DOOR_WIDTH wide.
 */
export function checkEntrances(map: GrayboxMap, limits: MapLimits): string[] {
  const out: string[] = []
  if (map.entrances.length < MIN_ENTRANCES) out.push(`${map.entrances.length} entrances (< ${MIN_ENTRANCES})`)
  const bld = building(map)
  for (const e of map.entrances) {
    const box = playerBox(e.x, e.z, limits.playerHalfSize)
    for (const s of map.solids) if (rectsOverlap(box, solidRect(s))) out.push(`entrance ${e.id} overlaps ${s.id}`)
    if (bld && !(pointWithin(e.x, e.z, bld.outer) && !(e.x > bld.inner.minX && e.x < bld.inner.maxX && e.z > bld.inner.minZ && e.z < bld.inner.maxZ))) {
      out.push(`entrance ${e.id} is not in the building's wall ring`)
    }
    const width = Math.min(gapAlong(map, e.x, e.z, 'x'), gapAlong(map, e.x, e.z, 'z'))
    if (width < MIN_DOOR_WIDTH) out.push(`entrance ${e.id} doorway ${width} wide (< ${MIN_DOOR_WIDTH})`)
  }
  return out
}

/** 6. Exactly two terminals, each clear for a player box and inside the building. */
export function checkTerminals(map: GrayboxMap, limits: MapLimits): string[] {
  const out: string[] = []
  if (map.terminals.length !== 2) out.push(`${map.terminals.length} terminals (expected 2)`)
  const bld = building(map)
  for (const t of map.terminals) {
    if (![t.x, t.y, t.z].every(Number.isFinite)) out.push(`terminal ${t.id}: non-finite position`)
    const box = playerBox(t.x, t.z, limits.playerHalfSize)
    for (const s of map.solids) if (rectsOverlap(box, solidRect(s))) out.push(`terminal ${t.id} overlaps ${s.id}`)
    if (bld && !(t.x > bld.inner.minX && t.x < bld.inner.maxX && t.z > bld.inner.minZ && t.z < bld.inner.maxZ)) {
      out.push(`terminal ${t.id} is not inside the building`)
    }
  }
  return out
}

/** 7. Ids are unique within each list (and non-empty). */
export function checkIds(map: GrayboxMap): string[] {
  const out: string[] = []
  if (!map.id) out.push('map has no id')
  for (const [name, list] of [
    ['solids', map.solids],
    ['entrances', map.entrances],
    ['terminals', map.terminals],
  ] as const) {
    const seen = new Set<string>()
    for (const { id } of list) {
      if (!id) out.push(`${name}: empty id`)
      if (seen.has(id)) out.push(`${name}: duplicate id ${id}`)
      seen.add(id)
    }
  }
  return out
}

/** Every check at once. */
export function allViolations(map: GrayboxMap, limits: MapLimits): string[] {
  return [
    ...checkSolidShapes(map),
    ...checkBounds(map, limits),
    ...checkWithinBounds(map),
    ...checkSpawnAreas(map),
    ...checkEntrances(map, limits),
    ...checkTerminals(map, limits),
    ...checkIds(map),
  ]
}

/**
 * Cells (on a `step` grid of player-centre positions) reachable from `from`
 * by a player box that never overlaps a solid and stays within bounds.
 * Returns a predicate for "is (x, z) reachable".
 */
export function reachableFrom(
  map: GrayboxMap,
  limits: MapLimits,
  from: { x: number; z: number },
  step = 0.25,
): (x: number, z: number) => boolean {
  const h = limits.playerHalfSize
  const b = map.bounds
  const x0 = b.minX + h
  const z0 = b.minZ + h
  const nx = Math.floor((b.maxX - h - x0) / step) + 1
  const nz = Math.floor((b.maxZ - h - z0) / step) + 1
  const rects = map.solids.map(solidRect)
  const free = (i: number, j: number) => {
    const box = playerBox(x0 + i * step, z0 + j * step, h)
    return !rects.some((r) => rectsOverlap(box, r))
  }
  const seen = new Uint8Array(nx * nz)
  const cell = (x: number, z: number): [number, number] => [Math.round((x - x0) / step), Math.round((z - z0) / step)]
  const [si, sj] = cell(from.x, from.z)
  const queue: number[] = []
  if (si >= 0 && si < nx && sj >= 0 && sj < nz && free(si, sj)) {
    seen[si + sj * nx] = 1
    queue.push(si + sj * nx)
  }
  while (queue.length) {
    const k = queue.pop()!
    const i = k % nx
    const j = (k - i) / nx
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const a = i + di
      const c = j + dj
      if (a < 0 || a >= nx || c < 0 || c >= nz) continue
      const n = a + c * nx
      if (seen[n] || !free(a, c)) continue
      seen[n] = 1
      queue.push(n)
    }
  }
  return (x, z) => {
    const [i, j] = cell(x, z)
    return i >= 0 && i < nx && j >= 0 && j < nz && seen[i + j * nx] === 1
  }
}
