import { describe, expect, it } from 'vitest'
import { decodeRoomMessage, MsgpackReader } from '../e2e/support/frames.ts'

// #25: the e2e specs read the moves a tab sends by decoding its WebSocket
// frames (e2e/support/frames.ts). These are real frames captured from the
// client (Colyseus 0.18 SDK, msgpackr records), so a change of wire format
// fails here first, with a clear message, rather than as odd e2e results.

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))

describe('move frame decoder', () => {
  it('decodes a yaw-only move { dx: 0, dz: 0, yaw: 0.025 } as the client sends it', () => {
    const m = decodeRoomMessage(hex('0da46d6f7665d4724093a26478a2647aa37961770000cb3f99999999999a00'))
    expect(m).toEqual({ type: 'move', payload: { dx: 0, dz: 0, yaw: 0.025000000000000355 } })
  })

  it('decodes a held-W move { dx: 0, dz: 1, yaw: 0.25 }', () => {
    const m = decodeRoomMessage(hex('0da46d6f7665d4724093a26478a2647aa37961770001cb3fd0000000000040'))
    expect(m?.payload).toEqual({ dx: 0, dz: 1, yaw: 0.25000000000000355 })
  })

  it('decodes the interact messages the client will send (M6, #55): { active: true } and { active: false }', () => {
    // 0d, "interact" (fixstr 8), plain fixmap of one key "active", then true / false.
    const head = '0da8696e746572616374' + '81a6616374697665'
    expect(decodeRoomMessage(hex(head + 'c3'))).toEqual({ type: 'interact', payload: { active: true } })
    expect(decodeRoomMessage(hex(head + 'c2'))).toEqual({ type: 'interact', payload: { active: false } })
  })

  it('ignores frames that are not room messages (the join handshake)', () => {
    expect(decodeRoomMessage(hex('0a'))).toBeNull()
    expect(decodeRoomMessage(new Uint8Array())).toBeNull()
  })

  it('decodes plain maps, negative ints and reused record slots', () => {
    // { dx: -1, dz: 1 } as a plain fixmap
    expect(decodeRoomMessage(hex('0da46d6f766582a26478ffa2647a01'))?.payload).toEqual({ dx: -1, dz: 1 })
    // two records in one value: [ {a:1}, {a:2} ] with the slot defined once, then reused
    const r = new MsgpackReader(hex('92d472409' + '1a16101' + '4002'))
    expect(r.value()).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('throws on bytes it does not understand instead of guessing', () => {
    expect(() => decodeRoomMessage(hex('0da46d6f7665c1'))).toThrow(/unsupported/)
    expect(() => decodeRoomMessage(hex('0da46d6f766541'))).toThrow(/before it was defined/)
    expect(() => decodeRoomMessage(hex('0da46d6f7665cb3f'))).toThrow(/past the frame/)
    expect(() => decodeRoomMessage(hex('0da46d6f76650101'))).toThrow(/left over/)
  })
})
