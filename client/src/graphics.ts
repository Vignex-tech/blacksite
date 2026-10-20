/**
 * Graphics tiers (M8, #79), picked with the `?gfx=low|medium|high` URL
 * parameter. They change rendering only: nothing here is a gameplay value, a
 * message field or a server setting, and no game rule reads them.
 *
 * - low: no shadows, no post effects (tests default to this; weak machines).
 * - medium: the player default (the owner's integrated GPU targets 60 fps here).
 * - high: shadows, post effects, the best textures and fog.
 *
 * The settings are read by the systems that arrive in later M8 issues
 * (lighting in #87, textured surfaces in #85); this module only decides them.
 */
export type GfxTier = 'low' | 'medium' | 'high'

export interface GfxSettings {
  tier: GfxTier
  /** Directional-light shadows. */
  shadows: boolean
  /** Shadow map size in pixels (0 when shadows are off). */
  shadowMapSize: number
  /** Post effects such as anti-aliasing. */
  postEffects: boolean
  /** Largest texture edge to load, in pixels. */
  maxTextureSize: number
  /** Fog: a cheap linear fog, or fog with a height falloff. */
  fog: 'linear' | 'full'
  /** Practical (point) lights allowed at once. */
  maxLocalLights: number
  /** Shadow filter: `soft` is PCF at low quality, `softer` at medium quality (high only). */
  shadowFilter: 'none' | 'soft' | 'softer'
  /** The shadow map is re-rendered every this many frames (moving characters are casters). */
  shadowRefresh: number
  /** Bloom on emissives, FXAA and filmic tone mapping through a render pipeline (high only). */
  bloom: boolean
  /** The moon light and the sky dome with stars (low keeps the old flat look, one light). */
  moonAndSky: boolean
}

export const DEFAULT_GFX_TIER: GfxTier = 'medium'

export const GFX_SETTINGS: Readonly<Record<GfxTier, GfxSettings>> = {
  low: { tier: 'low', shadows: false, shadowMapSize: 0, postEffects: false, maxTextureSize: 512, fog: 'linear', maxLocalLights: 0, shadowFilter: 'none', shadowRefresh: 0, bloom: false, moonAndSky: false },
  medium: { tier: 'medium', shadows: true, shadowMapSize: 1024, postEffects: false, maxTextureSize: 1024, fog: 'full', maxLocalLights: 2, shadowFilter: 'soft', shadowRefresh: 2, bloom: false, moonAndSky: true },
  high: { tier: 'high', shadows: true, shadowMapSize: 1024, postEffects: true, maxTextureSize: 1024, fog: 'full', maxLocalLights: 3, shadowFilter: 'softer', shadowRefresh: 1, bloom: true, moonAndSky: true },
}

/** Reads `gfx` from a query string (`location.search`); anything unknown gives the default. */
export function parseGfxTier(search: string): GfxTier {
  const value = new URLSearchParams(search).get('gfx')?.toLowerCase()
  return value === 'low' || value === 'medium' || value === 'high' ? value : DEFAULT_GFX_TIER
}

export function gfxSettingsFor(search: string): GfxSettings {
  return GFX_SETTINGS[parseGfxTier(search)]
}
