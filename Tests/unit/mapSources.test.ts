// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GRAYBOX_MAP } from '../../shared/map.js'

// Source checks for #16 (the "grep" criteria): the map layout lives only in
// shared/map.js, client/ renders it from there, and shared/ stays free of
// Babylon and browser-only code so the server can import it.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

function files(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...files(p, exts))
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

const read = (p: string) => ({ path: relative(ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') })

/** Source without // and /* comments (good enough for these files). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const CLIENT = [...files(join(ROOT, 'client/src'), ['.ts', '.js']), join(ROOT, 'client/index.html')].map(read)
const SHARED = files(join(ROOT, 'shared'), ['.js', '.d.ts']).map(read)

describe('client/ does not hard-code the map layout', () => {
  it('found the client sources', () => {
    expect(CLIENT.map((f) => f.path)).toContain('client/src/map.ts')
  })

  it('names no map, solid, entrance or terminal id', () => {
    const ids = [
      GRAYBOX_MAP.id,
      ...GRAYBOX_MAP.solids.map((s) => s.id),
      ...GRAYBOX_MAP.entrances.map((e) => e.id),
      ...GRAYBOX_MAP.terminals.map((t) => t.id),
    ]
    const hits = CLIENT.flatMap((f) => ids.filter((id) => f.text.includes(id)).map((id) => `${f.path}: ${id}`))
    expect(hits).toEqual([])
  })

  it('contains no coordinates that only the layout uses', () => {
    // Every distinct non-integer coordinate in the map (7.5, 9.75, 13.5, ...).
    // Integers are too common (sizes, counts) to tell apart from layout.
    const coords = new Set<number>()
    for (const s of GRAYBOX_MAP.solids) for (const v of [s.min.x, s.max.x, s.min.z, s.max.z]) coords.add(Math.abs(v))
    for (const p of [...GRAYBOX_MAP.entrances, ...GRAYBOX_MAP.terminals]) coords.add(Math.abs(p.x)).add(Math.abs(p.z))
    const fractional = [...coords].filter((v) => !Number.isInteger(v))
    expect(fractional.length).toBeGreaterThan(0)
    const hits: string[] = []
    for (const f of CLIENT) {
      const nums = code(f.text).match(/(?<![\w.])\d+\.\d+(?![\w.])/g) ?? []
      for (const n of nums) if (fractional.includes(Number(n))) hits.push(`${f.path}: ${n}`)
    }
    expect(hits).toEqual([])
  })

  it('renders from GRAYBOX_MAP in shared/map.js', () => {
    const map = CLIENT.find((f) => f.path === 'client/src/map.ts')!.text
    expect(map).toMatch(/import\s*\{[^}]*\bGRAYBOX_MAP\b[^}]*\}\s*from\s*'(\.\.\/)+shared\/map\.js'/)
    expect(map).toMatch(/\.solids\b/)
    expect(map).toMatch(/\.terminals\b/)
    expect(map).toMatch(/\bbounds\b/)
  })
})

describe('shared/ has no Babylon or browser-only code', () => {
  it('found map.js and map.d.ts', () => {
    expect(SHARED.map((f) => f.path)).toEqual(expect.arrayContaining(['shared/map.js', 'shared/map.d.ts']))
  })

  it('imports nothing but other shared/ files', () => {
    const bad: string[] = []
    for (const f of SHARED) {
      const specs = [...code(f.text).matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)]
      for (const m of specs) {
        const spec = m[1] ?? m[2]
        if (!/^\.\/[\w.-]+\.js$/.test(spec)) bad.push(`${f.path}: ${spec}`)
      }
      if (/@babylonjs|\bBABYLON\b/.test(code(f.text))) bad.push(`${f.path}: Babylon`)
    }
    expect(bad).toEqual([])
  })

  it('runtime files use no browser globals', () => {
    const globals = /\b(window|document|navigator|localStorage|sessionStorage|requestAnimationFrame|HTMLElement|HTMLCanvasElement|WebGL\w*)\b/
    const hits = SHARED.filter((f) => f.path.endsWith('.js') && !f.path.endsWith('.d.ts'))
      .filter((f) => globals.test(code(f.text)))
      .map((f) => `${f.path}: ${code(f.text).match(globals)![0]}`)
    expect(hits).toEqual([])
  })
})
