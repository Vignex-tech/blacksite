// Types of the client/server contract. Runtime values live in protocol.js.
// Import from "<relative path>/shared/protocol.js" on both sides.

/** Name of the shared room registered in server/src/app.config.ts. */
export declare const ROOM_NAME: 'my_room'

/** Message type the client sends while a movement key is held. Payload: MoveMessage. */
export declare const MOVE_MESSAGE: 'move'

/**
 * Width and depth of the square ground, centred on the origin (world units).
 * Valid positions are within -GROUND_SIZE / 2 .. GROUND_SIZE / 2 on x and z.
 */
export declare const GROUND_SIZE: 40

/** A team. The values equal the keys of `GRAYBOX_MAP.spawnAreas` (shared/map.js). */
export type Team = 'ghost' | 'warden'

/**
 * The two teams, frozen: `['ghost', 'warden']`. The server spawns a player in
 * `GRAYBOX_MAP.spawnAreas[team]`.
 */
export declare const TEAMS: readonly ['ghost', 'warden']

/** Largest team the room is designed for (up to 4v4; playtests are 1v1 and 2v2). */
export declare const MAX_TEAM_SIZE: 4

/**
 * Max sustained speed per team, in world units per second, frozen:
 * `{ ghost: 2.4, warden: 2.0 }`. The server derives its per-message step from
 * it and its move rate (2.4 / 20 Hz = 0.12, 2.0 / 20 Hz = 0.1). The client may
 * only display it; it never moves anything locally. Tunable, and only here.
 */
export declare const TEAM_SPEED: Readonly<Record<Team, number>>

/**
 * Payload of the "move" message: camera-relative movement intent.
 *
 * - `dx` is strafe (+1 right), `dz` is forward (+1 forward), each in -1..1.
 * - `yaw` (optional) is the player's facing in radians. Yaw 0 faces +z.
 *   Positive yaw turns toward +x (clockwise seen from above, the same as
 *   Babylon's `rotation.y`). Forward is `(sin yaw, cos yaw)` and right is
 *   `(cos yaw, -sin yaw)` on (x, z).
 * - World step on (x, z), after capping the intent's length `hypot(dx, dz)`
 *   at 1, times the team's step (`TEAM_SPEED[team] / move rate`):
 *     stepX =  dx * cos(yaw) + dz * sin(yaw)
 *     stepZ = -dx * sin(yaw) + dz * cos(yaw)
 * - If `yaw` is absent, the server uses the player's current yaw. With yaw 0,
 *   `dx` is +x and `dz` is +z, exactly as in M1 and M2, so clients that send
 *   no yaw keep working.
 * - A move with `dx = dz = 0` and a `yaw` only turns the player. It still
 *   counts against the rate limit.
 *
 * Server validation: `dx` and `dz` must be finite numbers, and `yaw`, if
 * present, too; otherwise the whole message is ignored. The server wraps yaw
 * into -pi..pi, clamps `dx` and `dz` to -1..1, caps the intent's length at 1,
 * applies the team speed, the rate limit and map collision.
 */
export interface MoveMessage {
  dx: number
  dz: number
  yaw?: number
}

/** One player in room state. Positions are server-authoritative. */
export interface PlayerState {
  x: number
  z: number
  /** The player's team, assigned by the server on join (clients can't choose). */
  team: Team
  /**
   * Facing in radians, -pi..pi, same convention as `MoveMessage.yaw`. In M3
   * the server spawns every player with yaw 0 (facing +z).
   */
  yaw: number
}

/** Minimal read-only view of a map keyed by string (MapSchema satisfies it). */
export interface ReadonlyKeyedMap<V> {
  get(key: string): V | undefined
  forEach(callback: (value: V, key: string) => void): void
  readonly size: number
}

/** Shape of the room state: `players` keyed by the client's sessionId. */
export interface GameRoomState {
  players: ReadonlyKeyedMap<PlayerState>
}
