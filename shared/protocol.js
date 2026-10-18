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
