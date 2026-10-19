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
  /**
   * Feet height in world units (M4, #27): 0 on the ground floor,
   * `UPPER_LEVEL_Y` (3) on the upper level. Set by the server since #29;
   * required since #33.
   */
  y: number
  /** Movement mode (M4, #27). Set by the server since #29; required since #33. */
  mode: MovementMode
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

// ---------------------------------------------------------------------------
// Vertical movement (M4, #27). Runtime values live in protocol.js. Nothing
// reads them until the server applies them (#29: gravity, floors, ramps,
// jumps; #31: climbing and hanging). Each constant is changeable in
// protocol.js, and only there (owner decisions on #26).

/**
 * Movement modes, frozen: `['ground', 'falling', 'climbing', 'hanging']`.
 * - `ground`: standing on the ground, a floor top or a ramp.
 * - `falling`: in the air, rising after a jump or falling.
 * - `climbing`: attached to a climb anchor (`kind: 'climb'`, shared/map.js).
 * - `hanging`: hanging from a ledge anchor (`kind: 'ledge'`).
 */
export declare const MOVEMENT_MODES: readonly ['ground', 'falling', 'climbing', 'hanging']
export type MovementMode = 'ground' | 'falling' | 'climbing' | 'hanging'

/** Message type the client sends for a discrete action. Payload: ActionMessage. */
export declare const ACTION_MESSAGE: 'action'

/** The actions, frozen: `['jump', 'climb', 'drop']`. */
export declare const ACTIONS: readonly ['jump', 'climb', 'drop']
export type Action = 'jump' | 'climb' | 'drop'

/**
 * Payload of the "action" message.
 *
 * - `jump`: only from `ground`. Starts a jump at `JUMP_SPEED[team]` (mode
 *   becomes `falling`). A team whose jump speed is 0 is refused.
 * - `climb`: a context action, only for teams with `CAN_CLIMB[team]`
 *   (Ghosts). From `ground` or `falling`:
 *   - within `ANCHOR_RANGE` (horizontally) of a climb anchor, it attaches to
 *     it (`climbing`);
 *   - within reach of a ledge anchor (horizontally within `ANCHOR_RANGE` of
 *     the ledge segment, and the hands, at `y + PLAYER_HEIGHT`, within
 *     `ANCHOR_REACH` of the ledge's y), it grabs the ledge (`hanging`).
 *   While `hanging`, it mantles onto the walkable surface above the ledge,
 *   if a player box fits there (mode becomes `ground`).
 * - `drop`: from `climbing` or `hanging`, let go (`falling`).
 *
 * The message carries no anchor id and no position: the server picks the
 * nearest valid anchor from the player's own server position, so there is
 * nothing to forge. Anything else (not a non-array object, `action` not one
 * of `ACTIONS`) is ignored, and extra fields are never read. Actions have
 * their own server-side rate limit, separate from moves.
 *
 * Moves while attached (the `move` message keeps its shape):
 * - `climbing`: `dz` is up (+1) or down (-1) along the anchor at
 *   `CLIMB_SPEED`; `dx` is ignored.
 * - `hanging`: `dx` shimmies along the ledge at `SHIMMY_SPEED` (+1 is to the
 *   player's right when facing the ledge's `facing`); `dz` is ignored.
 * - In both, `yaw` is still stored.
 */
export interface ActionMessage {
  action: Action
}

/** Downward acceleration while falling: 20 u/s^2. */
export declare const GRAVITY: 20

/** Fastest downward speed while falling: 20 u/s. */
export declare const MAX_FALL_SPEED: 20

/**
 * Upward speed at the start of a jump, per team, in u/s, frozen:
 * `{ ghost: 4.5, warden: 0 }`. Apex height is `speed^2 / (2 * GRAVITY)`,
 * about 0.51 for a Ghost: too low to reach low cover (1.2) even with
 * `STEP_HEIGHT`, or the upper level. Wardens (0) can't jump.
 */
export declare const JUMP_SPEED: Readonly<Record<Team, number>>

/**
 * The most a walking move may raise the feet: 0.35 u. Ramps and floor edges
 * within this are walked onto; anything taller blocks (cover at 1.2 does).
 */
export declare const STEP_HEIGHT: 0.35

/** Speed along a climb anchor while climbing: 1.5 u/s. */
export declare const CLIMB_SPEED: 1.5

/** Speed along a ledge anchor while hanging: 1.0 u/s. */
export declare const SHIMMY_SPEED: 1

/**
 * Largest horizontal distance (on x, z) from a player's centre to an anchor
 * (a climb anchor's point, or the nearest point of a ledge segment) that is
 * still in range: 0.8 u.
 */
export declare const ANCHOR_RANGE: 0.8

/**
 * Vertical slack for grabbing a ledge: 0.6 u. A ledge at height `ly` is in
 * reach when `|y + PLAYER_HEIGHT - ly| <= ANCHOR_REACH`.
 */
export declare const ANCHOR_REACH: 0.6

/** Which teams may climb and hang, frozen: `{ ghost: true, warden: false }`. */
export declare const CAN_CLIMB: Readonly<Record<Team, boolean>>
