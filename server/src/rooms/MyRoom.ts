import { Room, Client, CloseCode } from "colyseus";
import { StateView } from "@colyseus/schema";
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
  HACK_ALERT_AFTER_MS,
  HACK_PROGRESS_MESSAGE,
  INTERACT_MESSAGE,
  GROUND_SIZE,
  HIT_EVENT,
  MAX_HEALTH,
  ROUND_EVENT,
  RELOAD_MESSAGE,
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
import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP, PLAYER_HALF_SIZE } from "../../../shared/map.js";
import { MyRoomState, Player, Round, Terminal } from "./schema/MyRoomState.js";
import { groundSolids } from "../rules/collision.js";
import { moveBody, startJump, stepFall, supportHeight, type Body, type World } from "../rules/vertical.js";
import { parseAction } from "../rules/actions.js";
import { aimDirection, castRay, type Target } from "../rules/ballistics.js";
import { parseFire } from "../rules/fire.js";
import { advanceProgress, canHack, parseInteract } from "../rules/hacking.js";
import { canSee } from "../rules/visibility.js";
import { MANTLE_DISTANCE, climbMove, grab, letGo, mantle, shimmy, type ClimbBody } from "../rules/climbing.js";
import { randomSpawnPoint } from "../rules/spawn.js";
import { assignTeam } from "../rules/teams.js";
import { parseMove, worldStep } from "../rules/movement.js";
import { advanceRound, newRoundMachine, presetWarning, roundSettingsFromEnv, secondsLeft, type RoundConfig } from "../rules/round.js";

/**
 * Round configuration, read ONCE from the server's own environment when this
 * module loads (an unknown preset throws, so the server refuses to start).
 * Never read from room options, join options or messages.
 */
const STARTUP_ROUND_CONFIG: RoundConfig = roundSettingsFromEnv(process.env);
const STARTUP_WARNING = presetWarning(process.env);
if (STARTUP_WARNING) console.warn(STARTUP_WARNING);

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

/** Interact budget refill rate (messages per second), server-side only. */
export const INTERACT_RATE_HZ = 4;

/** Interact budget capacity: at most this many valid interact messages back to back. */
export const INTERACT_BURST = 2;

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

/** The one terminal that can be hacked (Phase 1). */
const ACTIVE_TERMINAL = MAP.terminals.find((term) => term.id === ACTIVE_TERMINAL_ID)!;

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

  /** Server-only interact budgets by sessionId; never synchronized. */
  private interactBudgets = new Map<string, Budget>();

  /** Sessions currently hacking the active terminal; server-only, never synchronized (no hacker ids to Wardens). */
  private hackers = new Set<string>();

  /** Hack progress 0..1 of the active terminal; server-only, Ghost clients get it as a message. */
  private progress = 0;

  /** Server time (ms) up to which `progress` is settled. */
  private progressAt: number | undefined;

  /** Server time (ms) at which the current unbroken hack began; undefined while nobody hacks. Server-only. */
  private hackStartedAt: number | undefined;

  /** Last progress sent to Ghost clients. */
  private sentProgress = 0;

  /** Server-only time (ms, server clock) of each player's last accepted shot; never synchronized. */
  private lastShots = new Map<string, number>();

  /** Server-only time (ms, server clock) at which each reloading player finishes; never synchronized. */
  private reloadEnds = new Map<string, number>();

  /**
   * Sessions eliminated since the last simulation step. Kill order rule: within
   * one step a player who just died can still be hit (the second shooter gets
   * `hit` with damage 0 and killed false), but only the shot that took health
   * to 0 reports killed: true. Cleared at the start of each step.
   */
  private killedThisStep = new Set<string>();

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

  /**
   * Round settings (M7). From the server environment at startup; null is the
   * `open` preset (live from creation, nothing ends). Tests assign it after
   * create, like autoSimulate. Never set from options or messages.
   */
  roundSettings: RoundConfig = STARTUP_ROUND_CONFIG;

  /** Server-only round machine; its public fields are mirrored into state.round. */
  private roundMachine = newRoundMachine();

  /** The settings the machine was last evaluated with (to notice a replaced config). */
  private appliedRound: RoundConfig | undefined;

  /** True while inputs are accepted: only in the live phase. */
  private get inputsOpen(): boolean {
    return this.state.round.phase === "live";
  }

  /** Whether a joiner must sit out: a timed round is live. */
  private get roundIsLiveTimed(): boolean {
    return this.roundSettings !== null && this.state.round.phase === "live";
  }

  /** Start of a countdown: every terminal idle, alert off, no hackers, progress 0, no decay state (#70). */
  private resetTerminals() {
    this.hackers.clear();
    this.progress = 0;
    this.progressAt = this.now();
    this.hackStartedAt = undefined;
    this.state.terminals.forEach((term) => {
      if (term.status !== "idle") term.status = "idle";
      if (term.alert) term.alert = false;
    });
  }

  /** Gives every connected player a fresh spawn and full health and ammo (start of a countdown). */
  private resetPlayers() {
    this.resetTerminals();
    this.state.players.forEach((player, id) => {
      const team = player.team as Team;
      const spawn = randomSpawnPoint(MAP.spawnAreas[team], SOLIDS);
      player.x = spawn.x;
      player.z = spawn.z;
      player.y = supportHeight(WORLD, spawn.x, spawn.z, STEP_HEIGHT);
      player.yaw = SPAWN_YAW;
      player.mode = "ground";
      player.health = MAX_HEALTH[team];
      player.ammo = WEAPONS[team].magazine;
      player.reloading = false;
      this.reloadEnds.delete(id);
      this.lastShots.delete(id);
      this.attachments.delete(id);
      this.verticalSpeeds.set(id, 0);
    });
    this.sendProgress();
  }

  /** Runs the round machine at server time now and mirrors it into state. */
  private updateRound() {
    const now = this.now();
    if (this.appliedRound !== this.roundSettings) {
      // Settings were replaced (tests): start the machine afresh.
      this.appliedRound = this.roundSettings;
      this.roundMachine = newRoundMachine();
    }
    const counts = { ghost: 0, warden: 0 };
    this.state.players.forEach((p) => { counts[p.team as Team] += 1; });
    const wasLive = this.roundMachine.phase === "live";
    // Hack completion is evaluated first in a step: bring progress up to now.
    if (wasLive) {
      this.dropInvalidHackers();
      this.settleHack();
    }
    let ghostsAlive = 0;
    this.state.players.forEach((p) => { if (p.team === "ghost" && p.health > 0) ghostsAlive += 1; });
    const hacked = this.state.terminals.get(ACTIVE_TERMINAL_ID)?.status === "hacked";
    const adv = advanceRound(this.roundMachine, this.roundSettings, now, counts, { hacked, ghostsAlive });
    const m = this.roundMachine;
    if (wasLive && m.phase !== "live") {
      // Round over or aborted: no hack carries on.
      for (const id of [...this.hackers]) this.interruptHack(id);
    }
    if (adv.reset) this.resetPlayers();
    const r = this.state.round;
    if (r.phase !== m.phase) r.phase = m.phase;
    if (r.roundNumber !== m.roundNumber) r.roundNumber = m.roundNumber;
    if (r.winner !== m.winner) r.winner = m.winner;
    if (r.winReason !== m.winReason) r.winReason = m.winReason;
    const left = secondsLeft(m, now);
    if (r.secondsLeft !== left) r.secondsLeft = left;
    if (adv.phaseChanged) {
      this.broadcast(ROUND_EVENT, { phase: m.phase, roundNumber: m.roundNumber, winner: m.winner, winReason: m.winReason });
    }
  }

  private spendMove(sessionId: string): boolean {
    return spend(this.moveBudgets.get(sessionId), this.now(), MOVE_RATE_HZ, MOVE_BURST);
  }

  private spendAction(sessionId: string): boolean {
    return spend(this.actionBudgets.get(sessionId), this.now(), ACTION_RATE_HZ, ACTION_BURST);
  }

  private spendInteract(sessionId: string): boolean {
    return spend(this.interactBudgets.get(sessionId), this.now(), INTERACT_RATE_HZ, INTERACT_BURST);
  }

  /** Hack progress of the active terminal (0..1). Server-only; read by tests. */
  get hackProgress(): number {
    return this.progress;
  }

  /** Settles progress up to server time now with the current hackers (gain if any, else decay). */
  private settleHack() {
    const now = this.now();
    const term = this.state.terminals.get(ACTIVE_TERMINAL_ID);
    if (term && term.status !== "hacked") {
      const dt = this.progressAt === undefined ? 0 : Math.max(0, now - this.progressAt);
      this.progress = advanceProgress(this.progress, dt, this.hackers.size > 0);
      if (this.progress >= 1) {
        this.hackers.clear();
        this.hackStartedAt = undefined;
        term.status = "hacked";
        if (term.alert) term.alert = false;
      }
    }
    this.progressAt = now;
  }

  /**
   * Sets the synced terminal values from the hacker set (hacked is final). What
   * is synced is exactly what a Warden may learn (#58, rules 2 and 3), so the
   * state is not view-tagged and carries no second, richer copy: `alert` is
   * true once the current unbroken hack has run HACK_ALERT_AFTER_MS, and
   * `status` shows "hacking" only while `alert` is true (the first
   * HACK_ALERT_AFTER_MS give no cue; Ghosts have their own hackProgress
   * message). Both fall back to idle/false the moment the hack is interrupted.
   */
  private syncTerminal() {
    const term = this.state.terminals.get(ACTIVE_TERMINAL_ID);
    if (!term || term.status === "hacked") return;
    let alert = false;
    if (this.hackers.size === 0) {
      this.hackStartedAt = undefined;
    } else {
      const now = this.now();
      if (this.hackStartedAt === undefined) this.hackStartedAt = now;
      alert = now - this.hackStartedAt >= HACK_ALERT_AFTER_MS;
    }
    const status = alert ? "hacking" : "idle";
    if (term.status !== status) term.status = status;
    if (term.alert !== alert) term.alert = alert;
  }

  /** Stops a player's hack at once (progress is settled first and then decays). A fresh interact is needed to resume. */
  private interruptHack(sessionId: string) {
    if (!this.hackers.has(sessionId)) return;
    this.settleHack();
    this.hackers.delete(sessionId);
    this.syncTerminal();
    this.sendProgress();
  }

  /** Sends progress to Ghost clients when it changed since the last send (Wardens never get it). */
  private sendProgress(onlyTo?: Client) {
    if (onlyTo) {
      if (this.state.players.get(onlyTo.sessionId)?.team === "ghost") onlyTo.send(HACK_PROGRESS_MESSAGE, { progress: this.progress });
      return;
    }
    if (this.progress === this.sentProgress) return;
    this.sentProgress = this.progress;
    for (const c of this.clients) {
      if (this.state.players.get(c.sessionId)?.team === "ghost") c.send(HACK_PROGRESS_MESSAGE, { progress: this.progress });
    }
  }

  /** Removes hackers who can no longer hack (left range, died, left the ground). */
  private dropInvalidHackers() {
    this.hackers.forEach((id) => {
      const p = this.state.players.get(id);
      if (!p || !canHack(p, ACTIVE_TERMINAL)) this.hackers.delete(id);
    });
  }

  /** Runs the hack for one step: drops hackers who can no longer hack, settles progress, updates status. */
  private stepHack() {
    this.dropInvalidHackers();
    this.settleHack();
    this.syncTerminal();
    this.sendProgress();
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

  /**
   * Recomputes, for every client, which players it is sent (#46): adds the
   * ones it may see to its StateView and removes the rest, so a hidden Ghost
   * is deleted from that client's state in the next patch. Cost per step at
   * 4v4: 4 Wardens x 4 Ghosts x at most 7 ray tests = 112 tests (Ghost
   * viewers and teammates need none).
   */
  private updateViews() {
    const entries: Array<{ id: string; p: Player }> = [];
    this.state.players.forEach((p, id) => entries.push({ id, p }));
    for (const client of this.clients) {
      const view = client.view;
      const me = this.state.players.get(client.sessionId);
      if (!view || !me) continue;
      const viewer = { id: client.sessionId, team: me.team, x: me.x, y: me.y, z: me.z };
      for (const { id, p } of entries) {
        const visible = canSee(WORLD, viewer, { id, team: p.team, x: p.x, y: p.y, z: p.z });
        const has = view.has(p);
        if (visible && !has) view.add(p);
        else if (!visible && has) view.remove(p);
      }
    }
  }

  /** One fixed simulation step. */
  private step() {
    this.killedThisStep.clear();
    this.updateRound();
    // Finish reloads that are due (server clock). Eliminated players never reach here with a reload.
    const t = this.now();
    this.reloadEnds.forEach((end, id) => {
      const p = this.state.players.get(id);
      if (!p || p.health <= 0) {
        this.reloadEnds.delete(id);
        return;
      }
      if (t < end) return;
      p.ammo = WEAPONS[p.team as Team].magazine;
      p.reloading = false;
      this.reloadEnds.delete(id);
    });
    this.state.players.forEach((player, sessionId) => {
      if (player.mode !== "falling") return;
      const body = this.bodyOf(sessionId, player);
      stepFall(WORLD, body, SIM_STEP_S);
      this.storeBody(sessionId, player, body);
    });
    this.stepHack();
    this.updateViews();
  }

  /**
   * Eliminates a player whose health reached 0: cancels any reload (ammo stays)
   * and drops an attached player so the simulation settles the body on the
   * ground. A grounded body stays where it is. No respawn.
   */
  private eliminate(sessionId: string, player: Player) {
    this.killedThisStep.add(sessionId);
    this.reloadEnds.delete(sessionId);
    if (player.reloading) player.reloading = false;
    if (player.mode === "climbing" || player.mode === "hanging") {
      const body = this.climbBodyOf(sessionId, player);
      letGo(body);
      this.storeClimbBody(sessionId, player, body);
    }
  }

  onCreate() {
    this.state.round = new Round();
    this.updateRound();
    for (const term of MAP.terminals) {
      const entry = new Terminal();
      entry.id = term.id;
      entry.status = "idle";
      entry.alert = false;
      this.state.terminals.set(term.id, entry);
    }
    this.setSimulationInterval((dt) => {
      if (this.autoSimulate) this.simulate(dt);
    }, SIM_STEP_MS);
  }

  messages = {
    [MOVE_MESSAGE]: (client: Client, message: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.health <= 0 || !this.inputsOpen) return;

      const move = parseMove(message);
      if (!move) return;
      // Over budget: ignore the message (don't disconnect). Turning counts too.
      if (!this.spendMove(client.sessionId)) return;

      if (move.yaw !== undefined) player.yaw = move.yaw;
      if (move.dx === 0 && move.dz === 0) return;
      // Any non-zero intent interrupts a hack (turning to aim does not).
      this.interruptHack(client.sessionId);

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
      if (!player || player.health <= 0 || !this.inputsOpen) return;

      const action = parseAction(message);
      if (!action) return;
      // Over budget: ignore. Refused actions still spend a token.
      if (!this.spendAction(client.sessionId)) return;

      const team = player.team as Team;
      if (action === "jump") {
        // Leaving the ground interrupts a hack (a refused jump changes nothing).
        const wasGround = player.mode === "ground";
        // Only from the ground, and only for teams that can jump (not Wardens).
        const body = this.bodyOf(client.sessionId, player);
        if (startJump(body, JUMP_SPEED[team])) {
          this.storeBody(client.sessionId, player, body);
          if (wasGround) this.interruptHack(client.sessionId);
        }
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
      if (changed) {
        this.storeClimbBody(client.sessionId, player, body);
        this.interruptHack(client.sessionId);
      }
    },

    [RELOAD_MESSAGE]: (client: Client, message: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.health <= 0 || !this.inputsOpen) return;
      if (typeof message !== "object" || message === null || Array.isArray(message)) return;
      // Shares the fire bucket. Refused reloads still spend a token.
      if (!this.spendFire(client.sessionId)) return;

      const weapon = WEAPONS[player.team as Team];
      if (player.reloading || player.ammo >= weapon.magazine) return;
      player.reloading = true;
      this.reloadEnds.set(client.sessionId, this.now() + weapon.reloadMs);
    },

    [INTERACT_MESSAGE]: (client: Client, message: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.health <= 0 || !this.inputsOpen) return;

      const active = parseInteract(message);
      if (active === null) return;
      // Over budget: ignore. Refused starts still spend a token.
      if (!this.spendInteract(client.sessionId)) return;

      // Bring progress up to date before the hacker set changes.
      this.settleHack();
      if (!active) this.hackers.delete(client.sessionId);
      else if (this.state.terminals.get(ACTIVE_TERMINAL_ID)?.status !== "hacked" && canHack(player, ACTIVE_TERMINAL)) {
        this.hackers.add(client.sessionId);
      }
      this.syncTerminal();
      this.sendProgress();
    },

    [FIRE_MESSAGE]: (client: Client, message: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.health <= 0 || !this.inputsOpen) return;

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
      if (id === client.sessionId) return;
      if (p.health <= 0 && !this.killedThisStep.has(id)) return;
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
    if (victim.health <= 0) {
      // Already killed in this step: a hit, but no damage, no second kill, no revive.
      client.send(HIT_EVENT, { target: hit.id, damage: 0, killed: false });
      return;
    }
    const before = victim.health;
    victim.health = Math.max(0, before - weapon.damage);
    const damage = before - victim.health;
    const killed = victim.health <= 0;
    // Any damage stops the victim's hack at once; no other penalty.
    if (damage > 0) this.interruptHack(hit.id);
    if (killed) this.eliminate(hit.id, victim);
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
    // Joining a live timed round: sit out (eliminated) until the next reset.
    player.health = this.roundIsLiveTimed ? 0 : MAX_HEALTH[team];
    player.ammo = WEAPONS[team].magazine;
    player.reloading = false;
    this.state.players.set(client.sessionId, player);
    client.view = new StateView();
    this.updateViews();
    this.fireBudgets.set(client.sessionId, { tokens: FIRE_BURST, at: this.now() });
    this.moveBudgets.set(client.sessionId, { tokens: MOVE_BURST, at: this.now() });
    this.actionBudgets.set(client.sessionId, { tokens: ACTION_BURST, at: this.now() });
    this.interactBudgets.set(client.sessionId, { tokens: INTERACT_BURST, at: this.now() });
    this.verticalSpeeds.set(client.sessionId, 0);
    this.sendProgress(client);
    this.updateRound();
    console.log(client.sessionId, "joined as", team);
  }

  onLeave(client: Client, code: CloseCode) {
    if (this.hackers.has(client.sessionId)) {
      this.settleHack();
      this.hackers.delete(client.sessionId);
      this.syncTerminal();
    }
    this.interactBudgets.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    client.view?.dispose();
    this.updateViews();
    this.moveBudgets.delete(client.sessionId);
    this.actionBudgets.delete(client.sessionId);
    this.fireBudgets.delete(client.sessionId);
    this.lastShots.delete(client.sessionId);
    this.reloadEnds.delete(client.sessionId);
    this.killedThisStep.delete(client.sessionId);
    this.verticalSpeeds.delete(client.sessionId);
    this.attachments.delete(client.sessionId);
    this.updateRound();
    console.log(client.sessionId, "left!", code);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }
}
