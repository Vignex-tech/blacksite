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
export type SurfaceKind = 'wall' | 'cover' | 'floor' | 'ramp' | 'ground' | 'perimeter'

export type MaterialKey =
  | 'concrete_painted'
  | 'concrete_rough'
  | 'steel_painted'
  | 'floor_plate'
  | 'steel_brushed'
  | 'ground'

/** Metal factor already baked into each set's ORM texture (#84): 0.55 on these, 0 on the rest. */
export const METAL_SCALE: Readonly<Partial<Record<MaterialKey, number>>> = {
  steel_brushed: 0.55,
  floor_plate: 0.55,
}

export interface SurfaceStyle {
  material: MaterialKey
  /** Multiplier on the albedo texture to keep the colour language (walls lighter than cover, ramp warm). */
  tint: readonly [number, number, number]
  /** Flat diffuse colour (r, g, b in 0..1) used while no textured material is available. */
  fallback: readonly [number, number, number]
  /** Metres per texture repeat; larger makes busy textures calmer (default TILE_METRES in surfaces.ts). */
  tileMetres?: number
  /** Normal-map strength (default 1); below 1 calms a busy set. */
  bumpLevel?: number
  /** Multiplier on the ORM roughness (default 1); above 1 flattens glints. */
  roughness?: number
  /** Multiplier on the metal scale already baked into the ORM (default 1); no environment map means metal reads dark. */
  metallic?: number
}

export const SURFACE_STYLE: Readonly<Record<SurfaceKind, SurfaceStyle>> = {
  // Neutral greys, well away from the player colours.
  wall: { material: 'concrete_painted', tint: [1.15, 1.15, 1.15], fallback: [0.62, 0.62, 0.63] },
  cover: { material: 'steel_painted', tint: [1.0, 1.05, 1.15], fallback: [0.42, 0.42, 0.43], tileMetres: 70, bumpLevel: 0.2, roughness: 1 },
  // Upper-level slabs: cool blue-grey.
  floor: { material: 'floor_plate', tint: [1.1, 1.15, 1.35], fallback: [0.4, 0.46, 0.55], metallic: 0.3 },
  // Stairs: warm tan, so the Warden route reads at a glance.
  ramp: { material: 'steel_brushed', tint: [1.6, 1.25, 0.85], fallback: [0.55, 0.47, 0.34], metallic: 0.3 },
  ground: { material: 'ground', tint: [2.4, 2.4, 2.45], fallback: [0.24, 0.24, 0.25] },
  // Low boundary wall around the yard (decor only).
  perimeter: { material: 'concrete_rough', tint: [0.9, 0.9, 0.92], fallback: [0.36, 0.36, 0.38] },
}

/** The style for a kind; an unknown kind (a newer map) falls back to the wall style. */
export function surfaceStyleFor(kind: string): SurfaceStyle {
  return (SURFACE_STYLE as Record<string, SurfaceStyle | undefined>)[kind] ?? SURFACE_STYLE.wall
}

/** Name of the shared material for a kind: `<kind>Mat` (wallMat, coverMat, floorMat, rampMat, groundMat). */
export function surfaceMaterialName(kind: SurfaceKind): string {
  return `${kind}Mat`
}
