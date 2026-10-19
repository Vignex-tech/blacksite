// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// #49: weapon and health numbers come from shared/, never from client/ (#48).
// (Separate file: it needs the node environment for file URLs.)

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

describe('no weapon numbers hard-coded in client/', () => {
  const src = (f: string) =>
    readFileSync(join(ROOT, 'client/src', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('vitals.ts reads maximums from shared; HUD strings have no digits', () => {
    const t = src('vitals.ts')
    expect(t).toMatch(/MAX_HEALTH/)
    expect(t).toMatch(/WEAPONS/)
    expect(t).not.toMatch(/\b(100|150)\b/) // the two max health values
    expect(t).not.toMatch(/magazine:\s*\d/)
  })

  it('no client file redefines the weapon table or max health', () => {
    for (const f of ['vitals.ts', 'net.ts', 'main.ts', 'players.ts', 'testHook.ts', 'cameras.ts', 'scene.ts', 'input.ts']) {
      const t = src(f)
      expect(t, f).not.toMatch(/\b(intervalMs|reloadMs)\b/)
      expect(t, f).not.toMatch(/(const|let)\s+(MAX_HEALTH|WEAPONS)\b/)
      expect(t, f).not.toMatch(/damage:\s*\d/)
    }
  })
})
