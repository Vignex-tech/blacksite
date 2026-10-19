// Hitscan ballistics (M5, #41). Pure code with no Colyseus dependency.
//
// A shot is a ray from the shooter's eye. It is tested against the map's
// solids (boxes), floors (slabs), ramps (the same wedge rules/vertical.ts
// collides with: footprint from the ground up to the walkable height), the
// ground plane (y = 0) and other players' boxes. Anchors and terminals never
// block. The nearest hit wins. `segmentBlocked` is the same test without
// player volumes; the visibility filter (#46) reuses it as line of sight.

import { PLAYER_HALF_SIZE, PLAYER_HEIGHT, type Floor, type Ramp, type Solid } from "../../../shared/map.js";

/** Tolerance when comparing distances along a ray. */
const T_EPS = 1e-9;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The map geometry a ray is tested against. */
export interface BallisticWorld {
  readonly solids: readonly Solid[];
  readonly floors: readonly Floor[];
  readonly ramps: readonly Ramp[];
}

/** A player volume a shot can hit: feet position, `PLAYER_HALF_SIZE` wide, `PLAYER_HEIGHT` tall. */
export interface Target {
  id: string;
  x: number;
  y: number;
  z: number;
}

export type HitKind = "solid" | "floor" | "ramp" | "ground" | "player";

export interface RayHit {
  kind: HitKind;
  /** Solid, floor, ramp or player id; absent for the ground. */
  id?: string;
  /** Distance from the origin along the (unit) direction. */
  t: number;
  point: Vec3;
}

/**
 * Unit aim direction from yaw and pitch. Forward is (sin yaw, cos yaw) on
 * (x, z) (0 faces +z, positive turns toward +x); positive pitch looks up.
 */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: Math.cos(yaw) * c };
}

/**
 * Clips a ray against a convex region given as half-spaces n . p <= d
 * (Cyrus-Beck). Returns the entry distance (0 if the origin is inside), or
 * null on a miss. Only hits in 0..maxT count.
 */
function clip(o: Vec3, dir: Vec3, planes: ReadonlyArray<readonly [number, number, number, number]>, maxT: number): number | null {
  let tIn = 0;
  let tOut = maxT;
  for (const [nx, ny, nz, d] of planes) {
    const denom = nx * dir.x + ny * dir.y + nz * dir.z;
    const dist = d - (nx * o.x + ny * o.y + nz * o.z); // > 0 means the origin is inside this half-space
    if (Math.abs(denom) < 1e-12) {
      if (dist < 0) return null;
      continue;
    }
    const t = dist / denom;
    if (denom > 0) tOut = Math.min(tOut, t);
    else tIn = Math.max(tIn, t);
    if (tIn > tOut + T_EPS) return null;
  }
  return tIn <= tOut + T_EPS ? tIn : null;
}

function boxPlanes(min: Vec3, max: Vec3): Array<readonly [number, number, number, number]> {
  return [
    [1, 0, 0, max.x], [-1, 0, 0, -min.x],
    [0, 1, 0, max.y], [0, -1, 0, -min.y],
    [0, 0, 1, max.z], [0, 0, -1, -min.z],
  ];
}

/** The ramp as half-spaces: its footprint, y >= 0, and below the sloped top. */
function rampPlanes(r: Ramp): Array<readonly [number, number, number, number]> {
  const slope = (r.high - r.low);
  let top: readonly [number, number, number, number];
  switch (r.rises) {
    case "+z": { const k = slope / (r.maxZ - r.minZ); top = [0, 1, -k, r.low - k * r.minZ]; break; }
    case "-z": { const k = slope / (r.maxZ - r.minZ); top = [0, 1, k, r.low + k * r.maxZ]; break; }
    case "+x": { const k = slope / (r.maxX - r.minX); top = [-k, 1, 0, r.low - k * r.minX]; break; }
    default: { const k = slope / (r.maxX - r.minX); top = [k, 1, 0, r.low + k * r.maxX]; break; }
  }
  const high = Math.max(r.low, r.high);
  return [
    [1, 0, 0, r.maxX], [-1, 0, 0, -r.minX],
    [0, 0, 1, r.maxZ], [0, 0, -1, -r.minZ],
    [0, -1, 0, 0], [0, 1, 0, high],
    top,
  ];
}

function pointAt(o: Vec3, dir: Vec3, t: number): Vec3 {
  return { x: o.x + dir.x * t, y: o.y + dir.y * t, z: o.z + dir.z * t };
}

/**
 * Nearest thing a ray hits within `range`, or null. `dir` must be a unit
 * vector. `targets` are player volumes (the caller leaves out the shooter,
 * teammates and eliminated players). Map surfaces and players are all
 * considered, and the nearest wins; on a tie the map wins.
 */
export function castRay(
  world: BallisticWorld,
  origin: Vec3,
  dir: Vec3,
  range: number,
  targets: readonly Target[] = [],
): RayHit | null {
  let best: RayHit | null = null;
  const consider = (kind: HitKind, t: number | null, id?: string) => {
    if (t === null || t > range) return;
    if (best === null || t < best.t - T_EPS) best = { kind, id, t, point: pointAt(origin, dir, t) };
  };

  for (const s of world.solids) consider("solid", clip(origin, dir, boxPlanes(s.min, s.max), range), s.id);
  for (const f of world.floors) consider("floor", clip(origin, dir, boxPlanes(f.min, f.max), range), f.id);
  for (const r of world.ramps) consider("ramp", clip(origin, dir, rampPlanes(r), range), r.id);
  if (dir.y < 0 && origin.y > 0) consider("ground", -origin.y / dir.y);
  for (const p of targets) {
    const min = { x: p.x - PLAYER_HALF_SIZE, y: p.y, z: p.z - PLAYER_HALF_SIZE };
    const max = { x: p.x + PLAYER_HALF_SIZE, y: p.y + PLAYER_HEIGHT, z: p.z + PLAYER_HALF_SIZE };
    consider("player", clip(origin, dir, boxPlanes(min, max), range), p.id);
  }
  if (best) {
    const hit = best as RayHit;
    if (hit.kind === "ground") hit.point.y = 0;
    if (!hit.id) delete hit.id;
  }
  return best;
}

/**
 * True if a solid, floor, ramp or the ground lies between `a` and `b`
 * (player volumes are ignored). Used as the line-of-sight test.
 */
export function segmentBlocked(world: BallisticWorld, a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < T_EPS) return false;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  const hit = castRay(world, a, dir, len);
  return hit !== null && hit.t < len - 1e-6;
}
