// A Ghost observer for the browser specs (#45).
//
// Two tabs join a fresh room as a Ghost (tab A) and a Warden (tab B). Since
// the M5 visibility filter (#46) the Warden tab is not sent the Ghost unless it
// is near or in line of sight, so a spec that needs "a second client sees the
// Ghost move" can no longer use tab B. The observer is a Node @colyseus/sdk
// client that joins the tabs' room after both tabs are in. It is the third
// joiner of a 1v1, so it is a Ghost, and a Ghost client is sent every player.
//
// Use it like another tab: `observer.at(id)` reads a player as it received it,
// `observer.waitFor(...)` waits on state, `observer.record()` samples every
// state change in the same shape as support/tabs.ts startSampler (so
// support/legs.ts analyse / expectNoOverlap / expectGroundRoute work on it).
// It adds one player to the room: pass `{ ghosts: 2, wardens: 1 }` to `joined`.
// Always `await observer.leave()` before the tabs close (closing a tab does not
// remove it), and assert after it has left (handoff: assert once, after the SDK
// clients leave).

import { Client } from '@colyseus/sdk'
import { ROOM_NAME } from '../../../shared/protocol.js'
import { endpoint, leaveQuietly, pos, teamOf, waitForState, type GameRoom, type SyncedPlayer } from './sdk.js'
import type { Sample } from './tabs.js'

export class Observer {
  private constructor(readonly room: GameRoom) {}

  /** Joins the room the tabs are in (`joinOrCreate`) and checks it landed as a Ghost. */
  static async join(): Promise<Observer> {
    const room = (await new Client(endpoint).joinOrCreate(ROOM_NAME)) as GameRoom
    const o = new Observer(room)
    await waitForState(room, 'the observer sees itself', (s) => !!s.players?.has(room.sessionId))
    if (teamOf(room) !== 'ghost') {
      await leaveQuietly(room)
      throw new Error('the observer joined as a Warden: it must be the third joiner of a 1v1 room (a Ghost)')
    }
    return o
  }

  get id(): string {
    return this.room.sessionId
  }

  /** Player `id` as the observer received it, or undefined if it isn't in its state. */
  at(id: string): SyncedPlayer | undefined {
    return this.room.state.players.has(id) ? pos(this.room, id) : undefined
  }

  /** Resolves once `predicate` holds on the observer's state (5 s limit, a failure never a delay). */
  waitFor(what: string, predicate: () => boolean): Promise<void> {
    return waitForState(this.room, `the observer: ${what}`, predicate)
  }

  /** Waits until the observer holds `n` players. */
  waitForPlayers(n: number): Promise<void> {
    return this.waitFor(`holds ${n} players`, () => this.room.state.players.size === n)
  }

  /**
   * Starts recording every state change as a Sample (time from Date.now()).
   * Returns a function that stops and returns the samples.
   */
  record(): () => Sample[] {
    const samples: Sample[] = []
    const take = () => {
      const players: Sample['players'] = []
      this.room.state.players.forEach((p, id: string) => {
        const q = p as unknown as { x: number; z: number; yaw: number; y?: unknown; mode?: unknown }
        players.push({ id, x: q.x, z: q.z, yaw: q.yaw, ...(q.y !== undefined ? { y: q.y } : {}), ...(q.mode !== undefined ? { mode: q.mode } : {}) })
      })
      samples.push({ t: Date.now(), players })
    }
    this.room.onStateChange(take)
    take()
    return () => {
      this.room.onStateChange.remove(take)
      take()
      return samples
    }
  }

  leave(): Promise<void> {
    return leaveQuietly(this.room)
  }
}
