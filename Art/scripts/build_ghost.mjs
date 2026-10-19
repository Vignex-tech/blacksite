// Builds client/public/assets/characters/mesh_ghost.glb from the Quaternius UAL1/UAL2 mannequin (CC0).
// Usage (run from anywhere; Windows paths in Git Bash must be C:/...):
//   node Art/scripts/build_ghost.mjs --ual1 <UAL1_Standard.glb> --ual2 <UAL2_Standard.glb> --out <mesh_ghost.glb>
// Recipe: simplify, drop finger joints (merged into the hand, 65 -> 23 joints), recolour with a palette atlas,
// add hood, visor, harness, belt, pouches and a violet armband as rigid skinned primitives, embed the clips, bake the
// scale to 1.8 m. Needs `npm install` in Art/. Nothing from the downloads is executed.
import {
  readGlb, jointInfo, ibmFor, simplifyDoc, extractGeometry, remapJoints, dominantJoint, centroid, rayHit,
  addBox, addEllipsoid, addStrip, addCone, reskinNearest, makeAtlas, writeGeometry, bakeScale, readClip, buildClip,
  movingTranslations, removeOldAnimations, disposeNodes, finish, sub, add, mul,
} from './char_lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []))
for (const k of ['ual1', 'ual2', 'out']) if (!args[k]) throw new Error(`missing --${k}`)

const RATIO = 0.25, ERROR = 0.02, TARGET_HEIGHT = 1.8

const PALETTE = {
  cloth: '#343b46', pants: '#2a3038', hood: '#20242b', glove: '#1b1d22', boot: '#1e2026', pad: '#4a525d',
  strap: '#5c646f', belt: '#25282e', pouch: '#414955', plate: '#404855', violet: '#9d6cff',
}

const FINGER = /^(index|middle|pinky|ring|thumb)_|_leaf_/
const TORSO = new Set(['pelvis', 'spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r', 'neck_01'])

// Ghost clips: exact game names -> source clip (UAL1 unless noted).
const CLIPS = [
  ['idle', 'Idle_Loop'], ['walk', 'Walk_Loop'], ['run', 'Jog_Fwd_Loop'], ['jump', 'Jump_Start'], ['fall', 'Jump_Loop'],
  ['land', 'Jump_Land'], ['hit', 'Hit_Chest'], ['crouch_idle', 'Crouch_Idle_Loop'], ['crouch_walk', 'Crouch_Fwd_Loop'],
  ['mantle', 'ClimbUp_1m', 'ual2'],
]

const doc = await readGlb(args.ual1)
const doc2 = await readGlb(args.ual2)
const info = jointInfo(doc)
const ibm = ibmFor(doc)
const keep = new Set(info.names.filter((n) => !FINGER.test(n)))

// 1. clips (read as plain data before the skeleton is edited)
const clipData = CLIPS.map(([name, src, from]) => [name, readClip(from === 'ual2' ? doc2 : doc, src)])
const translateJoints = new Set(['root', 'pelvis', ...movingTranslations(clipData.map((c) => c[1]))])

// 2. geometry
await simplifyDoc(doc, RATIO, ERROR)
const geo = extractGeometry(doc)
const { keptOrder } = remapJoints(geo, info.names, info.parent, keep)
const W = info.world

for (const t of geo.t) {
  const j = dominantJoint(t, keptOrder)
  const c = centroid(t)
  const joints = t.a.tag === 1 && t.b.tag === 1 && t.c.tag === 1
  const dist = (n) => Math.hypot(...sub(c, W[n]))
  let reg
  if (/^hand_/.test(j)) reg = 'glove'
  else if (/^lowerarm_/.test(j)) reg = dist(j.replace('lowerarm', 'hand')) < 0.11 ? 'glove' : 'cloth'
  else if (/^(Head|neck_01)$/.test(j)) reg = 'hood'
  else if (/^(foot|ball)_/.test(j)) reg = 'boot'
  else if (/^calf_/.test(j)) reg = c[1] < 0.3 ? 'boot' : joints && c[1] > 0.4 ? 'pad' : 'pants'
  else if (/^thigh_/.test(j)) reg = joints && c[1] < 0.62 ? 'pad' : 'pants'
  else if (j === 'pelvis') reg = 'pants'
  else if (/^spine_0[12]$/.test(j)) reg = 'cloth'
  else if (j === 'spine_03') reg = 'plate'
  else reg = 'cloth'
  t.reg = reg
}
// the bare mannequin head is replaced by a hood
geo.t = geo.t.filter((t) => !(dominantJoint(t, keptOrder) === 'Head' && centroid(t)[1] > 1.6))

const bodyTris = geo.t.filter((t) => TORSO.has(dominantJoint(t, keptOrder)))
const J = (n) => keptOrder.indexOf(n)
const zc = 0.0

// hood and visor on the head
const head = { center: [0, 1.705, 0.01], radii: [0.108, 0.142, 0.128] }
addEllipsoid(geo, { ...head, seg: 10, rings: 6, joint: J('Head'), reg: 'hood' })
addCone(geo, { base: [0, 1.80, -0.085], tip: [0, 1.775, -0.2], radius: 0.07, seg: 5, joint: J('Head'), reg: 'hood' })
{
  const rows = []
  for (const dy of [-0.016, 0.016]) {
    const row = []
    for (let i = 0; i <= 6; i++) {
      const x = -0.075 + (0.15 * i) / 6
      const y = 1.705 + dy
      const u = Math.sqrt(Math.max(0, 1 - (x / head.radii[0]) ** 2 - ((y - head.center[1]) / head.radii[1]) ** 2))
      row.push([x, y, head.center[2] + head.radii[2] * u + 0.004])
    }
    rows.push(row)
  }
  addStrip(geo, { rows, normalAt: (p) => [p[0] / head.radii[0] ** 2 * 0.2, (p[1] - head.center[1]) * 0.2, 1], joint: J('Head'), reg: 'violet' })
}

// harness: shoulder straps front and back, chest strap, belt ring, pouches
const harnessFrom = geo.v.length
const surfaceZ = (x, y, front) => {
  const t = rayHit(bodyTris, [x + 0.0013, y + 0.0007, front ? 1 : -1], [0, 0, front ? -1 : 1], 'min')
  return t === null ? null : front ? 1 - t : -1 + t
}
for (const sx of [-1, 1]) {
  for (const front of [true, false]) {
    const rows = []
    for (let i = 0; i <= 5; i++) {
      const s = i / 5
      const y = 1.47 - 0.4 * s
      const xc = sx * (0.085 - 0.03 * s)
      const left = [xc - 0.017, y], right = [xc + 0.017, y]
      const row = [left, right].map(([x, yy]) => {
        const z = surfaceZ(x, yy, front)
        return [x, yy, (z === null ? (front ? 0.1 : -0.1) : z) + (front ? 0.012 : -0.012)]
      })
      rows.push(row)
    }
    addStrip(geo, { rows, normalAt: (p) => [0, 0, front ? 1 : -1], joint: J('spine_03'), reg: 'strap' })
  }
}
{
  const rows = []
  for (const dy of [-0.016, 0.016]) {
    const row = []
    for (let i = 0; i <= 6; i++) {
      const x = -0.08 + (0.16 * i) / 6
      const z = surfaceZ(x, 1.33 + dy, true)
      row.push([x, 1.33 + dy, (z ?? 0.1) + 0.012])
    }
    rows.push(row)
  }
  addStrip(geo, { rows, normalAt: () => [0, 0, 1], joint: J('spine_03'), reg: 'strap' })
  const z = surfaceZ(0, 1.33, true) ?? 0.1
  addBox(geo, { center: [0, 1.33, z + 0.018], size: [0.045, 0.035, 0.014], joint: J('spine_03'), reg: 'violet' })
}
{
  // belt ring, hugging the torso
  const rows = []
  const N = 14
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2 + 0.013
    const d = [Math.cos(th), 0, Math.sin(th)]
    const row = [1.03, 1.1].map((y) => {
      const o = [0, y, zc]
      const t = rayHit(bodyTris, o, d, 'max')
      return add(o, mul(d, (t ?? 0.14) + 0.012))
    })
    rows.push(row)
  }
  addStrip(geo, { rows, normalAt: (p) => [p[0], 0, p[2] - zc], joint: J('spine_01'), reg: 'belt', closeRing: true })
  const zf = surfaceZ(0.1, 1.07, true) ?? 0.1
  addBox(geo, { center: [0.11, 1.05, zf + 0.02], size: [0.07, 0.08, 0.04], joint: J('spine_01'), reg: 'pouch' })
  addBox(geo, { center: [-0.11, 1.05, zf + 0.02], size: [0.07, 0.08, 0.04], joint: J('spine_01'), reg: 'pouch' })
  const zb = surfaceZ(0, 1.07, false) ?? -0.1
  addBox(geo, { center: [0, 1.06, zb - 0.025], size: [0.14, 0.07, 0.05], joint: J('spine_01'), reg: 'pouch' })
}
reskinNearest(geo, harnessFrom, geo.v.length)
{
  // violet armband on the left upper arm (T-pose: the arm runs along +x)
  const armTris = geo.t.filter((t) => dominantJoint(t, keptOrder) === 'upperarm_l')
  const rows = []
  const N = 8
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2
    const d = [0, Math.cos(th), Math.sin(th)]
    const row = [0.3, 0.345].map((x) => {
      const o = [x, W.upperarm_l[1], W.upperarm_l[2]]
      const t = rayHit(armTris, o, d, 'max')
      return add(o, mul(d, (t ?? 0.06) + 0.008))
    })
    rows.push(row)
  }
  addStrip(geo, { rows, normalAt: (p) => [0, p[1] - W.upperarm_l[1], p[2] - W.upperarm_l[2]], joint: J('upperarm_l'), reg: 'violet', closeRing: true })
}

// 3. skeleton, clips, scale, write
let maxY = -1e9
for (const v of geo.v) maxY = Math.max(maxY, v.p[1])
const scale = TARGET_HEIGHT / maxY

removeOldAnimations(doc)
disposeNodes(doc, new Set(info.names.filter((n) => !keep.has(n))))
for (const [name, clip] of clipData) buildClip(doc, name, clip, { keepNodes: keep, translateJoints })
bakeScale(doc, geo, ibm, scale)
const { png, uv } = await makeAtlas(PALETTE)
const meshInfo = writeGeometry(doc, geo, {
  meshName: 'mesh_ghost', atlasPng: png, uvByReg: uv, materialName: 'mat_ghost', keptOrder, ibmByName: ibm, skin: info.skin,
})
await finish(doc, args.out)
console.log(JSON.stringify({ out: args.out, scale: +scale.toFixed(4), vertices: meshInfo.vertices, triangles: meshInfo.triangles, joints: keptOrder.length, clips: CLIPS.map((c) => c[0]) }))
