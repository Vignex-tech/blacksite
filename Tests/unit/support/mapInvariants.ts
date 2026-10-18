// Independent checker for the invariants of the graybox map contract
// (shared/map.d.ts, #10, and the upper level, #27). Written from the
// documented contract, not from the map data, so it can be pointed at broken
// copies of the map to prove that each check really fails when its invariant
// is broken (map.test.ts).
//
// Each check returns a list of human-readable violations; [] means it holds.
//
// Since #28 the ground checks (invariants 3, 5, 6 and the ground flood fill)
// look only at volumes in the ground band: what blocks a player standing on
// the ground (feet at y 0) under the y-aware rule of map.d.ts, a box blocks
// when its y range overlaps STEP_HEIGHT..PLAYER_HEIGHT. Upper-level floors
// are above that band; ramps are solid wedges from the ground and count.

import type { ClimbAnchor, Floor, GrayboxMap, LedgeAnchor, Ramp, Rect, Solid } from '../../../shared/map.js'

export interface MapLimits {
  /** Half the player's box on x and z. */
  playerHalfSize: number
  /** Side length of the ground (bounds must be +- groundSize / 2). */
  groundSize: number
  /** Height of the player's box from its feet (PLAYER_HEIGHT). */
  playerHeight: number
  /** The most a walking move raises the feet (STEP_HEIGHT). */
  stepHeight: number
}

/** Limits for the upper-level invariants (9 to 16, #27). */
export interface VerticalLimits extends MapLimits {
  /** Walking height of the upper level (UPPER_LEVEL_Y). */
  upperY: number
  gravity: number
  /** Jump speed of every team (the values of JUMP_SPEED). */
  jumpSpeeds: number[]
  /** Vertical slack for grabbing a ledge (ANCHOR_REACH). */
  anchorReach: number
}

/** Minimum thickness of a solid on x and z (more than a 0.1 move step). */
export const MIN_THICKNESS = 0.5
/** Clearance between a spawn area and any solid on every side. */
export const SPAWN_CLEARANCE = 1
/** Minimum width of a doorway. */
export const MIN_DOOR_WIDTH = 2
/** Minimum number of entrances. */
export const MIN_ENTRANCES = 3

// Upper level (invariants 10 and 11).
export const SLAB_MIN_THICKNESS = 0.1
export const SLAB_MAX_THICKNESS = 0.3
export const SLAB_MIN_WIDTH = 1.5
/** Headroom under a floor slab beyond the player's height. */
export const SLAB_HEADROOM = 0.4
export const RAMP_MIN_WIDTH = 1.5
export const RAMP_MAX_SLOPE = 0.6
/** Space around a doorway that a ramp must leave free: the entrance's player box grown by this. */
export const DOORWAY_APPROACH = 1

/** Float tolerance for values that the contract states exactly (e.g. 1.2 + 1.8 = 3). */
const TOL = 1e-9

/** Strict overlap of two floor rectangles: touching edges is not an overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ
}

export function solidRect(s: Solid | Floor): Rect {
  return { minX: s.min.x, maxX: s.max.x, minZ: s.min.z, maxZ: s.max.z }
}

export function rampRect(r: Ramp): Rect {
  return { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ }
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

/** A volume whose footprint blocks a player standing on the ground. */
export interface GroundVolume {
  id: string
  rect: Rect
}

/**
 * Volumes in the ground band: solids and floors whose y range overlaps
 * stepHeight..playerHeight, and every ramp whose high end is above the step
 * height (a solid wedge from the ground, so an obstacle on the ground).
 */
export function groundVolumes(map: GrayboxMap, limits: MapLimits): GroundVolume[] {
  const inBand = (minY: number, maxY: number) => minY < limits.playerHeight && maxY > limits.stepHeight
  return [
    ...map.solids.filter((s) => inBand(s.min.y, s.max.y)).map((s) => ({ id: s.id, rect: solidRect(s) })),
    ...(map.floors ?? []).filter((f) => inBand(f.min.y, f.max.y)).map((f) => ({ id: f.id, rect: solidRect(f) })),
    ...(map.ramps ?? []).filter((r) => inBand(0, Math.max(r.low, r.high))).map((r) => ({ id: r.id, rect: rampRect(r) })),
  ]
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
 * 3. Each spawn area grown by SPAWN_CLEARANCE overlaps no ground-band volume.
 * 4. The spawn areas don't overlap each other.
 * Plus: the Ghost area is outside the building and the Warden area inside it.
 */
export function checkSpawnAreas(map: GrayboxMap, limits: MapLimits): string[] {
  const out: string[] = []
  const { ghost, warden } = map.spawnAreas
  const vols = groundVolumes(map, limits)
  for (const [k, r] of Object.entries(map.spawnAreas)) {
    for (const s of vols) {
      if (rectsOverlap(grow(r, SPAWN_CLEARANCE), s.rect)) out.push(`spawn ${k} within ${SPAWN_CLEARANCE} of ${s.id}`)
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
 * the nearest ground-band faces (or bounds) on either side, looking at
 * volumes that cross the line through the point.
 */
function gapAlong(map: GrayboxMap, limits: MapLimits, x: number, z: number, axis: 'x' | 'z'): number {
  const b = map.bounds
  let lo = axis === 'x' ? b.minX : b.minZ
  let hi = axis === 'x' ? b.maxX : b.maxZ
  const p = axis === 'x' ? x : z
  for (const { rect: r } of groundVolumes(map, limits)) {
    const crosses = axis === 'x' ? z > r.minZ && z < r.maxZ : x > r.minX && x < r.maxX
    if (!crosses) continue
    const sMin = axis === 'x' ? r.minX : r.minZ
    const sMax = axis === 'x' ? r.maxX : r.maxZ
    if (sMax <= p) lo = Math.max(lo, sMax)
    else if (sMin >= p) hi = Math.min(hi, sMin)
    else return 0 // the point is inside a volume
  }
  return hi - lo
}

/**
 * 5. At least MIN_ENTRANCES entrances. A player box centred on each overlaps no
 * ground-band volume, each lies in the building's wall ring, and its doorway
 * (the narrower free gap through it) is at least MIN_DOOR_WIDTH wide.
 */
export function checkEntrances(map: GrayboxMap, limits: MapLimits): string[] {
  const out: string[] = []
  if (map.entrances.length < MIN_ENTRANCES) out.push(`${map.entrances.length} entrances (< ${MIN_ENTRANCES})`)
  const bld = building(map)
  const vols = groundVolumes(map, limits)
  for (const e of map.entrances) {
    const box = playerBox(e.x, e.z, limits.playerHalfSize)
    for (const s of vols) if (rectsOverlap(box, s.rect)) out.push(`entrance ${e.id} overlaps ${s.id}`)
    if (bld && !(pointWithin(e.x, e.z, bld.outer) && !(e.x > bld.inner.minX && e.x < bld.inner.maxX && e.z > bld.inner.minZ && e.z < bld.inner.maxZ))) {
      out.push(`entrance ${e.id} is not in the building's wall ring`)
    }
    const width = Math.min(gapAlong(map, limits, e.x, e.z, 'x'), gapAlong(map, limits, e.x, e.z, 'z'))
    if (width < MIN_DOOR_WIDTH) out.push(`entrance ${e.id} doorway ${width} wide (< ${MIN_DOOR_WIDTH})`)
  }
  return out
}

/** 6. Exactly two terminals, each clear of ground-band volumes for a player box and inside the building. */
export function checkTerminals(map: GrayboxMap, limits: MapLimits): string[] {
  const out: string[] = []
  if (map.terminals.length !== 2) out.push(`${map.terminals.length} terminals (expected 2)`)
  const bld = building(map)
  const vols = groundVolumes(map, limits)
  for (const t of map.terminals) {
    if (![t.x, t.y, t.z].every(Number.isFinite)) out.push(`terminal ${t.id}: non-finite position`)
    const box = playerBox(t.x, t.z, limits.playerHalfSize)
    for (const s of vols) if (rectsOverlap(box, s.rect)) out.push(`terminal ${t.id} overlaps ${s.id}`)
    if (bld && !(t.x > bld.inner.minX && t.x < bld.inner.maxX && t.z > bld.inner.minZ && t.z < bld.inner.maxZ)) {
      out.push(`terminal ${t.id} is not inside the building`)
    }
  }
  return out
}

/** 7. Ids are unique within each list (and non-empty). 15. The same for anchors, floors and ramps. */
export function checkIds(map: GrayboxMap): string[] {
  const out: string[] = []
  if (!map.id) out.push('map has no id')
  for (const [name, list] of [
    ['solids', map.solids],
    ['entrances', map.entrances],
    ['terminals', map.terminals],
    ['floors', map.floors ?? []],
    ['ramps', map.ramps ?? []],
    ['anchors', map.anchors ?? []],
  ] as const) {
    const seen = new Set<string>()
    for (const { id } of list as readonly { id: string }[]) {
      if (!id) out.push(`${name}: empty id`)
      if (seen.has(id)) out.push(`${name}: duplicate id ${id}`)
      seen.add(id)
    }
  }
  return out
}

/** Every ground check at once (invariants 1 to 8). */
export function allViolations(map: GrayboxMap, limits: MapLimits): string[] {
  return [
    ...checkSolidShapes(map),
    ...checkBounds(map, limits),
    ...checkWithinBounds(map),
    ...checkSpawnAreas(map, limits),
    ...checkEntrances(map, limits),
    ...checkTerminals(map, limits),
    ...checkIds(map),
  ]
}

/**
 * Cells (on a `step` grid of player-centre positions) reachable on the ground
 * from `from` by a player box that never overlaps a ground-band volume
 * (solids and floors in the band, and every ramp) and stays within bounds.
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
  const rects = groundVolumes(map, limits).map((v) => v.rect)
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

// ---------------------------------------------------------------------------
// Upper level (invariants 9 to 16 of shared/map.d.ts, #27).
// ---------------------------------------------------------------------------

/** An axis-aligned box in 3D. */
export interface Box3 {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

/** Strict overlap in 3D: boxes that only touch don't overlap. */
export function boxesOverlap(a: Box3, b: Box3): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ
}

function box3(b: Solid | Floor): Box3 {
  return { minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y, minZ: b.min.z, maxZ: b.max.z }
}

function playerBox3(x: number, z: number, minY: number, maxY: number, half: number): Box3 {
  return { minX: x - half, maxX: x + half, minY, maxY, minZ: z - half, maxZ: z + half }
}

/** Solids and floors (each a box) with their ids. */
function boxes(map: GrayboxMap): { id: string; box: Box3; top: number; rect: Rect }[] {
  return [...map.solids, ...map.floors].map((b) => ({ id: b.id, box: box3(b), top: b.max.y, rect: solidRect(b) }))
}

const isLedge = (a: { kind: string }): a is LedgeAnchor => a.kind === 'ledge'
const isClimb = (a: { kind: string }): a is ClimbAnchor => a.kind === 'climb'

/** Unit direction (x, z) of a yaw (0 faces +z, positive toward +x). */
function forward(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) }
}

function distToSegment(px: number, pz: number, l: LedgeAnchor): number {
  const dx = l.x1 - l.x0
  const dz = l.z1 - l.z0
  const len2 = dx * dx + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - l.x0) * dx + (pz - l.z0) * dz) / len2))
  return Math.hypot(px - (l.x0 + t * dx), pz - (l.z0 + t * dz))
}

/** 9. Every floor, ramp and anchor is within bounds (and has finite coordinates). */
export function checkUpperWithinBounds(map: GrayboxMap): string[] {
  const out: string[] = []
  const b = map.bounds
  for (const f of map.floors) {
    const nums = [f.min.x, f.min.y, f.min.z, f.max.x, f.max.y, f.max.z]
    if (!nums.every(Number.isFinite)) out.push(`floor ${f.id}: non-finite coordinates`)
    if (!rectWithin(solidRect(f), b)) out.push(`floor ${f.id} outside bounds`)
  }
  for (const r of map.ramps) {
    if (![r.minX, r.maxX, r.minZ, r.maxZ, r.low, r.high].every(Number.isFinite)) out.push(`ramp ${r.id}: non-finite coordinates`)
    if (!rectWithin(rampRect(r), b)) out.push(`ramp ${r.id} outside bounds`)
  }
  for (const a of map.anchors) {
    const pts = isClimb(a) ? [[a.x, a.z]] : isLedge(a) ? [[a.x0, a.z0], [a.x1, a.z1]] : []
    if (!pts.length) out.push(`anchor ${(a as { id: string }).id}: unknown kind ${String((a as { kind: unknown }).kind)}`)
    for (const [x, z] of pts) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) out.push(`anchor ${a.id}: non-finite position`)
      else if (!pointWithin(x, z, b)) out.push(`anchor ${a.id} outside bounds`)
    }
  }
  return out
}

/**
 * 10. Floors are thin slabs with their top at the upper level, wide enough,
 * with headroom underneath, overlapping no solid and no other floor.
 */
export function checkFloors(map: GrayboxMap, limits: VerticalLimits): string[] {
  const out: string[] = []
  for (const f of map.floors) {
    for (const axis of ['x', 'y', 'z'] as const) {
      if (!(f.min[axis] < f.max[axis])) out.push(`floor ${f.id}: min.${axis} >= max.${axis}`)
    }
    if (Math.abs(f.max.y - limits.upperY) > TOL) out.push(`floor ${f.id}: top ${f.max.y} is not the upper level ${limits.upperY}`)
    const t = f.max.y - f.min.y
    if (t < SLAB_MIN_THICKNESS - TOL || t > SLAB_MAX_THICKNESS + TOL) out.push(`floor ${f.id}: ${t} thick (not ${SLAB_MIN_THICKNESS}..${SLAB_MAX_THICKNESS})`)
    for (const axis of ['x', 'z'] as const) {
      const w = f.max[axis] - f.min[axis]
      if (w < SLAB_MIN_WIDTH) out.push(`floor ${f.id}: ${w} wide on ${axis} (< ${SLAB_MIN_WIDTH})`)
    }
    const minUnder = limits.playerHeight + SLAB_HEADROOM
    if (f.min.y < minUnder - TOL) out.push(`floor ${f.id}: underside ${f.min.y} leaves no headroom (< ${minUnder})`)
    for (const s of map.solids) if (boxesOverlap(box3(f), box3(s))) out.push(`floor ${f.id} overlaps solid ${s.id}`)
    for (const g of map.floors) if (g !== f && boxesOverlap(box3(f), box3(g))) out.push(`floor ${f.id} overlaps floor ${g.id}`)
  }
  return out
}

/** Run, width across the rise, and the high edge of a ramp. */
function rampShape(r: Ramp): { run: number; width: number; edge: Rect } | null {
  switch (r.rises) {
    case '+z':
      return { run: r.maxZ - r.minZ, width: r.maxX - r.minX, edge: { minX: r.minX, maxX: r.maxX, minZ: r.maxZ, maxZ: r.maxZ } }
    case '-z':
      return { run: r.maxZ - r.minZ, width: r.maxX - r.minX, edge: { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.minZ } }
    case '+x':
      return { run: r.maxX - r.minX, width: r.maxZ - r.minZ, edge: { minX: r.maxX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ } }
    case '-x':
      return { run: r.maxX - r.minX, width: r.maxZ - r.minZ, edge: { minX: r.minX, maxX: r.minX, minZ: r.minZ, maxZ: r.maxZ } }
    default:
      return null
  }
}

/**
 * True if floor rectangle `f` lies beyond the ramp's high edge and touches it
 * along part of its length: it shares the edge line and overlaps it lengthwise.
 */
function floorMeetsEdge(r: Ramp, f: Rect): boolean {
  const e = rampShape(r)!.edge
  const near = (a: number, b: number) => Math.abs(a - b) <= TOL
  switch (r.rises) {
    case '+z':
      return near(f.minZ, e.minZ) && f.minX < e.maxX && f.maxX > e.minX
    case '-z':
      return near(f.maxZ, e.minZ) && f.minX < e.maxX && f.maxX > e.minX
    case '+x':
      return near(f.minX, e.minX) && f.minZ < e.maxZ && f.maxZ > e.minZ
    case '-x':
      return near(f.maxX, e.minX) && f.minZ < e.maxZ && f.maxZ > e.minZ
  }
}

/**
 * 11. Each ramp is at least RAMP_MIN_WIDTH wide across its rise, its slope is
 * at most RAMP_MAX_SLOPE, it starts on the ground (low 0), and its high end
 * meets the top of a floor within the step height.
 */
export function checkRamps(map: GrayboxMap, limits: VerticalLimits): string[] {
  const out: string[] = []
  for (const r of map.ramps) {
    const shape = rampShape(r)
    if (!shape) {
      out.push(`ramp ${r.id}: unknown rise ${String(r.rises)}`)
      continue
    }
    if (!(r.minX < r.maxX && r.minZ < r.maxZ)) out.push(`ramp ${r.id}: min >= max`)
    if (shape.width < RAMP_MIN_WIDTH) out.push(`ramp ${r.id}: ${shape.width} wide (< ${RAMP_MIN_WIDTH})`)
    const slope = (r.high - r.low) / shape.run
    if (!(slope <= RAMP_MAX_SLOPE)) out.push(`ramp ${r.id}: slope ${slope} (> ${RAMP_MAX_SLOPE})`)
    if (!(r.high > r.low)) out.push(`ramp ${r.id}: high ${r.high} is not above low ${r.low}`)
    if (r.low !== 0) out.push(`ramp ${r.id}: low ${r.low} is not the ground`)
    const landing = map.floors.find((f) => floorMeetsEdge(r, solidRect(f)) && Math.abs(f.max.y - r.high) <= limits.stepHeight + TOL)
    if (!landing) out.push(`ramp ${r.id}: its high end meets no floor top within ${limits.stepHeight}`)
  }
  return out
}

/**
 * 12. Ramps overlap no spawn area grown by 1, entrance player box, doorway
 * approach (the entrance's player box grown by DOORWAY_APPROACH), terminal
 * player box, solid, floor or other ramp.
 */
export function checkRampClearance(map: GrayboxMap, limits: MapLimits): string[] {
  const out: string[] = []
  const h = limits.playerHalfSize
  for (const r of map.ramps) {
    const rr = rampRect(r)
    for (const [k, a] of Object.entries(map.spawnAreas)) if (rectsOverlap(rr, grow(a, SPAWN_CLEARANCE))) out.push(`ramp ${r.id} within ${SPAWN_CLEARANCE} of spawn ${k}`)
    for (const e of map.entrances) {
      if (rectsOverlap(rr, playerBox(e.x, e.z, h))) out.push(`ramp ${r.id} overlaps entrance ${e.id}`)
      else if (rectsOverlap(rr, grow(playerBox(e.x, e.z, h), DOORWAY_APPROACH))) out.push(`ramp ${r.id} blocks doorway ${e.id}`)
    }
    for (const t of map.terminals) if (rectsOverlap(rr, playerBox(t.x, t.z, h))) out.push(`ramp ${r.id} overlaps terminal ${t.id}`)
    for (const s of map.solids) if (rectsOverlap(rr, solidRect(s))) out.push(`ramp ${r.id} overlaps solid ${s.id}`)
    for (const f of map.floors) if (rectsOverlap(rr, solidRect(f))) out.push(`ramp ${r.id} overlaps floor ${f.id}`)
    for (const o of map.ramps) if (o !== r && rectsOverlap(rr, rampRect(o))) out.push(`ramp ${r.id} overlaps ramp ${o.id}`)
  }
  return out
}

/**
 * 13. Each climb anchor names a ledge, is flush with a solid face it faces
 * (the solid spans minY..maxY + playerHeight over the climber's width), its
 * climbing box overlaps no solid or floor, its top (maxY + playerHeight) is
 * the ledge's y, and the climb point lies on the ledge's segment.
 */
export function checkClimbAnchors(map: GrayboxMap, limits: MapLimits): string[] {
  const out: string[] = []
  const h = limits.playerHalfSize
  const H = limits.playerHeight
  for (const a of map.anchors.filter(isClimb)) {
    if (![a.x, a.z, a.facing, a.minY, a.maxY].every(Number.isFinite)) {
      out.push(`climb ${a.id}: non-finite fields`)
      continue
    }
    if (!(a.minY < a.maxY)) out.push(`climb ${a.id}: minY >= maxY`)
    const ledge = map.anchors.find((l) => l.id === a.ledgeId)
    if (!ledge || !isLedge(ledge)) out.push(`climb ${a.id}: ledgeId ${a.ledgeId} names no ledge`)
    // The face it faces: the climber's box side in the facing direction.
    const f = forward(a.facing)
    const axisX = Math.abs(Math.abs(f.x) - 1) < 1e-9
    const axisZ = Math.abs(Math.abs(f.z) - 1) < 1e-9
    if (!axisX && !axisZ) out.push(`climb ${a.id}: facing ${a.facing} is not along x or z`)
    else {
      const top = a.maxY + H
      const flush = map.solids.find((s) => {
        const spansY = s.min.y <= a.minY + TOL && s.max.y >= top - TOL
        if (axisX) {
          const face = f.x > 0 ? s.min.x : s.max.x
          return Math.abs(face - (a.x + Math.sign(f.x) * h)) <= TOL && s.min.z <= a.z - h + TOL && s.max.z >= a.z + h - TOL && spansY
        }
        const face = f.z > 0 ? s.min.z : s.max.z
        return Math.abs(face - (a.z + Math.sign(f.z) * h)) <= TOL && s.min.x <= a.x - h + TOL && s.max.x >= a.x + h - TOL && spansY
      })
      if (!flush) out.push(`climb ${a.id}: not flush with a solid face it faces`)
    }
    const climbBox = playerBox3(a.x, a.z, a.minY, a.maxY + H, h)
    for (const b of boxes(map)) if (boxesOverlap(climbBox, b.box)) out.push(`climb ${a.id}: its climbing box overlaps ${b.id}`)
    if (ledge && isLedge(ledge)) {
      if (Math.abs(a.maxY + H - ledge.y) > TOL) out.push(`climb ${a.id}: top ${a.maxY + H} is not ledge ${ledge.id}'s y ${ledge.y}`)
      if (distToSegment(a.x, a.z, ledge) > 1e-9) out.push(`climb ${a.id}: not on ledge ${ledge.id}'s segment`)
    }
  }
  return out
}

/**
 * 14. Each ledge has a clear standing spot (its segment's midpoint moved 1
 * along `facing`, at the ledge's y): the player box there rests on a floor
 * or solid top at that y and overlaps no solid or floor. A player hanging
 * anywhere on the segment (box from y - playerHeight to y) overlaps nothing.
 */
export function checkLedges(map: GrayboxMap, limits: MapLimits): string[] {
  const out: string[] = []
  const h = limits.playerHalfSize
  const H = limits.playerHeight
  const all = boxes(map)
  for (const l of map.anchors.filter(isLedge)) {
    if (![l.x0, l.z0, l.x1, l.z1, l.y, l.facing].every(Number.isFinite)) {
      out.push(`ledge ${l.id}: non-finite fields`)
      continue
    }
    const f = forward(l.facing)
    const sx = (l.x0 + l.x1) / 2 + f.x
    const sz = (l.z0 + l.z1) / 2 + f.z
    const stand = playerBox3(sx, sz, l.y, l.y + H, h)
    for (const b of all) if (boxesOverlap(stand, b.box)) out.push(`ledge ${l.id}: standing spot ${sx},${sz} overlaps ${b.id}`)
    const footprint = playerBox(sx, sz, h)
    const support = all.find((b) => Math.abs(b.top - l.y) <= TOL && rectsOverlap(footprint, b.rect))
    if (!support) out.push(`ledge ${l.id}: standing spot ${sx},${sz} rests on nothing at y ${l.y}`)
    const len = Math.hypot(l.x1 - l.x0, l.z1 - l.z0)
    const n = Math.max(1, Math.ceil(len / 0.05))
    const hit = new Set<string>()
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const hang = playerBox3(l.x0 + (l.x1 - l.x0) * t, l.z0 + (l.z1 - l.z0) * t, l.y - H, l.y, h)
      for (const b of all) if (boxesOverlap(hang, b.box)) hit.add(b.id)
    }
    for (const id of hit) out.push(`ledge ${l.id}: a player hanging on it overlaps ${id}`)
  }
  return out
}

/** Highest jump apex over the teams: v^2 / (2 * gravity). */
export function jumpApex(limits: VerticalLimits): number {
  return Math.max(0, ...limits.jumpSpeeds.map((v) => (v * v) / (2 * limits.gravity)))
}

/**
 * 16, numerically: the jump apex plus the step height is below the lowest
 * solid top, and every ledge is out of reach from the ground
 * (y - playerHeight - anchorReach above the apex).
 */
export function checkOutOfReach(map: GrayboxMap, limits: VerticalLimits): string[] {
  const out: string[] = []
  const apex = jumpApex(limits)
  const lowest = Math.min(...map.solids.map((s) => s.max.y))
  if (!(apex + limits.stepHeight < lowest)) out.push(`jump apex ${apex} + step ${limits.stepHeight} reaches the lowest solid top ${lowest}`)
  for (const l of map.anchors.filter(isLedge)) {
    const lowestGrab = l.y - limits.playerHeight - limits.anchorReach
    if (!(lowestGrab > apex)) out.push(`ledge ${l.id} can be grabbed from a jump (feet ${lowestGrab} <= apex ${apex})`)
  }
  return out
}

/** Every upper-level check at once (invariants 9 to 16, except the flood fill). */
export function allUpperViolations(map: GrayboxMap, limits: VerticalLimits): string[] {
  return [
    ...checkUpperWithinBounds(map),
    ...checkFloors(map, limits),
    ...checkRamps(map, limits),
    ...checkRampClearance(map, limits),
    ...checkClimbAnchors(map, limits),
    ...checkLedges(map, limits),
    ...checkIds(map),
    ...checkOutOfReach(map, limits),
  ]
}

// ---------------------------------------------------------------------------
// Reachability over heights (invariant 16).
//
// A flood fill over (cell, feet height) states. From a state, a move to a
// neighbouring cell lands on the highest surface under the player box (the
// ground, a solid or floor top, or the ramp wedge's highest point under the
// box) that is at most `rise` above the feet, where rise is the step height
// plus the team's jump apex: a jump is treated as reaching anything a step
// could from the apex, which can only make more reachable. Lower surfaces
// are reached by falling. The landing must be clear under the y-aware rule:
// no solid, floor or ramp wedge overlaps the band y + step .. y + height.
// ---------------------------------------------------------------------------

export interface HeightReach {
  /** Floors the fill stood on at their top (ids). */
  floorsReached: Set<string>
  /** Highest feet height reached. */
  maxY: number
  /** States visited. */
  states: number
  /** True if (x, z) was reached with the feet at y (within 1e-6). */
  at(x: number, z: number, y: number): boolean
}

function rampHeightAt(r: Ramp, x: number, z: number): number {
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

/** Highest point of a ramp's wedge over the part of `box` above it; -Infinity if they don't overlap. */
export function rampTopOver(r: Ramp, box: Rect): number {
  if (!rectsOverlap(box, rampRect(r))) return -Infinity
  const x0 = Math.max(box.minX, r.minX)
  const x1 = Math.min(box.maxX, r.maxX)
  const z0 = Math.max(box.minZ, r.minZ)
  const z1 = Math.min(box.maxZ, r.maxZ)
  return Math.max(rampHeightAt(r, x0, z0), rampHeightAt(r, x1, z0), rampHeightAt(r, x0, z1), rampHeightAt(r, x1, z1))
}

export function reachByHeight(
  map: GrayboxMap,
  limits: MapLimits,
  from: { x: number; z: number },
  jumpApexHeight: number,
  step = 0.25,
): HeightReach {
  const h = limits.playerHalfSize
  const H = limits.playerHeight
  const S = limits.stepHeight
  const rise = S + Math.max(0, jumpApexHeight)
  const b = map.bounds
  const x0 = b.minX + h
  const z0 = b.minZ + h
  const nx = Math.floor((b.maxX - h - x0) / step) + 1
  const nz = Math.floor((b.maxZ - h - z0) / step) + 1
  const vols = [
    ...map.solids.map((s) => ({ id: s.id, rect: solidRect(s), minY: s.min.y, top: () => s.max.y, floor: false })),
    ...map.floors.map((f) => ({ id: f.id, rect: solidRect(f), minY: f.min.y, top: () => f.max.y, floor: true })),
  ]
  /** Surfaces under a box: [height, floor id or null]. */
  const surfaces = (box: Rect): [number, string | null][] => {
    const out: [number, string | null][] = [[0, null]]
    for (const v of vols) if (rectsOverlap(box, v.rect)) out.push([v.top(), v.floor ? v.id : null])
    for (const r of map.ramps) {
      const t = rampTopOver(r, box)
      if (t > -Infinity) out.push([t, null])
    }
    return out
  }
  const clear = (box: Rect, y: number) => {
    for (const v of vols) if (rectsOverlap(box, v.rect) && v.minY < y + H - TOL && v.top() > y + S + TOL) return false
    for (const r of map.ramps) if (rampTopOver(r, box) > y + S + TOL && 0 < y + H) return false
    return true
  }
  const key = (i: number, j: number, y: number) => `${i},${j},${Math.round(y * 1e6)}`
  const seen = new Set<string>()
  const floorsReached = new Set<string>()
  let maxY = 0
  const queue: [number, number, number][] = []
  const [si, sj] = [Math.round((from.x - x0) / step), Math.round((from.z - z0) / step)]
  const startBox = playerBox(x0 + si * step, z0 + sj * step, h)
  if (clear(startBox, 0)) {
    seen.add(key(si, sj, 0))
    queue.push([si, sj, 0])
  }
  while (queue.length) {
    const [i, j, y] = queue.pop()!
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const a = i + di
      const c = j + dj
      if (a < 0 || a >= nx || c < 0 || c >= nz) continue
      const box = playerBox(x0 + a * step, z0 + c * step, h)
      let best: [number, string | null] | null = null
      for (const s of surfaces(box)) if (s[0] <= y + rise + TOL && (!best || s[0] > best[0])) best = s
      if (!best) continue
      const ny = best[0]
      if (!clear(box, ny)) continue
      const k = key(a, c, ny)
      if (seen.has(k)) continue
      seen.add(k)
      // Which floors this box stands on at their top.
      for (const v of vols) if (v.floor && Math.abs(v.top() - ny) <= TOL && rectsOverlap(box, v.rect)) floorsReached.add(v.id)
      if (ny > maxY) maxY = ny
      queue.push([a, c, ny])
    }
  }
  return {
    floorsReached,
    maxY,
    states: seen.size,
    at: (x, z, y) => seen.has(key(Math.round((x - x0) / step), Math.round((z - z0) / step), y)),
  }
}

/**
 * 16 by flood fill: from `from` (the Warden spawn), with the ramps removed,
 * no floor of the upper level can be stood on, for every jump speed.
 */
export function checkUpperOnlyByRamps(map: GrayboxMap, limits: VerticalLimits, from: { x: number; z: number }): string[] {
  const out: string[] = []
  const noRamps = { ...map, ramps: [] } as GrayboxMap
  for (const v of limits.jumpSpeeds) {
    const apex = (v * v) / (2 * limits.gravity)
    const r = reachByHeight(noRamps, limits, from, apex)
    if (r.floorsReached.size) out.push(`without ramps, jump speed ${v} reaches floors ${[...r.floorsReached].join(',')}`)
  }
  return out
}
