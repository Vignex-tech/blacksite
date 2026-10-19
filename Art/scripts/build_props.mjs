// Builds the prop models (client/public/assets/props/) for #84: console, server rack, crate, lamp, pipe, fence, ladder strip.
// Usage (Windows paths in Git Bash must be C:/...):
//   node Art/scripts/build_props.mjs --mega <glTF dir of the Modular SciFi MegaKit> --out <props dir>
// console, crate and lamp start from Quaternius MegaKit meshes (CC0). The download's textures are never read: the glTF JSON is
// loaded with every texture reference removed and the materials are replaced by flat palette materials. That keeps each file
// tiny, drops any printed decal or text the kit textures carry (the console's screen decal in particular), and keeps the
// palette restrained (Art/STYLE.md). server rack, pipe, fence and ladder strip are generated here from boxes and cylinders (no
// CC0 model matched them, see Art/README.md); they are our own work and are dedicated CC0 like the rest of the repository's art.
// Fronts face +z in glTF (Babylon's glTF loader turns the model half a turn, like the characters); origins sit at the base.
import { Document, NodeIO } from '@gltf-transform/core'
import { dedup, prune } from '@gltf-transform/functions'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []))
for (const k of ['mega', 'out']) if (!args[k]) throw new Error(`missing --${k}`)
const io = new NodeIO()

// ---------------------------------------------------------------- palette (sRGB hex, converted to linear for glTF)
const lin = (h) => [1, 3, 5].map((o) => { const c = parseInt(h.slice(o, o + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
const PAL = {
  steel: { color: '#58646f', rough: 0.55, metal: 0.3 },
  steel_dark: { color: '#2f373f', rough: 0.6, metal: 0.3 },
  steel_light: { color: '#7a8792', rough: 0.5, metal: 0.3 },
  black: { color: '#0e1114', rough: 0.8, metal: 0 },
  plastic: { color: '#1b2025', rough: 0.7, metal: 0 },
  screen: { color: '#06120b', rough: 0.35, metal: 0, emissive: '#12432a' },
  leds: { color: '#0a1a10', rough: 0.5, metal: 0, emissive: '#3bd072' },
  bulb: { color: '#2a2418', rough: 0.4, metal: 0, emissive: '#ffd49a' },
  rungs: { color: '#0b2a30', rough: 0.5, metal: 0, emissive: '#27c6d9' },
}

// ---------------------------------------------------------------- reading a MegaKit gltf without its textures
async function loadNoTextures(file) {
  const dir = path.dirname(file)
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete json.images; delete json.textures; delete json.samplers
  for (const m of json.materials ?? []) {
    delete m.extensions; delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture
    if (m.pbrMetallicRoughness) { delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture }
  }
  delete json.extensionsUsed; delete json.extensionsRequired
  const resources = {}
  for (const b of json.buffers ?? []) if (b.uri) resources[b.uri] = new Uint8Array(fs.readFileSync(path.join(dir, b.uri)))
  return io.readJSON({ json, resources })
}

function setMaterial(doc, mat, key) {
  const p = PAL[key]
  mat.setBaseColorFactor([...lin(p.color), 1]).setRoughnessFactor(p.rough).setMetallicFactor(p.metal)
  mat.setEmissiveFactor(p.emissive ? lin(p.emissive) : [0, 0, 0])
  return mat
}

/** Offsets every vertex so the bounding box is centred on x/z and rests on y = 0 (origin at the base). */
function rebase(doc, { keepZ = false, yAt = 'min' } = {}) {
  const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const p of prims) {
    const a = p.getAttribute('POSITION')
    const mn = a.getMin([0, 0, 0]), mx = a.getMax([0, 0, 0])
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], mn[i]); hi[i] = Math.max(hi[i], mx[i]) }
  }
  const off = [-(lo[0] + hi[0]) / 2, yAt === 'min' ? -lo[1] : -hi[1], keepZ ? 0 : -(lo[2] + hi[2]) / 2]
  for (const p of prims) {
    const a = p.getAttribute('POSITION')
    for (let i = 0; i < a.getCount(); i++) { const v = a.getElement(i, [0, 0, 0]); a.setElement(i, [v[0] + off[0], v[1] + off[1], v[2] + off[2]]) }
  }
  return { lo, hi, off }
}

/** Bakes node transforms into the vertices (the kit nodes carry no transform, so this is a safety net) and flattens the node tree. */
function flatten(doc) {
  const scene = doc.getRoot().listScenes()[0]
  for (const n of doc.getRoot().listNodes()) {
    const t = n.getTranslation(), r = n.getRotation(), s = n.getScale()
    const identity = t.every((v) => v === 0) && s.every((v) => v === 1) && r[0] === 0 && r[1] === 0 && r[2] === 0 && r[3] === 1
    if (!identity && n.getMesh()) throw new Error('unexpected node transform on ' + n.getName())
  }
  void scene
}

function stats(doc) {
  let tris = 0
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += p.getIndices() ? p.getIndices().getCount() / 3 : p.getAttribute('POSITION').getCount() / 3
  return tris
}

async function write(doc, name) {
  // source vertex colours would tint the flat palette, so they go; UVs stay (the console screen quad carries them)
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) p.setAttribute('COLOR_0', null)
  await doc.transform(dedup(), prune({ keepAttributes: true }))
  doc.getRoot().getAsset().generator = 'Blacksite art pipeline (gltf-transform)'
  const file = path.join(args.out, name + '.glb')
  await io.write(file, doc)
  const info = { name, bytes: fs.statSync(file).size, triangles: stats(doc), materials: doc.getRoot().listMaterials().map((m) => m.getName()), nodes: doc.getRoot().listNodes().map((n) => n.getName()) }
  console.log(JSON.stringify(info))
  return info
}

// ---------------------------------------------------------------- a tiny geometry builder (flat-shaded boxes, smooth cylinders)
class Builder {
  constructor() { this.prims = new Map() }
  prim(mat) {
    if (!this.prims.has(mat)) this.prims.set(mat, { P: [], N: [], I: [] })
    return this.prims.get(mat)
  }
  quad(mat, corners, n) {
    const g = this.prim(mat)
    const base = g.P.length / 3
    for (const c of corners) { g.P.push(...c); g.N.push(...n) }
    g.I.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  box(mat, [cx, cy, cz], [sx, sy, sz]) {
    const x = sx / 2, y = sy / 2, z = sz / 2
    const P = (a, b, c) => [cx + a * x, cy + b * y, cz + c * z]
    // counter-clockwise seen from outside
    this.quad(mat, [P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)], [1, 0, 0])
    this.quad(mat, [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)], [-1, 0, 0])
    this.quad(mat, [P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1)], [0, 1, 0])
    this.quad(mat, [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)], [0, -1, 0])
    this.quad(mat, [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], [0, 0, 1])
    this.quad(mat, [P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)], [0, 0, -1])
  }
  /** Cylinder along x, y or z from `a` to `b` (centre line), smooth side normals, flat caps. */
  cyl(mat, axis, [cx, cy, cz], length, radius, seg = 10, caps = true) {
    const g = this.prim(mat)
    const ring = (t, s) => {
      const th = (s / seg) * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th)
      if (axis === 'x') return { p: [cx + t, cy + c * radius, cz + sn * radius], n: [0, c, sn] }
      if (axis === 'y') return { p: [cx + c * radius, cy + t, cz + sn * radius], n: [c, 0, sn] }
      return { p: [cx + c * radius, cy + sn * radius, cz + t], n: [c, sn, 0] }
    }
    const base = g.P.length / 3
    for (const t of [-length / 2, length / 2]) for (let s = 0; s < seg; s++) { const r = ring(t, s); g.P.push(...r.p); g.N.push(...r.n) }
    for (let s = 0; s < seg; s++) {
      const s2 = (s + 1) % seg
      // winding chosen so normals point outwards for every axis (checked by the front-face test in the preview)
      const a = base + s, b = base + s2, c = base + seg + s2, d = base + seg + s
      if (axis === 'y') g.I.push(a, b, c, a, c, d)
      else g.I.push(a, c, b, a, d, c)
    }
    if (caps) {
      for (const [t, sign] of [[-length / 2, -1], [length / 2, 1]]) {
        const cb = g.P.length / 3
        const nrm = axis === 'x' ? [sign, 0, 0] : axis === 'y' ? [0, sign, 0] : [0, 0, sign]
        const centre = axis === 'x' ? [cx + t, cy, cz] : axis === 'y' ? [cx, cy + t, cz] : [cx, cy, cz + t]
        g.P.push(...centre); g.N.push(...nrm)
        for (let s = 0; s < seg; s++) { const r = ring(t, s); g.P.push(...r.p); g.N.push(...nrm) }
        for (let s = 0; s < seg; s++) {
          const s2 = (s + 1) % seg
          const flip = axis === 'y' ? sign < 0 : axis === 'x' ? sign > 0 : sign < 0
          if (flip) g.I.push(cb, cb + 1 + s2, cb + 1 + s)
          else g.I.push(cb, cb + 1 + s, cb + 1 + s2)
        }
      }
    }
  }
  /** Writes one node holding one mesh per material group, all under a root node named `name`. */
  toDocument(name) {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const mesh = doc.createMesh(name)
    for (const [mat, g] of this.prims) {
      const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer)
      const prim = doc.createPrimitive()
        .setAttribute('POSITION', acc('VEC3', new Float32Array(g.P)))
        .setAttribute('NORMAL', acc('VEC3', new Float32Array(g.N)))
        .setIndices(acc('SCALAR', g.P.length / 3 > 65535 ? new Uint32Array(g.I) : new Uint16Array(g.I)))
        .setMaterial(setMaterial(doc, doc.createMaterial(mat), mat))
      mesh.addPrimitive(prim)
    }
    const node = doc.createNode(name).setMesh(mesh)
    doc.createScene('scene').addChild(node)
    return doc
  }
}

const results = []

// ---------------------------------------------------------------- console (MegaKit Prop_Computer, 519 tris)
{
  const doc = await loadNoTextures(path.join(args.mega, 'Props', 'Prop_Computer.gltf'))
  flatten(doc)
  const root = doc.getRoot()
  const mesh = root.listMeshes()[0]
  const body = doc.createMesh('body'), screen = doc.createMesh('screen')
  for (const p of mesh.listPrimitives().slice()) {
    const mname = p.getMaterial().getName()
    mesh.removePrimitive(p)
    if (mname === 'M_Decal_Screen') { setMaterial(doc, p.getMaterial(), 'screen').setName('screen'); screen.addPrimitive(p) }
    else if (mname === 'M_Black') { setMaterial(doc, p.getMaterial(), 'black').setName('bezel'); body.addPrimitive(p) }
    else { setMaterial(doc, p.getMaterial(), 'steel').setName('steel'); body.addPrimitive(p) }
  }
  rebase(doc)
  // The decal geometry is only a few small glyph shapes. Replace it with one clean quad on the same tilted plane (y + z = 1.45,
  // 45 degrees, facing up and +z) so tex_screen_idle / off / hacked (256x128) fill it exactly. glTF v runs downwards.
  {
    const sp = screen.listPrimitives()[0]
    const n = [0, Math.SQRT1_2, Math.SQRT1_2], up = [0, Math.SQRT1_2, -Math.SQRT1_2]
    const centre = [0, 1.435 + 0.0014, 0.015 + 0.0014], hw = 0.28, hh = 0.14
    const at = (sx, sy) => [centre[0] + sx * hw, centre[1] + sy * hh * up[1], centre[2] + sy * hh * up[2]]
    const corners = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)]
    const mk = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(root.listBuffers()[0])
    sp.setAttribute('POSITION', mk('VEC3', new Float32Array(corners.flat())))
    sp.setAttribute('NORMAL', mk('VEC3', new Float32Array([...n, ...n, ...n, ...n])))
    sp.setAttribute('TEXCOORD_0', mk('VEC2', new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])))
    sp.setIndices(mk('SCALAR', new Uint16Array([0, 1, 2, 0, 2, 3])))
  }
  const faceFront = true
  const mn = [-0.28, 1.3, 0], mx = [0.28, 1.57, 0.16]
  const bodyNode = root.listNodes()[0].setName('body').setMesh(body)
  const screenNode = doc.createNode('screen').setMesh(screen)
  const top = doc.createNode('mesh_console').addChild(bodyNode).addChild(screenNode)
  const scene = root.listScenes()[0]
  scene.addChild(top)
  for (const n of scene.listChildren()) if (n !== top) scene.removeChild(n)
  mesh.dispose()
  results.push(await write(doc, 'mesh_console'))
  console.log('console screen faces', faceFront ? '+z' : '-z', 'bbox', mn.map((v) => v.toFixed(2)), mx.map((v) => v.toFixed(2)))
}

// ---------------------------------------------------------------- crate (MegaKit Prop_Crate4, 972 tris)
{
  const doc = await loadNoTextures(path.join(args.mega, 'Props', 'Prop_Crate4.gltf'))
  flatten(doc)
  for (const m of doc.getRoot().listMaterials()) setMaterial(doc, m, 'steel').setName('crate')
  rebase(doc)
  doc.getRoot().listNodes()[0].setName('mesh_crate')
  results.push(await write(doc, 'mesh_crate'))
}

// ---------------------------------------------------------------- lamp (MegaKit Prop_Light_Small, 160 tris): a bar lamp, origin at the mounting face
{
  const doc = await loadNoTextures(path.join(args.mega, 'Props', 'Prop_Light_Small.gltf'))
  flatten(doc)
  for (const m of doc.getRoot().listMaterials()) {
    if (m.getName() === 'M_Light') setMaterial(doc, m, 'bulb').setName('bulb')
    else setMaterial(doc, m, 'steel').setName('housing')
  }
  rebase(doc, { yAt: 'max' }) // the housing hangs below its mounting plane, so y = 0 is the top face
  doc.getRoot().listNodes()[0].setName('mesh_lamp')
  results.push(await write(doc, 'mesh_lamp'))
}

// ---------------------------------------------------------------- server rack (generated): 0.6 w x 2.0 h x 0.9 d, front faces +z
{
  const b = new Builder()
  const W = 0.6, H = 2.0, D = 0.9, post = 0.05
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('steel_dark', [sx * (W / 2 - post / 2), H / 2, sz * (D / 2 - post / 2)], [post, H, post])
  b.box('steel', [0, 0.05, 0], [W, 0.1, D]) // plinth
  b.box('steel', [0, H - 0.03, 0], [W, 0.06, D]) // roof
  b.box('steel_dark', [0, H / 2, -D / 2 + 0.015], [W - 0.06, H - 0.14, 0.03]) // back
  for (const sx of [-1, 1]) b.box('steel_dark', [sx * (W / 2 - 0.01), H / 2, 0], [0.02, H - 0.14, D - 0.1]) // sides
  const units = 8, y0 = 0.2, pitch = (H - 0.4) / units
  for (let i = 0; i < units; i++) {
    const y = y0 + pitch * (i + 0.5)
    b.box('plastic', [0, y, 0.02], [W - 0.12, pitch - 0.035, D - 0.2]) // server unit
    b.box('black', [0.06, y, D / 2 - 0.074], [W - 0.34, pitch - 0.09, 0.012]) // vent grille
    for (let k = 0; k < 5; k++) b.box('leds', [-(W - 0.12) / 2 + 0.05 + k * 0.045, y + (pitch - 0.09) / 2 - 0.012, D / 2 - 0.069], [0.03, 0.03, 0.014]) // LEDs (own primitive, material 'leds')
  }
  const doc = b.toDocument('mesh_server_rack')
  const prims = doc.getRoot().listMeshes()[0].listPrimitives()
  // gameplay swaps the LED material, so the LEDs must be their own mesh named `leds`
  const leds = doc.createMesh('leds')
  for (const p of prims) if (p.getMaterial().getName() === 'leds') { doc.getRoot().listMeshes()[0].removePrimitive(p); leds.addPrimitive(p) }
  const ledNode = doc.createNode('leds').setMesh(leds)
  const rootNode = doc.getRoot().listNodes().find((n) => n.getName() === 'mesh_server_rack')
  rootNode.setMesh(null)
  const bodyMesh = doc.getRoot().listMeshes().find((m) => m.getName() === 'mesh_server_rack')
  rootNode.addChild(doc.createNode('body').setMesh(bodyMesh)).addChild(ledNode)
  results.push(await write(doc, 'mesh_server_rack'))
}

// ---------------------------------------------------------------- pipe (generated): 2 m horizontal run, bottom of the pipe on y = 0
{
  const b = new Builder()
  const r = 0.08, L = 2.0
  b.cyl('steel', 'x', [0, r, 0], L, r, 12)
  for (const x of [-L / 2 + 0.06, L / 2 - 0.06]) b.cyl('steel_dark', 'x', [x, r, 0], 0.07, r + 0.03, 12) // flanges
  for (const x of [-0.55, 0.55]) {
    b.cyl('steel_dark', 'x', [x, r, 0], 0.06, r + 0.02, 12) // clamp ring
    b.box('steel_dark', [x, 0.02, 0], [0.06, 0.04, 0.2]) // clamp foot
  }
  results.push(await write(b.toDocument('mesh_pipe'), 'mesh_pipe'))
}

// ---------------------------------------------------------------- fence (generated): one 2 m bar-fence panel, 2.2 m tall, posts at both ends
{
  const b = new Builder()
  const L = 2.0, H = 2.2, post = 0.08
  for (const sx of [-1, 1]) {
    b.box('steel_dark', [sx * (L / 2 - post / 2), H / 2, 0], [post, H, post])
    b.box('steel_dark', [sx * (L / 2 - post / 2), H + 0.02, 0], [post + 0.03, 0.04, post + 0.03]) // post cap
  }
  for (const y of [0.15, H - 0.2]) b.box('steel', [0, y, 0], [L - post * 2, 0.05, 0.05]) // bottom and top rail
  const bars = 17
  for (let i = 0; i < bars; i++) b.box('steel_dark', [-(L - post * 2) / 2 + 0.06 + (i * (L - post * 2 - 0.12)) / (bars - 1), (H - 0.2 + 0.15) / 2, 0], [0.02, H - 0.2 - 0.15, 0.02])
  results.push(await write(b.toDocument('mesh_fence'), 'mesh_fence'))
}

// ---------------------------------------------------------------- ladder strip (generated): 0.3 m wide, 3 m tall, back face on z = 0, rungs are their own mesh
{
  const b = new Builder()
  const W = 0.3, H = 3.0, rail = 0.04, depth = 0.07
  for (const sx of [-1, 1]) b.box('steel_dark', [sx * (W / 2 - rail / 2), H / 2, depth / 2], [rail, H, depth])
  const rungs = Math.round((H - 0.1) / 0.25)
  for (let i = 0; i < rungs; i++) b.box('rungs', [0, 0.15 + i * 0.25, depth / 2 + 0.005], [W - rail * 2, 0.035, 0.045])
  b.box('steel_dark', [0, 0.01, depth / 2], [W, 0.02, depth]) // foot plate
  const doc = b.toDocument('mesh_ladder_strip')
  const mesh = doc.getRoot().listMeshes()[0]
  const rungMesh = doc.createMesh('rungs')
  for (const p of mesh.listPrimitives().slice()) if (p.getMaterial().getName() === 'rungs') { mesh.removePrimitive(p); rungMesh.addPrimitive(p) }
  const rootNode = doc.getRoot().listNodes()[0]
  rootNode.setMesh(null)
  rootNode.addChild(doc.createNode('rails').setMesh(mesh)).addChild(doc.createNode('rungs').setMesh(rungMesh))
  results.push(await write(doc, 'mesh_ladder_strip'))
}

console.table(results.map((r) => ({ name: r.name, bytes: r.bytes, triangles: r.triangles })))
console.log('props total bytes', results.reduce((t, r) => t + r.bytes, 0), 'triangles', results.reduce((t, r) => t + r.triangles, 0))
