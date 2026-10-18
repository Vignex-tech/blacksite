import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// Babylon is a dependency of client/, not of Tests/: load it from there so the
// test uses the same module instances as client/src/map.ts.
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import type { StandardMaterial } from '../../client/node_modules/@babylonjs/core/Materials/standardMaterial.js'
import type { AbstractMesh } from '../../client/node_modules/@babylonjs/core/Meshes/abstractMesh.js'
import { buildMap } from '../../client/src/map.ts'
import { GRAYBOX_MAP } from '../../shared/map.js'

// Unit checks of the client's map rendering (#14), verified in #16: buildMap()
// builds one mesh per solid and terminal from shared/map.js, at the data's
// positions and sizes, with walls lighter than cover and green terminals.
// Runs on Babylon's NullEngine (no GPU), so it is deterministic. What the map
// looks like in a real browser is the screenshot from e2e/map.spec.ts.

const EPS = 1e-6
let engine: NullEngine
let scene: Scene

beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
})

function worldBox(mesh: AbstractMesh) {
  mesh.computeWorldMatrix(true)
  const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox
  return { min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } }
}

function expectClose(actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }, what: string) {
  for (const k of ['x', 'y', 'z'] as const) {
    expect(Math.abs(actual[k] - expected[k]), `${what}.${k}: ${actual[k]} vs ${expected[k]}`).toBeLessThan(EPS)
  }
}

const brightness = (m: StandardMaterial) => m.diffuseColor.r + m.diffuseColor.g + m.diffuseColor.b

describe('buildMap (client/src/map.ts)', () => {
  it('reports the map id and one rendered solid per solid', () => {
    expect(buildMap(scene)).toEqual({ id: GRAYBOX_MAP.id, renderedSolids: GRAYBOX_MAP.solids.length })
  })

  it('creates solid-<id> boxes matching every solid exactly', () => {
    buildMap(scene)
    const solids = scene.meshes.filter((m) => m.name.startsWith('solid-'))
    expect(solids.map((m) => m.name).sort()).toEqual(GRAYBOX_MAP.solids.map((s) => `solid-${s.id}`).sort())
    for (const s of GRAYBOX_MAP.solids) {
      const mesh = scene.getMeshByName(`solid-${s.id}`)!
      const box = worldBox(mesh)
      expectClose(box.min, s.min, `${s.id}.min`)
      expectClose(box.max, s.max, `${s.id}.max`)
    }
  })

  it('colours walls lighter than cover, both neutral grey', () => {
    buildMap(scene)
    const matOf = (kind: string) => {
      const mats = new Set(
        GRAYBOX_MAP.solids.filter((s) => s.kind === kind).map((s) => scene.getMeshByName(`solid-${s.id}`)!.material),
      )
      expect(mats.size, `one material for ${kind}`).toBe(1)
      return [...mats][0] as StandardMaterial
    }
    const wall = matOf('wall')
    const cover = matOf('cover')
    expect(brightness(wall)).toBeGreaterThan(brightness(cover))
    for (const m of [wall, cover]) {
      const { r, g, b } = m.diffuseColor
      // Grey: channels within a few percent of each other.
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0.05)
    }
  })

  it('places one green terminal-<id> post on each terminal, from the floor up past its y', () => {
    buildMap(scene)
    const posts = scene.meshes.filter((m) => m.name.startsWith('terminal-'))
    expect(posts).toHaveLength(GRAYBOX_MAP.terminals.length)
    for (const t of GRAYBOX_MAP.terminals) {
      const mesh = scene.getMeshByName(`terminal-${t.id}`)!
      expect(mesh, t.id).toBeTruthy()
      const box = worldBox(mesh)
      expect(Math.abs((box.min.x + box.max.x) / 2 - t.x)).toBeLessThan(EPS)
      expect(Math.abs((box.min.z + box.max.z) / 2 - t.z)).toBeLessThan(EPS)
      expect(Math.abs(box.min.y)).toBeLessThan(EPS)
      expect(box.max.y).toBeGreaterThan(t.y)
      const { r, g, b } = (mesh.material as StandardMaterial).diffuseColor
      expect(g).toBeGreaterThan(r + 0.3)
      expect(g).toBeGreaterThan(b + 0.3)
      expect(mesh.isPickable).toBe(false)
    }
  })

  it('sizes and centres the ground from bounds', () => {
    buildMap(scene)
    const ground = scene.getMeshByName('ground')!
    const box = worldBox(ground)
    const b = GRAYBOX_MAP.bounds
    expectClose(box.min, { x: b.minX, y: 0, z: b.minZ }, 'ground.min')
    expectClose(box.max, { x: b.maxX, y: 0, z: b.maxZ }, 'ground.max')
  })

  it('creates only the ground, solids and terminal posts', () => {
    buildMap(scene)
    expect(scene.meshes).toHaveLength(1 + GRAYBOX_MAP.solids.length + GRAYBOX_MAP.terminals.length)
  })
})
