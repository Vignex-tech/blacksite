// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT, UPPER_LEVEL_Y } from '../../shared/map.js'
import { ANCHOR_RANGE, STEP_HEIGHT } from '../../shared/protocol.js'
import {
  GROUND_OBSTACLES,
  POCKETS,
  ROUTE_MARGIN,
  assertLegClear,
  feetY,
  groundProblems,
  hazardsAt,
  overlapping,
  playerRect,
  rampHeightAt,
  rampTopOver,
  stopAlongZ,
} from '../e2e/support/geometry.ts'

// The e2e geometry helpers (Tests/e2e/support/geometry.ts) made height-aware
// in #28, checked against the y-aware rule of shared/map.d.ts: a box blocks
// a player when its y range overlaps y + STEP_HEIGHT .. y + PLAYER_HEIGHT.
// Values come from GRAYBOX_MAP, looked up by id.

const floor = (id: string) => GRAYBOX_MAP.floors.find((f) => f.id === id)!
const wall = (id: string) => GRAYBOX_MAP.solids.find((s) => s.id === id)!
const stairs = GRAYBOX_MAP.ramps[0]
const ids = (p: { x: number; z: number; y?: unknown }) => overlapping(p).map((o) => o.id)

describe('y-aware overlap (support/geometry.ts)', () => {
  it('a missing or non-numeric y means the ground', () => {
    expect(feetY({ x: 0, z: 0 })).toBe(0)
    expect(feetY({ x: 0, z: 0, y: 'up' })).toBe(0)
    expect(feetY({ x: 0, z: 0, y: Number.NaN })).toBe(0)
    expect(feetY({ x: 0, z: 0, y: 1.5 })).toBe(1.5)
  })

  it('on the ground every solid blocks and no upper-level floor does', () => {
    for (const s of GRAYBOX_MAP.solids) {
      const c = { x: (s.min.x + s.max.x) / 2, z: (s.min.z + s.max.z) / 2 }
      expect(ids(c), s.id).toContain(s.id)
      expect(ids({ ...c, y: 0 }), s.id).toContain(s.id)
    }
    expect(GROUND_OBSTACLES.map((o) => o.id)).toEqual([...GRAYBOX_MAP.solids.map((s) => s.id), ...GRAYBOX_MAP.ramps.map((r) => r.id)])
  })

  it('a player above a wall top, or on a floor, overlaps neither', () => {
    const w = wall('wall-w-n')
    const onWall = { x: (w.min.x + w.max.x) / 2, z: (w.min.z + w.max.z) / 2, y: w.max.y }
    expect(ids(onWall)).toEqual([])
    for (const f of GRAYBOX_MAP.floors) {
      const c = { x: (f.min.x + f.max.x) / 2, z: (f.min.z + f.max.z) / 2 }
      expect(ids({ ...c, y: f.max.y }), `on ${f.id}`).toEqual([])
      expect(ids({ ...c, y: 0 }).includes(f.id), `under ${f.id}`).toBe(false)
      // Mid-air inside the slab's band (head through the floor) does overlap it.
      expect(ids({ ...c, y: f.min.y - PLAYER_HEIGHT + 0.2 }), `head in ${f.id}`).toContain(f.id)
    }
    // A Ghost hanging from a ledge (feet at y - PLAYER_HEIGHT) is clear too.
    for (const a of GRAYBOX_MAP.anchors) {
      if (a.kind !== 'ledge') continue
      expect(ids({ x: (a.x0 + a.x1) / 2, z: (a.z0 + a.z1) / 2, y: a.y - PLAYER_HEIGHT }), a.id).toEqual([])
    }
    expect(UPPER_LEVEL_Y).toBe(floor('catwalk').max.y)
  })

  it('a ramp blocks from the ground but not a player standing on it, however its height is sampled', () => {
    expect(stairs.rises).toBe('+z')
    const x = (stairs.minX + stairs.maxX) / 2
    for (let z = stairs.minZ + 0.5; z <= stairs.maxZ - 0.5; z += 0.25) {
      // On the ground in the middle of the ramp: inside the wedge.
      if (rampHeightAt(stairs, x, z + PLAYER_HALF_SIZE) > STEP_HEIGHT) expect(ids({ x, z }), `ground at z ${z}`).toContain(stairs.id)
      // Standing on it, feet at the box's highest point or at the centre's height.
      const top = rampTopOver(stairs, playerRect({ x, z }))
      expect(ids({ x, z, y: top }), `feet at the top under the box, z ${z}`).toEqual([])
      expect(ids({ x, z, y: rampHeightAt(stairs, x, z) }), `feet at the centre's height, z ${z}`).toEqual([])
    }
    // The ramp's height formula, from the contract.
    expect(rampHeightAt(stairs, x, stairs.minZ)).toBe(stairs.low)
    expect(rampHeightAt(stairs, x, stairs.maxZ)).toBe(stairs.high)
    // Just touching its side on the ground is not an overlap.
    expect(ids({ x: stairs.maxX + PLAYER_HALF_SIZE, z: stairs.minZ + 1 })).toEqual([])
  })
})

describe('route hazards (support/geometry.ts)', () => {
  it('the ramp, the covered pocket beside it and each climb spot are hazards', () => {
    expect(hazardsAt({ x: (stairs.minX + stairs.maxX) / 2, z: (stairs.minZ + stairs.maxZ) / 2 })).toContain(stairs.id)
    // The pocket is the part of the mezzanine's footprint beside the stairs.
    expect(POCKETS).toHaveLength(1)
    const mezz = floor('mezz-west')
    expect(POCKETS[0].rect).toEqual({ minX: mezz.min.x, maxX: stairs.minX, minZ: stairs.minZ, maxZ: stairs.maxZ })
    expect(hazardsAt({ x: (mezz.min.x + stairs.minX) / 2, z: 4 })).toContain(POCKETS[0].id)
    for (const a of GRAYBOX_MAP.anchors) {
      if (a.kind !== 'climb') continue
      expect(hazardsAt({ x: a.x, z: a.z }), a.id).toContain(a.id)
      expect(hazardsAt({ x: a.x, z: a.z + ANCHOR_RANGE + ROUTE_MARGIN - 0.01 }), a.id).toContain(a.id)
      expect(hazardsAt({ x: a.x, z: a.z + ANCHOR_RANGE + ROUTE_MARGIN + 0.01 }).includes(a.id), a.id).toBe(false)
    }
  })

  it('spawn areas, terminals and the entrances used by the routes are clear of hazards', () => {
    for (const [k, r] of Object.entries(GRAYBOX_MAP.spawnAreas)) {
      for (const p of [
        { x: r.minX, z: r.minZ },
        { x: r.maxX, z: r.maxZ },
        { x: r.minX, z: r.maxZ },
        { x: r.maxX, z: r.minZ },
      ]) {
        expect(hazardsAt(p), `spawn ${k} corner`).toEqual([])
      }
    }
    for (const t of GRAYBOX_MAP.terminals) expect(hazardsAt(t), t.id).toEqual([])
    for (const e of GRAYBOX_MAP.entrances) expect(hazardsAt(e, 0), e.id).toEqual([])
  })

  it('assertLegClear and stopAlongZ refuse legs that cross a hazard', () => {
    const x = (stairs.minX + stairs.maxX) / 2
    expect(() => assertLegClear({ x, z: -3 }, { x, z: 3 }, 'test')).toThrow(/stairs-west/)
    expect(() => assertLegClear({ x: 0, z: -3 }, { x: 0, z: 3 }, 'test')).not.toThrow()
    expect(() => stopAlongZ({ x, z: -3 }, 1, 19.5)).toThrow(/stairs-west/)
    // The south wall west of the door, as room.integration.spec.ts uses it.
    expect(stopAlongZ({ x: -3, z: -13 }, 1, 19.5)).toBe(wall('wall-s-w').min.z - PLAYER_HALF_SIZE)
  })

  it('groundProblems accepts the ground (or no y and mode) and reports anything else', () => {
    expect(groundProblems({ x: 0, z: 0 })).toEqual([])
    expect(groundProblems({ x: 0, z: 0, y: 0, mode: 'ground' })).toEqual([])
    expect(groundProblems({ x: 0, z: 0, y: 0.5 })).toEqual(['y is 0.5, not on the ground'])
    expect(groundProblems({ x: 0, z: 0, mode: 'falling' })).toEqual([`mode is "falling", not 'ground'`])
    expect(groundProblems({ x: 0, z: 0, y: 'x' })).toEqual(['y is "x", not a finite number'])
  })
})
