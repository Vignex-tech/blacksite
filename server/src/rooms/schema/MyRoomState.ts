import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * One player. Field names match `PlayerState` in shared/protocol.d.ts.
 * Positions are server-authoritative; clients only send `move` inputs.
 */
export const Player = schema({
  x: t.number().default(0),
  z: t.number().default(0),
});
export type Player = SchemaType<typeof Player>;

/** Room state. Matches `GameRoomState`: `players` keyed by client.sessionId. */
export const MyRoomState = schema({
  players: t.map(Player),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;
