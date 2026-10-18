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

/** Axis-aligned box from (x0, z0) to (x1, z1) on the floor, `height` tall. */
function box(id, kind, x0, z0, x1, z1, height) {
  return { id, kind, min: { x: x0, y: 0, z: z0 }, max: { x: x1, y: height, z: z1 } }
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
})
