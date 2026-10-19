import { Callbacks, Client, type Room } from '@colyseus/sdk'
import {
  ACTION_MESSAGE,
  DAMAGED_EVENT,
  FIRE_MESSAGE,
  HACK_PROGRESS_MESSAGE,
  HIT_EVENT,
  INTERACT_MESSAGE,
  MOVE_MESSAGE,
  MOVEMENT_MODES,
  RELOAD_MESSAGE,
  ROOM_NAME,
  ROUND_PHASES,
  ROUND_WIN_REASONS,
  SHOT_EVENT,
  TEAMS,
  TERMINAL_STATUSES,
  type Action,
  type DamagedEvent,
  type HitEvent,
  type ShotEvent,
  type MoveMessage,
  type MovementMode,
  type PlayerState,
  type Team,
  type TerminalState,
  type TerminalStatus,
} from '../../shared/protocol.js'
import { defaultVitals } from './vitals.ts'
import type { RoundView } from './roundView.ts'

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

/** Team, facing, height and movement mode of a player as received from room state. */
export interface PlayerPose {
  /** null if the state holds no valid team (yet). */
  team: Team | null
  /** Radians, 0 faces +z (0 if the state holds no finite yaw yet). */
  yaw: number
  /** Feet height (M4). Treated as 0 when omitted. */
  y?: number
  /** Movement mode (M4). Treated as 'ground' when omitted. */
  mode?: MovementMode
  /** Health, ammo and reload flag (M5, #48). Safe defaults when the state holds none. */
  health?: number
  ammo?: number
  reloading?: boolean
}

export interface PlayerView {
  /** `pose` is omitted only by callers that know no team or facing. */
  upsertPlayer(id: string, x: number, z: number, isLocal?: boolean, pose?: PlayerPose): void
  removePlayer(id: string): void
}

const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * Reads team, yaw, y and mode from a synced player, tolerating missing or
 * unknown values (team null, yaw 0, y 0, mode 'ground').
 */
export function poseOf(player: PlayerState): PlayerPose {
  const team = (TEAMS as readonly string[]).includes(player.team) ? player.team : null
  const mode = (MOVEMENT_MODES as readonly string[]).includes(player.mode) ? player.mode : 'ground'
  const d = defaultVitals(team)
  return {
    team,
    yaw: finiteOr(player.yaw, 0),
    y: finiteOr(player.y, 0),
    mode,
    health: finiteOr(player.health, d.health),
    ammo: finiteOr(player.ammo, d.ammo),
    reloading: typeof player.reloading === 'boolean' ? player.reloading : d.reloading,
  }
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

/** Sends one "action" message (one per key press). The server decides whether it does anything. */
export function sendAction(room: Room, action: Action): void {
  room.send(ACTION_MESSAGE, { action })
}

/** Sends one "interact" message: hold F sends true, release sends false. The server decides everything else. */
export function sendInteract(room: Room, active: boolean): void {
  room.send(INTERACT_MESSAGE, { active })
}

/** Mirrors `state.terminals` into the handler. Unknown statuses are dropped. */
export function watchTerminals(
  room: Room,
  onTerminal: (id: string, status: TerminalStatus, alert: boolean) => void,
): void {
  const callbacks = Callbacks.get(room) as unknown as TerminalCallbacks
  callbacks.onAdd('terminals', (t, id) => {
    const update = (): void => {
      if ((TERMINAL_STATUSES as readonly string[]).includes(t.status)) onTerminal(id, t.status, t.alert === true)
    }
    update()
    callbacks.onChange(t, update)
  })
}

/** Subscribes to the Ghost-only hack progress (0..1). Malformed payloads are dropped; values are clamped. */
export function onHackProgress(room: Room, handler: (progress: number) => void): void {
  room.onMessage(HACK_PROGRESS_MESSAGE, (m: unknown) => {
    const p = isObj(m) ? m.progress : undefined
    if (typeof p === 'number' && Number.isFinite(p)) handler(Math.min(1, Math.max(0, p)))
  })
}

/** Sends one "fire" message: aim only. `pitch` is on the wire convention (positive looks up). */
export function sendFire(room: Room, yaw: number, pitch: number): void {
  room.send(FIRE_MESSAGE, { yaw, pitch })
}

/** Sends one "reload" message. The server decides whether a reload starts. */
export function sendReload(room: Room): void {
  room.send(RELOAD_MESSAGE, {})
}

/** Handlers for the server events of M5. Payloads are checked before a handler runs. */
export interface CombatHandlers {
  onShot(e: ShotEvent): void
  onHit(e: HitEvent): void
  onDamaged(e: DamagedEvent): void
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isPoint = (v: unknown): boolean =>
  isObj(v) && [v.x, v.y, v.z].every((n) => typeof n === 'number' && Number.isFinite(n))

/** Subscribes to shot, hit and damaged events; malformed payloads are dropped. */
export function onCombatEvents(room: Room, h: CombatHandlers): void {
  room.onMessage(SHOT_EVENT, (m: unknown) => {
    if (isObj(m) && isPoint(m.origin) && isPoint(m.end)) h.onShot(m as unknown as ShotEvent)
  })
  room.onMessage(HIT_EVENT, (m: unknown) => {
    if (isObj(m) && typeof m.killed === 'boolean') h.onHit(m as unknown as HitEvent)
  })
  room.onMessage(DAMAGED_EVENT, (m: unknown) => {
    if (isObj(m) && typeof m.killed === 'boolean') h.onDamaged(m as unknown as DamagedEvent)
  })
}

/** The subset of the SDK callbacks API used here, typed against the shared player shape. */
interface PlayersCallbacks {
  onAdd(property: 'players', handler: (player: PlayerState, sessionId: string) => void): () => void
  onRemove(property: 'players', handler: (player: PlayerState, sessionId: string) => void): () => void
  onChange(instance: PlayerState, handler: () => void): () => void
}

interface TerminalCallbacks {
  onAdd(property: 'terminals', handler: (terminal: TerminalState, id: string) => void): () => void
  onChange(instance: TerminalState, handler: () => void): () => void
}

/**
 * Reads `state.round` on every state patch (and once now) and passes a
 * checked copy to the handler. Bad or missing fields are dropped; the handler
 * is not called until a valid round exists.
 */
export function watchRound(room: Room, onRound: (round: RoundView) => void): void {
  const read = (): void => {
    const r = (room.state as unknown as { round?: unknown } | undefined)?.round
    if (!isObj(r)) return
    if (!(ROUND_PHASES as readonly string[]).includes(r.phase as string)) return
    const winner = r.winner === 'ghost' || r.winner === 'warden' ? r.winner : ''
    const winReason = (ROUND_WIN_REASONS as readonly string[]).includes(r.winReason as string)
      ? (r.winReason as RoundView['winReason'])
      : ''
    onRound({
      phase: r.phase as RoundView['phase'],
      roundNumber: finiteOr(r.roundNumber, 0),
      secondsLeft: finiteOr(r.secondsLeft, 0),
      winner,
      winReason,
    })
  }
  room.onStateChange(read)
  read()
}
