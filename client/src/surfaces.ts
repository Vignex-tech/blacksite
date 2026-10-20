import type { Scene } from '@babylonjs/core/scene'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import { GRAYBOX_MAP } from '../../shared/map.js'
import type { GrayboxMap } from '../../shared/map.js'
import type { GfxSettings } from './graphics.ts'
import { assetUrl } from './assets/assetLoader.ts'
import { SURFACE_STYLE, surfaceMaterialName, type SurfaceKind } from './surfaceStyle.ts'

/**
 * Textured PBR surfaces, the perimeter and the apron (M8, #85). Purely visual.
 * `buildMap` and `buildTraversal` still create the flat-colour graybox meshes;
 * `texturizeSurfaces` then gives their UVs in world units and swaps the shared
 * flat materials for textured ones as the files arrive. A texture that fails
 * to load leaves the flat material in place.
 */

/** One texture repeat covers this many metres. */
export const TILE_METRES = 2
/** Perimeter wall: height and thickness (it stands just outside the bounds). */
export const PERIMETER_HEIGHT = 1.4
export const PERIMETER_THICKNESS = 0.5
/** The apron extends the ground this far past the bounds, as a ring around the ground. */
export const APRON_MARGIN = 80
const APRON_Y = 0

/**
 * Rewrites a mesh's UVs as world-space coordinates, one unit per tile, using
 * the face's dominant axis. `index` shifts the pattern (a stable low-frequency
 * variation derived from build order, not from ids).
 */
export function applyWorldUVs(mesh: AbstractMesh, index: number, tile: number = TILE_METRES): void {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)
  const nor = mesh.getVerticesData(VertexBuffer.NormalKind)
  if (!pos || !nor) return
  mesh.computeWorldMatrix(true)
  const world = mesh.getWorldMatrix()
  const du = (index * 0.381966) % 1
  const dv = (index * 0.618034) % 1
  const uvs = new Array<number>((pos.length / 3) * 2)
  const p = new Vector3()
  const n = new Vector3()
  for (let i = 0; i < pos.length / 3; i++) {
    Vector3.TransformCoordinatesFromFloatsToRef(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], world, p)
    Vector3.TransformNormalFromFloatsToRef(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2], world, n)
    const ax = Math.abs(n.x)
    const ay = Math.abs(n.y)
    const az = Math.abs(n.z)
    let u: number
    let v: number
    if (ay >= ax && ay >= az) [u, v] = [p.x, p.z]
    else if (ax >= az) [u, v] = [p.z, p.y]
    else [u, v] = [p.x, p.y]
    uvs[i * 2] = u / tile + du
    uvs[i * 2 + 1] = v / tile + dv
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, false)
}

function flatMaterial(scene: Scene, kind: SurfaceKind): StandardMaterial {
  const name = surfaceMaterialName(kind)
  const existing = scene.getMaterialByName(name)
  if (existing instanceof StandardMaterial) return existing
  const [r, g, b] = SURFACE_STYLE[kind].fallback
  const mat = new StandardMaterial(name, scene)
  mat.diffuseColor = new Color3(r, g, b)
  mat.specularColor = Color3.Black()
  mat.freeze()
  return mat
}

export interface RenderedPerimeter {
  /** The merged boundary wall (one draw call). */
  perimeter: Mesh
  /** The ground extension past the bounds. */
  apron: Mesh
}

/**
 * A low wall just outside `map.bounds` and a ground plane extending far past
 * them. Both are `decor-` meshes: not pickable, never collided with.
 */
export function buildPerimeter(scene: Scene, map: GrayboxMap = GRAYBOX_MAP): RenderedPerimeter {
  const { minX, maxX, minZ, maxZ } = map.bounds
  const t = PERIMETER_THICKNESS
  const h = PERIMETER_HEIGHT
  const side = (name: string, w: number, d: number, x: number, z: number): Mesh => {
    const b = CreateBox(name, { width: w, height: h, depth: d }, scene)
    b.position.set(x, h / 2, z)
    b.bakeCurrentTransformIntoVertices()
    return b
  }
  const w = maxX - minX + 2 * t
  const d = maxZ - minZ
  const parts = [
    side('decor-perimeter-s', w, t, (minX + maxX) / 2, minZ - t / 2),
    side('decor-perimeter-n', w, t, (minX + maxX) / 2, maxZ + t / 2),
    side('decor-perimeter-w', t, d, minX - t / 2, (minZ + maxZ) / 2),
    side('decor-perimeter-e', t, d, maxX + t / 2, (minZ + maxZ) / 2),
  ]
  const perimeter = Mesh.MergeMeshes(parts, true, true) as Mesh
  perimeter.name = 'decor-perimeter'
  perimeter.material = flatMaterial(scene, 'perimeter')
  perimeter.isPickable = false
  perimeter.checkCollisions = false
  applyWorldUVs(perimeter, 3)
  perimeter.freezeWorldMatrix()

  // A ring of four strips around the bounds (not one plane under the ground,
  // which would draw every ground pixel twice).
  const m = APRON_MARGIN
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const strip = (name: string, width: number, height: number, x: number, z: number): Mesh => {
    const g = CreateGround(name, { width, height }, scene)
    g.position.set(x, 0, z)
    g.bakeCurrentTransformIntoVertices()
    return g
  }
  const fullW = maxX - minX + 2 * m
  const apron = Mesh.MergeMeshes(
    [
      strip('decor-apron-s', fullW, m, cx, minZ - m / 2),
      strip('decor-apron-n', fullW, m, cx, maxZ + m / 2),
      strip('decor-apron-w', m, maxZ - minZ, minX - m / 2, cz),
      strip('decor-apron-e', m, maxZ - minZ, maxX + m / 2, cz),
    ],
    true,
    true,
  ) as Mesh
  apron.name = 'decor-apron'
  apron.position.y = APRON_Y
  apron.material = flatMaterial(scene, 'ground')
  apron.isPickable = false
  apron.checkCollisions = false
  applyWorldUVs(apron, 5)
  apron.freezeWorldMatrix()
  return { perimeter, apron }
}

export interface SurfaceLoadHooks {
  /** Starts a tracked load (the loading screen). */
  begin(): { progress(fraction: number): void; end(): void }
}

function textureUrl(set: string, map: 'albedo' | 'normal' | 'orm'): string {
  return assetUrl(`textures/tex_${set}_${map}.webp`)
}

/**
 * Gives every graybox surface mesh world-unit UVs, then loads the texture set
 * of each kind and swaps the flat material for the textured one when it is
 * ready. `low` loads albedo only into a StandardMaterial; `medium` and `high`
 * build a PBRMaterial with albedo, normal and packed ORM.
 */
export function texturizeSurfaces(scene: Scene, gfx: GfxSettings, hooks?: SurfaceLoadHooks): void {
  // World-unit UVs, with a stable per-mesh offset from build order.
  let order = 0
  for (const m of scene.meshes) {
    if (/^(solid|floor|ramp)-/.test(m.name) || m.name === 'ground') {
      const kind = (Object.keys(SURFACE_STYLE) as SurfaceKind[]).find((k) => surfaceMaterialName(k) === m.material?.name)
      applyWorldUVs(m, order++, (kind && SURFACE_STYLE[kind].tileMetres) || TILE_METRES)
    }
  }

  const pbr = gfx.tier !== 'low'
  const maps = pbr ? (['albedo', 'normal', 'orm'] as const) : (['albedo'] as const)
  const kinds = (Object.keys(SURFACE_STYLE) as SurfaceKind[]).filter(() => true)
  const total = kinds.length * maps.length
  let done = 0
  const load = hooks?.begin()
  const finishOne = (): void => {
    done++
    load?.progress(done / total)
    if (done >= total) load?.end()
  }

  const swap = (kind: SurfaceKind, textures: Texture[]): void => {
    const style = SURFACE_STYLE[kind]
    const flat = scene.getMaterialByName(surfaceMaterialName(kind))
    if (!flat) return
    const [tr, tg, tb] = style.tint
    let mat: StandardMaterial | PBRMaterial
    if (pbr) {
      const m = new PBRMaterial(`${kind}Pbr`, scene)
      m.albedoTexture = textures[0]
      m.albedoColor = new Color3(tr, tg, tb)
      m.bumpTexture = textures[1]
      textures[1].level = style.bumpLevel ?? 1
      m.invertNormalMapY = true // textures are OpenGL/glTF normal maps
      m.metallicTexture = textures[2]
      m.useAmbientOcclusionFromMetallicTextureRed = true
      m.useRoughnessFromMetallicTextureGreen = true
      m.useMetallnessFromMetallicTextureBlue = true
      // The ORM already holds the metal scale (0.55 or 0); the factors pass it through.
      m.metallic = style.metallic ?? 1
      m.roughness = style.roughness ?? 1
      mat = m
    } else {
      const m = new StandardMaterial(`${kind}Tex`, scene)
      m.diffuseTexture = textures[0]
      m.diffuseColor = new Color3(Math.min(1, tr), Math.min(1, tg), Math.min(1, tb))
      m.specularColor = Color3.Black()
      mat = m
    }
    mat.freeze()
    for (const m of scene.meshes) if (m.material === flat) m.material = mat
  }

  for (const kind of kinds) {
    const set = SURFACE_STYLE[kind].material
    if (!scene.getMaterialByName(surfaceMaterialName(kind))) {
      for (let i = 0; i < maps.length; i++) finishOne()
      continue
    }
    const textures: Texture[] = []
    let loaded = 0
    let failed = false
    const settle = (ok: boolean): void => {
      finishOne()
      if (!ok) {
        if (!failed) console.warn(`Surface textures "${set}" failed to load; keeping the flat material.`)
        failed = true
        return
      }
      if (++loaded === maps.length && !failed) swap(kind, textures)
    }
    for (const map of maps) {
      const tex = new Texture(
        textureUrl(set, map),
        scene,
        !pbr, // low: no mipmaps, the cheapest sampling (weak and software renderers)
        false, // invertY = false: glTF convention
        pbr ? Texture.TRILINEAR_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE,
        () => settle(true),
        () => settle(false),
      )
      tex.wrapU = Texture.WRAP_ADDRESSMODE
      tex.wrapV = Texture.WRAP_ADDRESSMODE
      if (map === 'albedo') tex.anisotropicFilteringLevel = pbr ? 4 : 1
      else tex.gammaSpace = false
      textures.push(tex)
    }
  }
}
