import { describe, expect, it } from 'vitest'
import { DEFAULT_GFX_TIER, GFX_SETTINGS, gfxSettingsFor, parseGfxTier } from '../../client/src/graphics.ts'

// #80: the player default tier is medium (owner decision on #77); tests pass ?gfx=low.
describe('graphics tiers', () => {
  it('defaults to medium, and falls back to it for unknown values', () => {
    expect(DEFAULT_GFX_TIER).toBe('medium')
    expect(parseGfxTier('')).toBe('medium')
    expect(parseGfxTier('?gfx=ultra')).toBe('medium')
    expect(parseGfxTier('?other=1')).toBe('medium')
  })
  it('reads ?gfx=low|medium|high, case-insensitively', () => {
    expect(parseGfxTier('?gfx=low')).toBe('low')
    expect(parseGfxTier('?a=1&gfx=HIGH')).toBe('high')
    expect(gfxSettingsFor('?gfx=medium')).toBe(GFX_SETTINGS.medium)
  })
  it('low has no shadows or post effects; budgets never exceed the plan', () => {
    expect(GFX_SETTINGS.low).toMatchObject({ shadows: false, postEffects: false, shadowMapSize: 0 })
    for (const s of Object.values(GFX_SETTINGS)) {
      expect(s.maxLocalLights).toBeLessThanOrEqual(3)
      expect(s.maxTextureSize).toBeLessThanOrEqual(1024)
    }
  })
})
