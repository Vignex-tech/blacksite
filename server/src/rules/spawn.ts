// Spawn rules: where in a team's spawn area a joiner appears. The area is
// GRAYBOX_MAP.spawnAreas[team]; the team comes from rules/teams.ts.
// Pure functions with no Colyseus dependency.

import type { Rect, Solid, SpawnAreas } from "../../../shared/map.js";
import { overlapsAny, type FloorPoint } from "./collision.js";

/** Name of a spawn area in the map (`ghost` or `warden`). */
export type SpawnAreaName = keyof SpawnAreas;

/** Random points tried before falling back to the area's centre. */
export const SPAWN_ATTEMPTS = 50;

/**
 * A random point inside `area` whose player box does not overlap any solid.
 * The map guarantees 1 unit of clearance around spawn areas, so the first
 * try always succeeds today; the retries and the centre fallback only guard
 * against a later map edit.
 */
export function randomSpawnPoint(
  area: Rect,
  solids: readonly Solid[],
  random: () => number = Math.random,
): FloorPoint {
  for (let i = 0; i < SPAWN_ATTEMPTS; i++) {
    const x = area.minX + random() * (area.maxX - area.minX);
    const z = area.minZ + random() * (area.maxZ - area.minZ);
    if (!overlapsAny(x, z, solids)) return { x, z };
  }
  return { x: (area.minX + area.maxX) / 2, z: (area.minZ + area.maxZ) / 2 };
}
