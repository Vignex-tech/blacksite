// Builds the environment PBR texture sets (client/public/assets/textures/) from ambientCG 1K-JPG downloads (CC0).
// Usage (Windows paths in Git Bash must be C:/...):
//   node Art/scripts/build_textures.mjs --src <folder holding one extracted folder per ambientCG id> --out <textures dir>
// Each set becomes tex_<surface>_albedo.webp, tex_<surface>_normal.webp and tex_<surface>_orm.webp (R occlusion,
// G roughness, B metal; the glTF convention). The source files are only parsed as images, nothing from the downloads runs.
// Grading (colour, brightness, noise) is data in SETS below; #84 reviewed every source set by eye first and
// replaced or regraded the ones that did not fit (the PaintedMetal004 set is bright red and is repainted muted green).
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
const require = createRequire(import.meta.url)
const sharp = require('sharp')

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []))
for (const k of ['src', 'out']) if (!args[k]) throw new Error(`missing --${k}`)

const COLD = [0.94, 0.99, 1.06] // cold blue-gray bias applied to every grey surface

// size: 1024 only for wall, floor and ground; 512 for the rest (Docs/art-plan.md section 9)
// mean: target mean albedo value (0..255 sRGB) so upper walls stay light enough for a dark Ghost to read against (rule 7)
// sat: colour kept from the source (0 = grey); contrast: pull of every texel towards the mean (noise control)
// normal: strength of the normal map (1 = as authored); rough: [min, max] clamp (never mirror-like); ao: occlusion strength
// metal: 'map' (threshold the source map, scaled by metalScale), 0 (dielectric) or a fixed value. metalScale is below 1 on
// the two steel sets because the scene ships without a full reflection environment, where metal 1 renders almost black (rule 7).
// powder-coat is paint, so panel_powder is a dielectric.
const SETS = [
  { surface: 'concrete_smooth', id: 'Concrete034', size: 1024, mean: 150, sat: 0.4, tint: COLD, contrast: 1.5, normal: 0.9, rough: [0.62, 0.95], ao: 0, metal: 0 },
  { surface: 'concrete_rough', id: 'Concrete037', size: 1024, mean: 118, sat: 0.3, tint: COLD, contrast: 0.55, normal: 0.6, rough: [0.7, 0.95], ao: 0.6, metal: 0 },
  { surface: 'concrete_painted', id: 'PaintedPlaster012', size: 1024, mean: 128, sat: 0.3, tint: [0.92, 1.0, 1.05], contrast: 1.4, normal: 0.8, rough: [0.6, 0.9], ao: 0.5, metal: 0 },
  { surface: 'concrete_damp', id: 'Concrete033', size: 1024, mean: 84, sat: 0.45, tint: [0.92, 1.0, 1.04], contrast: 1.1, normal: 0.9, rough: [0.45, 0.85], ao: 0.7, metal: 0 },
  { surface: 'steel_painted', id: 'PaintedMetal004', size: 512, repaint: [78, 92, 82], mean: 92, contrast: 0.8, normal: 0.7, rough: [0.4, 0.85], ao: 0, metal: 0 },
  { surface: 'steel_brushed', id: 'Metal038', size: 512, mean: 128, sat: 0.3, tint: COLD, contrast: 2.2, normal: 0.8, rough: [0.35, 0.8], ao: 0, metal: 'map', metalScale: 0.55 },
  { surface: 'steel_rusted', id: 'Rust004', size: 512, mean: 74, sat: 0.45, tint: [0.98, 1.0, 1.04], contrast: 1.0, normal: 0.8, rough: [0.55, 0.95], ao: 0, metal: 0 },
  { surface: 'panel_powder', id: 'Metal027', size: 512, mean: 46, sat: 0.6, tint: COLD, contrast: 2.0, normal: 0.7, rough: [0.4, 0.75], ao: 0, metal: 0 },
  { surface: 'floor_plate', id: 'DiamondPlate008A', size: 1024, mean: 96, sat: 0.5, tint: COLD, contrast: 1.6, normal: 1.0, rough: [0.38, 0.85], ao: 0.7, metal: 'map', metalScale: 0.55 },
  { surface: 'ground', id: 'Asphalt033', size: 1024, mean: 62, sat: 0.25, tint: [0.94, 0.99, 1.06], contrast: 1.2, normal: 0.6, rough: [0.8, 0.97], ao: 0.5, metal: 0 },
]

const WEBP = { albedo: { quality: 85, effort: 6 }, normal: { quality: 92, effort: 6, smartSubsample: true }, orm: { quality: 90, effort: 6, smartSubsample: true } }

const clamp = (v, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v)

async function readRaw(file, size, channels = 3) {
  let img = sharp(file).resize(size, size, { fit: 'fill' }).removeAlpha()
  if (channels === 1) img = img.greyscale()
  const { data } = await img.raw().toBuffer({ resolveWithObject: true })
  return data
}

function gradeAlbedo(rgb, s) {
  const n = rgb.length / 3
  const out = Buffer.alloc(rgb.length)
  const lum = (i) => 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]
  if (s.repaint) {
    // The source is red paint over bare metal (scratches are grey). Keep its luminance structure, repaint the paint
    // muted green and the scratches as dull bare steel, so it fits the security-gear green of the palette.
    let mean = 0
    for (let p = 0; p < n; p++) mean += lum(p * 3)
    mean /= n
    for (let p = 0; p < n; p++) {
      const i = p * 3
      const L = lum(i) / mean
      const paintiness = clamp((rgb[i] - Math.max(rgb[i + 1], rgb[i + 2])) / 120, 0, 1)
      const paint = [s.repaint[0] * (0.55 + 0.45 * L), s.repaint[1] * (0.55 + 0.45 * L), s.repaint[2] * (0.55 + 0.45 * L)]
      const steel = [s.mean * 1.05 * L, s.mean * 1.08 * L, s.mean * 1.14 * L]
      for (let c = 0; c < 3; c++) out[i + c] = clamp(steel[c] + (paint[c] - steel[c]) * paintiness)
    }
    return out
  }
  // pass 1: desaturate and tint
  const tmp = new Float32Array(rgb.length)
  let mean = 0
  for (let p = 0; p < n; p++) {
    const i = p * 3
    const L = lum(i)
    for (let c = 0; c < 3; c++) tmp[i + c] = (L + (rgb[i + c] - L) * s.sat) * s.tint[c]
    mean += 0.2126 * tmp[i] + 0.7152 * tmp[i + 1] + 0.0722 * tmp[i + 2]
  }
  mean /= n
  // pass 2: move the mean to the target and scale the deviation by the contrast factor
  const gain = s.mean / mean
  for (let i = 0; i < rgb.length; i++) out[i] = clamp(s.mean + (tmp[i] * gain - s.mean) * s.contrast)
  return out
}

function gradeNormal(rgb, strength) {
  const out = Buffer.alloc(rgb.length)
  for (let i = 0; i < rgb.length; i += 3) {
    let x = (rgb[i] / 255) * 2 - 1, y = (rgb[i + 1] / 255) * 2 - 1, z = (rgb[i + 2] / 255) * 2 - 1
    x *= strength; y *= strength
    const l = Math.hypot(x, y, z) || 1
    out[i] = clamp(Math.round(((x / l) * 0.5 + 0.5) * 255))
    out[i + 1] = clamp(Math.round(((y / l) * 0.5 + 0.5) * 255))
    out[i + 2] = clamp(Math.round(((z / l) * 0.5 + 0.5) * 255))
  }
  return out
}

await fs.promises.mkdir(args.out, { recursive: true })
const report = []
for (const s of SETS) {
  const dir = path.join(args.src, s.id)
  const f = (suffix) => path.join(dir, `${s.id}_1K-JPG_${suffix}.jpg`)
  const color = await readRaw(f('Color'), s.size)
  const normal = await readRaw(f('NormalGL'), s.size)
  const rough = await readRaw(f('Roughness'), s.size, 1)
  const ao = fs.existsSync(f('AmbientOcclusion')) ? await readRaw(f('AmbientOcclusion'), s.size, 1) : null
  const metalMap = s.metal === 'map' ? await readRaw(f('Metalness'), s.size, 1) : null

  const albedo = gradeAlbedo(color, s)
  const nrm = gradeNormal(normal, s.normal)
  const orm = Buffer.alloc(s.size * s.size * 3)
  for (let p = 0; p < s.size * s.size; p++) {
    const a = ao ? ao[p] : 255
    orm[p * 3] = Math.round(255 - (255 - a) * s.ao)
    orm[p * 3 + 1] = Math.round(clamp(rough[p] / 255, s.rough[0], s.rough[1]) * 255)
    orm[p * 3 + 2] = metalMap ? (metalMap[p] > 127 ? Math.round(255 * (s.metalScale ?? 1)) : 0) : Math.round(255 * (typeof s.metal === 'number' ? s.metal : 0))
  }
  const sizes = {}
  for (const [kind, buf] of [['albedo', albedo], ['normal', nrm], ['orm', orm]]) {
    const file = path.join(args.out, `tex_${s.surface}_${kind}.webp`)
    await sharp(buf, { raw: { width: s.size, height: s.size, channels: 3 } }).webp(WEBP[kind]).toFile(file)
    sizes[kind] = fs.statSync(file).size
  }
  report.push({ surface: s.surface, id: s.id, px: s.size, ...sizes, total: sizes.albedo + sizes.normal + sizes.orm })
}
console.table(report)
console.log('textures total bytes', report.reduce((t, r) => t + r.total, 0))
