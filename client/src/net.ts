import { Callbacks, Client, type Room } from '@colyseus/sdk'
import { MOVE_MESSAGE, ROOM_NAME, TEAMS, type MoveMessage, type PlayerState, type Team } from '../../shared/protocol.js'

/** Port the Colyseus server listens on by default (server/src/index.ts). */
const SERVER_PORT = 2567
/** Port of the Vite dev server (`npm run dev` in client/). */
const VITE_DEV_PORT = '5173'

/**
 * WebSocket endpoint of the game server, derived from the page location:
 * `wss:` on https, `ws:` on http, same host and port. The server serves the
 * built client itself (port 2567, or an https tunnel in front of it), so the
 * page origin is the server.
 *
 * Exception: on the Vite dev server (port 5173) the page is not served by
 * Colyseus, so it connects to port 2567 on the same hostname instead.
 */
export function serverUrl(loc: Location = location): string {
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = loc.port === VITE_DEV_PORT ? `${loc.hostname}:${SERVER_PORT}` : loc.host
  return `${protocol}//${host}`
}

/** Team and facing of a player as received from room state. */
export interface PlayerPose {
  /** null if the state holds no valid team (yet). */
  team: Team | null
  /** Radians, 0 faces +z (0 if the state holds no finite yaw yet). */
  yaw: number
}

export interface PlayerView {
  /** `pose` is omitted only by callers that know no team or facing. */
  upsertPlayer(id: string, x: number, z: number, isLocal?: boolean, pose?: PlayerPose): void
  removePlayer(id: string): void
}

/** Reads team and yaw from a synced player, tolerating missing or unknown values. */
export function poseOf(player: PlayerState): PlayerPose {
  const team = (TEAMS as readonly string[]).includes(player.team) ? player.team : null
  const yaw = typeof player.yaw === 'number' && Number.isFinite(player.yaw) ? player.yaw : 0
  return { team, yaw }
}

/** Joins the shared room and mirrors `state.players` into the view. Rejects if joining fails. */
export async function joinGame(view: PlayerView, onPlayerCount: (count: number) => void): Promise<Room> {
  const client = new Client(serverUrl())
  const room = await client.joinOrCreate(ROOM_NAME)

  const ids = new Set<string>()
  // `players` may be missing from the state (older server). onAdd waits for the
  // collection to appear, so nothing is rendered and nothing throws until then.
  const callbacks = Callbacks.get(room) as unknown as PlayersCallbacks
  callbacks.onAdd('players', (player, sessionId) => {
    const isLocal = sessionId === room.sessionId
    const update = (): void => view.upsertPlayer(sessionId, player.x, player.z, isLocal, poseOf(player))
    update()
    ids.add(sessionId)
    onPlayerCount(ids.size)
    callbacks.onChange(player, update)
  })
  callbacks.onRemove('players', (_player, sessionId) => {
    view.removePlayer(sessionId)
    ids.delete(sessionId)
    onPlayerCount(ids.size)
  })
  room.onLeave(() => {
    for (const id of ids) view.removePlayer(id)
    ids.clear()
  })
  return room
}

/** Sends one "move" message. The server is authoritative; nothing moves locally. */
export function sendMove(room: Room, move: MoveMessage): void {
  room.send(MOVE_MESSAGE, move)
}

/** The subset of the SDK callbacks API used here, typed against the shared player shape. */
interface PlayersCallbacks {
  onAdd(property: 'players', handler: (player: PlayerState, sessionId: string) => void): () => void
  onRemove(property: 'players', handler: (player: PlayerState, sessionId: string) => void): () => void
  onChange(instance: PlayerState, handler: () => void): () => void
}
