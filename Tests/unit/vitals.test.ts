import { describe, expect, it } from 'vitest'
import { hookVitals } from '../e2e/support/vitals.ts'
import type { BlacksiteSnapshot } from '../../shared/testhook.js'

// #40: the e2e vitals reader tolerates missing and present fields.
const snap = (players: unknown[]) => ({ version: 1, players }) as unknown as BlacksiteSnapshot

describe('hookVitals', () => {
  it('omits missing fields, passes present ones, ignores wrong types', () => {
    const s = snap([
      { id: 'a' },
      { id: 'b', health: 75, ammo: 3, reloading: false },
      { id: 'c', health: 'x', ammo: null, reloading: 1 },
    ])
    expect(hookVitals(s, 'a')).toEqual({})
    expect(hookVitals(s, 'b')).toEqual({ health: 75, ammo: 3, reloading: false })
    expect(hookVitals(s, 'c')).toEqual({})
    expect(hookVitals(s, 'zz')).toBeUndefined()
  })
})
