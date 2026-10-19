// Builds client/public/assets/characters/mesh_rifle.glb from Quaternius Sci-Fi Essentials Kit Gun_Rifle.gltf (CC0).
// Usage: node Art/scripts/build_rifle.mjs --gltf <Gun_Rifle.gltf> --atlas <T_Guns_Batch1_BaseColor.png> --out <mesh_rifle.glb>
// The source atlas contains small printed serial text, so it is NOT shipped: each triangle is classified by the average
// atlas colour under it (dark / mid / light / orange) and recoloured from a flat 512 px palette atlas. Reduced to <= 1,500 tris,
// rotated so the muzzle points +z, scaled to about 0.9 m, origin at the grip. Adds empty nodes muzzle, grip and light_mount.
import fs from 'node:fs'
import { Document } from '@gltf-transform/core'
import { weld, simplify, dedup, prune } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import { io, decodePng, makeAtlas } from './char_lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []))
for (const k of ['gltf', 'atlas', 'out']) if (!args[k]) throw new Error(`missing --${k}`)
const RATIO = 0.225, ERROR = 0.01, LENGTH = 0.9
const PALETTE = { dark: '#262a30', mid: '#3d444c', light: '#5d656d', accent: '#d9751c' }

const src = await io.read(args.gltf)
await MeshoptSimplifier.ready
await src.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: ERROR }))
const png = decodePng(fs.readFileSync(args.atlas))
const sample = (u, v) => {
  const x = Math.min(png.w - 1, Math.max(0, Math.floor((u % 1 + 1) % 1 * png.w))), y = Math.min(png.h - 1, Math.max(0, Math.floor((v % 1 + 1) % 1 * png.h)))
  const o = (y * png.w + x) * png.ch
  return [png.data[o], png.data[o + 1], png.data[o + 2]]
}
const prim = src.getRoot().listMeshes()[0].listPrimitives()[0]
const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), T = prim.getAttribute('TEXCOORD_0'), I = prim.getIndices()
const pos = (i) => P.getElement(i, [0, 0, 0])
// find the long axis end that is the muzzle: source runs along x (-0.75 .. 0.31)
let minX = 1e9, maxX = -1e9, minY = 1e9
for (let i = 0; i < P.getCount(); i++) { const p = pos(i); minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]) }
const s = LENGTH / (maxX - minX)
const cls = new Map()
const tri = []
for (let k = 0; k < I.getCount(); k += 3) {
  const ids = [I.getScalar(k), I.getScalar(k + 1), I.getScalar(k + 2)]
  let r = 0, g = 0, b = 0
  for (const i of ids) { const uv = T.getElement(i, [0, 0]); const c = sample(uv[0], uv[1]); r += c[0]; g += c[1]; b += c[2] }
  r /= 3; g /= 3; b /= 3
  const lum = (r + g + b) / 3
  tri.push({ ids, reg: r > g * 1.25 && r > b * 1.8 ? 'accent' : lum < 70 ? 'dark' : lum < 125 ? 'mid' : 'light' })
}
const { png: atlasPng, uv } = await makeAtlas(PALETTE)
// transform: (x,y,z) -> forward z' = -(x - x0), x' = z, y' = y - y0 ; muzzle at the -x end (checked in the preview)
const FLIP = process.env.RIFLE_FLIP === '1'
const tf = (p) => { const f = FLIP ? (p[0] - minX) : (maxX - p[0]); return [p[2] * s, (p[1] - minY) * s, f * s] }
const doc = new Document()
const buffer = doc.createBuffer()
const Pn = [], Nn = [], Un = [], In = []
const ids = new Map()
const idx = (i, reg) => {
  const key = i + ':' + reg
  if (ids.has(key)) return ids.get(key)
  const n = N.getElement(i, [0, 0, 0])
  Pn.push(...tf(pos(i))); Nn.push(n[2], n[1], FLIP ? n[0] : -n[0]); Un.push(...uv[reg])
  const id = Pn.length / 3 - 1
  ids.set(key, id)
  return id
}
for (const t of tri) In.push(...t.ids.map((i) => idx(i, t.reg)))
const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer)
const tex = doc.createTexture('tex_mesh_rifle').setImage(atlasPng).setMimeType('image/png')
const mat = doc.createMaterial('mat_rifle').setBaseColorTexture(tex).setRoughnessFactor(0.7).setMetallicFactor(0)
const mprim = doc.createPrimitive().setAttribute('POSITION', acc('VEC3', new Float32Array(Pn))).setAttribute('NORMAL', acc('VEC3', new Float32Array(Nn)))
  .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(Un))).setIndices(acc('SCALAR', new Uint16Array(In))).setMaterial(mat)
const mesh = doc.createMesh('mesh_rifle').addPrimitive(mprim)
const root = doc.createNode('rifle').setMesh(mesh)
const zMax = (maxX - minX) * s
const place = (name, t) => root.addChild(doc.createNode(name).setTranslation(t))
const cfg = JSON.parse(process.env.RIFLE_NODES || '{}')
place('muzzle', cfg.muzzle || [0, 0.18, zMax])
place('grip', cfg.grip || [0, 0.07, 0.22])
place('light_mount', cfg.light_mount || [0, 0.1, 0.72])
doc.createScene('Scene').addChild(root)
await doc.transform(dedup(), prune({ keepLeaves: true }))
await io.write(args.out, doc)
console.log(JSON.stringify({ out: args.out, triangles: In.length / 3, vertices: Pn.length / 3, length: +zMax.toFixed(3), heightY: +((Math.max(...Pn.filter((_, i) => i % 3 === 1))).toFixed(3)) }))
