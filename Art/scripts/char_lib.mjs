// Shared helpers for building the Blacksite characters (Ghost, Warden) from the Quaternius UAL mannequin.
// Pure node + @gltf-transform (installed in Art/), no Blender. Used by build_ghost.mjs and build_warden.mjs.
// Input glb files are untrusted downloads: they are only parsed as data here, nothing in them is executed.
import { NodeIO, Document } from '@gltf-transform/core'
import { weld, simplify, dedup, prune } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import zlib from 'node:zlib'

export const io = new NodeIO()

// ---------------------------------------------------------------- small vector helpers
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a) => Math.hypot(a[0], a[1], a[2])
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

// ---------------------------------------------------------------- source reading
export async function readGlb(path) {
  return io.read(path)
}

/** World bind-pose position of each joint, by name. */
export function jointInfo(doc) {
  const skin = doc.getRoot().listSkins()[0]
  const joints = skin.listJoints()
  const names = joints.map((j) => j.getName())
  const world = {}
  const parent = {}
  for (const j of joints) {
    world[j.getName()] = j.getWorldTranslation()
    const p = j.getParentNode()
    parent[j.getName()] = p ? p.getName() : null
  }
  return { skin, joints, names, world, parent }
}

/** Simplify every primitive of the document (same recipe as the measured numbers in Art/README.md). */
export async function simplifyDoc(doc, ratio, error) {
  await MeshoptSimplifier.ready
  await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error }))
}

// ---------------------------------------------------------------- geometry model
/** Geometry as plain JS: v = vertices {p,n,j:[4],w:[4],tag}, t = triangles {a,b,c,reg}. */
export function extractGeometry(doc) {
  const geo = { v: [], t: [] }
  let tag = 0
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION')
      const N = prim.getAttribute('NORMAL')
      const J = prim.getAttribute('JOINTS_0')
      const W = prim.getAttribute('WEIGHTS_0')
      const I = prim.getIndices()
      const map = new Map()
      const get = (i) => {
        if (map.has(i)) return map.get(i)
        const o = { p: P.getElement(i, [0, 0, 0]), n: N.getElement(i, [0, 0, 0]), j: J.getElement(i, [0, 0, 0, 0]), w: W.getElement(i, [0, 0, 0, 0]), tag }
        geo.v.push(o)
        map.set(i, o)
        return o
      }
      for (let k = 0; k < I.getCount(); k += 3) {
        const a = get(I.getScalar(k)), b = get(I.getScalar(k + 1)), c = get(I.getScalar(k + 2))
        if (a === b || b === c || a === c) continue
        geo.t.push({ a, b, c, reg: null })
      }
      tag++
    }
  }
  return geo
}

/** Replaces each vertex's joints by the nearest kept ancestor (finger joints merge into the hand). */
export function remapJoints(geo, names, parent, keep) {
  const resolve = {}
  for (const n of names) {
    let c = n
    while (c && !keep.has(c)) c = parent[c]
    if (!c) throw new Error('no kept ancestor for ' + n)
    resolve[n] = c
  }
  const keptOrder = names.filter((n) => keep.has(n))
  const newIndex = Object.fromEntries(keptOrder.map((n, i) => [n, i]))
  for (const v of geo.v) {
    const acc = new Map()
    for (let k = 0; k < 4; k++) {
      if (v.w[k] <= 0) continue
      const ni = newIndex[resolve[names[v.j[k]]]]
      acc.set(ni, (acc.get(ni) || 0) + v.w[k])
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    const sum = top.reduce((s, e) => s + e[1], 0) || 1
    v.j = [0, 0, 0, 0]
    v.w = [0, 0, 0, 0]
    top.forEach(([ji, w], k) => { v.j[k] = ji; v.w[k] = w / sum })
  }
  return { keptOrder, newIndex }
}

export function dominantJoint(tri, keptOrder) {
  const acc = {}
  for (const v of [tri.a, tri.b, tri.c]) for (let k = 0; k < 4; k++) if (v.w[k] > 0) acc[v.j[k]] = (acc[v.j[k]] || 0) + v.w[k]
  let best = -1, bw = -1
  for (const [j, w] of Object.entries(acc)) if (w > bw) { bw = w; best = Number(j) }
  return keptOrder[best]
}

export const centroid = (tri) => [
  (tri.a.p[0] + tri.b.p[0] + tri.c.p[0]) / 3,
  (tri.a.p[1] + tri.b.p[1] + tri.c.p[1]) / 3,
  (tri.a.p[2] + tri.b.p[2] + tri.c.p[2]) / 3,
]

/** Ray against a list of triangles; returns the largest hit distance t (or null). */
export function rayHit(tris, o, d, which = 'max') {
  let best = null
  for (const t of tris) {
    const e1 = sub(t.b.p, t.a.p), e2 = sub(t.c.p, t.a.p)
    const h = cross(d, e2)
    const a = dot(e1, h)
    if (Math.abs(a) < 1e-12) continue
    const f = 1 / a
    const s = sub(o, t.a.p)
    const u = f * dot(s, h)
    if (u < 0 || u > 1) continue
    const q = cross(s, e1)
    const v = f * dot(d, q)
    if (v < 0 || u + v > 1) continue
    const tt = f * dot(e2, q)
    if (tt <= 1e-6) continue
    if (best === null || (which === 'max' ? tt > best : tt < best)) best = tt
  }
  return best
}

// ---------------------------------------------------------------- primitive builders (all rigidly skinned to one joint)
function addVert(geo, p, n, joint) {
  const v = { p, n, j: [joint, 0, 0, 0], w: [1, 0, 0, 0], tag: 9 }
  geo.v.push(v)
  return v
}

/** Orients triangle (a,b,c) so its face normal agrees with the average vertex normal. */
function pushTri(geo, a, b, c, reg) {
  const fn = cross(sub(b.p, a.p), sub(c.p, a.p))
  const avg = add(add(a.n, b.n), c.n)
  if (dot(fn, avg) < 0) geo.t.push({ a, c: b, b: c, reg })
  else geo.t.push({ a, b, c, reg })
}

/** Box with flat normals. size = full extents. rot = optional rotation about Y (radians). */
export function addBox(geo, { center, size, joint, reg, rotY = 0 }) {
  const [sx, sy, sz] = size.map((x) => x / 2)
  const cs = Math.cos(rotY), sn = Math.sin(rotY)
  const R = (p) => [p[0] * cs + p[2] * sn, p[1], -p[0] * sn + p[2] * cs]
  const faces = [
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
    [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
  ]
  for (const [nrm, corners] of faces) {
    const n = R(nrm)
    const vs = corners.map((c) => addVert(geo, add(center, R([c[0] * sx, c[1] * sy, c[2] * sz])), n, joint))
    pushTri(geo, vs[0], vs[1], vs[2], reg)
    pushTri(geo, vs[0], vs[2], vs[3], reg)
  }
}

/** Ellipsoid (smooth normals). yMin/yMax clip in unit space (-1..1) to make a dome or a cup. */
export function addEllipsoid(geo, { center, radii, seg = 10, rings = 6, joint, reg, vMin = -1, vMax = 1 }) {
  // rings from angle phi0 (bottom) to phi1 (top); y = sin(phi)
  const phi0 = Math.asin(vMin), phi1 = Math.asin(vMax)
  const grid = []
  for (let r = 0; r <= rings; r++) {
    const phi = phi0 + ((phi1 - phi0) * r) / rings
    const row = []
    for (let s = 0; s < seg; s++) {
      const th = (s / seg) * Math.PI * 2
      const u = [Math.cos(phi) * Math.cos(th), Math.sin(phi), Math.cos(phi) * Math.sin(th)]
      const p = [center[0] + u[0] * radii[0], center[1] + u[1] * radii[1], center[2] + u[2] * radii[2]]
      const n = norm([u[0] / radii[0], u[1] / radii[1], u[2] / radii[2]])
      row.push(addVert(geo, p, n, joint))
    }
    grid.push(row)
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const s2 = (s + 1) % seg
      const a = grid[r][s], b = grid[r][s2], c = grid[r + 1][s2], d = grid[r + 1][s]
      if (r === 0 && phi0 <= -Math.PI / 2 + 1e-6) pushTri(geo, a, c, d, reg)
      else if (r === rings - 1 && phi1 >= Math.PI / 2 - 1e-6) pushTri(geo, a, b, d, reg)
      else { pushTri(geo, a, b, c, reg); pushTri(geo, a, c, d, reg) }
    }
  }
}

/** Triangular-prism-free helper: a strip of quads between consecutive rows of points. rows[i] = [p0, p1, ...] (a polyline across). */
export function addStrip(geo, { rows, normalAt, joint, reg, closeRing = false }) {
  const vr = rows.map((row) => row.map((p) => addVert(geo, p, norm(normalAt(p)), joint)))
  const nr = rows.length - (closeRing ? 0 : 1)
  for (let i = 0; i < nr; i++) {
    const A = vr[i], B = vr[(i + 1) % vr.length]
    for (let k = 0; k < A.length - 1; k++) {
      pushTri(geo, A[k], A[k + 1], B[k + 1], reg)
      pushTri(geo, A[k], B[k + 1], B[k], reg)
    }
  }
}

/** Cone/pyramid with `seg` sides pointing from base centre along dir. */
export function addCone(geo, { base, tip, radius, seg = 5, joint, reg }) {
  const axis = norm(sub(tip, base))
  const up = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = norm(cross(axis, up)), w = cross(axis, u)
  const ring = []
  for (let s = 0; s < seg; s++) {
    const th = (s / seg) * Math.PI * 2
    const o = add(mul(u, Math.cos(th) * radius), mul(w, Math.sin(th) * radius))
    ring.push(addVert(geo, add(base, o), norm(o), joint))
  }
  const t = addVert(geo, tip, axis, joint)
  const c = addVert(geo, base, mul(axis, -1), joint)
  for (let s = 0; s < seg; s++) {
    pushTri(geo, ring[s], ring[(s + 1) % seg], t, reg)
    pushTri(geo, ring[s], ring[(s + 1) % seg], c, reg)
  }
}

/** Hexagon-ish cylinder along an axis. */
export function addCylinder(geo, { base, tip, radius, seg = 8, joint, reg }) {
  const axis = norm(sub(tip, base))
  const up = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = norm(cross(axis, up)), w = cross(axis, u)
  const r0 = [], r1 = []
  for (let s = 0; s < seg; s++) {
    const th = (s / seg) * Math.PI * 2
    const o = add(mul(u, Math.cos(th) * radius), mul(w, Math.sin(th) * radius))
    const n = norm(o)
    r0.push(addVert(geo, add(base, o), n, joint))
    r1.push(addVert(geo, add(tip, o), n, joint))
  }
  const c0 = addVert(geo, base, mul(axis, -1), joint), c1 = addVert(geo, tip, axis, joint)
  const e0 = r0.map((v) => addVert(geo, v.p, mul(axis, -1), joint)), e1 = r1.map((v) => addVert(geo, v.p, axis, joint))
  for (let s = 0; s < seg; s++) {
    const s2 = (s + 1) % seg
    pushTri(geo, r0[s], r0[s2], r1[s2], reg)
    pushTri(geo, r0[s], r1[s2], r1[s], reg)
    pushTri(geo, e0[s], e0[s2], c0, reg)
    pushTri(geo, e1[s], e1[s2], c1, reg)
  }
}

// ---------------------------------------------------------------- palette atlas
/** Minimal RGB PNG encoder (no dependency). */
function encodePng(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** Writes a 512 px palette atlas (8x8 cells of 64 px, one flat colour per region) and returns the png bytes plus cell centres. */
export async function makeAtlas(palette) {
  const names = Object.keys(palette)
  if (names.length > 64) throw new Error('palette too large')
  const W = 512, cell = 64
  const buf = Buffer.alloc(W * W * 3)
  names.forEach((n, i) => {
    const hex = palette[n].replace('#', '')
    const rgb = [0, 2, 4].map((o) => parseInt(hex.slice(o, o + 2), 16))
    const cx = (i % 8) * cell, cy = Math.floor(i / 8) * cell
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) { const o = ((cy + y) * W + cx + x) * 3; buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2] }
  })
  // fill the unused cells with the first colour so no stray black remains
  const png = encodePng(buf, W, W)
  const uv = Object.fromEntries(names.map((n, i) => [n, [((i % 8) + 0.5) / 8, (Math.floor(i / 8) + 0.5) / 8]]))
  return { png, uv }
}

// ---------------------------------------------------------------- writing the final primitive
/** Replaces every mesh primitive of the document with one skinned primitive built from geo. */
export function writeGeometry(doc, geo, { meshName, atlasPng, uvByReg, materialName, keptOrder, ibmByName, skin }) {
  const root = doc.getRoot()
  const buffer = root.listBuffers()[0]
  const meshes = root.listMeshes()
  const mesh = meshes[0]
  for (const m of meshes.slice(1)) m.dispose()
  for (const p of mesh.listPrimitives()) p.dispose()
  mesh.setName(meshName)

  // Split vertices per region so each colour cell is sampled flat.
  const P = [], N = [], U = [], J = [], W = [], I = []
  const ids = new Map()
  const index = (v, reg) => {
    let m = ids.get(v)
    if (!m) { m = new Map(); ids.set(v, m) }
    if (m.has(reg)) return m.get(reg)
    const i = P.length / 3
    P.push(...v.p); N.push(...v.n); U.push(...uvByReg[reg]); J.push(...v.j); W.push(...v.w)
    m.set(reg, i)
    return i
  }
  for (const t of geo.t) {
    if (!uvByReg[t.reg]) throw new Error('triangle without a region: ' + t.reg)
    I.push(index(t.a, t.reg), index(t.b, t.reg), index(t.c, t.reg))
  }
  const vcount = P.length / 3
  const acc = (type, arr, normalized = false) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer).setNormalized(normalized)
  const wq = new Uint8Array(W.length)
  for (let i = 0; i < W.length; i += 4) {
    // quantise weights to normalised bytes that sum to exactly 255
    let s = 0
    for (let k = 0; k < 4; k++) { wq[i + k] = Math.round(W[i + k] * 255); s += wq[i + k] }
    let big = 0
    for (let k = 1; k < 4; k++) if (wq[i + k] > wq[i + big]) big = k
    wq[i + big] += 255 - s
    for (let k = 0; k < 4; k++) if (wq[i + k] === 0) J[i + k] = 0
  }
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array(P)))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array(N)))
    .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(U)))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint8Array(J)))
    .setAttribute('WEIGHTS_0', acc('VEC4', wq, true))
    .setIndices(acc('SCALAR', vcount > 65535 ? new Uint32Array(I) : new Uint16Array(I)))
  const tex = doc.createTexture('tex_' + materialName).setImage(atlasPng).setMimeType('image/png')
  const mat = doc.createMaterial(materialName).setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.85).setMetallicFactor(0).setDoubleSided(false)
  for (const m of root.listMaterials()) if (m !== mat) m.dispose()
  prim.setMaterial(mat)
  mesh.addPrimitive(prim)
  // a skinned mesh node must sit at the scene root (glTF validator: NODE_SKINNED_MESH_NON_ROOT)
  const meshNode = root.listNodes().find((n) => n.getMesh() === mesh)
  const parentNode = meshNode.getParentNode()
  if (parentNode) { parentNode.removeChild(meshNode); root.listScenes()[0].addChild(meshNode) }

  // Skin: only the kept joints, in the order geo.j refers to, with matching inverse bind matrices.
  const joints = skin.listJoints()
  const byName = Object.fromEntries(joints.map((j) => [j.getName(), j]))
  for (const j of joints) skin.removeJoint(j)
  for (const n of keptOrder) skin.addJoint(byName[n])
  const ibm = new Float32Array(keptOrder.length * 16)
  keptOrder.forEach((n, i) => ibm.set(ibmByName[n], i * 16))
  skin.setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer))
  return { vertices: vcount, triangles: I.length / 3, byName }
}

export function ibmFor(doc) {
  const skin = doc.getRoot().listSkins()[0]
  const ibm = skin.getInverseBindMatrices()
  const out = {}
  skin.listJoints().forEach((j, i) => { out[j.getName()] = ibm.getElement(i, new Array(16).fill(0)) })
  return out
}

/** Uniformly scales everything that carries a length: vertices, joint translations, inverse bind matrices, clip translations. */
export function bakeScale(doc, geo, ibmByName, s) {
  for (const v of geo.v) v.p = mul(v.p, s)
  for (const n of Object.keys(ibmByName)) { const m = ibmByName[n]; m[12] *= s; m[13] *= s; m[14] *= s }
  for (const node of doc.getRoot().listNodes()) {
    const t = node.getTranslation()
    node.setTranslation([t[0] * s, t[1] * s, t[2] * s])
  }
  for (const a of doc.getRoot().listAnimations()) {
    for (const c of a.listChannels()) {
      if (c.getTargetPath() !== 'translation') continue
      const out = c.getSampler().getOutput()
      const arr = out.getArray().slice()
      for (let i = 0; i < arr.length; i++) arr[i] *= s
      out.setArray(arr)
    }
  }
}

// ---------------------------------------------------------------- animation
const sameArr = (a, b, eps) => { for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > eps) return false; return true }

/** Reads a clip into {dur, chans: Map(`${node}/${path}` -> {times, values, size})}. */
export function readClip(doc, clipName) {
  const anim = doc.getRoot().listAnimations().find((a) => a.getName() === clipName)
  if (!anim) throw new Error('clip not found: ' + clipName)
  const chans = new Map()
  let dur = 0
  for (const c of anim.listChannels()) {
    const node = c.getTargetNode()
    if (!node) continue
    const s = c.getSampler()
    if (s.getInterpolation() !== 'LINEAR') throw new Error('non-linear interpolation in ' + clipName)
    const times = Float32Array.from(s.getInput().getArray())
    const size = c.getTargetPath() === 'rotation' ? 4 : 3
    chans.set(`${node.getName()}/${c.getTargetPath()}`, { times, values: Float32Array.from(s.getOutput().getArray()), size })
    dur = Math.max(dur, times[times.length - 1])
  }
  return { dur, chans }
}

/**
 * Builds a new animation in `doc` from a clip description. rules:
 *   keepNodes: Set of joint names that exist in doc
 *   translateJoints: Set of joint names whose translation is kept (others are dropped; they never move)
 *   override: optional { joints:Set, clip } - those joints take their rotation from clip (at time 0, held) instead
 */
export function buildClip(doc, name, clip, { keepNodes, translateJoints, override = null, fps = null }) {
  const root = doc.getRoot()
  const buffer = root.listBuffers()[0]
  const nodeByName = Object.fromEntries(root.listNodes().map((n) => [n.getName(), n]))
  const anim = doc.createAnimation(name)
  const dur = clip.dur
  const mk = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer)
  for (const [key, ch] of clip.chans) {
    const [nodeName, path] = key.split('/')
    if (!keepNodes.has(nodeName)) continue
    if (path === 'scale') continue
    if (path === 'translation' && !translateJoints.has(nodeName)) continue
    let times = ch.times, values = ch.values
    if (override && path === 'rotation' && override.joints.has(nodeName)) {
      const o = override.clip.chans.get(key)
      if (!o) continue
      times = Float32Array.from([0, dur || 1 / 30])
      values = Float32Array.from([...o.values.slice(0, ch.size), ...o.values.slice(0, ch.size)])
    } else if (times.length > 1) {
      // collapse constant channels to two keys
      let constant = true
      for (let i = ch.size; i < values.length && constant; i++) if (Math.abs(values[i] - values[i % ch.size]) > 1e-5) constant = false
      if (constant) {
        times = Float32Array.from([times[0], times[times.length - 1]])
        values = Float32Array.from([...values.slice(0, ch.size), ...values.slice(0, ch.size)])
      }
    }
    const sampler = doc.createAnimationSampler().setInterpolation('LINEAR').setInput(mk('SCALAR', times)).setOutput(mk(ch.size === 4 ? 'VEC4' : 'VEC3', values))
    const channel = doc.createAnimationChannel().setTargetNode(nodeByName[nodeName]).setTargetPath(path).setSampler(sampler)
    anim.addSampler(sampler).addChannel(channel)
  }
  void fps
  return anim
}

/** Joints whose translation changes in any of the given clips (besides root motion bones). */
export function movingTranslations(clips, eps = 1e-4) {
  const moving = new Set()
  for (const clip of clips) {
    for (const [key, ch] of clip.chans) {
      const [n, path] = key.split('/')
      if (path !== 'translation') continue
      for (let i = 3; i < ch.values.length; i++) if (Math.abs(ch.values[i] - ch.values[i % 3]) > eps) { moving.add(n); break }
    }
  }
  return moving
}

export function removeOldAnimations(doc) {
  for (const a of doc.getRoot().listAnimations()) {
    for (const c of a.listChannels()) c.dispose()
    for (const sm of a.listSamplers()) sm.dispose()
    a.dispose()
  }
}

/** Disposes skeleton nodes that are not in `keep` (and not needed): leaf joints, fingers. */
export function disposeNodes(doc, names) {
  for (const n of doc.getRoot().listNodes()) if (names.has(n.getName())) n.dispose()
}

export async function finish(doc, outPath) {
  await doc.transform(dedup(), prune())
  const root = doc.getRoot()
  root.getAsset().generator = 'Blacksite art pipeline (gltf-transform)'
  await io.write(outPath, doc)
}

export { Document }
