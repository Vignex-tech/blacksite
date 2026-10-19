// Climb and ledge-hang state machine (M4, #31). Pure functions with no
// Colyseus dependency. Anchors, the player size and the climbing constants
// come from shared/; nothing here redefines them.
//
// Rules (rule 5: Ghosts climb only on authored anchors):
// - `climb` from `ground` or `falling` (only if the team may climb):
//   1. a climb anchor whose (x, z) is within ANCHOR_RANGE of the centre, with
//      the feet within minY - ANCHOR_REACH .. maxY + ANCHOR_REACH: snap to
//      the anchor's (x, z), feet clamped into minY..maxY, yaw = facing,
//      mode `climbing`;
//   2. otherwise a ledge whose segment is within ANCHOR_RANGE of the centre,
//      with the hands (y + PLAYER_HEIGHT) within ANCHOR_REACH of its y: snap
//      to the nearest point of the segment, feet at y - PLAYER_HEIGHT,
//      yaw = facing, mode `hanging`;
//   the nearest valid anchor wins; climb anchors are tried first. A snap is
//   refused if the box doesn't fit there or the centre's path to it crosses
//   a solid or floor. Otherwise nothing changes.
// - `climbing`: `dz` moves the feet along the anchor at CLIMB_SPEED, clamped
//   to minY..maxY. Reaching maxY going up hangs from the anchor's ledge.
//   Going down to minY onto a surface (within STEP_HEIGHT) stands on it.
// - `hanging`: `dx` shimmies along the segment at SHIMMY_SPEED (+dx is to
//   the right when facing the ledge's `facing`), clamped to the segment.
//   `climb` mantles MANTLE_DISTANCE along `facing` onto an authored walkable
//   surface at the ledge's y (within STEP_HEIGHT), only if the box fits.
// - `drop` from `climbing` or `hanging` lets go: `falling` with vy 0.
// - No gravity while attached; the simulation only steps `falling` bodies.

import {
  PLAYER_HALF_SIZE,
  PLAYER_HEIGHT,
  type Anchor,
  type ClimbAnchor,
  type LedgeAnchor,
} from "../../../shared/map.js";
import { ANCHOR_RANGE, ANCHOR_REACH, STEP_HEIGHT } from "../../../shared/protocol.js";
import { isClear, supportHeight, type Body, type World } from "./vertical.js";

/** Tolerance for range and height comparisons (world units). */
const EPS = 1e-9;

/**
 * How far a mantle moves the centre along the ledge's `facing`: one player
 * width, from half a width outside the edge to half a width onto the top, so
 * the whole box ends up over the walkable side.
 */
export const MANTLE_DISTANCE = 2 * PLAYER_HALF_SIZE;

/** A body that can be attached to an anchor. `anchorId` is server-only. */
export interface ClimbBody extends Body {
  yaw: number;
  /** The anchor while `climbing` or `hanging`, otherwise null. */
  anchorId: string | null;
}

function findAnchor(anchors: readonly Anchor[], id: string | null): Anchor | undefined {
  return id === null ? undefined : anchors.find((a) => a.id === id);
}

/** Nearest point of a ledge's segment to (x, z). */
export function nearestOnLedge(ledge: LedgeAnchor, x: number, z: number): { x: number; z: number } {
  const ux = ledge.x1 - ledge.x0;
  const uz = ledge.z1 - ledge.z0;
  const len2 = ux * ux + uz * uz;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ledge.x0) * ux + (z - ledge.z0) * uz) / len2));
  return { x: ledge.x0 + ux * t, z: ledge.z0 + uz * t };
}

/**
 * True if the straight path of the centre from (x0, z0) to (x1, z1) passes
 * through the inside of a solid's or floor's footprint whose y range overlaps
 * yLo..yHi. A legitimate snap never does: boxes are only ever flush with faces.
 */
function pathCrosses(world: World, x0: number, z0: number, x1: number, z1: number, yLo: number, yHi: number): boolean {
  for (const o of [...world.solids, ...world.floors]) {
    if (!(o.min.y < yHi - EPS && o.max.y > yLo + EPS)) continue;
    // Liang-Barsky clip of the segment against the open footprint.
    let t0 = 0;
    let t1 = 1;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const clips: [number, number][] = [
      [-dx, x0 - o.min.x], [dx, o.max.x - x0],
      [-dz, z0 - o.min.z], [dz, o.max.z - z0],
    ];
    let inside = true;
    for (const [p, q] of clips) {
      if (p === 0) {
        if (q <= EPS) { inside = false; break; }
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    if (inside && t1 - t0 > EPS) return true;
  }
  return false;
}

/** Whether `b` may snap to (x, y, z): the box fits and the path there is clean. */
function canSnap(world: World, b: Body, x: number, y: number, z: number): boolean {
  if (!isClear(world, x, z, y)) return false;
  return !pathCrosses(world, b.x, b.z, x, z, Math.min(b.y, y), Math.max(b.y, y) + PLAYER_HEIGHT);
}

function attach(b: ClimbBody, anchor: Anchor, x: number, y: number, z: number) {
  b.x = x;
  b.y = y;
  b.z = z;
  b.vy = 0;
  b.yaw = anchor.facing;
  b.mode = anchor.kind === "climb" ? "climbing" : "hanging";
  b.anchorId = anchor.id;
}

/**
 * `climb` from `ground` or `falling`: attaches to the nearest valid climb
 * anchor, else the nearest ledge in reach (rules at the top of this file).
 * The anchor is chosen from the body's own position; nothing else is read.
 * Returns false and changes nothing if refused.
 */
export function grab(world: World, anchors: readonly Anchor[], b: ClimbBody, canClimb: boolean): boolean {
  if (!canClimb) return false;
  if (b.mode !== "ground" && b.mode !== "falling") return false;

  const climbs = anchors
    .filter((a): a is ClimbAnchor => a.kind === "climb")
    .map((a) => ({ a, d: Math.hypot(a.x - b.x, a.z - b.z) }))
    .filter(({ a, d }) => d <= ANCHOR_RANGE + EPS && b.y >= a.minY - ANCHOR_REACH - EPS && b.y <= a.maxY + ANCHOR_REACH + EPS)
    .sort((p, q) => p.d - q.d);
  for (const { a } of climbs) {
    const y = Math.min(a.maxY, Math.max(a.minY, b.y));
    if (canSnap(world, b, a.x, y, a.z)) {
      attach(b, a, a.x, y, a.z);
      return true;
    }
  }

  const hands = b.y + PLAYER_HEIGHT;
  const ledges = anchors
    .filter((a): a is LedgeAnchor => a.kind === "ledge")
    .map((a) => {
      const p = nearestOnLedge(a, b.x, b.z);
      return { a, p, d: Math.hypot(p.x - b.x, p.z - b.z) };
    })
    .filter(({ a, d }) => d <= ANCHOR_RANGE + EPS && Math.abs(hands - a.y) <= ANCHOR_REACH + EPS)
    .sort((p, q) => p.d - q.d);
  for (const { a, p } of ledges) {
    const y = a.y - PLAYER_HEIGHT;
    if (canSnap(world, b, p.x, y, p.z)) {
      attach(b, a, p.x, y, p.z);
      return true;
    }
  }
  return false;
}

/**
 * A move while `climbing`: `step` (CLIMB_SPEED / move rate, signed by dz)
 * along the anchor, clamped to minY..maxY. Going up to maxY hangs from the
 * anchor's ledge; going down to minY onto a surface stands on it. Returns
 * true if anything changed.
 */
export function climbMove(world: World, anchors: readonly Anchor[], b: ClimbBody, step: number): boolean {
  if (b.mode !== "climbing" || step === 0) return false;
  const anchor = findAnchor(anchors, b.anchorId);
  if (!anchor || anchor.kind !== "climb") return false;
  const y = Math.min(anchor.maxY, Math.max(anchor.minY, b.y + step));
  if (y !== b.y && !isClear(world, b.x, b.z, y)) return false;
  const before = b.y;
  b.y = y;

  if (step > 0 && y >= anchor.maxY - EPS) {
    const ledge = findAnchor(anchors, anchor.ledgeId);
    if (ledge && ledge.kind === "ledge") {
      const p = nearestOnLedge(ledge, b.x, b.z);
      const hangY = ledge.y - PLAYER_HEIGHT;
      if (isClear(world, p.x, p.z, hangY)) {
        attach(b, ledge, p.x, hangY, p.z);
        return true;
      }
    }
  } else if (step < 0 && y <= anchor.minY + EPS) {
    const support = supportHeight(world, b.x, b.z, y + STEP_HEIGHT);
    if (y - support <= STEP_HEIGHT + EPS && isClear(world, b.x, b.z, support)) {
      b.y = support;
      b.mode = "ground";
      b.vy = 0;
      b.anchorId = null;
      return true;
    }
  }
  return b.y !== before;
}

/**
 * A move while `hanging`: `step` (SHIMMY_SPEED / move rate, signed by dx)
 * to the right when facing the ledge's `facing`, clamped to the segment. A
 * spot where the box wouldn't fit is refused. Returns true if it moved.
 */
export function shimmy(world: World, anchors: readonly Anchor[], b: ClimbBody, step: number): boolean {
  if (b.mode !== "hanging" || step === 0) return false;
  const ledge = findAnchor(anchors, b.anchorId);
  if (!ledge || ledge.kind !== "ledge") return false;
  // Right of yaw f is (cos f, -sin f) on (x, z); see MoveMessage.
  const p = nearestOnLedge(ledge, b.x + step * Math.cos(ledge.facing), b.z - step * Math.sin(ledge.facing));
  if (p.x === b.x && p.z === b.z) return false;
  if (!isClear(world, p.x, p.z, b.y)) return false;
  b.x = p.x;
  b.z = p.z;
  return true;
}

/**
 * `climb` while `hanging`: mantles MANTLE_DISTANCE along the ledge's
 * `facing` onto an authored walkable surface (floor or ramp top; solid tops
 * don't count) within STEP_HEIGHT of the ledge's y, standing in `ground`.
 * Refused (no change) if there is no such surface or the box doesn't fit.
 */
export function mantle(world: World, anchors: readonly Anchor[], b: ClimbBody): boolean {
  if (b.mode !== "hanging") return false;
  const ledge = findAnchor(anchors, b.anchorId);
  if (!ledge || ledge.kind !== "ledge") return false;
  // Forward of yaw f is (sin f, cos f) on (x, z).
  const x = b.x + MANTLE_DISTANCE * Math.sin(ledge.facing);
  const z = b.z + MANTLE_DISTANCE * Math.cos(ledge.facing);
  const support = supportHeight(world, x, z, ledge.y + STEP_HEIGHT);
  if (Math.abs(support - ledge.y) > STEP_HEIGHT + EPS) return false;
  if (!isClear(world, x, z, support)) return false;
  b.x = x;
  b.z = z;
  b.y = support;
  b.vy = 0;
  b.mode = "ground";
  b.anchorId = null;
  return true;
}

/** `drop` from `climbing` or `hanging`: lets go (`falling`, vy 0). Otherwise no change. */
export function letGo(b: ClimbBody): boolean {
  if (b.mode !== "climbing" && b.mode !== "hanging") return false;
  b.mode = "falling";
  b.vy = 0;
  b.anchorId = null;
  return true;
}
