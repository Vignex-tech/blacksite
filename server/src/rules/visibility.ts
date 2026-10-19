// Who may be sent whom (M5, #46). Pure code with no Colyseus dependency.
//
// Rule 2: a Warden client must not learn where a Ghost is unless the Warden
// could see or be next to it. `canSee(world, viewer, target)` decides it:
//   - a Ghost viewer sees everyone;
//   - anyone sees themselves and their teammates;
//   - a Warden sees an enemy Ghost if the 3D distance between the two box
//     centres is at most VISIBILITY_NEAR (even through a wall: it is "heard"),
//     or if a straight line from the Warden's eye (x, y + EYE_HEIGHT, z) to at
//     least one sample point of the Ghost's box is not blocked by a solid,
//     floor, ramp or the ground (`segmentBlocked`, rules/ballistics.ts).
// No view cone and no range limit. Eliminated players are treated like live
// ones: a dead Ghost is hidden like a live one, a dead Warden sees by its eye.
//
// Sample points of a Ghost's box (feet position x, y, z), `SAMPLE_OFFSETS`:
// the centre column at feet (+0.1), centre (+0.9) and head (+1.7), and four
// shoulder points at head height, 0.4 to each side on x and z (inside the
// 1.0 wide box). Any one clear line is enough, so a head over low cover, or
// a shoulder past a corner, is visible. Worst case 7 ray tests per
// Warden-Ghost pair, and the search stops at the first clear line.

import { PLAYER_HEIGHT } from "../../../shared/map.js";
import { EYE_HEIGHT, VISIBILITY_NEAR } from "../../../shared/protocol.js";
import { segmentBlocked, type BallisticWorld, type Vec3 } from "./ballistics.js";

/** What visibility needs to know about a player. `x, y, z` is the feet position. */
export interface Viewable {
  id: string;
  team: string;
  x: number;
  y: number;
  z: number;
}

/** Offsets (dx, dy, dz) from the feet position to each sample point. */
export const SAMPLE_OFFSETS: ReadonlyArray<Readonly<Vec3>> = Object.freeze([
  { x: 0, y: PLAYER_HEIGHT * 0.5, z: 0 }, // centre first: it is the most common clear line
  { x: 0, y: PLAYER_HEIGHT - 0.1, z: 0 }, // head
  { x: 0, y: 0.1, z: 0 }, // feet
  { x: 0.4, y: PLAYER_HEIGHT - 0.1, z: 0.4 },
  { x: -0.4, y: PLAYER_HEIGHT - 0.1, z: 0.4 },
  { x: 0.4, y: PLAYER_HEIGHT - 0.1, z: -0.4 },
  { x: -0.4, y: PLAYER_HEIGHT - 0.1, z: -0.4 },
]);

/** Number of ray tests `canSee` runs at most for one Warden-Ghost pair. */
export const MAX_RAYS_PER_PAIR = SAMPLE_OFFSETS.length;

/** True if `viewer` is sent `target`. */
export function canSee(world: BallisticWorld, viewer: Viewable, target: Viewable): boolean {
  if (viewer.team === "ghost") return true;
  if (viewer.id === target.id || viewer.team === target.team) return true;

  const half = PLAYER_HEIGHT * 0.5;
  const near = Math.hypot(target.x - viewer.x, target.y + half - (viewer.y + half), target.z - viewer.z);
  if (near <= VISIBILITY_NEAR) return true;

  const eye = { x: viewer.x, y: viewer.y + EYE_HEIGHT, z: viewer.z };
  for (const o of SAMPLE_OFFSETS) {
    const p = { x: target.x + o.x, y: target.y + o.y, z: target.z + o.z };
    if (!segmentBlocked(world, eye, p)) return true;
  }
  return false;
}
