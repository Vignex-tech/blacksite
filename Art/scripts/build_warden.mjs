// Builds client/public/assets/characters/mesh_warden.glb from the Quaternius UAL1 mannequin (CC0).
// Usage (Windows paths in Git Bash must be C:/...):
//   node Art/scripts/build_warden.mjs --ual1 <UAL1_Standard.glb> --out <mesh_warden.glb>
// The KayKit Mannequin_Medium named in the original plan was rejected: it is a cartoon figure with a head half the
// height of the body, a printed smiley face and a "HELLO my name is" name tag texture, which breaks the "realistic
// proportions, no readable text" rules. The Warden uses the same realistic UAL rig as the Ghost, made broader (soft
// radial scaling around the bones) and dressed with a vest shell, plates, helmet, orange visor, radio and flashlight mount.
// Rifle clips are built from the UAL pistol clips: the locomotion legs plus a held two-handed aim pose for the upper body.
import {
  readGlb, jointInfo, ibmFor, simplifyDoc, extractGeometry, remapJoints, dominantJoint, centroid, rayHit,
  addBox, addEllipsoid, addStrip, addCylinder, reskinNearest, makeAtlas, writeGeometry, bakeScale, readClip, buildClip,
  movingTranslations, removeOldAnimations, disposeNodes, finish, sub, add, mul, norm, len,
} from './char_lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []))
for (const k of ['ual1', 'out']) if (!args[k]) throw new Error(`missing --${k}`)

const RATIO = 0.27, ERROR = 0.02, TARGET_HEIGHT = 1.8

const PALETTE = {
  uniform: '#3d4853', pants: '#353f49', skin: '#7b6558', glove: '#23272d', boot: '#262a30', pad: '#59616b',
  vest: '#4d594e', plate: '#626b72', helmet: '#323a43', belt: '#2a2e34', pouch: '#46514a', strap: '#5f6a72', orange: '#f07a1c',
}

const FINGER = /^(index|middle|pinky|ring|thumb)_|_leaf_/
const TORSO = new Set(['pelvis', 'spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r', 'neck_01'])

const LOCO = [
  ['idle', 'Idle_Loop'], ['walk', 'Walk_Loop'], ['run', 'Jog_Fwd_Loop'], ['jump', 'Jump_Start'], ['fall', 'Jump_Loop'],
  ['land', 'Jump_Land'], ['hit', 'Hit_Chest'],
]
// rifle clips: [name, source clip, optional locomotion source whose legs are kept]
const UPPER = new Set(['spine_02', 'spine_03', 'neck_01', 'Head', 'clavicle_l', 'clavicle_r', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r'])
const RIFLE = [
  ['idle_rifle', 'Pistol_Idle_Loop', null], ['walk_rifle', 'Walk_Loop', 'Pistol_Aim_Neutral'], ['run_rifle', 'Jog_Fwd_Loop', 'Pistol_Aim_Neutral'],
  ['fire', 'Pistol_Shoot', null], ['reload', 'Pistol_Reload', null],
]

const doc = await readGlb(args.ual1)
const info = jointInfo(doc)
const ibm = ibmFor(doc)
const keep = new Set(info.names.filter((n) => !FINGER.test(n)))

// 1. clips
const clipData = LOCO.map(([name, src]) => ({ name, clip: readClip(doc, src), override: null }))
for (const [name, src, poseSrc] of RIFLE) {
  clipData.push({ name, clip: readClip(doc, src), override: poseSrc ? { joints: UPPER, clip: readClip(doc, poseSrc) } : null })
}
const translateJoints = new Set(['root', 'pelvis', ...movingTranslations(clipData.map((c) => c.clip))])

// 2. geometry
await simplifyDoc(doc, RATIO, ERROR)
const geo = extractGeometry(doc)
const { keptOrder } = remapJoints(geo, info.names, info.parent, keep)
const W = info.world
const J = (n) => keptOrder.indexOf(n)

// broader build: soft radial scaling around each bone's axis, blended by skin weights.
const BULK = {
  pelvis: [1.12, 1.14], spine_01: [1.14, 1.16], spine_02: [1.2, 1.2], spine_03: [1.28, 1.2], neck_01: [1.1, 1.1],
  clavicle_l: [1.1, 1.1], clavicle_r: [1.1, 1.1], upperarm_l: [1.22, 1.22], upperarm_r: [1.22, 1.22],
  lowerarm_l: [1.14, 1.14], lowerarm_r: [1.14, 1.14],
  thigh_l: [1.14, 1.14], thigh_r: [1.14, 1.14], calf_l: [1.1, 1.1], calf_r: [1.1, 1.1],
}
const CHILD = {
  pelvis: 'spine_01', spine_01: 'spine_02', spine_02: 'spine_03', spine_03: 'neck_01', neck_01: 'Head',
  clavicle_l: 'upperarm_l', clavicle_r: 'upperarm_r', upperarm_l: 'lowerarm_l', upperarm_r: 'lowerarm_r', lowerarm_l: 'hand_l', lowerarm_r: 'hand_r',
  thigh_l: 'calf_l', thigh_r: 'calf_r', calf_l: 'foot_l', calf_r: 'foot_r',
}
const axisPoint = (p, a, b, vertical) => {
  if (vertical) return [0, p[1], 0.0]
  const ab = sub(b, a), t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)))
  return add(a, mul(ab, t))
}
for (const v of geo.v) {
  const base = v.p
  let out = [0, 0, 0]
  for (let k = 0; k < 4; k++) {
    if (v.w[k] <= 0) continue
    const name = keptOrder[v.j[k]]
    const f = BULK[name]
    let q = base
    if (f) {
      const vertical = TORSO.has(name) && name !== 'clavicle_l' && name !== 'clavicle_r'
      const ax = axisPoint(base, W[name], W[CHILD[name]], vertical)
      const d = sub(base, ax)
      q = vertical ? [ax[0] + d[0] * f[0], base[1], ax[2] + d[2] * f[1]] : add(ax, mul(d, f[0]))
    }
    out = add(out, mul(q, v.w[k]))
  }
  v.p = out
}

for (const t of geo.t) {
  const j = dominantJoint(t, keptOrder)
  const c = centroid(t)
  const joints = t.a.tag === 1 && t.b.tag === 1 && t.c.tag === 1
  const dist = (n) => Math.hypot(...sub(c, W[n]))
  let reg
  if (/^hand_/.test(j)) reg = 'glove'
  else if (/^lowerarm_/.test(j)) reg = dist(j.replace('lowerarm', 'hand')) < 0.11 ? 'glove' : 'uniform'
  else if (/^(Head|neck_01)$/.test(j)) reg = 'skin'
  else if (/^(foot|ball)_/.test(j)) reg = 'boot'
  else if (/^calf_/.test(j)) reg = c[1] < 0.3 ? 'boot' : joints && c[1] > 0.4 ? 'pad' : 'pants'
  else if (/^thigh_/.test(j)) reg = joints && c[1] < 0.62 ? 'pad' : 'pants'
  else if (j === 'pelvis') reg = 'pants'
  else reg = 'uniform'
  t.reg = reg
}

// vest: a shell over the torso, pushed out along the normals
{
  const shell = geo.t.filter((t) => {
    const j = dominantJoint(t, keptOrder)
    const c = centroid(t)
    return (/^spine_0[123]$/.test(j) || (/^clavicle_/.test(j) && Math.abs(c[0]) < 0.18)) && c[1] > 1.1 && c[1] < 1.47 && Math.abs(c[0]) < 0.26
  })
  const copies = new Map()
  const copy = (v) => {
    if (copies.has(v)) return copies.get(v)
    const n = norm(v.n)
    const o = { p: add(v.p, mul(n, 0.022)), n: v.n, j: v.j.slice(), w: v.w.slice(), tag: 8 }
    geo.v.push(o)
    copies.set(v, o)
    return o
  }
  for (const t of shell) geo.t.push({ a: copy(t.a), b: copy(t.b), c: copy(t.c), reg: 'vest' })
}

const bodyTris = geo.t.filter((t) => t.a.tag !== 9 && TORSO.has(dominantJoint(t, keptOrder)) && t.reg !== 'vest')
const surfaceZ = (x, y, front) => {
  const all = geo.t.filter((t) => TORSO.has(dominantJoint(t, keptOrder)))
  const t = rayHit(all, [x + 0.0013, y + 0.0007, front ? 1 : -1], [0, 0, front ? -1 : 1], 'min')
  return t === null ? null : front ? 1 - t : -1 + t
}
void bodyTris

// plates, radio, flashlight mount, belt and pouches
{
  const zf = surfaceZ(0, 1.3, true) ?? 0.15
  const zb = surfaceZ(0, 1.3, false) ?? -0.15
  const plateFrom = geo.v.length
  addBox(geo, { center: [0, 1.3, zf + 0.012], size: [0.22, 0.25, 0.03], joint: J('spine_03'), reg: 'plate' })
  addBox(geo, { center: [0, 1.28, zb - 0.012], size: [0.24, 0.27, 0.03], joint: J('spine_03'), reg: 'plate' })
  reskinNearest(geo, plateFrom, geo.v.length)
  // radio on the left chest (character's left is +x) with a stub antenna
  const zr = surfaceZ(0.12, 1.36, true) ?? 0.12
  addBox(geo, { center: [0.13, 1.36, zr + 0.012], size: [0.05, 0.09, 0.035], joint: J('spine_03'), reg: 'belt' })
  addCylinder(geo, { base: [0.14, 1.41, zr + 0.01], tip: [0.14, 1.53, zr + 0.01], radius: 0.007, seg: 5, joint: J('spine_03'), reg: 'belt' })
  // flashlight mount on the right shoulder front: body plus an orange lens ring
  const zl = surfaceZ(-0.17, 1.42, true) ?? 0.1
  addCylinder(geo, { base: [-0.17, 1.43, zl - 0.02], tip: [-0.17, 1.43, zl + 0.075], radius: 0.022, seg: 6, joint: J('spine_03'), reg: 'belt' })
  addCylinder(geo, { base: [-0.17, 1.43, zl + 0.07], tip: [-0.17, 1.43, zl + 0.085], radius: 0.026, seg: 6, joint: J('spine_03'), reg: 'orange' })
  // belt, pouches
  const beltFrom = geo.v.length
  const rows = []
  const N = 14
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2 + 0.013
    const d = [Math.cos(th), 0, Math.sin(th)]
    const row = [1.0, 1.08].map((y) => {
      const o = [0, y, 0]
      const all = geo.t.filter((t) => TORSO.has(dominantJoint(t, keptOrder)) && t.reg !== 'vest')
      const t = rayHit(all, o, d, 'max')
      return add(o, mul(d, (t ?? 0.16) + 0.012))
    })
    rows.push(row)
  }
  addStrip(geo, { rows, normalAt: (p) => [p[0], 0, p[2]], joint: J('spine_01'), reg: 'belt', closeRing: true })
  const zp = surfaceZ(0.12, 1.04, true) ?? 0.16
  addBox(geo, { center: [0.14, 1.03, zp + 0.025], size: [0.08, 0.09, 0.05], joint: J('spine_01'), reg: 'pouch' })
  addBox(geo, { center: [-0.14, 1.03, zp + 0.025], size: [0.08, 0.09, 0.05], joint: J('spine_01'), reg: 'pouch' })
  reskinNearest(geo, beltFrom, geo.v.length)
}

// helmet, orange visor, comms
const head = { center: [0, 1.705, 0.01], radii: [0.108, 0.142, 0.128] }
addEllipsoid(geo, { center: [0, 1.73, 0.005], radii: [0.128, 0.13, 0.15], seg: 10, rings: 4, joint: J('Head'), reg: 'helmet', vMin: -0.05, vMax: 1 })
addEllipsoid(geo, { center: [0, 1.74, -0.05], radii: [0.12, 0.09, 0.15], seg: 10, rings: 2, joint: J('Head'), reg: 'helmet', vMin: -1, vMax: -0.1 })
{
  const rows = []
  for (const dy of [-0.025, 0.022]) {
    const row = []
    for (let i = 0; i <= 8; i++) {
      const x = -0.09 + (0.18 * i) / 8
      const y = 1.70 + dy
      const u = Math.sqrt(Math.max(0, 1 - (x / head.radii[0]) ** 2 - ((y - head.center[1]) / head.radii[1]) ** 2))
      row.push([x, y, head.center[2] + head.radii[2] * u + 0.006])
    }
    rows.push(row)
  }
  addStrip(geo, { rows, normalAt: (p) => [p[0] * 4, (p[1] - head.center[1]) * 2, 1], joint: J('Head'), reg: 'orange' })
  addBox(geo, { center: [0.12, 1.70, 0.0], size: [0.03, 0.06, 0.06], joint: J('Head'), reg: 'belt' })
  addBox(geo, { center: [-0.12, 1.70, 0.0], size: [0.03, 0.06, 0.06], joint: J('Head'), reg: 'belt' })
}

// 3. skeleton, clips, scale, write
let maxY = -1e9
for (const v of geo.v) maxY = Math.max(maxY, v.p[1])
const scale = TARGET_HEIGHT / maxY
removeOldAnimations(doc)
disposeNodes(doc, new Set(info.names.filter((n) => !keep.has(n))))
for (const c of clipData) buildClip(doc, c.name, c.clip, { keepNodes: keep, translateJoints, override: c.override })
bakeScale(doc, geo, ibm, scale)
const { png, uv } = await makeAtlas(PALETTE)
const meshInfo = writeGeometry(doc, geo, {
  meshName: 'mesh_warden', atlasPng: png, uvByReg: uv, materialName: 'mat_warden', keptOrder, ibmByName: ibm, skin: info.skin,
})
await finish(doc, args.out)
console.log(JSON.stringify({ out: args.out, scale: +scale.toFixed(4), vertices: meshInfo.vertices, triangles: meshInfo.triangles, joints: keptOrder.length, clips: clipData.map((c) => c.name) }))
void len
