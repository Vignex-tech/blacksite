import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Babylon is a dependency of client/, not of Tests/: load it from there so the
// test uses the same module instances as client/src/surfaces.ts.
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import { ArcRotateCamera } from '../../client/node_modules/@babylonjs/core/Cameras/arcRotateCamera.js'
import { Vector3 } from '../../client/node_modules/@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '../../client/node_modules/@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { VertexBuffer } from '../../client/node_modules/@babylonjs/core/Buffers/buffer.js'
import { InternalTexture } from '../../client/node_modules/@babylonjs/core/Materials/Textures/internalTexture.js'
import type { TargetCamera } from '../../client/node_modules/@babylonjs/core/Cameras/targetCamera.js'
import type { StandardMaterial } from '../../client/node_modules/@babylonjs/core/Materials/standardMaterial.js'
import { buildMap, buildTraversal } from '../../client/src/map.ts'
import { createCameraRig } from '../../client/src/cameras.ts'
import {
  APRON_MARGIN,
  PERIMETER_HEIGHT,
  PERIMETER_THICKNESS,
  TILE_METRES,
  applyWorldUVs,
  buildPerimeter,
  texturizeSurfaces,
} from '../../client/src/surfaces.ts'
import { gfxSettingsFor } from '../../client/src/graphics.ts'
import { SURFACE_STYLE, surfaceMaterialName } from '../../client/src/surfaceStyle.ts'
import { GRAYBOX_MAP } from '../../shared/map.js'

// #86: the textured surfaces, perimeter and apron of #85 on Babylon's
// NullEngine (no GPU, no network). What it looks like in a browser is
// e2e/surfaces.spec.ts.

let engine: NullEngine
let scene: Scene

beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
  vi.restoreAllMocks()
})

const structural = (s: Scene) =>
  s.meshes
    .filter((m) => /^(solid|floor|ramp|anchor|terminal)-/.test(m.name) || m.name === 'ground')
    .map((m) => `${m.name}|${m.isPickable}|${m.getTotalVertices()}`)
    .sort()

function buildAll() {
  buildMap(scene)
  buildTraversal(scene)
}

describe('texturizeSurfaces keeps the graybox structure', () => {
  it('every solid-, floor-, ramp-, anchor- mesh keeps its name, count, pickability and vertices', () => {
    buildAll()
    const before = structural(scene)
    expect(before.filter((n) => n.startsWith('solid-')).length).toBe(GRAYBOX_MAP.solids.length)
    expect(before.filter((n) => n.startsWith('floor-')).length).toBe(GRAYBOX_MAP.floors.length)
    expect(before.filter((n) => n.startsWith('ramp-')).length).toBe(GRAYBOX_MAP.ramps.length)
    expect(before.filter((n) => n.startsWith('anchor-')).length).toBe(GRAYBOX_MAP.anchors.length)
    buildPerimeter(scene)
    texturizeSurfaces(scene, gfxSettingsFor('?gfx=medium'))
    expect(structural(scene)).toEqual(before)
  })

  it('shares one material per surface kind: no per-mesh clones', () => {
    buildAll()
    buildPerimeter(scene)
    texturizeSurfaces(scene, gfxSettingsFor('?gfx=medium'))
    const bySurface = (re: RegExp) => new Set(scene.meshes.filter((m) => re.test(m.name)).map((m) => m.material))
    expect(bySurface(/^solid-/).size, 'walls and cover only').toBeLessThanOrEqual(2)
    expect(bySurface(/^floor-/).size).toBe(1)
    expect(bySurface(/^ramp-/).size).toBe(1)
    expect(bySurface(/^ground$/).size).toBe(1)
    expect(bySurface(/^decor-perimeter$/).size).toBe(1)
    const used = new Set(scene.meshes.map((m) => m.material).filter(Boolean))
    const surfaceMats = [...used].filter((m) => /^(wall|cover|floor|ramp|ground|perimeter)(Mat|Tex|Pbr)$/.test(m!.name))
    expect(surfaceMats.length).toBeLessThanOrEqual(Object.keys(SURFACE_STYLE).length)
    // The apron reuses the ground material, not a clone.
    expect(scene.getMeshByName('decor-apron')!.material).toBe(scene.getMeshByName('ground')!.material)
  })
})

describe('world-unit UVs', () => {
  const texelDensity = (w: number, h: number, d: number, face: 'top' | 'side') => {
    const box = CreateBox(`b-${w}-${h}-${d}`, { width: w, height: h, depth: d }, scene)
    box.position.set(3, h / 2, -2)
    applyWorldUVs(box, 0)
    const pos = box.getVerticesData(VertexBuffer.PositionKind)!
    const nor = box.getVerticesData(VertexBuffer.NormalKind)!
    const uv = box.getVerticesData(VertexBuffer.UVKind)!
    const idx: number[] = []
    for (let i = 0; i < pos.length / 3; i++) {
      if (face === 'top' ? nor[i * 3 + 1] > 0.5 : nor[i * 3 + 2] > 0.5) idx.push(i)
    }
    const span = (a: (i: number) => number) => {
      const v = idx.map(a)
      return Math.max(...v) - Math.min(...v)
    }
    return { u: span((i) => uv[i * 2]) / w, v: span((i) => uv[i * 2 + 1]) / (face === 'top' ? d : h) }
  }

  it('a 1x1 and a 4x1 box have the same texel density (1 tile per TILE_METRES)', () => {
    for (const face of ['top', 'side'] as const) {
      const small = texelDensity(1, 1, 1, face)
      const wide = texelDensity(4, 1, 1, face)
      expect(wide.u).toBeCloseTo(small.u, 6)
      expect(wide.v).toBeCloseTo(small.v, 6)
      expect(small.u).toBeCloseTo(1 / TILE_METRES, 6)
      expect(small.v).toBeCloseTo(1 / TILE_METRES, 6)
    }
  })

  it('the per-mesh offset differs between meshes but never changes the density', () => {
    const a = CreateBox('a', { size: 2 }, scene)
    const b = CreateBox('b', { size: 2 }, scene)
    applyWorldUVs(a, 0)
    applyWorldUVs(b, 3)
    const ua = a.getVerticesData(VertexBuffer.UVKind)!
    const ub = b.getVerticesData(VertexBuffer.UVKind)!
    expect(ub[0]).not.toBeCloseTo(ua[0], 3)
    expect(ub[0] - ua[0]).toBeCloseTo(ub[ub.length - 2] - ua[ua.length - 2], 6)
  })

  it('texturizeSurfaces gives solids, floors, ramps and the ground world-unit UVs', () => {
    buildAll()
    texturizeSurfaces(scene, gfxSettingsFor('?gfx=low'))
    for (const m of scene.meshes.filter((x) => /^(solid|floor|ramp)-/.test(x.name) || x.name === 'ground')) {
      const uv = m.getVerticesData(VertexBuffer.UVKind)
      expect(uv, `${m.name} has UVs`).toBeTruthy()
      if (m.name === 'ground') {
        const u = uv!.filter((_, i) => i % 2 === 0)
        expect(Math.max(...u) - Math.min(...u), 'the ground spans many tiles').toBeGreaterThan(5)
      }
    }
  })
})

describe('perimeter and apron', () => {
  const inside = (x: number, z: number, eps: number) => {
    const { minX, maxX, minZ, maxZ } = GRAYBOX_MAP.bounds
    return x > minX + eps && x < maxX - eps && z > minZ + eps && z < maxZ - eps
  }

  it('use decor- names, are not pickable, not colliding, and lie outside the bounds', () => {
    const { perimeter, apron } = buildPerimeter(scene)
    const { minX, maxX, maxZ } = GRAYBOX_MAP.bounds
    expect(perimeter.name).toBe('decor-perimeter')
    expect(apron.name).toBe('decor-apron')
    for (const m of [perimeter, apron]) {
      expect(m.isPickable, `${m.name} pickable`).toBe(false)
      expect(m.checkCollisions, `${m.name} checkCollisions`).toBe(false)
    }
    const eps = 1e-4
    const pb = perimeter.getBoundingInfo().boundingBox
    expect(pb.minimumWorld.y).toBeCloseTo(0, 4)
    expect(pb.maximumWorld.y).toBeCloseTo(PERIMETER_HEIGHT, 4)
    expect(pb.minimumWorld.x).toBeLessThanOrEqual(minX - PERIMETER_THICKNESS + eps)
    expect(pb.maximumWorld.x).toBeGreaterThanOrEqual(maxX + PERIMETER_THICKNESS - eps)
    for (const [mesh, label] of [[perimeter, 'perimeter'], [apron, 'apron']] as const) {
      const p = mesh.getVerticesData(VertexBuffer.PositionKind)!
      for (let i = 0; i < p.length; i += 3) {
        expect(inside(p[i], p[i + 2], eps), `${label} vertex ${i / 3} inside the bounds`).toBe(false)
      }
    }
    const ab = apron.getBoundingInfo().boundingBox
    expect(ab.minimumWorld.x).toBeCloseTo(minX - APRON_MARGIN, 3)
    expect(ab.maximumWorld.z).toBeCloseTo(maxZ + APRON_MARGIN, 3)
  })

  it('building it adds only decor- meshes and changes no structural mesh', () => {
    buildAll()
    const before = structural(scene)
    const names = new Set(scene.meshes.map((m) => m.name))
    buildPerimeter(scene)
    const added = scene.meshes.map((m) => m.name).filter((n) => !names.has(n))
    expect(added.sort()).toEqual(['decor-apron', 'decor-perimeter'])
    expect(structural(scene)).toEqual(before)
  })

  // The ghost's third-person camera sits 3.2 m behind the shoulder and may leave the
  // bounds. Over the wall it is fine; inside the 1.4 m wall volume it clips.
  function cameraHitsInWall(pitchNames: string[]): string[] {
    const { minX, maxX, minZ, maxZ } = GRAYBOX_MAP.bounds
    const t = PERIMETER_THICKNESS
    const canvas = document.createElement('canvas')
    const overhead = new ArcRotateCamera('camera', -Math.PI / 2, 0.4, 56, Vector3.Zero(), scene)
    const rig = createCameraRig(scene, canvas, overhead)
    const eye = () => scene.getCameraByName('playerCamera') as TargetCamera
    // Pointer lock stub, then mouse movement to set the pitch (negative looks up).
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => canvas })
    const lookUp = () => {
      const e = new MouseEvent('mousemove')
      Object.defineProperty(e, 'movementX', { value: 0 })
      Object.defineProperty(e, 'movementY', { value: -1000 }) // clamps to the highest look-up
      document.dispatchEvent(e)
    }
    const inBounds = (x: number, z: number) => x > minX && x < maxX && z > minZ && z < maxZ
    const inWall = (x: number, y: number, z: number) =>
      y < PERIMETER_HEIGHT && x > minX - t && x < maxX + t && z > minZ - t && z < maxZ + t && !inBounds(x, z)
    const hits: string[] = []
    for (const pitchName of pitchNames) {
      for (const edge of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]) {
        for (let k = 0; k <= 20; k++) {
          for (let yawI = 0; yawI < 16; yawI++) {
            const yaw = (yawI / 16) * Math.PI * 2 - Math.PI
            const along = (k / 20) * (maxZ - minZ)
            for (const [px, pz] of [
              [minX + edge, minZ + along],
              [maxX - edge, minZ + along],
              [minX + along, minZ + edge],
              [minX + along, maxZ - edge],
            ]) {
              rig.setLocalPlayer('me', px, pz, 'ghost', yaw, 0)
              if (pitchName === 'looking up') lookUp()
              const p = eye().position
              if (inWall(p.x, p.y, p.z)) hits.push(`${pitchName}: player ${px},${pz} yaw ${yaw.toFixed(2)} -> camera ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`)
            }
          }
        }
      }
    }
    rig.dispose()
    return hits
  }

  it('the third-person camera at its start pitch is never inside the perimeter wall', () => {
    const hits = cameraHitsInWall(['start pitch'])
    expect(hits.slice(0, 5), `${hits.length} camera positions inside the wall`).toEqual([])
  })

  // BUG: looking fully up with the Ghost 2.7 to 3.2 m inside the bounds puts the camera
  // (clamped to 0.3 m high) inside the 1.4 m perimeter wall. Bug #96. Drop `.fails` when fixed.
  it('the third-person camera looking up is never inside the perimeter wall (known bug, see #96)', () => {
    const hits = cameraHitsInWall(['looking up'])
    expect(hits.slice(0, 5), `${hits.length} camera positions inside the wall`).toEqual([])
  })
})

describe('texture failure falls back to flat materials', () => {
  it('keeps the flat StandardMaterials when no texture loads, and the load tracker still ends', async () => {
    buildAll()
    buildPerimeter(scene)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // NullEngine "loads" any URL. Make every texture request fail instead, as a blocked file does.
    vi.spyOn(engine, 'createTexture').mockImplementation(((...args: unknown[]) => {
      const onError = args[6] as ((m?: string) => void) | undefined
      setTimeout(() => onError?.('blocked'), 0)
      return new InternalTexture(engine, 0)
    }) as unknown as typeof engine.createTexture)
    const flatBefore = new Map(scene.meshes.map((m) => [m.name, m.material]))
    let ended = false
    texturizeSurfaces(scene, gfxSettingsFor('?gfx=low'), { begin: () => ({ progress: () => {}, end: () => (ended = true) }) })
    await vi.waitFor(() => expect(ended, 'the load tracker finishes even when every texture fails').toBe(true), { timeout: 8000 })
    for (const m of scene.meshes) expect(m.material, `${m.name} keeps its flat material`).toBe(flatBefore.get(m.name))
    for (const kind of Object.keys(SURFACE_STYLE) as (keyof typeof SURFACE_STYLE)[]) {
      const flat = scene.getMaterialByName(surfaceMaterialName(kind)) as StandardMaterial | null
      if (!flat) continue
      const [r, g, b] = SURFACE_STYLE[kind].fallback
      expect(flat.diffuseColor.r).toBeCloseTo(r, 5)
      expect(flat.diffuseColor.g).toBeCloseTo(g, 5)
      expect(flat.diffuseColor.b).toBeCloseTo(b, 5)
    }
    expect(warn).toHaveBeenCalled()
  })
})
