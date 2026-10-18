// Helpers for the height-aware tests (#29). The overlap check here is written
// independently of server/src/rules/vertical.ts, from the rule in
// shared/map.d.ts, so the tests check the rules rather than reuse them.
import assert from "assert";
import { GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT, type Ramp } from "../../shared/map.js";
import { STEP_HEIGHT } from "../../shared/protocol.js";
import { BOUND } from "../src/rooms/MyRoom.js";
import type { World } from "../src/rules/vertical.js";

export const WORLD: World = {
  solids: GRAYBOX_MAP.solids,
  floors: GRAYBOX_MAP.floors,
  ramps: GRAYBOX_MAP.ramps,
  bounds: GRAYBOX_MAP.bounds,
};

/** Overlap tolerance for the independent checks. */
export const OVERLAP_EPS = 1e-6;

export function ramp(id: string): Ramp {
  const r = GRAYBOX_MAP.ramps.find((v) => v.id === id);
  if (!r) throw new Error(`no ramp ${id}`);
  return r;
}

export function floor(id: string) {
  const f = GRAYBOX_MAP.floors.find((v) => v.id === id);
  if (!f) throw new Error(`no floor ${id}`);
  return f;
}

/** Ramp height at (x, z), clamped to the ramp ('+z' ramps only, like the map's). */
function rampHeight(r: Ramp, z: number): number {
  assert.strictEqual(r.rises, "+z");
  const cz = Math.min(Math.max(z, r.minZ), r.maxZ);
  return r.low + ((r.high - r.low) * (cz - r.minZ)) / (r.maxZ - r.minZ);
}

interface Placed { x: number; y: number; z: number }

/**
 * What a box at p overlaps, by more than `eps`: solids, floors and ramp wedges
 * whose y range overlaps y + STEP_HEIGHT .. y + PLAYER_HEIGHT (the shared
 * rule), plus solids whose top is above the feet (solid tops are not
 * walkable, so a box is never over one that sticks up past its feet).
 */
export function overlapsAt(p: Placed, eps = OVERLAP_EPS): string[] {
  const h = PLAYER_HALF_SIZE - eps;
  const x0 = p.x - h, x1 = p.x + h, z0 = p.z - h, z1 = p.z + h;
  const hit: string[] = [];
  const lo = p.y + STEP_HEIGHT + eps;
  const hi = p.y + PLAYER_HEIGHT - eps;
  for (const s of GRAYBOX_MAP.solids) {
    if (!(x1 > s.min.x && x0 < s.max.x && z1 > s.min.z && z0 < s.max.z)) continue;
    if (s.min.y < hi && s.max.y > p.y + eps) hit.push(s.id);
  }
  for (const f of GRAYBOX_MAP.floors) {
    if (!(x1 > f.min.x && x0 < f.max.x && z1 > f.min.z && z0 < f.max.z)) continue;
    if (f.min.y < hi && f.max.y > lo) hit.push(f.id);
  }
  for (const r of GRAYBOX_MAP.ramps) {
    if (!(x1 > r.minX && x0 < r.maxX && z1 > r.minZ && z0 < r.maxZ)) continue;
    const top = rampHeight(r, Math.min(z1, r.maxZ));
    if (0 < hi && top > lo) hit.push(r.id);
  }
  return hit;
}

/** Asserts p overlaps nothing, is inside the bounds and isn't below the ground. */
export function assertClear3(p: Placed, what = "") {
  const hit = overlapsAt(p);
  assert.deepStrictEqual(hit, [], `${what} (${p.x}, ${p.y}, ${p.z}) overlaps ${hit.join(", ")}`);
  assert.ok(Math.abs(p.x) <= BOUND + 1e-9 && Math.abs(p.z) <= BOUND + 1e-9, `${what} (${p.x}, ${p.z}) out of bounds`);
  assert.ok(p.y >= -1e-9, `${what} y ${p.y} below the ground`);
}

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
