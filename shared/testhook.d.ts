// Types of the client test hook `window.__blacksite` (types only; there is no
// testhook.js). The client implements it in client/src/testHook.ts. Tests type
// it with `import type { BlacksiteSnapshot } from '<path>/shared/testhook.js'`.
//
// Rules:
// - Read-only: snapshot() returns a fresh plain-data copy on every call.
//   Changing it never changes game state or the next snapshot.
// - It reports only what the client already received from the server
//   (rule 2: once state is filtered per team, the hook shows no more than the
//   client was sent). It never adds a server message or synced state.
// - It ships in the production build, because Playwright tests client/dist.

/** One player as the client currently knows it from room state. */
export interface BlacksitePlayerSnapshot {
  /** The player's sessionId (key in `state.players`). */
  id: string
  /** Position as received from room state (float32 on the wire, not rounded). */
  x: number
  z: number
  /** True only for this client's own player (id === sessionId). */
  isLocal: boolean
}

export interface BlacksiteSnapshot {
  /** Shape version. Bumped when a field changes meaning or is removed. */
  version: 1
  /** True while this client is in the room (joined and not yet left). */
  connected: boolean
  /** This client's sessionId while connected, otherwise null. */
  sessionId: string | null
  /** Every player in room state, sorted by id. Empty when not connected. */
  players: BlacksitePlayerSnapshot[]
  /** Rendered map. `{ id: null, renderedSolids: 0 }` until the map is rendered (#14). */
  map: { id: string | null; renderedSolids: number }
}

export interface BlacksiteTestHook {
  /** Returns a fresh copy of the client's current view of the game. */
  snapshot(): BlacksiteSnapshot
}

declare global {
  interface Window {
    /** Read-only test hook, set by the client at startup. */
    readonly __blacksite: BlacksiteTestHook
  }
}
