import { Room, Client, CloseCode } from "colyseus";
import {
  GROUND_SIZE,
  MOVE_MESSAGE,
  type MoveMessage,
  type PlayerState,
} from "../../../shared/protocol.js";
import { MyRoomState, Player } from "./schema/MyRoomState.js";

/** Distance a player moves per accepted `move` message at full input (world units). */
export const SPEED = 0.1;

/** Half the player box size; keeps the whole box on the ground. */
export const PLAYER_HALF_SIZE = 0.5;

/** Players stay within -BOUND..BOUND on x and z. */
export const BOUND = GROUND_SIZE / 2 - PLAYER_HALF_SIZE;

/** New players spawn at a random offset within -SPAWN_SPREAD..SPAWN_SPREAD on x and z. */
export const SPAWN_SPREAD = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Returns the validated, clamped direction, or null if the payload is invalid
 * (not an object, or dx/dz not finite numbers).
 */
export function parseMove(message: unknown): MoveMessage | null {
  if (typeof message !== "object" || message === null) return null;
  const { dx, dz } = message as Record<string, unknown>;
  if (!isFiniteNumber(dx) || !isFiniteNumber(dz)) return null;
  return { dx: clamp(dx, -1, 1), dz: clamp(dz, -1, 1) };
}

export class MyRoom extends Room<{ state: MyRoomState }> {
  maxClients = 4;
  state = new MyRoomState();

  messages = {
    [MOVE_MESSAGE]: (client: Client, message: unknown) => {
      const player: PlayerState | undefined = this.state.players.get(client.sessionId);
      if (!player) return;

      const move = parseMove(message);
      if (!move) return;

      player.x = clamp(player.x + move.dx * SPEED, -BOUND, BOUND);
      player.z = clamp(player.z + move.dz * SPEED, -BOUND, BOUND);
    },
  };

  onJoin(client: Client, options: any) {
    const player = new Player();
    player.x = (Math.random() * 2 - 1) * SPAWN_SPREAD;
    player.z = (Math.random() * 2 - 1) * SPAWN_SPREAD;
    this.state.players.set(client.sessionId, player);
    console.log(client.sessionId, "joined!");
  }

  onLeave(client: Client, code: CloseCode) {
    this.state.players.delete(client.sessionId);
    console.log(client.sessionId, "left!", code);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }
}
