import { schema, t, type SchemaType } from "@colyseus/schema";
import { MOVEMENT_MODES, TEAMS, TERMINAL_STATUSES } from "../../../../shared/protocol.js";

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
 * One data terminal (M6, #56), keyed by terminal id. Sent to every client, so it
 * holds nothing a Warden must not know: no hacker, no count, no position, no
 * progress (progress is server-only and goes to Ghost clients as a message).
 * `status` is one of TERMINAL_STATUSES; `alert` is true once a hack has run HACK_ALERT_AFTER_MS (#58). `status` shows "hacking" only while `alert` is true, so these two values are all a Warden ever learns.
 */
export const Terminal = schema({
  id: t.string().default(""),
  status: t.string().default(TERMINAL_STATUSES[0]),
  alert: t.boolean().default(false),
});
export type Terminal = SchemaType<typeof Terminal>;

/**
 * Round phase, timer and result (M7, #68). Public to every client, identical
 * for both teams; fields match `RoundState` in shared/protocol.d.ts.
 */
export const Round = schema({
  phase: t.string().default("waiting"),
  roundNumber: t.number().default(0),
  secondsLeft: t.number().default(0),
  winner: t.string().default(""),
  winReason: t.string().default(""),
});
export type Round = SchemaType<typeof Round>;

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
  terminals: t.map(Terminal),
  round: t.ref(Round),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;
