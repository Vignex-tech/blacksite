import type { BlacksiteCameraSnapshot, BlacksiteSnapshot, BlacksiteTestHook } from '../../shared/testhook.js'
import { ACTIVE_TERMINAL_ID } from '../../shared/map.js'
import type { MovementMode, Team, TerminalStatus } from '../../shared/protocol.js'
import type { RoundView } from './roundView.ts'
import type { PlayerPose, PlayerView } from './net.ts'
import { defaultVitals } from './vitals.ts'

/**
 * Read-only test hook on `window.__blacksite` (types in shared/testhook.d.ts).
 *
 * This is intentionally part of the PRODUCTION build: Playwright runs against
 * client/dist served by the production server, so the hook must not be
 * stripped by a dev-only flag.
 *
 * It only mirrors data the client already received from the server (room
 * state as delivered to this client), so it can never reveal more than the
 * client was sent. It holds no references to Babylon or Colyseus objects, and
 * snapshot() builds a new plain object on each call, so nothing a caller does
 * with the result can change game state.
 */
export interface TestHookRecorder {
  /** Tees player updates into the hook before passing them to `view`. */
  wrapView(view: PlayerView): PlayerView
  setConnected(sessionId: string): void
  setDisconnected(): void
  /**
   * Records the rendered map: its id, the number of solid meshes created and,
   * since M4, the number of floor, ramp and anchor meshes (0 when omitted).
   */
  setMap(id: string, renderedSolids: number, traversal?: TraversalCounts): void
  /** Where snapshot() reads the camera from; until set, `camera` is absent. */
  setCamera(source: () => BlacksiteCameraSnapshot): void
  /** Counts a received combat event (M5, #50). */
  recordEvent(kind: 'shot' | 'hit' | 'kill' | 'damaged'): void
  /** Records a terminal as received from room state (M6, #60). */
  setTerminal(id: string, status: TerminalStatus, alert: boolean): void
  /** Records the Ghost-only hack progress as received (M6, #60). */
  setHackProgress(progress: number): void
  /** Records the round as received from room state (M7, #72); null clears it. */
  setRound(round: RoundView | null): void
}

interface TraversalCounts {
  renderedFloors: number
  renderedRamps: number
  renderedAnchors: number
}

interface PlayerRecord {
  x: number
  y: number
  z: number
  isLocal: boolean
  team: Team | null
  yaw: number
  mode: MovementMode
  health: number
  ammo: number
  reloading: boolean
}

function vitalsOf(pose: PlayerPose | undefined): { health: number; ammo: number; reloading: boolean } {
  const d = defaultVitals(pose?.team ?? null)
  return { health: pose?.health ?? d.health, ammo: pose?.ammo ?? d.ammo, reloading: pose?.reloading ?? d.reloading }
}

export function installTestHook(target: Window = window): TestHookRecorder {
  const players = new Map<string, PlayerRecord>()
  let connected = false
  let sessionId: string | null = null
  let mapId: string | null = null
  let renderedSolids = 0
  let traversal: TraversalCounts = { renderedFloors: 0, renderedRamps: 0, renderedAnchors: 0 }
  const events = { shots: 0, hits: 0, kills: 0, damaged: 0 }
  const terminals = new Map<string, { status: TerminalStatus; alert: boolean }>()
  let hackProgress: number | null = null
  let round: RoundView | null = null
  let cameraSource: (() => BlacksiteCameraSnapshot) | null = null

  const hook: BlacksiteTestHook = Object.freeze({
    snapshot(): BlacksiteSnapshot {
      const snap: BlacksiteSnapshot = {
        version: 1,
        connected,
        sessionId,
        players: [...players.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, p]) => ({
            id,
            x: p.x,
            z: p.z,
            isLocal: p.isLocal,
            team: p.team,
            yaw: p.yaw,
            y: p.y,
            mode: p.mode,
            health: p.health,
            ammo: p.ammo,
            reloading: p.reloading,
          })),
        localTeam: [...players.values()].find((p) => p.isLocal)?.team ?? null,
        map: {
          id: mapId,
          renderedSolids,
          renderedFloors: traversal.renderedFloors,
          renderedRamps: traversal.renderedRamps,
          renderedAnchors: traversal.renderedAnchors,
        },
        events: { ...events },
        terminals: [...terminals.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, t]) => ({ id, status: t.status, alert: t.alert, active: id === ACTIVE_TERMINAL_ID })),
        hack: hackProgress === null ? null : { progress: hackProgress },
      }
      if (round) snap.round = { ...round }
      if (cameraSource) {
        const { mode, yaw } = cameraSource()
        snap.camera = { mode, yaw }
      }
      return snap
    },
  })

  // Non-writable and non-configurable, so page scripts can't swap the hook.
  Object.defineProperty(target, '__blacksite', {
    value: hook,
    writable: false,
    configurable: false,
    enumerable: false,
  })

  return {
    wrapView: (view) => ({
      upsertPlayer(id, x, z, isLocal = false, pose) {
        players.set(id, {
          x,
          y: pose?.y ?? 0,
          z,
          isLocal,
          team: pose?.team ?? null,
          yaw: pose?.yaw ?? 0,
          mode: pose?.mode ?? 'ground',
          ...vitalsOf(pose),
        })
        // Forward exactly the arguments received (no trailing undefined).
        if (pose) view.upsertPlayer(id, x, z, isLocal, pose)
        else view.upsertPlayer(id, x, z, isLocal)
      },
      removePlayer(id) {
        players.delete(id)
        view.removePlayer(id)
      },
    }),
    setConnected(id) {
      connected = true
      sessionId = id
    },
    setDisconnected() {
      connected = false
      sessionId = null
      players.clear()
      terminals.clear()
      hackProgress = null
      round = null
    },
    setMap(id, count, counts) {
      mapId = id
      renderedSolids = count
      traversal = {
        renderedFloors: counts?.renderedFloors ?? 0,
        renderedRamps: counts?.renderedRamps ?? 0,
        renderedAnchors: counts?.renderedAnchors ?? 0,
      }
    },
    recordEvent(kind) {
      if (kind === 'shot') events.shots++
      else if (kind === 'hit') events.hits++
      else if (kind === 'kill') events.kills++
      else events.damaged++
    },
    setTerminal(id, status, alert) {
      terminals.set(id, { status, alert })
    },
    setHackProgress(progress) {
      hackProgress = progress
    },
    setRound(r) {
      round = r ? { ...r } : null
    },
    setCamera(source) {
      cameraSource = source
    },
  }
}
