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
