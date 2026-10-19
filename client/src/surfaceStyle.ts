/**
 * Data-driven surface styling (M8, #79). A surface kind (what the map data
 * calls a wall, a cover box, a floor slab, a ramp, the ground) maps to a
 * material key. A later map with more kinds or zones only adds entries here;
 * map.ts never names a colour or texture itself.
 *
 * Material keys name the texture sets in Manifests/assets.json
 * (`tex_<key>_{albedo,normal,orm}`), which #84 and #85 fill in. Until a
 * textured material exists for a key, `fallback` (a flat colour) is used, so
 * the look today is the same as the graybox.
 */
export type SurfaceKind = 'wall' | 'cover' | 'floor' | 'ramp' | 'ground'

export type MaterialKey =
  | 'concrete_painted'
  | 'metal_painted'
  | 'floor_plate'
  | 'metal_brushed'
  | 'ground_asphalt'

export interface SurfaceStyle {
  material: MaterialKey
  /** Flat diffuse colour (r, g, b in 0..1) used while no textured material is available. */
  fallback: readonly [number, number, number]
}

export const SURFACE_STYLE: Readonly<Record<SurfaceKind, SurfaceStyle>> = {
  // Neutral greys, well away from the player colours.
  wall: { material: 'concrete_painted', fallback: [0.62, 0.62, 0.63] },
  cover: { material: 'metal_painted', fallback: [0.42, 0.42, 0.43] },
  // Upper-level slabs: cool blue-grey.
  floor: { material: 'floor_plate', fallback: [0.4, 0.46, 0.55] },
  // Stairs: warm tan, so the Warden route reads at a glance.
  ramp: { material: 'metal_brushed', fallback: [0.55, 0.47, 0.34] },
  ground: { material: 'ground_asphalt', fallback: [0.24, 0.24, 0.25] },
}

/** The style for a kind; an unknown kind (a newer map) falls back to the wall style. */
export function surfaceStyleFor(kind: string): SurfaceStyle {
  return (SURFACE_STYLE as Record<string, SurfaceStyle | undefined>)[kind] ?? SURFACE_STYLE.wall
}

/** Name of the shared material for a kind: `<kind>Mat` (wallMat, coverMat, floorMat, rampMat, groundMat). */
export function surfaceMaterialName(kind: SurfaceKind): string {
  return `${kind}Mat`
}
