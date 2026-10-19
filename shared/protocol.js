// Runtime values of the client/server contract. Types live in protocol.d.ts.
// Plain ESM JavaScript with no dependencies and no build step, so the Vite
// client, the server's tsc build, tsx and plain `node` can all import it
// directly. Keep it in sync with protocol.d.ts.

/** Name of the shared room registered in server/src/app.config.ts. */
export const ROOM_NAME = 'my_room'

/** Message type the client sends while a movement key is held. Payload: MoveMessage. */
export const MOVE_MESSAGE = 'move'

/** Width and depth of the square ground, centred on the origin (world units). */
export const GROUND_SIZE = 40

// Teams (M3, #18). Conventions and the yaw formula are documented in
// protocol.d.ts. The server assigns teams and applies the speeds since #20.

/** The two teams. Equal to the keys of GRAYBOX_MAP.spawnAreas. */
export const TEAMS = Object.freeze(['ghost', 'warden'])

/** Largest team the room is designed for (up to 4v4). */
export const MAX_TEAM_SIZE = 4

/**
 * Max sustained speed per team, in world units per second. The server derives
 * its per-message step from it (speed / move rate). Tune here only.
 */
export const TEAM_SPEED = Object.freeze({ ghost: 2.4, warden: 2.0 })

// Vertical movement (M4, #27). Meanings and conventions are documented in
// protocol.d.ts. Nothing reads these yet; the server applies them from #29
// (gravity, floors, ramps, jumps) and #31 (climbing and hanging).

/**
 * Movement modes, in player state. `falling` is any time in the air (rising
 * after a jump, or falling); `climbing` is attached to a climb anchor;
 * `hanging` is hanging from a ledge anchor.
 */
export const MOVEMENT_MODES = Object.freeze(['ground', 'falling', 'climbing', 'hanging'])

/** Message type for a discrete action. Payload: ActionMessage. */
export const ACTION_MESSAGE = 'action'

/** The actions an ActionMessage may name. */
export const ACTIONS = Object.freeze(['jump', 'climb', 'drop'])

// Tuning constants. Each is changeable here, and only here (owner decisions
// on #26). Units: world units (u), seconds (s).

/** Downward acceleration while falling, in u/s^2. */
export const GRAVITY = 20

/** Fastest downward speed while falling, in u/s. */
export const MAX_FALL_SPEED = 20

/**
 * Upward speed at the start of a jump, per team, in u/s. The apex is
 * speed^2 / (2 * GRAVITY): about 0.51 for a Ghost. 0 means the team can't jump.
 */
export const JUMP_SPEED = Object.freeze({ ghost: 4.5, warden: 0 })

/** The most a walking move may raise the feet, in u. */
export const STEP_HEIGHT = 0.35

/** Speed along a climb anchor while climbing, in u/s. */
export const CLIMB_SPEED = 1.5

/** Speed along a ledge anchor while hanging, in u/s. */
export const SHIMMY_SPEED = 1.0

/** Largest horizontal distance from a player's centre to an anchor that still counts as in range, in u. */
export const ANCHOR_RANGE = 0.8

/** Vertical slack for grabbing a ledge: the hands (y + PLAYER_HEIGHT) within this of the ledge's y, in u. */
export const ANCHOR_REACH = 0.6

/** Which teams may climb and hang (rule 5: only on authored anchors). */
export const CAN_CLIMB = Object.freeze({ ghost: true, warden: false })

// Weapons and damage (M5, #39). Meanings and conventions are documented in
// protocol.d.ts. Nothing reads these until the server applies them (#41).

/** Message type the client sends to fire. Payload: FireMessage (aim only). */
export const FIRE_MESSAGE = 'fire'

/** Message type the client sends to reload. Payload ignored. */
export const RELOAD_MESSAGE = 'reload'

/** Starting and maximum health per team. A player is eliminated at health <= 0. */
export const MAX_HEALTH = Object.freeze({ ghost: 100, warden: 150 })

/**
 * Weapon per team: warden rifle and ghost suppressed sidearm.
 * damage per hit; intervalMs between shots; magazine rounds; reloadMs; range in u.
 */
export const WEAPONS = Object.freeze({
  warden: Object.freeze({ name: 'rifle', damage: 25, intervalMs: 150, magazine: 30, reloadMs: 2000, range: 40 }),
  ghost: Object.freeze({ name: 'suppressed sidearm', damage: 15, intervalMs: 300, magazine: 12, reloadMs: 1500, range: 25 }),
})

/** Height of the eye (shot origin) above the feet, in u. */
export const EYE_HEIGHT = 1.6

/** Whether shots hit teammates. */
export const FRIENDLY_FIRE = false

/** A Ghost within this 3D distance of a Warden is always visible to that Warden (used by #46), in u. */
export const VISIBILITY_NEAR = 2.0

/** Sustained rate of the shared fire/reload message bucket, per second. */
export const FIRE_RATE_HZ = 10

/** Burst size of the fire/reload message bucket. */
export const FIRE_BURST = 3

/** Server-to-client event: a shot was fired. Payload: ShotEvent. */
export const SHOT_EVENT = 'shot'

/** Server-to-client event, to the shooter: a shot hit a player. Payload: HitEvent. */
export const HIT_EVENT = 'hit'

/** Server-to-client event, to the victim: you were hurt. Payload: DamagedEvent. */
export const DAMAGED_EVENT = 'damaged'

// Hacking one terminal (M6, #54). Meanings and conventions are documented in
// protocol.d.ts. Nothing reads these until the server applies them (#56).
// INTERACT_RATE_HZ and INTERACT_BURST are server constants, not here.

/** Message type the client sends while holding (or releasing) interact. Payload: InteractMessage. */
export const INTERACT_MESSAGE = 'interact'

/** Message type the server sends to Ghost clients only: hack progress. Payload: HackProgressMessage. */
export const HACK_PROGRESS_MESSAGE = 'hackProgress'

/** Continuous hacking time needed to finish a hack, in ms. */
export const HACK_DURATION_MS = 10000

/** Largest horizontal distance from the terminal's x, z at which a Ghost can hack, in u. */
export const HACK_RANGE = 1.5

/** Progress lost per second while nobody hacks, as a fraction of the gain rate. */
export const HACK_DECAY_RATIO = 0.5

/** A hack must run this long before Wardens are alerted, in ms. */
export const HACK_ALERT_AFTER_MS = 3000

/** Which teams may hack. */
export const CAN_HACK = Object.freeze({ ghost: true, warden: false })

/** Terminal statuses, in room state. */
export const TERMINAL_STATUSES = Object.freeze(['idle', 'hacking', 'hacked'])

// The timed round (M7, #66). Meanings and conventions are documented in
// protocol.d.ts. Nothing reads these until the server applies them (#68).
// The server reads its settings once at startup from its own environment;
// this file never touches `process` or `location`.

/** Round phases, in order. */
export const ROUND_PHASES = Object.freeze(['waiting', 'countdown', 'live', 'ended'])

/** Why a round was won. */
export const ROUND_WIN_REASONS = Object.freeze(['hacked', 'ghosts_eliminated', 'time_out'])

/** Default round settings: timers in ms, finite and positive. */
export const DEFAULT_ROUND_SETTINGS = Object.freeze({
  countdownMs: 10000,
  liveMs: 420000,
  endedMs: 10000,
  minPlayersPerTeam: 1,
})

/** Event the server sends to all clients on every phase change. Payload: RoundEvent. */
export const ROUND_EVENT = 'round'
