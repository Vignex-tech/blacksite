// Byte-level search of raw WebSocket frames for a player's session id and
// coordinates (#47). The M5 visibility filter (#46) must keep a hidden Ghost
// out of what a Warden client RECEIVES, not only out of its decoded state, so
// the check works on the raw bytes and does not depend on any decoder.
//
// Where a number can hide in a frame:
//  - schema patches: float32, little endian
//  - room messages (msgpack): float32 or float64, big endian
// so every value is searched in all four forms. A string (session id) is
// searched as UTF-8. Values with too many zero bytes (0, 1.5, -14) would match
// unrelated bytes, so `searchable` drops them: pick test coordinates that are
// not round numbers.

/** A raw frame as received, with the Node time it arrived. */
export interface Frame {
  t: number
  bytes: Uint8Array
}

/** What was found in a frame. */
export interface Hit {
  t: number
  what: string
}

/** True if `hay` contains `needle` at any offset. */
export function includesBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

const zeros = (b: Uint8Array) => b.reduce((n, v) => n + (v === 0 ? 1 : 0), 0)

/** The four byte forms of `v`: float32 LE and BE, float64 LE and BE. */
export function numberForms(v: number): { label: string; bytes: Uint8Array }[] {
  const f32 = new DataView(new ArrayBuffer(4))
  const f64 = new DataView(new ArrayBuffer(8))
  const out: { label: string; bytes: Uint8Array }[] = []
  for (const little of [true, false]) {
    f32.setFloat32(0, v, little)
    f64.setFloat64(0, v, little)
    out.push({ label: `${v} as float32 ${little ? 'LE' : 'BE'}`, bytes: new Uint8Array(f32.buffer.slice(0)) })
    out.push({ label: `${v} as float64 ${little ? 'LE' : 'BE'}`, bytes: new Uint8Array(f64.buffer.slice(0)) })
  }
  return out
}

/** True if `v` is distinctive enough to search for: its float32 form has at most one zero byte. */
export function searchable(v: number): boolean {
  if (!Number.isFinite(v) || v === 0) return false
  const f = new DataView(new ArrayBuffer(4))
  f.setFloat32(0, v)
  return zeros(new Uint8Array(f.buffer)) <= 1
}

export interface ScanQuery {
  /** Session ids searched as UTF-8. */
  ids?: string[]
  /** Numbers searched in all four forms (non-distinctive ones are skipped). */
  values?: number[]
  /** Only frames with from <= t <= to are scanned. */
  from?: number
  to?: number
}

/** Every id and value of `query` found in `frames`. */
export function scanFrames(frames: Frame[], query: ScanQuery): Hit[] {
  const enc = new TextEncoder()
  const ids = (query.ids ?? []).map((id) => ({ id, bytes: enc.encode(id) }))
  const forms = [...new Set((query.values ?? []).filter(searchable))].flatMap(numberForms)
  const hits: Hit[] = []
  for (const f of frames) {
    if (query.from !== undefined && f.t < query.from) continue
    if (query.to !== undefined && f.t > query.to) continue
    for (const i of ids) if (includesBytes(f.bytes, i.bytes)) hits.push({ t: f.t, what: `session id ${i.id}` })
    for (const n of forms) if (includesBytes(f.bytes, n.bytes)) hits.push({ t: f.t, what: n.label })
  }
  return hits
}
