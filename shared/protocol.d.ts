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
  /**
   * Health (M5, #39): starts at `MAX_HEALTH[team]`. A player is eliminated
   * when `health <= 0`; there is no separate field. Required since #48.
   */
  health: number
  /** Rounds left in the magazine (M5). Required since #48. */
  ammo: number
  /** True while a reload is in progress (M5). Required since #48. */
  reloading: boolean
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
  /** Terminals keyed by terminal id (M6, #54). Not populated until the server adds it (#56). */
  terminals: ReadonlyKeyedMap<TerminalState>
  /** Round phase, timer and result (M7, #66). Public to every client. */
  round: RoundState
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

// ---------------------------------------------------------------------------
// Weapons and damage (M5, #39). Runtime values live in protocol.js. Nothing
// reads them until the server applies them (#41). Each constant is changeable
// in protocol.js, and only there (owner decisions on #38).

/** Message type the client sends to fire. Payload: FireMessage. */
export declare const FIRE_MESSAGE: 'fire'

/** Message type the client sends to reload. Payload is ignored. */
export declare const RELOAD_MESSAGE: 'reload'

/**
 * Payload of the "fire" message: aim only. There is no origin, target or hit
 * claim; the server shoots from the player's own server eye position
 * (`EYE_HEIGHT` above the feet).
 *
 * - `yaw`: radians, same convention as `MoveMessage.yaw` (0 faces +z,
 *   positive turns toward +x).
 * - `pitch`: radians, positive looks up, negative looks down.
 *
 * Server validation: `fire` is ignored unless the payload is a non-array
 * object with finite `yaw` and `pitch`. The server wraps yaw into -pi..pi and
 * clamps pitch to -pi/2..pi/2. It never trusts the client for origin, hits,
 * ammo or timing: cooldown, magazine, range and walls are all decided by the
 * server. Fire and reload share one rate-limit bucket (`FIRE_RATE_HZ`,
 * `FIRE_BURST`).
 */
export interface FireMessage {
  yaw: number
  pitch: number
}

/**
 * Payload of the "reload" message. It is ignored; the server only needs it
 * to be an object. The server decides whether a reload starts and when it
 * ends (`WEAPONS[team].reloadMs`).
 */
export type ReloadMessage = Record<string, never>

/** Max health per team, frozen: `{ ghost: 100, warden: 150 }`. No regeneration. */
export declare const MAX_HEALTH: Readonly<Record<Team, number>>

/** A team's weapon. Times in ms, distances in u. */
export interface Weapon {
  name: string
  /** Health removed per hit. */
  damage: number
  /** Minimum time between shots. */
  intervalMs: number
  /** Rounds per magazine. Reserve ammo is unlimited; there is no auto-reload. */
  magazine: number
  /** Time a reload takes. */
  reloadMs: number
  /** Longest distance a shot can hit. */
  range: number
}

/**
 * Weapon per team, frozen. Warden rifle: 25 damage, 150 ms, 30 rounds, 2000 ms
 * reload, range 40. Ghost suppressed sidearm: 15, 300 ms, 12, 1500 ms, 25.
 */
export declare const WEAPONS: Readonly<Record<Team, Weapon>>

/** Height of the eye (shot origin) above the feet: 1.6 u. */
export declare const EYE_HEIGHT: 1.6

/** Whether shots hit teammates: false. Shots pass through teammates. */
export declare const FRIENDLY_FIRE: false

/** A Ghost this close (3D, box centres) to a Warden is always sent to it: 2.0 u (used by #46). */
export declare const VISIBILITY_NEAR: 2

/** Sustained rate of the fire/reload message bucket: 10 per second. */
export declare const FIRE_RATE_HZ: 10

/** Burst size of the fire/reload message bucket: 3. */
export declare const FIRE_BURST: 3

/** A 3D point in world units. */
export interface ShotPoint {
  x: number
  y: number
  z: number
}

/** Server-to-client event name for a shot. Payload: ShotEvent. */
export declare const SHOT_EVENT: 'shot'

/**
 * A shot was fired. Sent to everyone for a Warden shot (the rifle is loud),
 * and only to Ghost clients for a Ghost shot (suppressed; never to Wardens).
 */
export interface ShotEvent {
  /** Shooter's session id. */
  shooter: string
  /** Shooter's team. */
  team: Team
  /** Where the shot started (the shooter's eye). */
  origin: ShotPoint
  /** Where it ended: the hit point, the wall it struck, or the range limit. */
  end: ShotPoint
  /** True if it hit a player. */
  hit: boolean
}

/** Server-to-client event name for a confirmed hit. Payload: HitEvent. */
export declare const HIT_EVENT: 'hit'

/** Sent to the shooter only: a shot hit a player. */
export interface HitEvent {
  /** Session id of the player hit. */
  target: string
  /** Health removed. */
  damage: number
  /** True if the hit eliminated the target. */
  killed: boolean
}

/** Server-to-client event name for a damage notice. Payload: DamagedEvent. */
export declare const DAMAGED_EVENT: 'damaged'

/**
 * Sent to the victim only. It carries no shooter id and no position, so it
 * leaks nothing about where the shot came from (rule 2).
 */
export interface DamagedEvent {
  /** Health removed. */
  damage: number
  /** Health left after the hit. */
  health: number
  /** True if this hit eliminated the victim. */
  killed: boolean
}

// ---------------------------------------------------------------------------
// Hacking one terminal (M6, #54). Runtime values live in protocol.js. Nothing
// reads them until the server applies them (#56). Each constant is changeable
// in protocol.js, and only there (owner decisions on #53).

/** Message type the client sends to hold or release interact. Payload: InteractMessage. */
export declare const INTERACT_MESSAGE: 'interact'

/**
 * Payload of the "interact" message: `active: true` starts or keeps holding,
 * `false` releases. It carries no terminal id and no position: the server
 * picks the active terminal from the player's own server position, so there
 * is nothing to forge. Anything that is not a non-array object with a boolean
 * `active` is ignored and spends no rate-limit token. After any interruption
 * the Ghost must send `active: true` again; a held key does not resume.
 * The bucket (`INTERACT_RATE_HZ`, `INTERACT_BURST`) is a server constant.
 */
export interface InteractMessage {
  active: boolean
}

/** Continuous hacking time to finish: 10000 ms. */
export declare const HACK_DURATION_MS: 10000

/** Horizontal range from the terminal's x, z: 1.5 u. */
export declare const HACK_RANGE: 1.5

/** Progress lost per second while nobody hacks, as a fraction of the gain rate: 0.5. */
export declare const HACK_DECAY_RATIO: 0.5

/** Time a hack must run before Wardens are alerted: 3000 ms. */
export declare const HACK_ALERT_AFTER_MS: 3000

/** Which teams may hack, frozen: `{ ghost: true, warden: false }`. */
export declare const CAN_HACK: Readonly<Record<Team, boolean>>

/** Terminal statuses, frozen: `['idle', 'hacking', 'hacked']`. */
export declare const TERMINAL_STATUSES: readonly ['idle', 'hacking', 'hacked']
export type TerminalStatus = 'idle' | 'hacking' | 'hacked'

/**
 * One terminal in room state, keyed by terminal id. Sent to every client, so
 * it holds nothing a Warden must not know: no hacker, no hacker count, no
 * position and no progress.
 *
 * What a Warden client is told: `status` and `alert` only. The server
 * withholds `hacking` from a Warden's view until the alert, so for the first
 * `HACK_ALERT_AFTER_MS` of a hack a Warden sees `idle` and no cue. `alert`
 * means "someone is hacking now"; it clears when the hack is interrupted.
 * What a Warden is never told: who is hacking, how many, where they stand,
 * or the progress. There is no marker or pin for the alert (rules 2 and 3).
 */
export interface TerminalState {
  id: string
  status: TerminalStatus
  alert: boolean
}

/** Message type the server sends to Ghost clients only. Payload: HackProgressMessage. */
export declare const HACK_PROGRESS_MESSAGE: 'hackProgress'

/**
 * Hack progress, 0 to 1. Sent to Ghost clients only, never to a Warden, and
 * not part of room state (so a Warden's state can never carry it).
 */
export interface HackProgressMessage {
  progress: number
}

// ---------------------------------------------------------------------------
// The timed round (M7, #66). Runtime values live in protocol.js. Nothing reads
// them until the server applies them (#68). No behaviour changes with this
// contract.

/** Round phases, frozen: `['waiting', 'countdown', 'live', 'ended']`. */
export declare const ROUND_PHASES: readonly ['waiting', 'countdown', 'live', 'ended']
export type RoundPhase = 'waiting' | 'countdown' | 'live' | 'ended'

/** Why a round was won, frozen: `['hacked', 'ghosts_eliminated', 'time_out']`. */
export declare const ROUND_WIN_REASONS: readonly ['hacked', 'ghosts_eliminated', 'time_out']
export type RoundWinReason = 'hacked' | 'ghosts_eliminated' | 'time_out'

/**
 * Round timers and start rule. All durations are milliseconds, finite and
 * positive. This is the shape the server config uses. The server is configured
 * once at startup from its own environment (#68; the shared files never read
 * `process` or `location`). Clients never send settings: no message carries
 * them, and no room or join option sets them (rule 1).
 */
export interface RoundSettings {
  /** Countdown before a round goes live: 10000. */
  countdownMs: number
  /** Live round length: 420000 (7 minutes). */
  liveMs: number
  /** How long the result shows before the next round: 10000. */
  endedMs: number
  /** Players needed on each team before a countdown starts: 1. */
  minPlayersPerTeam: number
}

/** Frozen defaults: `{ countdownMs: 10000, liveMs: 420000, endedMs: 10000, minPlayersPerTeam: 1 }`. */
export declare const DEFAULT_ROUND_SETTINGS: Readonly<RoundSettings>

/**
 * Round fields in room state. Public to every client and identical for Ghost
 * and Warden clients: no alive counts, no hack progress, no hacker.
 *
 * Rules the server applies (#68, #70):
 * - During `waiting`, `countdown` and `ended` a player is frozen: move,
 *   action, fire, reload and interact are ignored.
 * - A player who joins during `live` sits out (health 0, shown as eliminated)
 *   until the next round, so leaving and rejoining gives no fresh life.
 */
export interface RoundState {
  phase: RoundPhase
  /** Integer; 0 until the first countdown starts. */
  roundNumber: number
  /** Whole seconds left in the current timed phase, rounded up. 0 in `waiting` and when a phase has no timer. */
  secondsLeft: number
  /** Winning team; '' until `ended`, and '' for an aborted round. */
  winner: Team | ''
  /** Why `winner` won, or '' (no winner yet, or aborted). */
  winReason: RoundWinReason | ''
}

/** Server-to-client event name for a phase change. Payload: RoundEvent. */
export declare const ROUND_EVENT: 'round'

/**
 * Sent to all clients on every phase change. A convenience only: room state
 * (`round`) is the truth.
 */
export interface RoundEvent {
  phase: RoundPhase
  roundNumber: number
  winner: Team | ''
  winReason: RoundWinReason | ''
}
