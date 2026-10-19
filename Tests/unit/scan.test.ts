import { describe, expect, it } from 'vitest'
import { includesBytes, numberForms, scanFrames, searchable } from '../e2e/support/scan'

const f32le = (v: number) => {
  const d = new DataView(new ArrayBuffer(4))
  d.setFloat32(0, v, true)
  return [...new Uint8Array(d.buffer)]
}

describe('frame scanner (#47)', () => {
  it('finds a byte pattern anywhere, and not when absent', () => {
    expect(includesBytes(Uint8Array.of(1, 2, 3, 4), Uint8Array.of(3, 4))).toBe(true)
    expect(includesBytes(Uint8Array.of(1, 2, 3, 4), Uint8Array.of(4, 5))).toBe(false)
    expect(includesBytes(Uint8Array.of(1), Uint8Array.of())).toBe(false)
  })

  it('finds a session id and a coordinate in each of the four forms', () => {
    const id = 'AbCd1234x'
    const idBytes = [...new TextEncoder().encode(id)]
    const frames = [{ t: 10, bytes: Uint8Array.of(9, ...idBytes, 7) }, ...numberForms(6.13).map((f, i) => ({ t: 20 + i, bytes: Uint8Array.of(1, ...f.bytes, 2) }))]
    expect(scanFrames(frames, { ids: [id] }).map((h) => h.t)).toEqual([10])
    expect(scanFrames(frames, { values: [6.13] })).toHaveLength(4)
    expect(scanFrames(frames, { values: [6.13], from: 22 })).toHaveLength(2)
    expect(scanFrames(frames, { values: [6.14], ids: ['nobody'] })).toEqual([])
  })

  it('drops numbers that would match unrelated bytes', () => {
    expect(searchable(0)).toBe(false)
    expect(searchable(-14)).toBe(false)
    expect(searchable(1.5)).toBe(false)
    expect(searchable(-14.21)).toBe(true)
    const frames = [{ t: 1, bytes: Uint8Array.of(...f32le(-14), 0) }]
    expect(scanFrames(frames, { values: [-14, 0] })).toEqual([])
  })
})
