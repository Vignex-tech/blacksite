import { schema, t, type SchemaType } from "@colyseus/schema";
import { TEAMS } from "../../../../shared/protocol.js";

/**
 * One player. Field names match `PlayerState` in shared/protocol.d.ts.
 * Everything is server-authoritative; clients only send `move` inputs.
 * `team` is one of TEAMS, set on join and never changed. `yaw` is the
 * facing in radians (-pi..pi), 0 at spawn.
 */
export const Player = schema({
  x: t.number().default(0),
  z: t.number().default(0),
  team: t.string().default(TEAMS[0]),
  yaw: t.number().default(0),
});
export type Player = SchemaType<typeof Player>;

/** Room state. Matches `GameRoomState`: `players` keyed by client.sessionId. */
export const MyRoomState = schema({
  players: t.map(Player),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;
