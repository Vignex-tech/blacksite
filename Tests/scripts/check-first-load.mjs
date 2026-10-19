// First-load size check (#80). CLAUDE.md rule 8: first load under 30 MB (hard
// limit), target 20 MB (Docs/art-plan.md section 9). Run after `npm run build`
// in client/. Usage: node scripts/check-first-load.mjs [distDir]
//
//   first load = every file index.html references (script, modulepreload,
//                stylesheet, icon) + manifest assets whose entry has
//                "preload": true and whose file exists.
//   whole dist = everything in client/dist, including lazily loaded chunks and
//                all public assets. A conservative upper bound: the hard limit
//                is checked against it too, so a lazy file cannot hide a
//                bloated download.
// Fails (exit 1) above the hard limit; warns above the target. Raw bytes, no
// dependencies. Also prints the gzip size of the first load for information.
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const dist = path.resolve(process.argv[2] ?? path.join(root, 'client', 'dist'))
const manifest = JSON.parse(readFileSync(path.join(root, 'Manifests', 'assets.json'), 'utf8'))
const HARD = manifest.budgets.firstLoadHardLimitBytes
const TARGET = manifest.budgets.firstLoadTargetBytes

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`no index.html in ${dist}; build the client first (npm run build in client/)`)
  process.exit(2)
}

const html = readFileSync(path.join(dist, 'index.html'), 'utf8')
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
const external = refs.filter((r) => /^(https?:)?\/\//.test(r))
if (external.length) {
  console.error(`index.html loads from an external host: ${external.join(', ')} (no runtime CDN fetches)`)
  process.exit(1)
}

const files = new Map() // relative path -> bytes
const add = (rel) => {
  const abs = path.join(dist, rel)
  if (existsSync(abs) && statSync(abs).isFile() && !files.has(rel)) files.set(rel, readFileSync(abs))
}
add('index.html')
for (const r of refs) add(r.replace(/^\/+/, '').split(/[?#]/)[0])

// Preloaded art: the manifest path is under client/public/, which Vite serves from the dist root.
for (const a of manifest.assets) {
  if (a.preload !== true) continue
  for (const p of expand(a.path)) add(p.replace(/^client\/public\//, ''))
}
function expand(p) {
  const m = /\{([^}]+)\}/.exec(p)
  return m ? m[1].split(',').map((alt) => p.replace(m[0], alt)) : [p]
}

function walk(dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    total += e.isDirectory() ? walk(abs) : statSync(abs).size
  }
  return total
}

let first = 0
let firstGzip = 0
for (const buf of files.values()) {
  first += buf.length
  firstGzip += gzipSync(buf).length
}
const whole = walk(dist)
const mb = (n) => (n / 1e6).toFixed(2) + ' MB'

const lines = [
  `first load: ${mb(first)} (${files.size} files, gzip about ${mb(firstGzip)}); target ${mb(TARGET)}, hard limit ${mb(HARD)}`,
  `whole client/dist: ${mb(whole)} (upper bound, includes lazy chunks and every public asset)`,
]
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### First-load size\n\n' + lines.map((l) => `- ${l}`).join('\n') + '\n')

let failed = false
if (first > HARD) { console.error(`FAIL: first load ${mb(first)} is over the hard limit ${mb(HARD)}`); failed = true }
if (whole > HARD) { console.error(`FAIL: client/dist ${mb(whole)} is over the hard limit ${mb(HARD)}`); failed = true }
if (!failed && (first > TARGET || whole > TARGET)) console.warn(`WARNING: over the ${mb(TARGET)} target (still under the hard limit)`)
process.exit(failed ? 1 : 0)
