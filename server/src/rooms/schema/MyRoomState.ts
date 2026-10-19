import { schema, t, type SchemaType } from "@colyseus/schema";
import { MOVEMENT_MODES, TEAMS } from "../../../../shared/protocol.js";

/**
 * One player. Field names match `PlayerState` in shared/protocol.d.ts.
 * Everything is server-authoritative; clients only send `move` inputs.
 * `team` is one of TEAMS, set on join and never changed. `yaw` is the
 * facing in radians (-pi..pi), 0 at spawn. `y` is the feet height (0 on
 * the ground floor) and `mode` one of MOVEMENT_MODES (M4, #29). Vertical
 * speed is server-only and is not part of the synced state.
 */
export const Player = schema({
  x: t.number().default(0),
  z: t.number().default(0),
  team: t.string().default(TEAMS[0]),
  yaw: t.number().default(0),
  y: t.number().default(0),
  mode: t.string().default(MOVEMENT_MODES[0]),
  // Weapons and damage (M5, #41). Set on join from MAX_HEALTH and WEAPONS.
  health: t.number().default(0),
  ammo: t.number().default(0),
  reloading: t.boolean().default(false),
});
export type Player = SchemaType<typeof Player>;

/**
 * Room state. Matches `GameRoomState`: `players` keyed by client.sessionId.
 *
 * Hidden information (#46, rule 2). `players` is tagged `.view()` (@colyseus/schema
 * 5 StateView): a client is sent a `players` entry only if that entry was added
 * to the client's own `client.view`. MyRoom does this per client every
 * simulation step (rules/visibility.ts): Ghost clients get everyone, a Warden
 * client gets itself, its Wardens and the Ghosts it can see or is near. A Ghost
 * that is not in a client's view is absent from that client's `players` map, so
 * none of its fields (x, y, z, yaw, mode, health, ammo, reloading, key) are sent.
 * Limits: the `players` map itself exists on every client (empty views get an
 * empty map); a client with no `view` would receive nothing for `players`.
 */
export const MyRoomState = schema({
  players: t.map(Player).view(),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;
