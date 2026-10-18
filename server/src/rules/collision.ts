// Server-side collision against the shared map's solids. Pure functions with
// no Colyseus dependency, so they are easy to test. Map data and the player
// size come from shared/map.js; nothing here redefines them.

import {
  PLAYER_HALF_SIZE,
  PLAYER_HEIGHT,
  type Rect,
  type Solid,
} from "../../../shared/map.js";

/** Tolerance for "the solid is ahead of the player" checks (world units). */
const AHEAD_EPS = 1e-9;

/** A player's position on the floor: the centre of its box on x and z. */
export interface FloorPoint {
  x: number;
  z: number;
}

/**
 * Solids that block movement on the ground floor: those whose y range
 * overlaps the player's 0..PLAYER_HEIGHT. Upper-level solids (M4) are skipped.
 */
export function groundSolids(solids: readonly Solid[]): Solid[] {
  return solids.filter((s) => s.min.y < PLAYER_HEIGHT && s.max.y > 0);
}

/**
 * True if a player box centred at (x, z) strictly overlaps the solid on x and
 * z. Touching a face is not an overlap, so a player can stand flush against
 * a wall and slide along it.
 */
export function overlapsSolid(x: number, z: number, s: Solid, half = PLAYER_HALF_SIZE): boolean {
  return (
    x + half > s.min.x && x - half < s.max.x &&
    z + half > s.min.z && z - half < s.max.z
  );
}

/** True if a player box centred at (x, z) overlaps any of the solids. */
export function overlapsAny(x: number, z: number, solids: readonly Solid[], half = PLAYER_HALF_SIZE): boolean {
  return solids.some((s) => overlapsSolid(x, z, s, half));
}

/**
 * Moves along one axis by `delta`, swept against the solids: the box stops
 * flush with the first face in its path, however large `delta` is, so it
 * can't tunnel through thin walls. `along` is the moving coordinate, `across`
 * the fixed one. Solids the box already overlaps are ignored, so a player
 * placed inside one (never by this code) can still walk out.
 */
function sweepAxis(
  along: number,
  across: number,
  delta: number,
  axis: "x" | "z",
  solids: readonly Solid[],
  half: number,
): number {
  if (delta === 0) return along;
  const other = axis === "x" ? "z" : "x";
  let target = along + delta;
  for (const s of solids) {
    // Only solids that overlap the box on the other axis can block it.
    if (!(across + half > s.min[other] && across - half < s.max[other])) continue;
    if (delta > 0) {
      const face = s.min[axis] - half; // centre position flush with the face
      if (face >= along - AHEAD_EPS && face < target) target = face;
    } else {
      const face = s.max[axis] + half;
      if (face <= along + AHEAD_EPS && face > target) target = face;
    }
  }
  // Never move backwards because of a face we were already slightly past.
  return delta > 0 ? Math.max(along, target) : Math.min(along, target);
}

/**
 * Resolves a move of (dx, dz) from (x, z): x first, then z, each swept against
 * the solids, so being blocked on one axis still allows the other (sliding).
 * The result is clamped so the whole box stays inside `bounds`.
 */
export function resolveMove(
  from: FloorPoint,
  dx: number,
  dz: number,
  solids: readonly Solid[],
  bounds: Rect,
  half = PLAYER_HALF_SIZE,
): FloorPoint {
  const clampX = (v: number) => Math.min(bounds.maxX - half, Math.max(bounds.minX + half, v));
  const clampZ = (v: number) => Math.min(bounds.maxZ - half, Math.max(bounds.minZ + half, v));
  const x = clampX(sweepAxis(from.x, from.z, dx, "x", solids, half));
  const z = clampZ(sweepAxis(from.z, x, dz, "z", solids, half));
  return { x, z };
}
