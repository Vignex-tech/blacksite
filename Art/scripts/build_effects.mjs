// Generates the effect, screen-glyph and sky textures (client/public/assets/effects/) procedurally. Own work, no downloads:
// every pixel comes from the formulas below, so the files carry no third-party art, no text and no logos.
// Usage: node Art/scripts/build_effects.mjs --out <effects dir>
// Files: tex_muzzle_flash, tex_impact_spark, tex_tracer, tex_dust_puff (RGBA, for additive or alpha particles and quads),
// tex_screen_idle, tex_screen_off, tex_screen_hacked (256x128, distinct glyph shapes, not only colours) and tex_sky_stars.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
const require = createRequire(import.meta.url)
const sharp = require('sharp')

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []))
if (!args.out) throw new Error('missing --out')
await fs.promises.mkdir(args.out, { recursive: true })

// deterministic random numbers so the build is repeatable
const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v)
const mix = (a, b, t) => a + (b - a) * t
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t) }

const written = []
async function saveRgba(name, w, h, fn, opts = { quality: 80, alphaQuality: 90, effort: 6 }) {
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = fn(x, y)
    const i = (y * w + x) * 4
    buf[i] = Math.round(clamp(r) * 255); buf[i + 1] = Math.round(clamp(g) * 255); buf[i + 2] = Math.round(clamp(b) * 255); buf[i + 3] = Math.round(clamp(a) * 255)
  }
  const file = path.join(args.out, name + '.webp')
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).webp(opts).toFile(file)
  written.push([name, `${w}x${h}`, fs.statSync(file).size])
}
async function saveSvg(name, w, h, svg) {
  const file = path.join(args.out, name + '.webp')
  await sharp(Buffer.from(svg), { density: 72 }).resize(w, h).removeAlpha().webp({ quality: 90, effort: 6 }).toFile(file)
  written.push([name, `${w}x${h}`, fs.statSync(file).size])
}

// ---- muzzle flash: hot core, four long spikes and four short diagonal ones, warm white to amber (128 px, <= 20 KB)
await saveRgba('tex_muzzle_flash', 128, 128, (x, y) => {
  const u = (x + 0.5) / 128 * 2 - 1, v = (y + 0.5) / 128 * 2 - 1
  const r = Math.hypot(u, v), th = Math.atan2(v, u)
  const core = Math.exp(-(r * r) / 0.018)
  const spike4 = Math.pow(Math.abs(Math.cos(2 * th)), 14) * Math.exp(-r * 3.2) * smooth(1, 0.55, r)
  const spike8 = Math.pow(Math.abs(Math.cos(2 * (th - Math.PI / 4))), 20) * Math.exp(-r * 6) * 0.7
  const halo = Math.exp(-(r * r) / 0.12) * 0.35
  const a = clamp(core + spike4 + spike8 + halo)
  const heat = clamp(core * 1.4 + spike4 * 0.5)
  return [1, mix(0.62, 0.96, heat), mix(0.22, 0.8, heat), a]
})

// ---- impact spark: small hot centre with eight uneven thin streaks
{
  const rnd = rng(9)
  const rays = Array.from({ length: 8 }, (_, i) => ({ th: (i / 8) * Math.PI * 2 + (rnd() - 0.5) * 0.35, len: 0.45 + rnd() * 0.5, w: 90 + rnd() * 120 }))
  await saveRgba('tex_impact_spark', 128, 128, (x, y) => {
    const u = (x + 0.5) / 128 * 2 - 1, v = (y + 0.5) / 128 * 2 - 1
    const r = Math.hypot(u, v), th = Math.atan2(v, u)
    let a = Math.exp(-(r * r) / 0.012)
    for (const ray of rays) {
      const d = Math.atan2(Math.sin(th - ray.th), Math.cos(th - ray.th))
      a += Math.exp(-(d * d) * ray.w) * smooth(ray.len, 0, r) * 0.85
    }
    a = clamp(a)
    return [1, mix(0.75, 0.97, a * a), mix(0.35, 0.82, a * a), a]
  })
}

// ---- tracer: a streak, bright at the head (v = 0) fading to a thin tail (32x128)
await saveRgba('tex_tracer', 32, 128, (x, y) => {
  const u = Math.abs((x + 0.5) / 32 * 2 - 1), t = (y + 0.5) / 128
  const width = mix(0.22, 1.0, Math.pow(1 - t, 0.5))
  const edge = clamp(1 - u / width)
  const along = Math.pow(1 - t, 1.6)
  const a = clamp(edge * edge * along * 1.2)
  const core = clamp(edge * along)
  return [1, mix(0.85, 0.97, core), mix(0.55, 0.88, core), a]
}, { quality: 85, alphaQuality: 95, effort: 6 })

// ---- dust puff: soft grey-blue cloud with value noise (alpha is the shape)
{
  const rnd = rng(21)
  const N = 16
  const grid = Array.from({ length: N * N }, () => rnd())
  const noise = (px, py, f) => {
    const gx = ((px * f) % N + N) % N, gy = ((py * f) % N + N) % N
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0
    const g = (a, b) => grid[((b % N) * N) + (a % N)]
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
    return mix(mix(g(x0, y0), g(x0 + 1, y0), sx), mix(g(x0, y0 + 1), g(x0 + 1, y0 + 1), sx), sy)
  }
  await saveRgba('tex_dust_puff', 128, 128, (x, y) => {
    const u = (x + 0.5) / 128, v = (y + 0.5) / 128
    const r = Math.hypot(u - 0.5, v - 0.5) * 2
    const n = noise(u, v, 3) * 0.6 + noise(u, v, 7) * 0.4
    const a = clamp((1 - smooth(0.25, 1, r + (n - 0.5) * 0.5)) * 0.8)
    const shade = mix(0.5, 0.68, n)
    return [shade * 0.95, shade, shade * 1.06, a]
  })
}

// ---- screen glyphs (256x128): drawn from shapes only, no text. Idle = target ring, off = power symbol, hacked = check mark.
const frame = (c) => `<rect x="6" y="6" width="244" height="116" rx="14" fill="none" stroke="${c}" stroke-width="3"/>`
await saveSvg('tex_screen_idle', 256, 128, `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128">
  <rect width="256" height="128" fill="#06140c"/>${frame('#2f8f55')}
  <g fill="none" stroke="#49c477" stroke-width="5"><circle cx="128" cy="64" r="36"/><circle cx="128" cy="64" r="16" stroke-width="4"/></g>
  <g stroke="#49c477" stroke-width="5" stroke-linecap="round"><path d="M128 14v18M128 96v18M78 64h-18M196 64h18"/></g>
  <circle cx="128" cy="64" r="5" fill="#7fe6a3"/>
  <g stroke="#1f6a3c" stroke-width="2"><path d="M20 30h24M20 98h24M212 30h24M212 98h24"/></g></svg>`)
await saveSvg('tex_screen_off', 256, 128, `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128">
  <rect width="256" height="128" fill="#0a0c0f"/>${frame('#1c2127')}
  <g fill="none" stroke="#343b44" stroke-width="6" stroke-linecap="round"><path d="M108 42a34 34 0 1 0 40 0"/><path d="M128 28v32"/></g>
  <path d="M60 106l136-84" stroke="#262c33" stroke-width="3" stroke-linecap="round"/></svg>`)
await saveSvg('tex_screen_hacked', 256, 128, `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128">
  <rect width="256" height="128" fill="#1a1005"/>${frame('#a8741c')}
  <rect x="86" y="24" width="84" height="80" rx="10" fill="none" stroke="#c98a22" stroke-width="4"/>
  <path d="M104 66l16 18 34-40" fill="none" stroke="#f0b13a" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <g stroke="#6e4b12" stroke-width="2"><path d="M20 30h40M20 98h40M196 30h40M196 98h40"/></g></svg>`)

// ---- sky stars: 1024x512 equirectangular, black with sparse points (no moon). Used as an emissive layer on the sky dome.
{
  const W = 1024, H = 512
  const px = new Float32Array(W * H * 3)
  const rnd = rng(77)
  for (let i = 0; i < 1500; i++) {
    const z = rnd() * 2 - 1, lon = rnd() * Math.PI * 2
    const lat = Math.asin(z)
    const cx = (lon / (Math.PI * 2)) * W, cy = (0.5 - lat / Math.PI) * H
    const b = Math.pow(rnd(), 3.5) * 0.85 + 0.12
    const warm = rnd() < 0.12
    const col = warm ? [1, 0.88, 0.72] : [0.8, 0.88, 1]
    const sx = Math.min(5, 1 / Math.max(0.2, Math.cos(lat))) * (0.55 + b * 0.45), sy = 0.55 + b * 0.45
    for (let dy = -3; dy <= 3; dy++) for (let dx = -8; dx <= 8; dx++) {
      const x = Math.round(cx + dx), y = Math.round(cy + dy)
      if (y < 0 || y >= H) continue
      const xx = ((x % W) + W) % W
      const d = (dx / sx) ** 2 + (dy / sy) ** 2
      const v = b * Math.exp(-d * 1.4)
      if (v < 0.01) continue
      const o = (y * W + xx) * 3
      for (let c = 0; c < 3; c++) px[o + c] = Math.min(1, px[o + c] + v * col[c])
    }
  }
  const buf = Buffer.alloc(W * H * 3)
  for (let i = 0; i < buf.length; i++) buf[i] = Math.round(clamp(px[i]) * 255)
  const file = path.join(args.out, 'tex_sky_stars.webp')
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).webp({ quality: 88, effort: 6 }).toFile(file)
  written.push(['tex_sky_stars', `${W}x${H}`, fs.statSync(file).size])
}

console.table(written.map(([name, size, bytes]) => ({ name, size, bytes })))
console.log('effects total bytes', written.reduce((t, w) => t + w[2], 0))
