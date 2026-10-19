import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// Babylon is a dependency of client/, not of Tests/: load it from there so the
// test uses the same module instances as client/src/map.ts.
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import { VertexBuffer } from '../../client/node_modules/@babylonjs/core/Buffers/buffer.js'
import type { StandardMaterial } from '../../client/node_modules/@babylonjs/core/Materials/standardMaterial.js'
import type { AbstractMesh } from '../../client/node_modules/@babylonjs/core/Meshes/abstractMesh.js'
import { buildMap, buildTraversal } from '../../client/src/map.ts'
import { GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT, UPPER_LEVEL_Y } from '../../shared/map.js'
import type { ClimbAnchor, LedgeAnchor, Ramp } from '../../shared/map.js'

// #34: the client's upper-level rendering (#33, client/src/map.ts
// buildTraversal) on Babylon's NullEngine: one floor-<id>, ramp-<id> and
// anchor-<id> mesh per entry of shared/map.js, with bounds that match the
// data, the ramp's walkable surface going from `low` to `high`, and anchors
// coloured so they read apart from walls, cover, floors and stairs.
// buildMap itself is unchanged (unit/mapRender.test.ts); the scene builds
// both (client/src/scene.ts). The browser side is e2e/height.spec.ts.

const EPS = 1e-6
/** Size of the anchor markers (client/src/map.ts, #33's write-up): depth out of the face, strip width, bar height. */
const ANCHOR_DEPTH = 0.06
const CLIMB_STRIP_WIDTH = 0.3
const LEDGE_BAR_HEIGHT = 0.12

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

interface Box {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

function worldBox(mesh: AbstractMesh): Box {
  mesh.computeWorldMatrix(true)
  mesh.refreshBoundingInfo()
  const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox
  return { min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } }
}

function expectBox(actual: Box, expected: Box, what: string, eps = EPS) {
  for (const end of ['min', 'max'] as const) {
    for (const k of ['x', 'y', 'z'] as const) {
      expect(Math.abs(actual[end][k] - expected[end][k]), `${what}.${end}.${k}: ${actual[end][k]} vs ${expected[end][k]}`).toBeLessThan(eps)
    }
  }
}

function mesh(name: string): AbstractMesh {
  const m = scene.getMeshByName(name)
  if (!m) throw new Error(`no mesh named ${name}`)
  return m
}

const CLIMBS = GRAYBOX_MAP.anchors.filter((a): a is ClimbAnchor => a.kind === 'climb')
const LEDGES = GRAYBOX_MAP.anchors.filter((a): a is LedgeAnchor => a.kind === 'ledge')

/** A facing (yaw) as a unit axis on (x, z); every graybox anchor faces along an axis. */
function axisOf(facing: number): { x: number; z: number } {
  const x = Math.round(Math.sin(facing))
  const z = Math.round(Math.cos(facing))
  expect(Math.abs(x) + Math.abs(z), `facing ${facing} is axis-aligned`).toBe(1)
  expect(Math.abs(Math.sin(facing) - x) + Math.abs(Math.cos(facing) - z)).toBeLessThan(1e-9)
  return { x, z }
}

/**
 * The world box of a marker lying on a face: the face is `PLAYER_HALF_SIZE`
 * along `facing` from the centre line (cx, cz); the marker is ANCHOR_DEPTH
 * deep on the climber's side of it, spans `along` on the other axis, and y0..y1.
 */
function markerBox(cx: number, cz: number, facing: number, along: [number, number], y0: number, y1: number): Box {
  const f = axisOf(facing)
  if (f.x !== 0) {
    const face = cx + f.x * PLAYER_HALF_SIZE
    const [x0, x1] = f.x > 0 ? [face - ANCHOR_DEPTH, face] : [face, face + ANCHOR_DEPTH]
    return { min: { x: x0, y: y0, z: along[0] }, max: { x: x1, y: y1, z: along[1] } }
  }
  const face = cz + f.z * PLAYER_HALF_SIZE
  const [z0, z1] = f.z > 0 ? [face - ANCHOR_DEPTH, face] : [face, face + ANCHOR_DEPTH]
  return { min: { x: along[0], y: y0, z: z0 }, max: { x: along[1], y: y1, z: z1 } }
}

/** The surface height a ramp's data gives at (x, z) (shared/map.d.ts). */
function rampHeight(r: Ramp, x: number, z: number): number {
  const t =
    r.rises === '+z' ? (z - r.minZ) / (r.maxZ - r.minZ)
    : r.rises === '-z' ? (r.maxZ - z) / (r.maxZ - r.minZ)
    : r.rises === '+x' ? (x - r.minX) / (r.maxX - r.minX)
    : (r.maxX - x) / (r.maxX - r.minX)
  return r.low + (r.high - r.low) * t
}

/** World-space vertex positions and normals of a mesh (the ramps have an identity world matrix). */
function vertices(m: AbstractMesh): { p: number[][]; n: number[][] } {
  const pos = m.getVerticesData(VertexBuffer.PositionKind)!
  const nor = m.getVerticesData(VertexBuffer.NormalKind)!
  const p: number[][] = []
  const n: number[][] = []
  for (let i = 0; i < pos.length; i += 3) {
    p.push([pos[i], pos[i + 1], pos[i + 2]])
    n.push([nor[i], nor[i + 1], nor[i + 2]])
  }
  return { p, n }
}

describe('buildTraversal (client/src/map.ts, #33)', () => {
  it('returns one rendered floor, ramp and anchor per entry, and buildMap still returns only { id, renderedSolids }', () => {
    expect(buildMap(scene)).toEqual({ id: GRAYBOX_MAP.id, renderedSolids: GRAYBOX_MAP.solids.length })
    expect(buildTraversal(scene)).toEqual({
      renderedFloors: GRAYBOX_MAP.floors.length,
      renderedRamps: GRAYBOX_MAP.ramps.length,
      renderedAnchors: GRAYBOX_MAP.anchors.length,
    })
    // The graybox numbers the e2e specs also expect from the hook.
    expect([GRAYBOX_MAP.floors.length, GRAYBOX_MAP.ramps.length, GRAYBOX_MAP.anchors.length]).toEqual([4, 1, 6])
  })

  it('creates exactly floor-<id>, ramp-<id> and anchor-<id> meshes, one per entry, and nothing else', () => {
    buildTraversal(scene)
    const names = scene.meshes.map((m) => m.name).sort()
    expect(names).toEqual(
      [
        ...GRAYBOX_MAP.floors.map((f) => `floor-${f.id}`),
        ...GRAYBOX_MAP.ramps.map((r) => `ramp-${r.id}`),
        ...GRAYBOX_MAP.anchors.map((a) => `anchor-${a.id}`),
      ].sort(),
    )
    // With buildMap: the ground, solids and terminal posts as well.
    buildMap(scene)
    expect(scene.meshes).toHaveLength(
      1 + GRAYBOX_MAP.solids.length + GRAYBOX_MAP.terminals.length + GRAYBOX_MAP.floors.length + GRAYBOX_MAP.ramps.length + GRAYBOX_MAP.anchors.length,
    )
    for (const m of scene.meshes) expect(m.isPickable, `${m.name} is not pickable`).toBe(m.name === 'ground')
  })

  it('renders each floor as a box exactly min..max, its top at UPPER_LEVEL_Y', () => {
    buildTraversal(scene)
    for (const f of GRAYBOX_MAP.floors) {
      expectBox(worldBox(mesh(`floor-${f.id}`)), { min: f.min, max: f.max }, `floor-${f.id}`)
      expect(f.max.y).toBe(UPPER_LEVEL_Y)
    }
  })

  it('renders each ramp as a wedge over its rectangle from the ground up to `high`', () => {
    buildTraversal(scene)
    for (const r of GRAYBOX_MAP.ramps) {
      const box = worldBox(mesh(`ramp-${r.id}`))
      expectBox(box, { min: { x: r.minX, y: 0, z: r.minZ }, max: { x: r.maxX, y: r.high, z: r.maxZ } }, `ramp-${r.id}`)
    }
    // The values #33 reported for the graybox stairs.
    expectBox(worldBox(mesh('ramp-stairs-west')), { min: { x: -7.5, y: 0, z: 0.5 }, max: { x: -5.75, y: 3, z: 6 } }, 'ramp-stairs-west')
  })

  it("a ramp's walkable surface is `low` at its low edge and `high` at its high edge, and its top tilts toward the low end", () => {
    buildTraversal(scene)
    for (const r of GRAYBOX_MAP.ramps) {
      const m = mesh(`ramp-${r.id}`)
      m.computeWorldMatrix(true)
      expect(m.getWorldMatrix().isIdentity(), `ramp-${r.id} is built in world space`).toBe(true)
      const { p, n } = vertices(m)
      // Every vertex lies within the wedge: inside the rectangle, between the ground and the surface.
      for (const [x, y, z] of p) {
        expect(x).toBeGreaterThanOrEqual(r.minX - EPS)
        expect(x).toBeLessThanOrEqual(r.maxX + EPS)
        expect(z).toBeGreaterThanOrEqual(r.minZ - EPS)
        expect(z).toBeLessThanOrEqual(r.maxZ + EPS)
        expect(y).toBeGreaterThanOrEqual(-EPS)
        expect(y, `vertex ${x},${y},${z} under the surface`).toBeLessThanOrEqual(rampHeight(r, x, z) + EPS)
      }
      // The top face: the vertices whose normals point up (the bottom points down, the sides sideways).
      const top = p.filter((_, i) => n[i][1] > 0.1)
      expect(top.length, `ramp-${r.id} has an upward-facing top`).toBeGreaterThanOrEqual(3)
      for (const [x, y, z] of top) expect(Math.abs(y - rampHeight(r, x, z)), `top vertex ${x},${y},${z} on the surface`).toBeLessThan(EPS)
      // Its corners: low at the low edge, high at the high edge.
      const rise = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, 1], '-z': [0, -1] }[r.rises]
      const along = (v: number[]) => v[0] * rise[0] + v[2] * rise[1]
      const lowEnd = Math.min(...top.map(along))
      const highEnd = Math.max(...top.map(along))
      for (const v of top) {
        if (Math.abs(along(v) - lowEnd) < EPS) expect(Math.abs(v[1] - r.low), `low edge at ${v}`).toBeLessThan(EPS)
        if (Math.abs(along(v) - highEnd) < EPS) expect(Math.abs(v[1] - r.high), `high edge at ${v}`).toBeLessThan(EPS)
      }
      expect(top.filter((v) => Math.abs(v[1] - r.low) < EPS).length, 'two top corners at low').toBeGreaterThanOrEqual(2)
      expect(top.filter((v) => Math.abs(v[1] - r.high) < EPS).length, 'two top corners at high').toBeGreaterThanOrEqual(2)
      // The surface normal: up, and tilted back toward the low end, at the slope's angle.
      const run = r.rises.endsWith('x') ? r.maxX - r.minX : r.maxZ - r.minZ
      const len = Math.hypot(run, r.high - r.low)
      for (const [i] of p.map((_, i) => [i]).filter(([i]) => n[i][1] > 0.1)) {
        const [nx, ny, nz] = n[i]
        expect(Math.abs(ny - run / len), `top normal y ${ny}`).toBeLessThan(1e-4)
        expect(Math.abs(nx * rise[0] + nz * rise[1] + (r.high - r.low) / len), `top normal tilts toward the low end (${nx}, ${nz})`).toBeLessThan(1e-4)
      }
      // The other faces' normals point out of the wedge (down, or sideways away from its centre).
      const cx = (r.minX + r.maxX) / 2
      const cz = (r.minZ + r.maxZ) / 2
      p.forEach((v, i) => {
        const [nx, ny, nz] = n[i]
        if (ny > 0.1) return
        if (ny < -0.9) return // bottom
        // A corner where a side face narrows to nothing (the wedge's low end
        // sits on the ground) belongs only to a zero-area triangle: no normal.
        if (Math.hypot(nx, ny, nz) < 1e-6) return
        expect(nx * (v[0] - cx) + nz * (v[2] - cz), `side normal at ${v} points outward`).toBeGreaterThan(0)
      })
    }
  })

  it('renders each climb anchor as a strip on the wall face it climbs, from minY up to the ledge (maxY + PLAYER_HEIGHT)', () => {
    buildTraversal(scene)
    for (const a of CLIMBS) {
      const f = axisOf(a.facing)
      const centre = f.x !== 0 ? a.z : a.x
      const want = markerBox(a.x, a.z, a.facing, [centre - CLIMB_STRIP_WIDTH / 2, centre + CLIMB_STRIP_WIDTH / 2], a.minY, a.maxY + PLAYER_HEIGHT)
      expectBox(worldBox(mesh(`anchor-${a.id}`)), want, `anchor-${a.id}`)
      // The top of the strip is the ledge the climb leads to.
      const ledge = LEDGES.find((l) => l.id === a.ledgeId)!
      expect(Math.abs(a.maxY + PLAYER_HEIGHT - ledge.y)).toBeLessThan(EPS)
      // The face it lies on really is a solid's face (the wall being climbed).
      const face = f.x !== 0 ? a.x + f.x * PLAYER_HALF_SIZE : a.z + f.z * PLAYER_HALF_SIZE
      const k = f.x !== 0 ? 'x' : 'z'
      const sign = f.x + f.z
      expect(
        GRAYBOX_MAP.solids.some((s) => Math.abs((sign > 0 ? s.min[k] : s.max[k]) - face) < EPS),
        `anchor-${a.id} lies on a solid's face at ${k} ${face}`,
      ).toBe(true)
    }
    // #33's reported numbers for climb-west.
    expectBox(worldBox(mesh('anchor-climb-west')), { min: { x: -10.06, y: 0, z: 4.35 }, max: { x: -10, y: 3, z: 4.65 } }, 'anchor-climb-west', 1e-5)
  })

  it('renders each ledge as a bar along its segment on the edge face, its top at the ledge y', () => {
    buildTraversal(scene)
    for (const l of LEDGES) {
      const f = axisOf(l.facing)
      // The segment runs across the facing.
      if (f.x !== 0) expect(l.x0).toBe(l.x1)
      else expect(l.z0).toBe(l.z1)
      const [s0, s1] = f.x !== 0 ? [Math.min(l.z0, l.z1), Math.max(l.z0, l.z1)] : [Math.min(l.x0, l.x1), Math.max(l.x0, l.x1)]
      expect(s1 - s0, `${l.id} is at least a strip wide`).toBeGreaterThanOrEqual(CLIMB_STRIP_WIDTH)
      const want = markerBox(l.x0, l.z0, l.facing, [s0, s1], l.y - LEDGE_BAR_HEIGHT, l.y)
      expectBox(worldBox(mesh(`anchor-${l.id}`)), want, `anchor-${l.id}`, 1e-5)
      // The edge face is a solid's or a floor's face, topped at the ledge y.
      const face = f.x !== 0 ? l.x0 + f.x * PLAYER_HALF_SIZE : l.z0 + f.z * PLAYER_HALF_SIZE
      const k = f.x !== 0 ? 'x' : 'z'
      const sign = f.x + f.z
      expect(
        [...GRAYBOX_MAP.solids, ...GRAYBOX_MAP.floors].some((s) => Math.abs((sign > 0 ? s.min[k] : s.max[k]) - face) < EPS && Math.abs(s.max.y - l.y) < EPS),
        `anchor-${l.id} lies on an edge at ${k} ${face}, top ${l.y}`,
      ).toBe(true)
    }
    // #33's reported numbers.
    const bar = worldBox(mesh('anchor-ledge-mezz-south'))
    expectBox(bar, { min: { x: -9, y: 2.88, z: -1.06 }, max: { x: -7.5, y: 3, z: -1 } }, 'anchor-ledge-mezz-south', 1e-5)
    const west = worldBox(mesh('anchor-ledge-west-wall'))
    expectBox(west, { min: { x: -10.06, y: 2.88, z: 2.5 }, max: { x: -10, y: 3, z: 6.5 } }, 'anchor-ledge-west-wall', 1e-5)
  })

  it('anchors share one emissive cyan material that reads apart from walls, cover, floors, stairs and terminals', () => {
    buildMap(scene)
    buildTraversal(scene)
    const matOf = (names: string[]) => {
      const mats = new Set(names.map((n) => mesh(n).material))
      expect(mats.size, `one material for ${names[0]}...`).toBe(1)
      const m = [...mats][0] as StandardMaterial
      expect(m, `${names[0]} has a material`).toBeTruthy()
      return m
    }
    const anchor = matOf(GRAYBOX_MAP.anchors.map((a) => `anchor-${a.id}`))
    const floor = matOf(GRAYBOX_MAP.floors.map((f) => `floor-${f.id}`))
    const ramp = matOf(GRAYBOX_MAP.ramps.map((r) => `ramp-${r.id}`))
    const wall = matOf(GRAYBOX_MAP.solids.filter((s) => s.kind === 'wall').map((s) => `solid-${s.id}`))
    const cover = matOf(GRAYBOX_MAP.solids.filter((s) => s.kind === 'cover').map((s) => `solid-${s.id}`))
    const terminal = matOf(GRAYBOX_MAP.terminals.map((t) => `terminal-${t.id}`))
    expect([anchor.name, floor.name, ramp.name]).toEqual(['anchorMat', 'floorMat', 'rampMat'])

    // Cyan: green and blue high, red low.
    const { r, g, b } = anchor.diffuseColor
    expect(g).toBeGreaterThan(r + 0.5)
    expect(b).toBeGreaterThan(r + 0.5)
    // Emissive, so it reads in the dark (rule 7); walls, cover, floors and stairs are not.
    const glow = anchor.emissiveColor
    expect(glow.r + glow.g + glow.b, 'anchors glow').toBeGreaterThan(0.5)
    expect(glow.g).toBeGreaterThan(glow.r)
    expect(glow.b).toBeGreaterThan(glow.r)
    for (const m of [wall, cover, floor, ramp]) {
      const e = m.emissiveColor
      expect(e.r + e.g + e.b, `${m.name} does not glow`).toBe(0)
    }
    // Far from every other surface colour (including the green terminals).
    const dist = (a: StandardMaterial, o: StandardMaterial) =>
      Math.hypot(a.diffuseColor.r - o.diffuseColor.r, a.diffuseColor.g - o.diffuseColor.g, a.diffuseColor.b - o.diffuseColor.b)
    for (const m of [wall, cover, floor, ramp, terminal]) expect(dist(anchor, m), `anchor vs ${m.name}`).toBeGreaterThan(0.5)
    // Floors are set apart from walls (a blue-grey) and stairs from both (a tan).
    expect(floor.diffuseColor.b).toBeGreaterThan(floor.diffuseColor.r + 0.1)
    expect(ramp.diffuseColor.r).toBeGreaterThan(ramp.diffuseColor.b + 0.1)
    expect(dist(floor, wall)).toBeGreaterThan(0.1)
    expect(dist(ramp, wall)).toBeGreaterThan(0.1)
  })
})
