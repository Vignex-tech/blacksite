// Height-aware movement (M4, #29): floors, ramps, step-up, walking off edges,
// gravity and jumps. Pure functions with no Colyseus dependency. Map data,
// the player size and the vertical constants come from shared/; nothing here
// redefines them.
//
// Rules (see the "Extending" note in shared/map.d.ts):
// - Walkable surfaces are the ground (y 0), the tops of floors and the tops
//   of ramps. Tops of solids (walls, cover) are NOT walkable in M4 (decision
//   on #26).
// - A player's support is the highest walkable surface under its box whose
//   top is at most `y + STEP_HEIGHT`. A ramp's height under a box is the
//   wedge's highest point over the part of the box above it.
// - A floor blocks a player when its y range overlaps the player's
//   `y + STEP_HEIGHT .. y + PLAYER_HEIGHT`; a ramp blocks when its wedge
//   (0 up to its height under the box) does.
// - A solid blocks a player when its y range overlaps
//   `support .. y + PLAYER_HEIGHT`: it blocks in the usual band and, since
//   its top can't be stood on, the box can never move over a solid that
//   sticks up above the surface under it. So a player is never above a solid
//   top with nothing walkable beneath, and a fall can't end on one.
// - A grounded move whose support is at most STEP_HEIGHT above or below the
//   feet follows it (step up, walk down ramps). A bigger drop starts falling.
// - Every move is swept along each axis: it stops flush with the first face
//   that would block, however long it is.

import {
  PLAYER_HALF_SIZE,
  PLAYER_HEIGHT,
  type Floor,
  type Ramp,
  type Rect,
  type Solid,
} from "../../../shared/map.js";
import { GRAVITY, MAX_FALL_SPEED, STEP_HEIGHT, type MovementMode } from "../../../shared/protocol.js";

/** Tolerance for height comparisons (world units). */
const Y_EPS = 1e-9;
/** How far past a face the sweep probes to see what the box would touch there. */
const PROBE = 1e-7;
/** Longest stretch of a move checked at once; longer moves are split. */
const MAX_CHUNK = 0.25;
/** Bisection steps when a move becomes blocked between face events (ramps). */
const BISECT_STEPS = 30;

/** The map geometry that height-aware movement needs. */
export interface World {
  readonly solids: readonly Solid[];
  readonly floors: readonly Floor[];
  readonly ramps: readonly Ramp[];
  readonly bounds: Rect;
}

/** A player's position and movement state. `vy` is server-only (u/s, +up). */
export interface Body {
  x: number;
  y: number;
  z: number;
  mode: MovementMode;
  vy: number;
}

type Obstacle = Solid | Floor | Ramp;

function isRamp(o: Obstacle): o is Ramp {
  return (o as Ramp).rises !== undefined;
}

function minOf(o: Obstacle, axis: "x" | "z"): number {
  if (isRamp(o)) return axis === "x" ? o.minX : o.minZ;
  return o.min[axis];
}

function maxOf(o: Obstacle, axis: "x" | "z"): number {
  if (isRamp(o)) return axis === "x" ? o.maxX : o.maxZ;
  return o.max[axis];
}

/** Strict footprint overlap of a box centred at (x, z) with an obstacle. */
function overlaps(x: number, z: number, o: Obstacle, half: number): boolean {
  return (
    x + half > minOf(o, "x") && x - half < maxOf(o, "x") &&
    z + half > minOf(o, "z") && z - half < maxOf(o, "z")
  );
}

/** Walkable height of a ramp at (x, z), clamped to its rectangle (formula in shared/map.d.ts). */
export function rampHeightAt(r: Ramp, x: number, z: number): number {
  const cx = Math.min(Math.max(x, r.minX), r.maxX);
  const cz = Math.min(Math.max(z, r.minZ), r.maxZ);
  let t: number;
  switch (r.rises) {
    case "+z": t = (cz - r.minZ) / (r.maxZ - r.minZ); break;
    case "-z": t = (r.maxZ - cz) / (r.maxZ - r.minZ); break;
    case "+x": t = (cx - r.minX) / (r.maxX - r.minX); break;
    default: t = (r.maxX - cx) / (r.maxX - r.minX); break;
  }
  return r.low + (r.high - r.low) * t;
}

/**
 * Highest point of a ramp's wedge over the part of a box centred at (x, z)
 * that lies above it, or -Infinity if the footprints don't overlap.
 */
export function rampTopOver(r: Ramp, x: number, z: number, half: number = PLAYER_HALF_SIZE): number {
  if (!overlaps(x, z, r, half)) return -Infinity;
  const x0 = Math.max(x - half, r.minX);
  const x1 = Math.min(x + half, r.maxX);
  const z0 = Math.max(z - half, r.minZ);
  const z1 = Math.min(z + half, r.maxZ);
  // The height is linear, so its maximum over the overlap is at a corner.
  return Math.max(
    rampHeightAt(r, x0, z0), rampHeightAt(r, x1, z0),
    rampHeightAt(r, x0, z1), rampHeightAt(r, x1, z1),
  );
}

/**
 * The highest walkable surface (ground 0, floor tops, ramp tops) under a box
 * centred at (x, z) whose top is at most `maxTop`. Solid tops don't count.
 */
export function supportHeight(world: World, x: number, z: number, maxTop: number, half: number = PLAYER_HALF_SIZE): number {
  let best = 0;
  for (const f of world.floors) {
    const top = f.max.y;
    if (top > best && top <= maxTop + Y_EPS && overlaps(x, z, f, half)) best = top;
  }
  for (const r of world.ramps) {
    const top = rampTopOver(r, x, z, half);
    if (top > best && top <= maxTop + Y_EPS) best = top;
  }
  return best;
}

/**
 * True if obstacle `o` blocks a box centred at (x, z) with its feet at `y`,
 * given the support under it (see the rules at the top of this file).
 */
function blocksAt(o: Obstacle, x: number, z: number, y: number, support: number, half: number): boolean {
  if (!overlaps(x, z, o, half)) return false;
  const head = y + PLAYER_HEIGHT;
  if (isRamp(o)) {
    return Math.min(0, o.low) < head - Y_EPS && rampTopOver(o, x, z, half) > y + STEP_HEIGHT + Y_EPS;
  }
  if ((o as Solid).kind !== undefined) {
    return o.min.y < head - Y_EPS && o.max.y > support + Y_EPS;
  }
  return o.min.y < head - Y_EPS && o.max.y > y + STEP_HEIGHT + Y_EPS;
}

function allObstacles(world: World): Obstacle[] {
  return [...world.solids, ...world.floors, ...world.ramps];
}

/** The obstacles that block a box centred at (x, z) with its feet at `y`. */
export function blockersAt(world: World, x: number, z: number, y: number, half: number = PLAYER_HALF_SIZE): Obstacle[] {
  const support = supportHeight(world, x, z, y + STEP_HEIGHT, half);
  return allObstacles(world).filter((o) => blocksAt(o, x, z, y, support, half));
}

/** True if nothing blocks a box centred at (x, z) with its feet at `y`. */
export function isClear(world: World, x: number, z: number, y: number, half: number = PLAYER_HALF_SIZE): boolean {
  return blockersAt(world, x, z, y, half).length === 0;
}

/** Where the feet end up at (x, z), coming from feet height `y` in `mode`. */
function settle(world: World, x: number, z: number, y: number, mode: MovementMode, half: number): { y: number; mode: MovementMode } {
  const support = supportHeight(world, x, z, y + STEP_HEIGHT, half);
  if (mode === "ground") {
    // Follow the surface down by up to a step (ramps, small ledges); more is an edge.
    if (y - support <= STEP_HEIGHT + Y_EPS) return { y: support, mode: "ground" };
    return { y, mode: "falling" };
  }
  // In the air: a surface the feet have sunk below (by at most a step) is landed on.
  if (support > y + Y_EPS) return { y: support, mode: "ground" };
  return { y, mode };
}

interface AxisState {
  along: number;
  y: number;
  mode: MovementMode;
}

/**
 * One stretch of a move along one axis, swept against every obstacle. Between
 * two face events (the box starting or stopping to overlap a footprint) what
 * the box overlaps doesn't change, so it is checked just past each event and
 * at the end. Obstacles that already block at the start are ignored, so a
 * player placed inside one (never by this code) can still walk out.
 */
function sweepChunk(
  world: World,
  start: AxisState,
  across: number,
  delta: number,
  axis: "x" | "z",
  half: number,
): AxisState {
  const other = axis === "x" ? "z" : "x";
  const sign = Math.sign(delta);
  const target = start.along + delta;
  const at = (along: number) => (axis === "x" ? { x: along, z: across } : { x: across, z: along });

  const startPos = at(start.along);
  const startSupport = supportHeight(world, startPos.x, startPos.z, start.y + STEP_HEIGHT, half);
  const obstacles = allObstacles(world).filter(
    (o) => !blocksAt(o, startPos.x, startPos.z, start.y, startSupport, half),
  );

  /** The state at `along` reached from `from`, or null if something blocks there. */
  const tryAt = (along: number, from: AxisState): AxisState | null => {
    const p = at(along);
    const s = settle(world, p.x, p.z, from.y, from.mode, half);
    const support = supportHeight(world, p.x, p.z, s.y + STEP_HEIGHT, half);
    for (const o of obstacles) if (blocksAt(o, p.x, p.z, s.y, support, half)) return null;
    return { along, y: s.y, mode: s.mode };
  };

  // Face events in the box's path.
  const events: { at: number; enter: boolean }[] = [];
  for (const o of obstacles) {
    if (!(across + half > minOf(o, other) && across - half < maxOf(o, other))) continue;
    const lo = minOf(o, axis) - half; // centre where the box starts or stops touching the low face
    const hi = maxOf(o, axis) + half;
    const enter = sign > 0 ? lo : hi;
    const exit = sign > 0 ? hi : lo;
    if ((enter - start.along) * sign >= 0 && (target - enter) * sign > 0) events.push({ at: enter, enter: true });
    if ((exit - start.along) * sign > 0 && (target - exit) * sign >= 0) events.push({ at: exit, enter: false });
  }
  events.sort((a, b) => (a.at - b.at) * sign);

  let state = start;
  for (const e of events) {
    if (e.enter) {
      // Just past the face: if that's blocked, stop flush with it.
      const probe = e.at + sign * Math.min(PROBE, Math.abs(target - e.at) / 2);
      const next = tryAt(probe, state);
      if (!next) return tryAt(e.at, state) ?? state;
      state = next;
    } else {
      // Touching the far face is already past the obstacle.
      const next = tryAt(e.at, state);
      if (!next) return tryAt(e.at - sign * PROBE, state) ?? state;
      state = next;
    }
  }

  const end = tryAt(target, state);
  if (end) return end;
  // Blocked between events (a ramp rising under the box): bisect for the last clear point.
  let lo = state;
  let hiAlong = target;
  for (let i = 0; i < BISECT_STEPS; i++) {
    const mid = (lo.along + hiAlong) / 2;
    const next = tryAt(mid, lo);
    if (next) lo = next;
    else hiAlong = mid;
  }
  return lo;
}

/** A move along one axis, in stretches of at most MAX_CHUNK, then clamped inside the bounds. */
function moveAxis(world: World, body: Body, delta: number, axis: "x" | "z", half: number): void {
  if (delta === 0) return;
  const min = (axis === "x" ? world.bounds.minX : world.bounds.minZ) + half;
  const max = (axis === "x" ? world.bounds.maxX : world.bounds.maxZ) - half;
  const from = body[axis];
  const clamped = Math.min(max, Math.max(min, from + delta));
  const total = clamped - from;
  if (total === 0) return;
  const across = axis === "x" ? body.z : body.x;
  const chunks = Math.max(1, Math.ceil(Math.abs(total) / MAX_CHUNK));
  let state: AxisState = { along: from, y: body.y, mode: body.mode };
  for (let i = 0; i < chunks; i++) {
    const goal = i === chunks - 1 ? clamped : from + (total * (i + 1)) / chunks;
    const next = sweepChunk(world, state, across, goal - state.along, axis, half);
    const stopped = next.along !== goal;
    state = next;
    if (stopped) break;
  }
  body[axis] = state.along;
  body.y = state.y;
  if (state.mode !== body.mode) {
    body.mode = state.mode;
    body.vy = 0; // walking off an edge starts at rest; landing stops the fall
  }
}

/**
 * Applies a horizontal move of (dx, dz) to `body`: x first, then z, each
 * swept, so being blocked on one axis still allows the other (sliding). The
 * feet follow the surface on the ground, step up by at most STEP_HEIGHT, and
 * start falling off an edge. In the air the move has the same size; landing
 * on a surface the feet reach sets `ground`. Only `ground` and `falling`
 * bodies move this way.
 */
export function moveBody(world: World, body: Body, dx: number, dz: number, half: number = PLAYER_HALF_SIZE): void {
  if (body.mode !== "ground" && body.mode !== "falling") return;
  moveAxis(world, body, dx, "x", half);
  moveAxis(world, body, dz, "z", half);
}

/** Starts a jump at `speed` (u/s) from the ground. Returns false (no change) if not grounded or speed <= 0. */
export function startJump(body: Body, speed: number): boolean {
  if (body.mode !== "ground" || !(speed > 0)) return false;
  body.mode = "falling";
  body.vy = speed;
  return true;
}

/**
 * One fixed simulation step of `dt` seconds for a falling body: gravity
 * (capped at MAX_FALL_SPEED), a head check against undersides when rising,
 * and a swept landing on the highest walkable surface passed on the way down
 * (mode becomes `ground`). Other modes are left untouched, so grounded
 * players are never nudged.
 */
export function stepFall(world: World, body: Body, dt: number, half: number = PLAYER_HALF_SIZE): void {
  if (body.mode !== "falling" || !(dt > 0)) return;
  const v0 = body.vy;
  const v1 = Math.max(v0 - GRAVITY * dt, -MAX_FALL_SPEED);
  const dy = ((v0 + v1) / 2) * dt;

  if (dy > 0) {
    // Rising: stop with the head flush under the first underside above it.
    let ceiling = Infinity;
    for (const o of [...world.solids, ...world.floors]) {
      if (o.min.y >= body.y + PLAYER_HEIGHT - Y_EPS && overlaps(body.x, body.z, o, half)) {
        ceiling = Math.min(ceiling, o.min.y - PLAYER_HEIGHT);
      }
    }
    if (body.y + dy >= ceiling) {
      body.y = ceiling;
      body.vy = Math.min(0, v1);
    } else {
      body.y += dy;
      body.vy = v1;
    }
    return;
  }

  // Falling: land on the highest surface between the old and new feet heights.
  const support = supportHeight(world, body.x, body.z, body.y, half);
  if (body.y + dy <= support + Y_EPS) {
    body.y = support;
    body.vy = 0;
    body.mode = "ground";
  } else {
    body.y += dy;
    body.vy = v1;
  }
}
