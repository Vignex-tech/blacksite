// Runtime data of the graybox map. Types and the full contract (units,
// coordinate conventions, invariants) live in map.d.ts; keep the two in sync.
// Plain ESM JavaScript with no dependencies and no build step, like
// protocol.js. No Babylon or browser code: the server imports this too.
//
// World units, y up, origin at the centre of the ground. +z points away from
// the default camera (north), +x to its right (east).
//
// The server is authoritative: it collides and spawns with this data. The
// client only renders it.

import { GROUND_SIZE } from './protocol.js'

/** Half the width and depth of a player's box on x and z (world units). */
export const PLAYER_HALF_SIZE = 0.5

/** Height of a player's box, from its feet (y = 0 on the ground floor). */
export const PLAYER_HEIGHT = 1.8

/** Height of the building's walls. Taller than a player. */
const WALL_HEIGHT = 3
/** Height of low cover (crates, low walls). Shorter than a player. */
const COVER_HEIGHT = 1.2
/** y of terminal interaction points (about waist height). */
const TERMINAL_HEIGHT = 1

const HALF = GROUND_SIZE / 2

/**
 * Walking height of the upper service level (the top of its floors). Equal to
 * the wall height, so the west wall's top is flush with the mezzanine.
 */
export const UPPER_LEVEL_Y = 3
/** Thickness of upper-level floor slabs. */
const SLAB = 0.2
/** Feet height of a climber whose hands (feet + PLAYER_HEIGHT) are at the upper level. */
const CLIMB_TOP_Y = 1.2 // UPPER_LEVEL_Y - PLAYER_HEIGHT, written exactly
/** Yaw facing +x (east) and +z (north); see MoveMessage in protocol.d.ts. */
const FACE_EAST = Math.PI / 2
const FACE_NORTH = 0

/** Axis-aligned box from (x0, z0) to (x1, z1) on the floor, `height` tall. */
function box(id, kind, x0, z0, x1, z1, height) {
  return { id, kind, min: { x: x0, y: 0, z: z0 }, max: { x: x1, y: height, z: z1 } }
}

/** Upper-level floor slab from (x0, z0) to (x1, z1), walkable at UPPER_LEVEL_Y. */
function slab(id, x0, z0, x1, z1) {
  return { id, min: { x: x0, y: UPPER_LEVEL_Y - SLAB, z: z0 }, max: { x: x1, y: UPPER_LEVEL_Y, z: z1 } }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

// Central building: outer faces at x = -10..10 and z = -8..8, walls 0.5 thick.
// Doorways (3 units wide): south (x -1.5..1.5), north (x 4..7),
// west (z -1.5..1.5), east (z 2..5).
export const GRAYBOX_MAP = deepFreeze({
  id: 'graybox-1',
  bounds: { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },
  solids: [
    // Outer walls of the central building.
    box('wall-s-w', 'wall', -10, -8, -1.5, -7.5, WALL_HEIGHT),
    box('wall-s-e', 'wall', 1.5, -8, 10, -7.5, WALL_HEIGHT),
    box('wall-n-w', 'wall', -10, 7.5, 4, 8, WALL_HEIGHT),
    box('wall-n-e', 'wall', 7, 7.5, 10, 8, WALL_HEIGHT),
    box('wall-w-s', 'wall', -10, -7.5, -9.5, -1.5, WALL_HEIGHT),
    box('wall-w-n', 'wall', -10, 1.5, -9.5, 7.5, WALL_HEIGHT),
    box('wall-e-s', 'wall', 9.5, -7.5, 10, 2, WALL_HEIGHT),
    box('wall-e-n', 'wall', 9.5, 5, 10, 7.5, WALL_HEIGHT),
    // Interior cover.
    box('cover-low-wall', 'cover', -2, -3.5, 2, -3, COVER_HEIGHT),
    box('cover-crate-sw', 'cover', -6, -4, -4.5, -2.5, COVER_HEIGHT),
    box('cover-crate-se', 'cover', 4.5, -4, 6, -2.5, COVER_HEIGHT),
    box('pillar-nw', 'wall', -5.5, 3, -4.5, 4, WALL_HEIGHT),
    box('pillar-ne', 'wall', 4.5, 3, 5.5, 4, WALL_HEIGHT),
    // Exterior cover.
    box('cover-yard-s', 'cover', -6, -12, -4, -10.5, COVER_HEIGHT),
    box('cover-yard-e', 'cover', 12, 4, 13.5, 6, COVER_HEIGHT),
    box('cover-yard-w', 'cover', -14, -3, -12.5, -1, COVER_HEIGHT),
  ],
  entrances: [
    { id: 'door-south', x: 0, z: -7.75 },
    { id: 'door-north', x: 5.5, z: 7.75 },
    { id: 'door-west', x: -9.75, z: 0 },
    { id: 'door-east', x: 9.75, z: 3.5 },
  ],
  spawnAreas: {
    // Outside, south of the building.
    ghost: { minX: -4, maxX: 4, minZ: -18, maxZ: -14 },
    // Inside the building, north half, between the pillars.
    warden: { minX: -3, maxX: 3, minZ: 2, maxZ: 5 },
  },
  terminals: [
    { id: 'terminal-a', x: -7.5, y: TERMINAL_HEIGHT, z: -5.5 },
    { id: 'terminal-b', x: 7.5, y: TERMINAL_HEIGHT, z: 5.5 },
  ],
  // Upper service level (M4, #27). Routes up:
  // - Stairs (anyone): `stairs-west` rises north from the ground (z 0.5) to
  //   `landing-nw`, which joins the mezzanine.
  // - `climb-west` (Ghosts): outside the west wall, up to `ledge-west-wall`,
  //   then mantle onto the wall top and the mezzanine.
  // - `climb-east` (Ghosts): inside the east wall, up to
  //   `ledge-east-platform`, then mantle onto the east platform.
  // The mezzanine, landing, catwalk and east platform are one connected
  // walkable level at UPPER_LEVEL_Y. No railings: walking off an edge falls.
  floors: [
    // Mezzanine along the inside of the west wall.
    slab('mezz-west', -9.5, -1, -7.5, 7.5),
    // Top of the stairs, east of the mezzanine's north end.
    slab('landing-nw', -7.5, 6, -5.75, 7.5),
    // Overhead catwalk across the interior, from the mezzanine to the east platform.
    slab('catwalk', -7.5, -1, 6, 0.5),
    // Small platform inside the east wall, south of the east doorway.
    slab('platform-east', 6, -2, 9.5, 1.5),
  ],
  ramps: [
    // Stairs up to the mezzanine (the Warden route). Run 5.5, rise 3, slope ~0.55.
    { id: 'stairs-west', minX: -7.5, maxX: -5.75, minZ: 0.5, maxZ: 6, low: 0, high: UPPER_LEVEL_Y, rises: '+z' },
  ],
  anchors: [
    // Outside the west wall (face x = -10), from the yard to the wall top.
    { id: 'climb-west', kind: 'climb', x: -10.5, z: 4.5, facing: FACE_EAST, minY: 0, maxY: CLIMB_TOP_Y, ledgeId: 'ledge-west-wall' },
    { id: 'ledge-west-wall', kind: 'ledge', x0: -10.5, z0: 2.5, x1: -10.5, z1: 6.5, y: UPPER_LEVEL_Y, facing: FACE_EAST },
    // Inside the east wall (face x = 9.5), just south of the east platform.
    { id: 'climb-east', kind: 'climb', x: 9, z: -2.5, facing: FACE_EAST, minY: 0, maxY: CLIMB_TOP_Y, ledgeId: 'ledge-east-platform' },
    { id: 'ledge-east-platform', kind: 'ledge', x0: 6.75, z0: -2.5, x1: 9, z1: -2.5, y: UPPER_LEVEL_Y, facing: FACE_NORTH },
    // South edges of the mezzanine and the catwalk (edge z = -1), to hang from and drop.
    { id: 'ledge-mezz-south', kind: 'ledge', x0: -9, z0: -1.5, x1: -7.5, z1: -1.5, y: UPPER_LEVEL_Y, facing: FACE_NORTH },
    { id: 'ledge-catwalk-south', kind: 'ledge', x0: -7.5, z0: -1.5, x1: 5.5, z1: -1.5, y: UPPER_LEVEL_Y, facing: FACE_NORTH },
  ],
})
