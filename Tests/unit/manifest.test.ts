import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGlb, parseGlb } from './support/glb.ts'

// #80: validator for Manifests/assets.json (the art ledger, #78). Rules come
// from Docs/art-plan.md sections 8, 9 and 11. Entries may carry a free-text
// `notes` field (listed in entryFields). Entries that are `planned` need no
// file yet; `ready` and `used` entries must exist and respect their budgets.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const manifest = JSON.parse(readFileSync(path.join(root, 'Manifests', 'assets.json'), 'utf8'))
const assets: Record<string, any>[] = manifest.assets

const CATEGORIES = ['characters', 'props', 'textures', 'effects']
const STATUSES = ['planned', 'ready', 'used']
const PREFIXES = ['mesh_', 'tex_', 'anim_', 'sfx_']
const REQUIRED = ['name', 'category', 'sourceName', 'sourceUrl', 'licence', 'licenceUrl', 'author', 'path', 'maxBytes', 'maxTriangles', 'status', 'dateChecked']

/** Expands one `{a,b,c}` group in a path, as the manifest writes texture sets. */
function expandPath(p: string): string[] {
  const m = /\{([^}]+)\}/.exec(p)
  if (!m) return [p]
  return m[1].split(',').map((alt) => p.replace(m[0], alt))
}

describe('Manifests/assets.json', () => {
  it('has the header fields and the budgets from the art plan', () => {
    expect(manifest.version).toBe(1)
    expect(typeof manifest.notes).toBe('string')
    expect(manifest.licenseAllowed).toEqual(['CC0-1.0'])
    expect(manifest.budgets.firstLoadHardLimitBytes).toBe(30_000_000)
    expect(manifest.budgets.firstLoadTargetBytes).toBe(20_000_000)
    expect(manifest.budgets.triangles).toMatchObject({ mesh_ghost: 4000, mesh_warden: 5000, mesh_rifle: 1500, prop: 2000 })
    expect(manifest.budgets.frame).toMatchObject({ maxDrawCalls: 120, maxActiveTriangles: 150000, maxShadowCasters: 2, maxLocalLights: 3 })
    expect(assets.length).toBeGreaterThan(0)
  })

  it('names are unique, lowercase snake_case with a known prefix', () => {
    const names = assets.map((a) => a.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) {
      expect(n, n).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(PREFIXES.some((p) => n.startsWith(p)), `${n} has a prefix from ${PREFIXES.join(', ')}`).toBe(true)
    }
  })

  it('every entry has the required fields and only declared fields (notes allowed)', () => {
    expect(manifest.entryFields).toContain('notes')
    for (const a of assets) {
      for (const f of REQUIRED) expect(a[f], `${a.name}.${f}`).not.toBeUndefined()
      for (const k of Object.keys(a)) expect([...manifest.entryFields, 'preload'], `${a.name} has undeclared field ${k}`).toContain(k)
      expect(CATEGORIES, a.name).toContain(a.category)
      expect(STATUSES, a.name).toContain(a.status)
      if (a.preload !== undefined) expect(typeof a.preload, `${a.name}.preload`).toBe('boolean')
      if (a.notes !== undefined) expect(typeof a.notes, `${a.name}.notes`).toBe('string')
      expect(a.dateChecked, a.name).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isInteger(a.maxBytes) && a.maxBytes > 0, `${a.name}.maxBytes`).toBe(true)
      expect(Number.isInteger(a.maxTriangles) && a.maxTriangles >= 0, `${a.name}.maxTriangles`).toBe(true)
    }
  })

  it('every licence is CC0 and every source and licence link is https', () => {
    for (const a of assets) {
      expect(manifest.licenseAllowed, `${a.name} licence`).toContain(a.licence)
      expect(a.sourceUrl, `${a.name}.sourceUrl`).toMatch(/^https:\/\/\S+$/)
      expect(a.licenceUrl, `${a.name}.licenceUrl`).toMatch(/^https:\/\/\S+$/)
      expect(String(a.author).trim().length, `${a.name}.author`).toBeGreaterThan(0)
    }
  })

  it('paths sit under client/public/assets/<category>/ and files start with the asset name', () => {
    const seen = new Set<string>()
    for (const a of assets) {
      expect(a.path, a.name).not.toMatch(/\.\.|\\|^\/|:/)
      for (const p of expandPath(a.path)) {
        expect(p.startsWith(`client/public/assets/${a.category}/`), `${a.name}: ${p}`).toBe(true)
        const file = path.posix.basename(p)
        expect(file, p).toMatch(/^[a-z0-9_]+\.(glb|webp|jpg|png|env|ogg|mp3)$/)
        expect(file.startsWith(a.name), `${file} starts with ${a.name}`).toBe(true)
        expect(seen.has(p), `duplicate path ${p}`).toBe(false)
        seen.add(p)
      }
    }
  })

  it('triangle budgets hold', () => {
    const t = manifest.budgets.triangles
    let props = 0
    for (const a of assets) {
      if (a.name === 'mesh_ghost' || a.name === 'mesh_warden' || a.name === 'mesh_rifle') {
        expect(a.maxTriangles, a.name).toBeLessThanOrEqual(t[a.name])
      } else if (a.name.startsWith('mesh_prop_')) {
        expect(a.maxTriangles, a.name).toBeLessThanOrEqual(t.prop)
        props += a.maxTriangles
      } else if (a.name.startsWith('tex_')) {
        expect(a.maxTriangles, a.name).toBe(0)
      }
    }
    expect(props, 'sum of prop triangle budgets').toBeLessThanOrEqual(t.propsTotal)
  })

  it('the byte ceilings fit the first-load target', () => {
    // maxBytes are per-file ceilings of a planned set, not what is loaded at
    // once, so they are checked against the whole target, not per category.
    const total = assets.reduce((s, a) => s + a.maxBytes, 0)
    expect(total, 'sum of all maxBytes').toBeLessThanOrEqual(manifest.budgets.firstLoadTargetBytes)
    const cats = manifest.budgets.categoryBytes
    expect(Object.values<number>(cats).reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(manifest.budgets.firstLoadTargetBytes)
  })

  it('ready and used entries exist, fit their byte budget and (glb) their triangle budget', () => {
    const cats: Record<string, number> = {}
    for (const a of assets.filter((x) => x.status !== 'planned')) {
      for (const p of expandPath(a.path)) {
        const abs = path.join(root, p)
        expect(existsSync(abs), `${a.name}: ${p} exists`).toBe(true)
        const size = statSync(abs).size
        cats[a.category] = (cats[a.category] ?? 0) + size
        // A set of files (braces) shares one ceiling across its files.
        if (!a.path.includes('{')) expect(size, `${p} size`).toBeLessThanOrEqual(a.maxBytes)
        if (p.endsWith('.glb')) {
          const info = parseGlb(new Uint8Array(readFileSync(abs)))
          expect(info.triangles, `${p} triangles`).toBeLessThanOrEqual(a.maxTriangles)
          expect(info.externalUris, `${p} must be self-contained`).toEqual([])
          // No decoder is hosted, so no compressed-geometry or texture extension (a CDN fetch otherwise).
          for (const ext of [...info.extensionsUsed, ...info.extensionsRequired]) {
            expect(['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression'], `${p} uses ${ext}`).not.toContain(ext)
          }
        }
      }
    }
    for (const [cat, bytes] of Object.entries(cats)) {
      expect(bytes, `${cat} actual bytes`).toBeLessThanOrEqual(manifest.budgets.categoryBytes[cat])
    }
  })

  it('no entry or note names an existing game franchise', () => {
    const banned = /\b(halo|call of duty|rainbow six|splinter cell|metal gear|assassin.?s creed|counter-?strike|overwatch|valorant|fortnite)\b/i
    for (const a of assets) expect(JSON.stringify(a), a.name).not.toMatch(banned)
  })
})

describe('glb inspector (support/glb.ts)', () => {
  it('counts triangles, animations, extensions and external uris from the JSON chunk', () => {
    const info = parseGlb(
      buildGlb(12, {
        animations: [{ name: 'Idle_Loop' }, {}],
        extensionsUsed: ['KHR_materials_unlit'],
        images: [{ uri: 'https://cdn.example/x.png' }, { uri: 'data:image/png;base64,AAAA' }],
      }),
    )
    expect(info.triangles).toBe(12)
    expect(info.meshes).toBe(1)
    expect(info.animations).toEqual(['Idle_Loop', 'animation_1'])
    expect(info.extensionsUsed).toEqual(['KHR_materials_unlit'])
    expect(info.externalUris).toEqual(['https://cdn.example/x.png'])
  })

  it('rejects a file that is not a glb', () => {
    expect(() => parseGlb(new Uint8Array(32))).toThrow(/magic/)
  })
})
