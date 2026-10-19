// Types of the graybox map contract. Runtime data lives in map.js.
// Import from "<relative path>/shared/map.js" on both sides.
//
// Conventions
// - Units: world units (1 unit is roughly 1 metre; a player box is 1 x 1.8 x 1).
// - Axes: y is up. The ground floor is at y = 0. +z points away from the
//   default camera (north on the overhead view), +x to its right (east).
// - Player positions in room state (`PlayerState { x, z }`) are the centre of
//   the player's box on x and z; the box spans x +- PLAYER_HALF_SIZE,
//   z +- PLAYER_HALF_SIZE and y from the floor to floor + PLAYER_HEIGHT.
// - All ranges are closed min..max with min < max. Boxes are axis-aligned.
//
// Authority: the server collides moves and picks spawn points with this data.
// The client only renders it; it never blocks or corrects movement locally.
// Neither side redefines map data or player size: both import them from here.
//
// Invariants of GRAYBOX_MAP (tested by QA, #16):
// 1. Every solid has min < max on x, y and z, and is at least 0.5 thick on x
//    and on z (more than one move step of 0.1, so a move can't tunnel through).
// 2. Every solid, spawn area, entrance and terminal is within `bounds`.
// 3. Each spawn area is at least 1 unit clear of every solid on every side
//    (the area grown by 1 on x and z does not overlap any solid), so a player
//    centred anywhere in it never overlaps a solid.
// 4. The two spawn areas do not overlap.
// 5. Each entrance point is clear of solids: a player box centred on it does
//    not overlap any solid. Every doorway is at least 2 units wide.
// 6. Each terminal's x, z is clear of solids in the same sense, and the
//    terminal is inside the central building.
// 7. Ids are unique within each list.
// 8. bounds equal +- GROUND_SIZE / 2 (from protocol.js) on x and z.
//
// Invariants of the upper level (M4, #27; QA turns them into tests in #28):
// 9.  Every floor, ramp and anchor is within `bounds`.
// 10. Floors are thin slabs: max.y = UPPER_LEVEL_Y, 0.1..0.3 thick, at least
//     1.5 wide on x and on z, with their underside (min.y) at least
//     PLAYER_HEIGHT + 0.4 above the ground, so players walk under them. Floors
//     don't overlap solids or each other (touching faces is not overlap).
// 11. Each ramp is at least 1.5 wide across its rise, its slope
//     (high - low) / run is at most 0.6, low is 0, and its high end meets the
//     top of a floor within STEP_HEIGHT (a floor touches the high edge and
//     |floor top - high| <= STEP_HEIGHT).
// 12. Ramps don't overlap a spawn area grown by 1, an entrance's player box,
//     a terminal's player box, a solid, a floor or each other, so they never
//     block a doorway.
// 13. Every climb anchor's `ledgeId` names a ledge anchor; the climb point is
//     flush with a face of a solid (its player box touches that face, facing
//     it, and the solid spans minY..maxY + PLAYER_HEIGHT); its player box,
//     from minY to maxY + PLAYER_HEIGHT, overlaps no solid or floor; and
//     maxY + PLAYER_HEIGHT equals the ledge's y. The climb point lies on its
//     ledge's segment.
// 14. Every ledge has a clear standing spot on its walkable side: a player
//     box at the ledge's y, moved 1 unit from the segment's midpoint along
//     `facing`, rests on a floor or solid top at that y and overlaps no solid
//     or floor. A player hanging anywhere on the segment (box from
//     y - PLAYER_HEIGHT to y) overlaps no solid or floor.
// 15. Anchor ids are unique across `anchors`, and floor and ramp ids are
//     unique within their lists.
// 16. The upper level can't be reached from the ground by walking (raising
//     the feet by at most STEP_HEIGHT per move) and jumping (apex
//     max(JUMP_SPEED)^2 / (2 * GRAVITY)) except over ramps, so anchors are the
//     only other way up. In particular the jump apex plus STEP_HEIGHT is
//     below the lowest cover top (1.2), so no solid top can be stood on from
//     the ground, and every ledge is out of reach from the ground: its
//     y - PLAYER_HEIGHT - ANCHOR_REACH is above the jump apex.
// 17. (M6, #54) ACTIVE_TERMINAL_ID names an existing terminal.
//
// Extending:
// - Collision becomes y-aware in M4 (#29): a box (solid, floor or the wedge
//   under a ramp) blocks a player when its y range overlaps the player's
//   `y + STEP_HEIGHT .. y + PLAYER_HEIGHT`. Boxes below that band are stepped
//   onto or walked over; boxes above it are walked under. On the ground floor
//   (y = 0) that keeps every current solid blocking.
// - M6 activates one of `terminals` and may add fields to it (range, etc.).
// New fields will be added, not renamed, so existing readers keep working.

/** Half the width and depth of a player's box on x and z: 0.5 (world units). */
export declare const PLAYER_HALF_SIZE: 0.5

/**
 * Height of a player's box from its feet: 1.8 (world units). Walls (3 tall)
 * and low cover (1.2 tall) both overlap 0..PLAYER_HEIGHT, so both block
 * movement on the ground floor.
 */
export declare const PLAYER_HEIGHT: 1.8

export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** A floor rectangle on x and z (world units). */
export interface Rect {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

/**
 * Rendering hint only; collision treats every kind the same.
 * - "wall": full-height walls and pillars (taller than a player).
 * - "cover": low cover such as crates and low walls (shorter than a player,
 *   but still blocks movement).
 */
export type SolidKind = 'wall' | 'cover'

/** An axis-aligned box that players cannot overlap. */
export interface Solid {
  readonly id: string
  readonly kind: SolidKind
  readonly min: Vec3
  readonly max: Vec3
}

/** Centre point of a doorway into the central building, on the floor. */
export interface Entrance {
  readonly id: string
  readonly x: number
  readonly z: number
}

/**
 * A data terminal placement. x, z are on the floor, clear of solids; y is the
 * height of the interaction point (1). Terminals have no collision in Phase 1.
 * Phase 1 activates only one of them (milestone 6).
 */
export interface Terminal {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * Spawn areas: rectangles where a player's centre (x, z) may be placed.
 * `ghost` is outside the building, `warden` inside it.
 */
export interface SpawnAreas {
  readonly ghost: Rect
  readonly warden: Rect
}

/**
 * Walking height of the upper service level: 3 (the tops of its floors, equal
 * to the wall height).
 */
export declare const UPPER_LEVEL_Y: 3

/**
 * A walkable slab (M4). A box like a solid: walkable on its top (`max.y`) and
 * blocking like a solid otherwise. Upper-level floors have
 * `max.y = UPPER_LEVEL_Y`, are 0.2 thick and leave headroom underneath.
 */
export interface Floor {
  readonly id: string
  readonly min: Vec3
  readonly max: Vec3
}

/** Direction a ramp rises toward: its walkable height grows along this axis. */
export type RampRise = '+x' | '-x' | '+z' | '-z'

/**
 * Stairs, modelled as a solid wedge (M4) over the rectangle
 * minX..maxX, minZ..maxZ from the ground (y = 0) up to its walkable height.
 * The walkable height goes linearly from `low` at the low edge to `high` at
 * the high edge. For `rises: '+z'` at a point with coordinate z:
 *   height = low + (high - low) * (z - minZ) / (maxZ - minZ)
 * (and likewise for the other directions: '-z' measures from maxZ, '+x' from
 * minX, '-x' from maxX). Walkable on top, blocking like a solid of that
 * height from the sides. How a player box samples the height is the
 * server's rule (#29).
 */
export interface Ramp {
  readonly id: string
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  /** Walkable height at the low edge (0: it starts on the ground). */
  readonly low: number
  /** Walkable height at the high edge; meets a floor top within STEP_HEIGHT. */
  readonly high: number
  readonly rises: RampRise
}

/**
 * A vertical climb route on a wall face (M4, Ghosts only, rule 5).
 * - `x, z`: where the climber's centre is while climbing, flush with the
 *   face (the player box touches it).
 * - `facing`: yaw from the climber toward the wall (MoveMessage convention).
 * - `minY..maxY`: the range of the climber's feet height. At `maxY` the hands
 *   (`maxY + PLAYER_HEIGHT`) are at the ledge's y.
 * - `ledgeId`: the ledge anchor reached at the top (climbing up past `maxY`
 *   moves to `hanging` on that ledge).
 */
export interface ClimbAnchor {
  readonly id: string
  readonly kind: 'climb'
  readonly x: number
  readonly z: number
  readonly facing: number
  readonly minY: number
  readonly maxY: number
  readonly ledgeId: string
}

/**
 * A horizontal edge a Ghost can hang from (M4, rule 5).
 * - `(x0, z0)..(x1, z1)`: the segment of positions the hanging player's
 *   centre may take, on the hang side (half a player width out from the
 *   edge). Shimmying moves along it.
 * - `y`: the edge's height, where the hands are (the hanging player's feet
 *   are at `y - PLAYER_HEIGHT`).
 * - `facing`: yaw from the hang side toward the walkable top. Mantling moves
 *   the player onto the top in this direction.
 */
export interface LedgeAnchor {
  readonly id: string
  readonly kind: 'ledge'
  readonly x0: number
  readonly z0: number
  readonly x1: number
  readonly z1: number
  readonly y: number
  readonly facing: number
}

/** A traversal anchor: the only places a Ghost can climb or hang (rule 5). */
export type Anchor = ClimbAnchor | LedgeAnchor

export interface GrayboxMap {
  /** Stable id of this layout, e.g. reported by the client test hook. */
  readonly id: string
  /** Playable area on x and z: +- GROUND_SIZE / 2 (-20..20). */
  readonly bounds: Rect
  readonly solids: readonly Solid[]
  /** At least 3; doorways are at least 2 units wide. */
  readonly entrances: readonly Entrance[]
  readonly spawnAreas: SpawnAreas
  /** Exactly two placements, both inside the building. */
  readonly terminals: readonly Terminal[]
  /** Walkable slabs of the upper level (M4). */
  readonly floors: readonly Floor[]
  /** Stairs between the ground and the upper level (M4). */
  readonly ramps: readonly Ramp[]
  /** Climb and ledge anchors (M4); ids are unique across the list. */
  readonly anchors: readonly Anchor[]
}

/**
 * The Phase 1 graybox map: one ground floor with a central building
 * (outer faces x -10..10, z -8..8, walls 0.5 thick and 3 tall) with four
 * 3-wide doorways, interior and exterior cover, and two terminals inside.
 * Since M4 it also has an upper service level at UPPER_LEVEL_Y (a west
 * mezzanine, a stair landing, an overhead catwalk and an east platform),
 * one stair ramp and six anchors (two climb routes, four ledges).
 * The object is deeply frozen; treat it as read-only.
 */
export declare const GRAYBOX_MAP: GrayboxMap

/**
 * Id of the one terminal that can be hacked (M6, #54): `'terminal-a'`. Only
 * the active terminal can be hacked; the other one is drawn but inert until
 * Phase 2. Invariant 17: it names an existing entry of `GRAYBOX_MAP.terminals`.
 */
export declare const ACTIVE_TERMINAL_ID: 'terminal-a'
