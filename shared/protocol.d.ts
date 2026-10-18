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

/**
 * Payload of the "move" message: the direction the player wants to move.
 * Each component is in -1..1 (the client sends -1, 0 or 1; diagonals are not
 * normalised). The server must validate (finite numbers), clamp to -1..1,
 * scale by its own speed and clamp the result to the ground.
 */
export interface MoveMessage {
  dx: number
  dz: number
}

/** One player in room state. Positions are server-authoritative. */
export interface PlayerState {
  x: number
  z: number
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
