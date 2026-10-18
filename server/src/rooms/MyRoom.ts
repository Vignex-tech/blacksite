import { Room, Client, CloseCode } from "colyseus";
import {
  GROUND_SIZE,
  MAX_TEAM_SIZE,
  MOVE_MESSAGE,
  TEAMS,
  TEAM_SPEED,
  type Team,
} from "../../../shared/protocol.js";
import { GRAYBOX_MAP, PLAYER_HALF_SIZE } from "../../../shared/map.js";
import { MyRoomState, Player } from "./schema/MyRoomState.js";
import { groundSolids, resolveMove } from "../rules/collision.js";
import { randomSpawnPoint } from "../rules/spawn.js";
import { assignTeam } from "../rules/teams.js";
import { parseMove, worldStep } from "../rules/movement.js";

/** Player half size on x and z, from the shared map contract (re-exported for Tests/). */
export { PLAYER_HALF_SIZE };
/** Move validation lives in rules/movement.ts; re-exported for existing imports. */
export { parseMove };

/**
 * Intended move-message rate (Hz). Each team's max sustained speed is
 * TEAM_STEP[team] * MOVE_RATE_HZ = TEAM_SPEED[team]. Matches the client's send rate.
 */
export const MOVE_RATE_HZ = 20;

/**
 * Distance each team moves per accepted `move` message at full input (world
 * units): TEAM_SPEED[team] / MOVE_RATE_HZ (ghost 0.12, warden 0.1).
 */
export const TEAM_STEP: Readonly<Record<Team, number>> = Object.freeze(
  Object.fromEntries(TEAMS.map((t) => [t, TEAM_SPEED[t] / MOVE_RATE_HZ])) as Record<Team, number>,
);

/**
 * Legacy single step from M1 and M2, kept because Tests/ imports it. Equal to
 * the Warden step (0.1). Movement no longer uses it; see TEAM_STEP.
 */
export const SPEED = TEAM_STEP.warden;

/**
 * Movement budget capacity, in moves. A full bucket lets a few messages through
 * back to back, which absorbs network jitter (messages arriving bunched up)
 * without letting a client go faster than its team speed on average.
 */
export const MOVE_BURST = 3;

/** Players stay within -BOUND..BOUND on x and z. */
export const BOUND = GROUND_SIZE / 2 - PLAYER_HALF_SIZE;

/** Most players per room: two full teams. */
export const MAX_CLIENTS = TEAMS.length * MAX_TEAM_SIZE;

/** Yaw every player spawns with (facing +z). */
export const SPAWN_YAW = 0;

/** The map this room plays on. */
const MAP = GRAYBOX_MAP;

/** Solids that block ground-floor movement (y range overlaps the player's height). */
const SOLIDS = groundSolids(MAP.solids);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Per-client token bucket: `tokens` moves available, last refilled at `at` (ms). */
interface MoveBudget {
  tokens: number;
  at: number;
}

export class MyRoom extends Room<{ state: MyRoomState }> {
  maxClients = MAX_CLIENTS;
  state = new MyRoomState();

  /** Server-only movement budgets by sessionId; never synchronized. */
  private moveBudgets = new Map<string, MoveBudget>();

  /** Server time in ms. Tests replace this to control time. */
  now: () => number = () => performance.now();

  /**
   * Refills the client's budget for the time elapsed since the last refill and
   * spends one move if available. Returns false if the client is over budget.
   */
  private spendMove(sessionId: string): boolean {
    const now = this.now();
    const budget = this.moveBudgets.get(sessionId);
    if (!budget) return false;
    const elapsed = Math.max(0, now - budget.at);
    budget.tokens = Math.min(MOVE_BURST, budget.tokens + (elapsed / 1000) * MOVE_RATE_HZ);
    budget.at = now;
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  messages = {
    [MOVE_MESSAGE]: (client: Client, message: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const move = parseMove(message);
      if (!move) return;
      // Over budget: ignore the message (don't disconnect). Turning counts too.
      if (!this.spendMove(client.sessionId)) return;

      if (move.yaw !== undefined) player.yaw = move.yaw;
      if (move.dx === 0 && move.dz === 0) return;

      const step = worldStep(move.dx, move.dz, player.yaw, TEAM_STEP[player.team as Team]);
      // Collide with the map's solids (x, then z, so walls can be slid along)
      // and keep the box on the ground (centre within -BOUND..BOUND).
      const next = resolveMove(player, step.x, step.z, SOLIDS, MAP.bounds);
      player.x = clamp(next.x, -BOUND, BOUND);
      player.z = clamp(next.z, -BOUND, BOUND);
    },
  };

  /** Join options are ignored on purpose: clients cannot choose their team. */
  onJoin(client: Client, _options: unknown) {
    const team = assignTeam(this.state.players.values());
    if (!team) throw new Error("both teams are full");

    const player = new Player();
    player.team = team;
    player.yaw = SPAWN_YAW;
    const spawn = randomSpawnPoint(MAP.spawnAreas[team], SOLIDS);
    player.x = spawn.x;
    player.z = spawn.z;
    this.state.players.set(client.sessionId, player);
    this.moveBudgets.set(client.sessionId, { tokens: MOVE_BURST, at: this.now() });
    console.log(client.sessionId, "joined as", team);
  }

  onLeave(client: Client, code: CloseCode) {
    this.state.players.delete(client.sessionId);
    this.moveBudgets.delete(client.sessionId);
    console.log(client.sessionId, "left!", code);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }
}
