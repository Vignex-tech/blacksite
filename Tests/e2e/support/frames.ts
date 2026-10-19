// Reads the "move" messages a browser tab sends, from the WebSocket frames
// Playwright sees (page.on('websocket') -> 'framesent'). Used to check the
// client's input-to-message mapping end to end (#25): which dx, dz and yaw it
// sends and how often. The mapping lives inside client/src/main.ts's tick and
// can't be imported without a browser, so it is checked on the wire instead.
// Since #36 it also reads the "action" messages (Space, E, C), to count one
// action per key press.
//
// Wire format (Colyseus 0.18 SDK): one byte ROOM_DATA (13), the message type
// as a msgpack string, then the payload packed by msgpackr with records:
// `d4 72 <slot>` defines a record (an array of keys, then the values), and a
// single byte 0x40..0x7f reuses a slot defined earlier in the same frame.
// This is a small independent decoder for exactly what a move needs (maps,
// records, strings, numbers, booleans, nil); it throws on anything else, so a
// change of wire format fails loudly instead of being misread.

import type { Page } from '@playwright/test'
import { ACTION_MESSAGE, MOVE_MESSAGE } from '../../../shared/protocol.js'

/** Colyseus protocol code for a room message sent with room.send(type, payload). */
export const ROOM_DATA = 13

export class MsgpackReader {
  private i = 0
  private readonly records = new Map<number, string[]>()
  private readonly view: DataView

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  get done(): boolean {
    return this.i >= this.buf.length
  }

  private byte(): number {
    if (this.i >= this.buf.length) throw new Error('msgpack: unexpected end of frame')
    return this.buf[this.i++]
  }

  private str(n: number): string {
    if (this.i + n > this.buf.length) throw new Error('msgpack: string runs past the frame')
    const s = new TextDecoder().decode(this.buf.subarray(this.i, this.i + n))
    this.i += n
    return s
  }

  private num(kind: 'f32' | 'f64' | 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32'): number {
    const at = this.i
    const size = { f32: 4, f64: 8, u8: 1, u16: 2, u32: 4, i8: 1, i16: 2, i32: 4 }[kind]
    if (at + size > this.buf.length) throw new Error('msgpack: number runs past the frame')
    this.i += size
    switch (kind) {
      case 'f32':
        return this.view.getFloat32(at)
      case 'f64':
        return this.view.getFloat64(at)
      case 'u8':
        return this.view.getUint8(at)
      case 'u16':
        return this.view.getUint16(at)
      case 'u32':
        return this.view.getUint32(at)
      case 'i8':
        return this.view.getInt8(at)
      case 'i16':
        return this.view.getInt16(at)
      case 'i32':
        return this.view.getInt32(at)
    }
  }

  private map(n: number): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (let k = 0; k < n; k++) {
      const key = this.value()
      if (typeof key !== 'string') throw new Error(`msgpack: non-string map key ${String(key)}`)
      out[key] = this.value()
    }
    return out
  }

  private array(n: number): unknown[] {
    const out: unknown[] = []
    for (let k = 0; k < n; k++) out.push(this.value())
    return out
  }

  private record(keys: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of keys) out[key] = this.value()
    return out
  }

  value(): unknown {
    const b = this.byte()
    if (b <= 0x3f) return b // positive fixint (0x40..0x7f are record slots, see below)
    if (b <= 0x7f) {
      const keys = this.records.get(b)
      if (!keys) throw new Error(`msgpack: record slot 0x${b.toString(16)} used before it was defined`)
      return this.record(keys)
    }
    if (b <= 0x8f) return this.map(b & 0x0f)
    if (b <= 0x9f) return this.array(b & 0x0f)
    if (b <= 0xbf) return this.str(b & 0x1f)
    if (b >= 0xe0) return b - 0x100 // negative fixint
    switch (b) {
      case 0xc0:
        return null
      case 0xc2:
        return false
      case 0xc3:
        return true
      case 0xca:
        return this.num('f32')
      case 0xcb:
        return this.num('f64')
      case 0xcc:
        return this.num('u8')
      case 0xcd:
        return this.num('u16')
      case 0xce:
        return this.num('u32')
      case 0xd0:
        return this.num('i8')
      case 0xd1:
        return this.num('i16')
      case 0xd2:
        return this.num('i32')
      case 0xd9:
        return this.str(this.num('u8'))
      case 0xda:
        return this.str(this.num('u16'))
      case 0xd4: {
        // fixext 1: msgpackr's record definition is type 0x72 ('r') + slot.
        const type = this.byte()
        const slot = this.byte()
        if (type !== 0x72 || slot < 0x40 || slot > 0x7f) {
          throw new Error(`msgpack: unsupported fixext1 type 0x${type.toString(16)} slot 0x${slot.toString(16)}`)
        }
        const keys = this.value()
        if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) {
          throw new Error('msgpack: record definition is not an array of keys')
        }
        this.records.set(slot, keys)
        return this.record(keys)
      }
      default:
        throw new Error(`msgpack: unsupported type byte 0x${b.toString(16)}`)
    }
  }
}

/** A decoded room message: its type and payload. */
export interface RoomMessage {
  type: unknown
  payload: unknown
}

/** Decodes one sent frame; null if it isn't a ROOM_DATA message (e.g. the join handshake). */
export function decodeRoomMessage(frame: Uint8Array): RoomMessage | null {
  if (frame.length === 0 || frame[0] !== ROOM_DATA) return null
  const r = new MsgpackReader(frame.subarray(1))
  const type = r.value()
  const payload = r.done ? undefined : r.value()
  if (!r.done) throw new Error('msgpack: bytes left over after the payload')
  return { type, payload }
}

/** One move message as sent by a tab, with the page-independent Node time it was seen. */
export interface SentMove {
  t: number
  dx: unknown
  dz: unknown
  yaw?: unknown
  /** Every key of the payload, to catch extra fields. */
  keys: string[]
}

/** One action message as sent by a tab (#36), with the Node time it was seen. */
export interface SentAction {
  t: number
  action: unknown
  /** Every key of the payload, to catch extra fields (an action has only `action`). */
  keys: string[]
}

/**
 * Records every "move" and "action" message the page sends, from now on.
 * Call before page.goto so the room's socket is captured. Frames that aren't
 * room messages, or are other room messages, are ignored; a room message
 * that can't be decoded is kept in `errors`, so tests can fail on it.
 */
export function captureMoves(page: Page): {
  moves: SentMove[]
  actions: SentAction[]
  errors: string[]
  since(t: number): SentMove[]
} {
  const moves: SentMove[] = []
  const actions: SentAction[] = []
  const errors: string[] = []
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      const t = Date.now()
      const bytes = typeof f.payload === 'string' ? new TextEncoder().encode(f.payload) : new Uint8Array(f.payload)
      try {
        const m = decodeRoomMessage(bytes)
        if (!m || (m.type !== MOVE_MESSAGE && m.type !== ACTION_MESSAGE)) return
        const p = m.payload as Record<string, unknown>
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`${String(m.type)} payload is ${JSON.stringify(p)}`)
        if (m.type === ACTION_MESSAGE) actions.push({ t, action: p.action, keys: Object.keys(p).sort() })
        else moves.push({ t, dx: p.dx, dz: p.dz, yaw: p.yaw, keys: Object.keys(p).sort() })
      } catch (err) {
        errors.push(`${(err as Error).message} in frame ${Buffer.from(bytes).toString('hex')}`)
      }
    })
  })
  return { moves, actions, errors, since: (t) => moves.filter((m) => m.t >= t) }
}
