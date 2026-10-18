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
// Extending (later milestones; not present yet, don't rely on them):
// - M4 adds an upper service level as solids with a higher y range (floor
//   slabs, stairs or ramps), plus authored climb anchors as a new list. Code
//   that collides on the ground floor should only consider solids whose
//   y range overlaps 0..PLAYER_HEIGHT, so it keeps working when they arrive.
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
}

/**
 * The Phase 1 graybox map: one ground floor with a central building
 * (outer faces x -10..10, z -8..8, walls 0.5 thick and 3 tall) with four
 * 3-wide doorways, interior and exterior cover, and two terminals inside.
 * The object is deeply frozen; treat it as read-only.
 */
export declare const GRAYBOX_MAP: GrayboxMap
