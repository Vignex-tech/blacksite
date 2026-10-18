import type { BlacksiteSnapshot, BlacksiteTestHook } from '../../shared/testhook.js'
import type { PlayerView } from './net.ts'

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
  /** Records the rendered map (id and number of solid meshes created). */
  setMap(id: string, renderedSolids: number): void
}

interface PlayerRecord {
  x: number
  z: number
  isLocal: boolean
}

export function installTestHook(target: Window = window): TestHookRecorder {
  const players = new Map<string, PlayerRecord>()
  let connected = false
  let sessionId: string | null = null
  let mapId: string | null = null
  let renderedSolids = 0

  const hook: BlacksiteTestHook = Object.freeze({
    snapshot(): BlacksiteSnapshot {
      return {
        version: 1,
        connected,
        sessionId,
        players: [...players.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, p]) => ({ id, x: p.x, z: p.z, isLocal: p.isLocal })),
        map: { id: mapId, renderedSolids },
      }
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
      upsertPlayer(id, x, z, isLocal = false) {
        players.set(id, { x, z, isLocal })
        view.upsertPlayer(id, x, z, isLocal)
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
    },
    setMap(id, count) {
      mapId = id
      renderedSolids = count
    },
  }
}
