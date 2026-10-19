import { Room, Client, CloseCode } from "colyseus";
import {
  ACTION_MESSAGE,
  CAN_CLIMB,
  CLIMB_SPEED,
  DAMAGED_EVENT,
  EYE_HEIGHT,
  FIRE_BURST,
  FIRE_MESSAGE,
  FIRE_RATE_HZ,
  FRIENDLY_FIRE,
  GROUND_SIZE,
  HIT_EVENT,
  MAX_HEALTH,
  SHOT_EVENT,
  WEAPONS,
  JUMP_SPEED,
  MAX_TEAM_SIZE,
  MOVE_MESSAGE,
  SHIMMY_SPEED,
  STEP_HEIGHT,
  TEAMS,
  TEAM_SPEED,
  type MovementMode,
  type Team,
} from "../../../shared/protocol.js";
import { GRAYBOX_MAP, PLAYER_HALF_SIZE } from "../../../shared/map.js";
import { MyRoomState, Player } from "./schema/MyRoomState.js";
import { groundSolids } from "../rules/collision.js";
import { moveBody, startJump, stepFall, supportHeight, type Body, type World } from "../rules/vertical.js";
import { parseAction } from "../rules/actions.js";
import { aimDirection, castRay, type Target } from "../rules/ballistics.js";
import { parseFire } from "../rules/fire.js";
import { MANTLE_DISTANCE, climbMove, grab, letGo, mantle, shimmy, type ClimbBody } from "../rules/climbing.js";
import { randomSpawnPoint } from "../rules/spawn.js";
import { assignTeam } from "../rules/teams.js";
import { parseMove, worldStep } from "../rules/movement.js";

/** Player half size on x and z, from the shared map contract (re-exported for Tests/). */
export { PLAYER_HALF_SIZE };
/** Move validation lives in rules/movement.ts; re-exported for existing imports. */
export { parseMove };
/** Action validation lives in rules/actions.ts. */
export { parseAction };
/** Fire validation lives in rules/fire.ts. */
export { parseFire };
/** Fire/reload bucket, from the shared contract (re-exported for Tests/). */
export { FIRE_RATE_HZ, FIRE_BURST };
/** How far a mantle moves the player onto the top (rules/climbing.ts). */
export { MANTLE_DISTANCE };

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

/** Fixed server simulation rate (Hz): gravity, falls and landings run at this step. */
export const SIM_RATE_HZ = 20;

/** Action budget refill rate (actions per second), server-side only. */
export const ACTION_RATE_HZ = 5;

/** Action budget capacity: at most this many actions back to back. */
export const ACTION_BURST = 2;

/** Feet travel per accepted move while climbing, at full input: CLIMB_SPEED / MOVE_RATE_HZ (0.075). */
export const CLIMB_STEP = CLIMB_SPEED / MOVE_RATE_HZ;

/** Travel along a ledge per accepted move while hanging, at full input: SHIMMY_SPEED / MOVE_RATE_HZ (0.05). */
export const SHIMMY_STEP = SHIMMY_SPEED / MOVE_RATE_HZ;

/** The map this room plays on. */
const MAP = GRAYBOX_MAP;

/** Solids that block ground-floor movement (used to pick clear spawn points). */
const SOLIDS = groundSolids(MAP.solids);

/** The map geometry for height-aware movement (rules/vertical.ts). */
const WORLD: World = { solids: MAP.solids, floors: MAP.floors, ramps: MAP.ramps, bounds: MAP.bounds };

/** Length of one simulation step, in ms and in seconds. */
const SIM_STEP_MS = 1000 / SIM_RATE_HZ;
const SIM_STEP_S = 1 / SIM_RATE_HZ;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Per-client token bucket: `tokens` available, last refilled at `at` (ms). */
interface Budget {
  tokens: number;
  at: number;
}

/**
 * Refills a token bucket for the time elapsed since its last refill (at
 * `rateHz` tokens per second, up to `burst`) and spends one token if
 * available. Returns false if the bucket is empty.
 */
function spend(budget: Budget | undefined, now: number, rateHz: number, burst: number): boolean {
  if (!budget) return false;
  const elapsed = Math.max(0, now - budget.at);
  budget.tokens = Math.min(burst, budget.tokens + (elapsed / 1000) * rateHz);
  budget.at = now;
  if (budget.tokens < 1) return false;
  budget.tokens -= 1;
  return true;
}

export class MyRoom extends Room<{ state: MyRoomState }> {
  maxClients = MAX_CLIENTS;
  state = new MyRoomState();

  /** Server-only movement budgets by sessionId; never synchronized. */
  private moveBudgets = new Map<string, Budget>();

  /** Server-only action budgets by sessionId; never synchronized. */
  private actionBudgets = new Map<string, Budget>();

  /** Server-only fire/reload budgets by sessionId; never synchronized. */
  private fireBudgets = new Map<string, Budget>();

  /** Server-only time (ms, server clock) of each player's last accepted shot; never synchronized. */
  private lastShots = new Map<string, number>();

  /** Server-only vertical speeds (u/s, +up) by sessionId; never synchronized. */
  private verticalSpeeds = new Map<string, number>();

  /** Server-only anchor ids of attached (climbing or hanging) players; never synchronized. */
  private attachments = new Map<string, string>();

  /** Simulated time not yet consumed by a whole step (ms). */
  private simAccumulator = 0;

  /** Server time in ms. Tests replace this to control time. */
  now: () => number = () => performance.now();

  /**
   * When true (the default) the room's simulation interval drives
   * `simulate()` in real time. Tests set it to false and call `simulate()`
   * themselves, so falls and jumps run on a controlled clock.
   */
  autoSimulate = true;

  private spendMove(sessionId: string): boolean {
    return spend(this.moveBudgets.get(sessionId), this.now(), MOVE_RATE_HZ, MOVE_BURST);
  }

  private spendAction(sessionId: string): boolean {
    return spend(this.actionBudgets.get(sessionId), this.now(), ACTION_RATE_HZ, ACTION_BURST);
  }

  private spendFire(sessionId: string): boolean {
    return spend(this.fireBudgets.get(sessionId), this.now(), FIRE_RATE_HZ, FIRE_BURST);
  }

  /** The player's movement state as a Body for rules/vertical.ts. */
  private bodyOf(sessionId: string, player: Player): Body {
    return {
      x: player.x,
      y: player.y,
      z: player.z,
      mode: player.mode as MovementMode,
      vy: this.verticalSpeeds.get(sessionId) ?? 0,
    };
  }

  /** Writes a Body back. Only changed fields are assigned, so a no-op sends no patch. */
  private storeBody(sessionId: string, player: Player, body: Body) {
    if (player.x !== body.x) player.x = body.x;
    if (player.y !== body.y) player.y = body.y;
    if (player.z !== body.z) player.z = body.z;
    if (player.mode !== body.mode) player.mode = body.mode;
    this.verticalSpeeds.set(sessionId, body.vy);
  }

  /** The player's state as a ClimbBody for rules/climbing.ts (adds yaw and the anchor). */
  private climbBodyOf(sessionId: string, player: Player): ClimbBody {
    return { ...this.bodyOf(sessionId, player), yaw: player.yaw, anchorId: this.attachments.get(sessionId) ?? null };
  }

  /** Writes a ClimbBody back, with its yaw and anchor. */
  private storeClimbBody(sessionId: string, player: Player, body: ClimbBody) {
    this.storeBody(sessionId, player, body);
    if (player.yaw !== body.yaw) player.yaw = body.yaw;
    if (body.anchorId === null) this.attachments.delete(sessionId);
    else this.attachments.set(sessionId, body.anchorId);
  }

  /**
   * Advances the simulation by `dtMs` of server time, in fixed steps of
   * 1000 / SIM_RATE_HZ ms; a remainder carries over to the next call. Each
   * step applies gravity to falling players and lands them. Grounded players
   * are never touched.
   */
  simulate(dtMs: number) {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return;
    this.simAccumulator += dtMs;
    while (this.simAccumulator >= SIM_STEP_MS) {
      this.simAccumulator -= SIM_STEP_MS;
      this.step();
    }
  }

  /** One fixed simulation step. */
  private step() {
    this.state.players.forEach((player, sessionId) => {
      if (player.mode !== "falling") return;
      const body = this.bodyOf(sessionId, player);
      stepFall(WORLD, body, SIM_STEP_S);
      this.storeBody(sessionId, player, body);
    });
  }

  onCreate() {
    this.setSimulationInterval((dt) => {
      if (this.autoSimulate) this.simulate(dt);
    }, SIM_STEP_MS);
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

      if (player.mode === "climbing" || player.mode === "hanging") {
        // Attached: dz climbs along the anchor, dx shimmies along the ledge.
        const body = this.climbBodyOf(client.sessionId, player);
        const changed = player.mode === "climbing"
          ? climbMove(WORLD, MAP.anchors, body, move.dz * CLIMB_STEP)
          : shimmy(WORLD, MAP.anchors, body, move.dx * SHIMMY_STEP);
        if (changed) this.storeClimbBody(client.sessionId, player, body);
        return;
      }

      // Same team step on the ground and in the air (no extra air speed).
      const step = worldStep(move.dx, move.dz, player.yaw, TEAM_STEP[player.team as Team]);
      // Height-aware and swept (x, then z, so walls can be slid along); the
      // box stays inside the ground (centre within -BOUND..BOUND).
      const body = this.bodyOf(client.sessionId, player);
      moveBody(WORLD, body, step.x, step.z);
      body.x = clamp(body.x, -BOUND, BOUND);
      body.z = clamp(body.z, -BOUND, BOUND);
      this.storeBody(client.sessionId, player, body);
    },

    [ACTION_MESSAGE]: (client: Client, message: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const action = parseAction(message);
      if (!action) return;
      // Over budget: ignore. Refused actions still spend a token.
      if (!this.spendAction(client.sessionId)) return;

      const team = player.team as Team;
      if (action === "jump") {
        // Only from the ground, and only for teams that can jump (not Wardens).
        const body = this.bodyOf(client.sessionId, player);
        if (startJump(body, JUMP_SPEED[team])) this.storeBody(client.sessionId, player, body);
        return;
      }
      const body = this.climbBodyOf(client.sessionId, player);
      let changed = false;
      if (action === "climb") {
        // Grab the anchor picked from the player's own position, or mantle
        // while hanging. Wardens (CAN_CLIMB false) are always refused.
        changed = player.mode === "hanging"
          ? mantle(WORLD, MAP.anchors, body)
          : grab(WORLD, MAP.anchors, body, CAN_CLIMB[team]);
      } else {
        // 'drop': let go when attached; a no-op in any other mode.
        changed = letGo(body);
      }
      if (changed) this.storeClimbBody(client.sessionId, player, body);
    },

    [FIRE_MESSAGE]: (client: Client, message: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const aim = parseFire(message);
      if (!aim) return;
      // Over budget: ignore. Refused shots (cooldown, empty) still spend a token.
      if (!this.spendFire(client.sessionId)) return;

      const weapon = WEAPONS[player.team as Team];
      const now = this.now();
      const last = this.lastShots.get(client.sessionId);
      if (last !== undefined && now - last < weapon.intervalMs) return;
      if (player.ammo <= 0 || player.reloading) return;

      player.ammo -= 1;
      this.lastShots.set(client.sessionId, now);
      this.resolveShot(client, player, aim);
    },
  };

  /** Sends a shot event: Warden shots to everyone, Ghost shots (suppressed) to Ghost clients only. */
  private announceShot(shooterId: string, team: Team, payload: unknown) {
    for (const c of this.clients) {
      if (team === "ghost" && this.state.players.get(c.sessionId)?.team !== "ghost") continue;
      c.send(SHOT_EVENT, payload);
    }
  }

  /** Resolves one accepted shot: ray, damage and events. */
  private resolveShot(client: Client, shooter: Player, aim: { yaw: number; pitch: number }) {
    const team = shooter.team as Team;
    const weapon = WEAPONS[team];
    const origin = { x: shooter.x, y: shooter.y + EYE_HEIGHT, z: shooter.z };
    const targets: Target[] = [];
    this.state.players.forEach((p, id) => {
      if (id === client.sessionId || p.health <= 0) return;
      if (!FRIENDLY_FIRE && p.team === shooter.team) return;
      targets.push({ id, x: p.x, y: p.y, z: p.z });
    });
    const dir = aimDirection(aim.yaw, aim.pitch);
    const hit = castRay(WORLD, origin, dir, weapon.range, targets);
    const end = hit ? hit.point : { x: origin.x + dir.x * weapon.range, y: origin.y + dir.y * weapon.range, z: origin.z + dir.z * weapon.range };
    const victim = hit?.kind === "player" ? this.state.players.get(hit.id!) : undefined;

    this.announceShot(client.sessionId, team, {
      shooter: client.sessionId,
      team,
      origin,
      end,
      hit: victim !== undefined,
    });

    if (!victim || !hit?.id) return;
    const before = victim.health;
    victim.health = Math.max(0, before - weapon.damage);
    const damage = before - victim.health;
    const killed = victim.health <= 0;
    client.send(HIT_EVENT, { target: hit.id, damage, killed });
    this.clients.getById(hit.id)?.send(DAMAGED_EVENT, { damage, health: victim.health, killed });
  }

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
    // Standing on the surface under the spawn point (the ground today).
    player.y = supportHeight(WORLD, spawn.x, spawn.z, STEP_HEIGHT);
    player.mode = "ground";
    player.health = MAX_HEALTH[team];
    player.ammo = WEAPONS[team].magazine;
    player.reloading = false;
    this.state.players.set(client.sessionId, player);
    this.fireBudgets.set(client.sessionId, { tokens: FIRE_BURST, at: this.now() });
    this.moveBudgets.set(client.sessionId, { tokens: MOVE_BURST, at: this.now() });
    this.actionBudgets.set(client.sessionId, { tokens: ACTION_BURST, at: this.now() });
    this.verticalSpeeds.set(client.sessionId, 0);
    console.log(client.sessionId, "joined as", team);
  }

  onLeave(client: Client, code: CloseCode) {
    this.state.players.delete(client.sessionId);
    this.moveBudgets.delete(client.sessionId);
    this.actionBudgets.delete(client.sessionId);
    this.fireBudgets.delete(client.sessionId);
    this.lastShots.delete(client.sessionId);
    this.verticalSpeeds.delete(client.sessionId);
    this.attachments.delete(client.sessionId);
    console.log(client.sessionId, "left!", code);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }
}
