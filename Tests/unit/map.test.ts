import { describe, expect, it } from 'vitest'
import { GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT, type GrayboxMap } from '../../shared/map.js'
import { GROUND_SIZE } from '../../shared/protocol.js'
import {
  allViolations,
  building,
  checkBounds,
  checkEntrances,
  checkIds,
  checkSolidShapes,
  checkSpawnAreas,
  checkTerminals,
  checkWithinBounds,
  grow,
  reachableFrom,
  type MapLimits,
} from './support/mapInvariants.ts'

// Unit checks of the shared graybox map contract (#10), verified in #16.
// The invariants are the ones documented at the top of shared/map.d.ts. The
// checker (support/mapInvariants.ts) is also run on broken copies of the map,
// so a check that can never fail would show up here.

const LIMITS: MapLimits = { playerHalfSize: PLAYER_HALF_SIZE, groundSize: GROUND_SIZE }

/** A mutable deep copy of the (frozen) map, to break on purpose. */
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> }
function copy(): Mutable<GrayboxMap> {
  return structuredClone(GRAYBOX_MAP) as Mutable<GrayboxMap>
}

const centre = (r: { minX: number; maxX: number; minZ: number; maxZ: number }) => ({
  x: (r.minX + r.maxX) / 2,
  z: (r.minZ + r.maxZ) / 2,
})

describe('GRAYBOX_MAP contract (shared/map.js)', () => {
  it('exports the documented constants and ids', () => {
    expect(PLAYER_HALF_SIZE).toBe(0.5)
    expect(PLAYER_HEIGHT).toBe(1.8)
    expect(GRAYBOX_MAP.id).toBe('graybox-1')
    expect(GRAYBOX_MAP.solids.length).toBeGreaterThan(0)
  })

  it('1. every solid has min < max on x, y, z and is at least 0.5 thick on x and z', () => {
    expect(checkSolidShapes(GRAYBOX_MAP)).toEqual([])
  })

  it('2. every solid, spawn area, entrance and terminal is within bounds', () => {
    expect(checkWithinBounds(GRAYBOX_MAP)).toEqual([])
  })

  it('3/4. spawn areas are 1 unit clear of every solid, do not overlap; Ghost outside, Warden inside', () => {
    expect(checkSpawnAreas(GRAYBOX_MAP)).toEqual([])
    const bld = building(GRAYBOX_MAP)!
    // The building found from the walls matches the one documented in map.d.ts.
    expect(bld.outer).toEqual({ minX: -10, maxX: 10, minZ: -8, maxZ: 8 })
    expect(bld.inner).toEqual({ minX: -9.5, maxX: 9.5, minZ: -7.5, maxZ: 7.5 })
  })

  it('5. at least 3 entrances, each clear for a player box, in the wall ring, at least 2 wide', () => {
    expect(GRAYBOX_MAP.entrances.length).toBeGreaterThanOrEqual(3)
    expect(checkEntrances(GRAYBOX_MAP, LIMITS)).toEqual([])
  })

  it('6. exactly two terminals, each clear for a player box and inside the building', () => {
    expect(GRAYBOX_MAP.terminals).toHaveLength(2)
    expect(checkTerminals(GRAYBOX_MAP, LIMITS)).toEqual([])
  })

  it('7. ids are unique within each list', () => {
    expect(checkIds(GRAYBOX_MAP)).toEqual([])
  })

  it('8. bounds equal +- GROUND_SIZE / 2', () => {
    expect(GRAYBOX_MAP.bounds).toEqual({
      minX: -GROUND_SIZE / 2,
      maxX: GROUND_SIZE / 2,
      minZ: -GROUND_SIZE / 2,
      maxZ: GROUND_SIZE / 2,
    })
    expect(checkBounds(GRAYBOX_MAP, LIMITS)).toEqual([])
  })

  it('ground-floor walls are taller than a player and cover is shorter, both blocking 0..PLAYER_HEIGHT', () => {
    for (const s of GRAYBOX_MAP.solids.filter((v) => v.min.y === 0)) {
      if (s.kind === 'wall') expect(s.max.y, s.id).toBeGreaterThan(PLAYER_HEIGHT)
      else expect(s.max.y, s.id).toBeLessThan(PLAYER_HEIGHT)
      expect(s.max.y, s.id).toBeGreaterThan(0)
    }
  })

  it('is deeply frozen', () => {
    const objects: unknown[] = [
      GRAYBOX_MAP,
      GRAYBOX_MAP.bounds,
      GRAYBOX_MAP.solids,
      GRAYBOX_MAP.entrances,
      GRAYBOX_MAP.terminals,
      GRAYBOX_MAP.spawnAreas,
      GRAYBOX_MAP.spawnAreas.ghost,
      GRAYBOX_MAP.spawnAreas.warden,
      ...GRAYBOX_MAP.solids.flatMap((s) => [s, s.min, s.max]),
      ...GRAYBOX_MAP.entrances,
      ...GRAYBOX_MAP.terminals,
    ]
    for (const o of objects) expect(Object.isFrozen(o)).toBe(true)
    expect(() => {
      ;(GRAYBOX_MAP.solids[0].min as { x: number }).x = 99
    }).toThrow(TypeError)
    expect(GRAYBOX_MAP.solids[0].min.x).not.toBe(99)
  })

  it('a player can walk from the Ghost spawn to the Warden spawn, every entrance and every terminal', () => {
    const { ghost, warden } = GRAYBOX_MAP.spawnAreas
    const reach = reachableFrom(GRAYBOX_MAP, LIMITS, centre(ghost))
    expect(reach(centre(warden).x, centre(warden).z), 'warden spawn').toBe(true)
    for (const e of GRAYBOX_MAP.entrances) expect(reach(e.x, e.z), e.id).toBe(true)
    for (const t of GRAYBOX_MAP.terminals) expect(reach(t.x, t.z), t.id).toBe(true)
  })

  it('the entrances are the only ways into the building', () => {
    // Plug every doorway with a block: the inside can no longer be reached.
    const m = copy()
    for (const e of m.entrances) {
      const r = grow({ minX: e.x, maxX: e.x, minZ: e.z, maxZ: e.z }, 1.6)
      m.solids.push({ id: `plug-${e.id}`, kind: 'wall', min: { x: r.minX, y: 0, z: r.minZ }, max: { x: r.maxX, y: 3, z: r.maxZ } })
    }
    const reach = reachableFrom(m, LIMITS, centre(m.spawnAreas.ghost))
    const w = centre(m.spawnAreas.warden)
    expect(reach(w.x, w.z)).toBe(false)
    for (const t of m.terminals) expect(reach(t.x, t.z), t.id).toBe(false)
  })
})

// Each check must fail on a map that breaks its invariant.
describe('map invariant checks catch broken maps', () => {
  it('passes the real map with no violations at all', () => {
    expect(allViolations(GRAYBOX_MAP, LIMITS)).toEqual([])
  })

  const cases: [string, (m: Mutable<GrayboxMap>) => void, RegExp][] = [
    ['min >= max', (m) => void (m.solids[0].max.y = m.solids[0].min.y), /min\.y .* >= max\.y/],
    ['thin solid', (m) => void (m.solids[0].max.z = m.solids[0].min.z + 0.4), /thick on z/],
    ['solid outside bounds', (m) => void (m.solids[13].min.z = -21), /solid cover-yard-s outside bounds/],
    ['terminal outside bounds', (m) => void (m.terminals[0].x = 25), /terminal terminal-a outside bounds/],
    ['bounds not +-20', (m) => void (m.bounds.maxX = 19), /bounds .* != \+-20/],
    ['spawn too close to a solid', (m) => void (m.spawnAreas.warden.maxX = 3.6), /spawn warden within 1 of pillar-ne/],
    ['spawn areas overlap', (m) => void (m.spawnAreas.ghost = { ...m.spawnAreas.warden }), /spawn areas overlap/],
    ['ghost spawn inside', (m) => void (m.spawnAreas.ghost = { minX: -3, maxX: 3, minZ: -1, maxZ: 0 }), /ghost spawn is not outside/],
    ['warden spawn outside', (m) => void (m.spawnAreas.warden = { minX: 14, maxX: 16, minZ: 10, maxZ: 12 }), /warden spawn is not inside/],
    ['too few entrances', (m) => void m.entrances.splice(0, 2), /2 entrances \(< 3\)/],
    ['entrance in a wall', (m) => void (m.entrances[0].x = 3), /entrance door-south overlaps wall-s-e/],
    ['entrance not on the wall ring', (m) => void (m.entrances[0].z = -12), /door-south is not in the building's wall ring/],
    // South doorway gap becomes -1.5..0.4: 1.9 wide (the entrance box overlap is flagged too).
    ['narrow doorway', (m) => void (m.solids.find((s) => s.id === 'wall-s-e')!.min.x = 0.4), /door-south doorway 1\.9\d* wide/],
    ['one terminal', (m) => void m.terminals.pop(), /1 terminals \(expected 2\)/],
    ['terminal in cover', (m) => void Object.assign(m.terminals[0], { x: -5.25, z: -3.25 }), /terminal-a overlaps cover-crate-sw/],
    ['terminal outside', (m) => void Object.assign(m.terminals[0], { x: 15, z: 15 }), /terminal-a is not inside the building/],
    ['duplicate solid id', (m) => void (m.solids[1].id = m.solids[0].id), /solids: duplicate id wall-s-w/],
    ['duplicate terminal id', (m) => void (m.terminals[1].id = m.terminals[0].id), /terminals: duplicate id terminal-a/],
  ]

  for (const [name, breakIt, expected] of cases) {
    it(`flags: ${name}`, () => {
      const m = copy()
      breakIt(m)
      const v = allViolations(m, LIMITS)
      expect(v.some((s) => expected.test(s)), `violations: ${JSON.stringify(v)}`).toBe(true)
    })
  }
})
