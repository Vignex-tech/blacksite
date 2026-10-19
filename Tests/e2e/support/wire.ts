// SDK clients that keep every raw frame they receive (#47), so a spec can
// check what the server SENT a client, not only what the client decoded.
//
// `WireClient` is a @colyseus/sdk Client whose rooms tap `connection.events.
// onmessage` before anything is connected, so even the first frames (join
// handshake, full state) are kept. `framesOf(room)` returns them.

import { Client } from '@colyseus/sdk'
import { ROOM_NAME } from '../../../shared/protocol.js'
import { endpoint, sizeIs, waitForState, waitMustSee, type GameRoom } from './sdk.js'
import type { Frame } from './scan.js'

const frames = new WeakMap<object, Frame[]>()

/** Every frame `room` received so far, oldest first (empty for a room not made by a WireClient). */
export function framesOf(room: GameRoom): Frame[] {
  return frames.get(room) ?? []
}

export class WireClient extends Client {
  // createRoom is protected in the SDK's typings; it is the one place a Room exists before it connects.
  protected createRoom(name: string, rootSchema?: unknown): any {
    const room = (super.createRoom as any).call(this, name, rootSchema)
    const kept: Frame[] = []
    frames.set(room, kept)
    // The Room builds its Connection inside connect() and the socket opens
    // asynchronously, so wrapping the handler right after connect() returns
    // is early enough to keep the join handshake and the first full state.
    const connect = room.connect
    room.connect = function (...args: unknown[]) {
      const out = connect.apply(this, args)
      const original = this.connection.events.onmessage
      this.connection.events.onmessage = (ev: { data: ArrayBuffer | Uint8Array | string }) => {
        if (typeof ev.data !== 'string') kept.push({ t: Date.now(), bytes: new Uint8Array(ev.data as ArrayBuffer).slice() })
        return original?.(ev)
      }
      return out
    }
    return room
  }
}

/**
 * Like `joinInOrder` in sdk.ts, but every client is a WireClient (its frames
 * are kept). Joins `n` clients to a fresh room in order; each is pushed into
 * `open` and waits for what it must see before the next joins.
 */
export async function joinWire(n: number, open: GameRoom[], options: (i: number) => object = () => ({})): Promise<GameRoom[]> {
  const first = (await new WireClient(endpoint).create(ROOM_NAME, options(0))) as GameRoom
  const rooms: GameRoom[] = [first]
  open.push(first)
  await waitForState(first, 'joiner 1 sees itself', sizeIs(1))
  for (let i = 1; i < n; i++) {
    const r = (await new WireClient(endpoint).joinById(first.roomId, options(i))) as GameRoom
    rooms.push(r)
    open.push(r)
    await waitMustSee(rooms)
  }
  return rooms
}
