import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// #80: the CI first-load size check (scripts/check-first-load.mjs) on fake dist folders.
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-first-load.mjs')

function run(files: Record<string, number>, html: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-dist-'))
  try {
    mkdirSync(path.join(dir, 'assets'))
    writeFileSync(path.join(dir, 'index.html'), html)
    for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 7))
    return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const page = '<script type="module" src="/assets/index.js"></script>'

describe('check-first-load.mjs', () => {
  it('passes a small build and reports the size', () => {
    const r = run({ 'assets/index.js': 1_000_000 }, page)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/first load: 1\.0\d MB/)
  })
  it('warns above the 20 MB target but passes', () => {
    const r = run({ 'assets/index.js': 21_000_000 }, page)
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/WARNING/)
  })
  it('fails above the 30 MB hard limit', () => {
    const r = run({ 'assets/index.js': 31_000_000 }, page)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/hard limit/)
  })
  it('fails when the whole dist is over the hard limit even if the page loads little', () => {
    const r = run({ 'assets/index.js': 1000, 'assets/big.glb': 31_000_000 }, page)
    expect(r.status).toBe(1)
  })
  it('fails when index.html loads from an external host', () => {
    const r = run({ 'assets/index.js': 1000 }, page + '<script src="https://cdn.example.com/x.js"></script>')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/external host/)
  })
})
