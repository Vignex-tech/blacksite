// Types of the client test hook `window.__blacksite` (types only; there is no
// testhook.js). The client implements it in client/src/testHook.ts. Tests type
// it with `import type { BlacksiteSnapshot } from '<path>/shared/testhook.js'`.
//
// Rules:
// - Read-only: snapshot() returns a fresh plain-data copy on every call.
//   Changing it never changes game state or the next snapshot.
// - It reports only what the client already received from the server
//   (rule 2: once state is filtered per team, the hook shows no more than the
//   client was sent). It never adds a server message or synced state.
// - It ships in the production build, because Playwright tests client/dist.
// - Versioning: fields are only ever added in version 1 (#22 added `team`,
//   `yaw` and `localTeam`; #24 added `camera`; #33 added `y` and `mode` per
//   player and `renderedFloors`, `renderedRamps` and `renderedAnchors`). `version` is bumped only if a field is removed or
//   changes meaning, so tests should match the fields they need, not the
//   exact shape.

import type { MovementMode, Team } from './protocol.js'

/** One player as the client currently knows it from room state. */
export interface BlacksitePlayerSnapshot {
  /** The player's sessionId (key in `state.players`). */
  id: string
  /** Position as received from room state (float32 on the wire, not rounded). */
  x: number
  z: number
  /** True only for this client's own player (id === sessionId). */
  isLocal: boolean
  /**
   * The player's team as received from room state. null only if this client
   * hasn't received a valid team for the player yet.
   */
  team: Team | null
  /**
   * Facing in radians as received from room state (the server wraps it into
   * -pi..pi, so pi may arrive as -pi; compare angles modulo 2 pi). 0 until
   * received.
   */
  yaw: number
  /**
   * Feet height as received from room state (#33; float32 on the wire): 0 on
   * the ground floor, 3 on the upper level, 1.2 while hanging. 0 only if this
   * client hasn't received a finite y for the player.
   */
  y: number
  /**
   * Movement mode as received from room state (#33). 'ground' only if this
   * client hasn't received a valid mode for the player.
   */
  mode: MovementMode
}

/**
 * The client's camera (#24): 'overhead' until this client's team is known or
 * while disconnected, then 'third-person' for a Ghost and 'first-person' for a
 * Warden.
 */
export type CameraMode = 'overhead' | 'third-person' | 'first-person'

export interface BlacksiteCameraSnapshot {
  mode: CameraMode
  /**
   * The client's camera yaw in radians, wrapped to -pi..pi (0 faces +z,
   * positive turns toward +x). It starts at the local player's server yaw and
   * changes only on mouse input, so it can lead the server yaw by one move
   * message. 0 in overhead mode.
   */
  yaw: number
}

export interface BlacksiteSnapshot {
  /** Shape version. Bumped when a field changes meaning or is removed. */
  version: 1
  /** True while this client is in the room (joined and not yet left). */
  connected: boolean
  /** This client's sessionId while connected, otherwise null. */
  sessionId: string | null
  /** Every player in room state, sorted by id. Empty when not connected. */
  players: BlacksitePlayerSnapshot[]
  /** This client's own team once received from room state, otherwise null. */
  localTeam: Team | null
  /**
   * Rendered map. `id` null and every count 0 until the map is rendered (#14).
   * Counts are meshes created: one per solid, and (#33) one per floor
   * (`floor-<id>`), ramp (`ramp-<id>`) and anchor (`anchor-<id>`).
   */
  map: {
    id: string | null
    renderedSolids: number
    renderedFloors: number
    renderedRamps: number
    renderedAnchors: number
  }
  /**
   * The client's camera. Present once the game scene (and so a camera) exists;
   * absent if WebGL failed to start.
   */
  camera?: BlacksiteCameraSnapshot
}

export interface BlacksiteTestHook {
  /** Returns a fresh copy of the client's current view of the game. */
  snapshot(): BlacksiteSnapshot
}

declare global {
  interface Window {
    /** Read-only test hook, set by the client at startup. */
    readonly __blacksite: BlacksiteTestHook
  }
}
