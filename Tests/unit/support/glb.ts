// Dependency-free glb inspector (#80): reads only the JSON chunk. Used by the
// manifest validator and by tests that build a glb in memory.

export interface GlbInfo {
  /** Triangles over all mesh primitives (indexed or not), triangle modes only. */
  triangles: number
  meshes: number
  animations: string[]
  extensionsUsed: string[]
  extensionsRequired: string[]
  /** Every buffer or image uri that is not a data: uri (external fetches). */
  externalUris: string[]
  json: Record<string, any>
}

export function parseGlb(bytes: Uint8Array): GlbInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb (bad magic)')
  if (dv.getUint32(4, true) !== 2) throw new Error('glb version is not 2')
  const jsonLen = dv.getUint32(12, true)
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('first glb chunk is not JSON')
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as Record<string, any>
  const accessors: { count: number }[] = json.accessors ?? []
  let triangles = 0
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const mode = prim.mode ?? 4
      const count = prim.indices !== undefined ? accessors[prim.indices].count : accessors[prim.attributes.POSITION].count
      if (mode === 4) triangles += count / 3
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2)
    }
  }
  const uris: string[] = []
  for (const e of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (typeof e.uri === 'string' && !e.uri.startsWith('data:')) uris.push(e.uri)
  }
  return {
    triangles,
    meshes: (json.meshes ?? []).length,
    animations: (json.animations ?? []).map((a: any, i: number) => a.name ?? `animation_${i}`),
    extensionsUsed: json.extensionsUsed ?? [],
    extensionsRequired: json.extensionsRequired ?? [],
    externalUris: uris,
    json,
  }
}

/** Builds a minimal valid glb with `triangleCount` indexed triangles in one mesh, for tests. */
export function buildGlb(triangleCount: number, extra: Record<string, unknown> = {}): Uint8Array {
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 0 }],
    accessors: [
      { count: triangleCount * 3, componentType: 5123, type: 'SCALAR' },
      { count: Math.max(3, triangleCount * 3), componentType: 5126, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0 }] }],
    ...extra,
  }
  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const body = new TextEncoder().encode(text)
  const out = new Uint8Array(20 + body.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, out.length, true)
  dv.setUint32(12, body.length, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(body, 20)
  return out
}
