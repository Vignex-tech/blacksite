// Helpers for the timed round (M7, #64, #67). Nothing here imports server code.
//
// ROUND PRESETS. The server reads BLACKSITE_ROUND_PRESET ONCE, from its own
// process environment at startup (#68). No client message, room option or join
// option can set it (rule 1). Until #68 lands the server ignores it.
//   (unset)  production: DEFAULT_ROUND_SETTINGS (countdown 10 s, live 420 s,
//            ended 10 s, minimum 1 per team).
//   open     the room is `live` from creation; no timer; nothing ends or
//            resets. Today's behaviour, so every old spec is unchanged. The
//            main test server (port 2567) runs with it.
//   fast     countdown 2000 ms, live 30000 ms, ended 3000 ms, minimum 1 per
//            team. A second test server (port 2568, E2E_ROUND_PORT) runs with
//            it and serves only *.rounds.spec.ts (SDK clients) and
//            *.rounds.tabs.spec.ts (browser tabs), in the `rounds` project.
//
// Round state is read defensively: before #68 `state.round` is undefined, so
// `roundOf` returns undefined and nothing here throws on it.

import type { Room } from '@colyseus/sdk'
import { ROUND_EVENT, type RoundEvent, type RoundPhase, type RoundState } from '../../../shared/protocol.js'

/** Port of the second test server (the `fast` preset). */
export const roundPort = Number(process.env.E2E_ROUND_PORT ?? 2568)
/** SDK endpoint of the `fast` server, for `new Client(roundEndpoint)`. */
export const roundEndpoint = `ws://localhost:${roundPort}`

/** The `fast` preset, as the server implements it (#68). Milliseconds. */
export const ROUND_FAST = Object.freeze({ countdownMs: 2000, liveMs: 30000, endedMs: 3000, minPlayersPerTeam: 1 })
/** Preset names the server accepts; anything else makes it refuse to start. */
export const ROUND_PRESETS = Object.freeze(['open', 'fast'] as const)

/** `room.state.round` as received, or undefined before the server sends it. */
export function roundOf(room: Pick<Room, 'state'>): RoundState | undefined {
  const r = (room.state as { round?: RoundState } | undefined)?.round
  return r && typeof r === 'object' ? r : undefined
}

/** Phase changes received by a room (the `round` message). Unknown events are ignored. */
export interface RoundEvents {
  events: RoundEvent[]
  /** Phases received so far, in order. */
  phases(): RoundPhase[]
  /** Stop listening. */
  stop(): void
}

type Listening = { onMessage: (type: string, cb: (m: RoundEvent) => void) => unknown }

/** Start recording the `round` events `room` receives. Call before the phase changes you want to see. */
export function collectRoundEvents(room: Listening): RoundEvents {
  const events: RoundEvent[] = []
  let on = true
  const off = room.onMessage(ROUND_EVENT, (m) => {
    if (on && m && typeof m === 'object') events.push({ ...m })
  })
  return {
    events,
    phases: () => events.map((e) => e.phase),
    stop() {
      on = false
      if (typeof off === 'function') off()
    },
  }
}

/**
 * Resolve with the round state once its phase is `phase`; reject after
 * `timeoutMs` saying what was seen. Polls state, so it also works when the
 * phase was reached before the call.
 */
export async function waitForPhase(room: Pick<Room, 'state'>, phase: RoundPhase, timeoutMs: number): Promise<RoundState> {
  const start = Date.now()
  for (;;) {
    const r = roundOf(room)
    if (r?.phase === phase) return r
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`round phase ${phase} not reached in ${timeoutMs} ms (saw ${r ? r.phase : 'no round state'})`)
    }
    await new Promise((res) => setTimeout(res, 25))
  }
}
