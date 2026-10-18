// Map helpers shared by the collision and room tests.
import assert from "assert";
import { GRAYBOX_MAP, type Rect, type Solid } from "../../shared/map.js";
import { BOUND } from "../src/rooms/MyRoom.js";
import { groundSolids, overlapsSolid } from "../src/rules/collision.js";

export const SOLIDS = groundSolids(GRAYBOX_MAP.solids);
export const FACE_EPS = 1e-6;

export function solid(id: string): Solid {
  const s = GRAYBOX_MAP.solids.find((x) => x.id === id);
  if (!s) throw new Error(`no solid ${id}`);
  return s;
}

export function inRect(p: { x: number; z: number }, r: Rect): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
}

export function assertClear(p: { x: number; z: number }, what = "") {
  const hit = SOLIDS.find((s) => overlapsSolid(p.x, p.z, s));
  assert.ok(!hit, `${what} (${p.x}, ${p.z}) overlaps ${hit?.id}`);
  assert.ok(Math.abs(p.x) <= BOUND && Math.abs(p.z) <= BOUND, `${what} (${p.x}, ${p.z}) out of bounds`);
}
