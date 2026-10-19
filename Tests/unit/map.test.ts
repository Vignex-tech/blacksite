import { describe, expect, it } from 'vitest'
import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT, UPPER_LEVEL_Y, type GrayboxMap } from '../../shared/map.js'
import { ANCHOR_REACH, GRAVITY, GROUND_SIZE, HACK_RANGE, JUMP_SPEED, STEP_HEIGHT, TEAMS } from '../../shared/protocol.js'
import {
  allViolations,
  building,
  checkBounds,
  checkEntrances,
  checkIds,
  checkSolidShapes,
  checkSpawnAreas,
  checkActiveTerminal,
  checkTerminals,
  checkWithinBounds,
  grow,
  reachableFrom,
  type MapLimits,
} from './support/mapInvariants.ts'
import {
  allUpperViolations,
  checkClimbAnchors,
  checkFloors,
  checkLedges,
  checkOutOfReach,
  checkRampClearance,
  checkRamps,
  checkUpperOnlyByRamps,
  checkUpperWithinBounds,
  groundVolumes,
  jumpApex,
  reachByHeight,
  type VerticalLimits,
} from './support/mapInvariants.ts'

// Unit checks of the shared graybox map contract (#10), verified in #16.
// The invariants are the ones documented at the top of shared/map.d.ts. The
// checker (support/mapInvariants.ts) is also run on broken copies of the map,
// so a check that can never fail would show up here.

const LIMITS: MapLimits = { playerHalfSize: PLAYER_HALF_SIZE, groundSize: GROUND_SIZE, playerHeight: PLAYER_HEIGHT, stepHeight: STEP_HEIGHT }

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
    expect(checkSpawnAreas(GRAYBOX_MAP, LIMITS)).toEqual([])
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

  it('17. ACTIVE_TERMINAL_ID names an existing terminal, with ground to stand on within HACK_RANGE (M6, #55)', () => {
    expect(GRAYBOX_MAP.terminals.map((t) => t.id)).toContain(ACTIVE_TERMINAL_ID)
    expect(checkActiveTerminal(GRAYBOX_MAP, LIMITS, ACTIVE_TERMINAL_ID, HACK_RANGE)).toEqual([])
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
      GRAYBOX_MAP.floors,
      GRAYBOX_MAP.ramps,
      GRAYBOX_MAP.anchors,
      ...GRAYBOX_MAP.floors.flatMap((f) => [f, f.min, f.max]),
      ...GRAYBOX_MAP.ramps,
      ...GRAYBOX_MAP.anchors,
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
    // Ramps are obstacles on the ground, but the foot of each is reachable:
    // a player box just short of its low edge (here: south of a '+z' ramp).
    for (const r of GRAYBOX_MAP.ramps) {
      expect(r.rises, 'this test knows +z ramps').toBe('+z')
      expect(reach((r.minX + r.maxX) / 2, r.minZ - PLAYER_HALF_SIZE), `foot of ${r.id}`).toBe(true)
    }
  })

  it('the ground checks see only the ground band: every solid and ramp, no upper-level floor', () => {
    const ids = groundVolumes(GRAYBOX_MAP, LIMITS).map((v) => v.id)
    expect(ids).toEqual([...GRAYBOX_MAP.solids.map((s) => s.id), ...GRAYBOX_MAP.ramps.map((r) => r.id)])
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

  // Invariant 17 (M6, #55): the check must fail on a bad active id and on a hack circle with no room.
  it('flags: an active terminal id that is not a terminal', () => {
    expect(checkActiveTerminal(GRAYBOX_MAP, LIMITS, 'terminal-z', HACK_RANGE).join()).toMatch(/not a terminal of the map/)
  })

  it('flags: an active terminal boxed in by cover (no free ground within range)', () => {
    const m = copy()
    const t = m.terminals[0]
    // A big cover block around the terminal, thick enough to cover the whole ring.
    m.solids.push({ id: 'cover-box', kind: 'cover', min: { x: t.x - 4, y: 0, z: t.z - 4 }, max: { x: t.x + 4, y: 1.2, z: t.z + 4 } })
    expect(checkActiveTerminal(m, LIMITS, 'terminal-a', HACK_RANGE).join()).toMatch(/no free ground/)
  })

  it('flags: a non-positive hack range', () => {
    expect(checkActiveTerminal(GRAYBOX_MAP, LIMITS, 'terminal-a', 0).join()).toMatch(/not positive/)
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

// ---------------------------------------------------------------------------
// Upper level (M4, #27; invariants 9 to 16 of shared/map.d.ts), checked in #28.
// ---------------------------------------------------------------------------

const VLIMITS: VerticalLimits = {
  ...LIMITS,
  upperY: UPPER_LEVEL_Y,
  gravity: GRAVITY,
  jumpSpeeds: TEAMS.map((t) => JUMP_SPEED[t]),
  anchorReach: ANCHOR_REACH,
}

const wardenSpawn = () => centre(GRAYBOX_MAP.spawnAreas.warden)

describe('GRAYBOX_MAP upper level (shared/map.js, #27)', () => {
  it('exports UPPER_LEVEL_Y 3 and lists floors, ramps and anchors of both kinds', () => {
    expect(UPPER_LEVEL_Y).toBe(3)
    expect(GRAYBOX_MAP.floors.length).toBeGreaterThan(0)
    expect(GRAYBOX_MAP.ramps.length).toBeGreaterThan(0)
    expect(GRAYBOX_MAP.anchors.some((a) => a.kind === 'climb')).toBe(true)
    expect(GRAYBOX_MAP.anchors.some((a) => a.kind === 'ledge')).toBe(true)
    expect(GRAYBOX_MAP.anchors.every((a) => a.kind === 'climb' || a.kind === 'ledge')).toBe(true)
  })

  it('9. every floor, ramp and anchor is within bounds', () => {
    expect(checkUpperWithinBounds(GRAYBOX_MAP)).toEqual([])
  })

  it('10. floors are thin slabs at UPPER_LEVEL_Y with headroom underneath, overlapping no solid or floor', () => {
    expect(checkFloors(GRAYBOX_MAP, VLIMITS)).toEqual([])
  })

  it('11. ramps are wide enough, no steeper than 0.6, start on the ground and meet a floor top', () => {
    expect(checkRamps(GRAYBOX_MAP, VLIMITS)).toEqual([])
  })

  it('12. ramps are clear of spawn areas, entrances, doorways, terminals, solids, floors and each other', () => {
    expect(checkRampClearance(GRAYBOX_MAP, LIMITS)).toEqual([])
  })

  it('13. each climb anchor is flush with a solid face, clear, and linked to an existing ledge it reaches', () => {
    expect(checkClimbAnchors(GRAYBOX_MAP, LIMITS)).toEqual([])
  })

  it('14. each ledge has a clear, supported standing spot and a clear hanging line', () => {
    expect(checkLedges(GRAYBOX_MAP, LIMITS)).toEqual([])
  })

  it('15. anchor, floor and ramp ids are unique', () => {
    expect(checkIds(GRAYBOX_MAP)).toEqual([])
  })

  it('16. the jump apex plus a step is below the lowest solid top, and every ledge is out of reach from the ground', () => {
    expect(jumpApex(VLIMITS)).toBeCloseTo(JUMP_SPEED.ghost ** 2 / (2 * GRAVITY), 12)
    expect(checkOutOfReach(GRAYBOX_MAP, VLIMITS)).toEqual([])
  })

  for (const team of TEAMS) {
    const apex = JUMP_SPEED[team] ** 2 / (2 * GRAVITY)

    it(`16. reachability (${team} jump ${JUMP_SPEED[team]}): from the Warden spawn the ramps lead onto every upper floor`, () => {
      const r = reachByHeight(GRAYBOX_MAP, LIMITS, wardenSpawn(), apex)
      expect([...r.floorsReached].sort()).toEqual(GRAYBOX_MAP.floors.map((f) => f.id).sort())
      expect(r.maxY).toBeCloseTo(UPPER_LEVEL_Y, 9)
      // A grid point (0.25 apart, aligned like the fill's) near each floor's centre is stood on at its top.
      for (const f of GRAYBOX_MAP.floors) {
        const cx = Math.round(((f.min.x + f.max.x) / 2) * 4) / 4
        const cz = Math.round(((f.min.z + f.max.z) / 2) * 4) / 4
        expect(r.at(cx, cz, f.max.y), `${f.id} at ${cx},${cz}`).toBe(true)
      }
    })

    it(`16. reachability (${team} jump ${JUMP_SPEED[team]}): with the ramps removed the upper level is out of reach`, () => {
      const r = reachByHeight({ ...copy(), ramps: [] } as GrayboxMap, LIMITS, wardenSpawn(), apex)
      expect([...r.floorsReached]).toEqual([])
      expect(r.maxY, 'nothing above the ground can be stood on').toBe(0)
      expect(r.states, 'the fill still covered the ground').toBeGreaterThan(10_000)
    })
  }
})

describe('upper-level checks catch broken maps', () => {
  it('passes the real map with no violations at all', () => {
    expect(allUpperViolations(GRAYBOX_MAP, VLIMITS)).toEqual([])
    expect(checkUpperOnlyByRamps(GRAYBOX_MAP, VLIMITS, wardenSpawn())).toEqual([])
  })

  const floor = (m: Mutable<GrayboxMap>, id: string) => m.floors.find((f) => f.id === id)!
  const anchor = (m: Mutable<GrayboxMap>, id: string) => m.anchors.find((a) => a.id === id)! as Record<string, unknown>
  const ramp = (m: Mutable<GrayboxMap>) => m.ramps[0]

  const cases: [string, (m: Mutable<GrayboxMap>) => void, RegExp, Partial<VerticalLimits>?][] = [
    // 9
    ['floor outside bounds', (m) => void (floor(m, 'mezz-west').min.x = -21), /floor mezz-west outside bounds/],
    ['ramp outside bounds', (m) => void (ramp(m).minZ = -25), /ramp stairs-west outside bounds/],
    ['anchor outside bounds', (m) => void (anchor(m, 'climb-west').x = -30), /anchor climb-west outside bounds/],
    ['ledge end outside bounds', (m) => void (anchor(m, 'ledge-catwalk-south').x1 = 30), /anchor ledge-catwalk-south outside bounds/],
    // 10
    ['floor top not at the upper level', (m) => void (floor(m, 'landing-nw').max.y = 2.9), /floor landing-nw: top 2\.9 is not the upper level/],
    ['floor slab too thick', (m) => void (floor(m, 'catwalk').min.y = 2.5), /floor catwalk: 0\.5 thick/],
    ['floor with no headroom', (m) => void (floor(m, 'catwalk').min.y = 2.1), /floor catwalk: underside 2\.1 leaves no headroom/],
    ['floor too narrow', (m) => void (floor(m, 'landing-nw').max.x = -6.5), /floor landing-nw: 1 wide on x/],
    ['floor overlaps a solid', (m) => void (floor(m, 'mezz-west').min.x = -9.75), /floor mezz-west overlaps solid wall-w-/],
    ['floors overlap', (m) => void (floor(m, 'landing-nw').min.x = -8), /floor landing-nw overlaps floor mezz-west/],
    // 11
    ['ramp too narrow', (m) => void (ramp(m).maxX = -6.25), /ramp stairs-west: 1\.25 wide/],
    ['ramp too steep', (m) => void (ramp(m).minZ = 2), /ramp stairs-west: slope 0\.75/],
    ['ramp not starting on the ground', (m) => void (ramp(m).low = 0.2), /ramp stairs-west: low 0\.2 is not the ground/],
    ['ramp meeting no floor', (m) => void (ramp(m).high = 2), /ramp stairs-west: its high end meets no floor/],
    ['ramp rising the wrong way', (m) => void (ramp(m).rises = '+x'), /ramp stairs-west: its high end meets no floor/],
    ['ramp with an unknown rise', (m) => void ((ramp(m) as Record<string, unknown>).rises = 'up'), /ramp stairs-west: unknown rise up/],
    // 12
    ['ramp near a spawn area', (m) => void Object.assign(ramp(m), { minX: -2, maxX: 0 }), /ramp stairs-west within 1 of spawn warden/],
    ['ramp in an entrance', (m) => void Object.assign(ramp(m), { minX: -10.5, maxX: -8.5, minZ: -1, maxZ: 1 }), /ramp stairs-west overlaps entrance door-west/],
    ['ramp blocking a doorway', (m) => void Object.assign(ramp(m), { minX: 7.5, maxX: 9.25, minZ: 0.5, maxZ: 2.25 }), /ramp stairs-west blocks doorway door-east/],
    ['ramp on a terminal', (m) => void Object.assign(ramp(m), { minX: -8, maxX: -6, minZ: -6, maxZ: -4.5 }), /ramp stairs-west overlaps terminal terminal-a/],
    ['ramp overlapping a solid', (m) => void (ramp(m).maxX = -5.25), /ramp stairs-west overlaps solid pillar-nw/],
    ['ramp overlapping a floor', (m) => void (ramp(m).maxZ = 6.5), /ramp stairs-west overlaps floor landing-nw/],
    ['ramps overlapping', (m) => void m.ramps.push({ ...ramp(m), id: 'stairs-copy' }), /ramp stairs-west overlaps ramp stairs-copy/],
    // 13
    ['climb naming a missing ledge', (m) => void (anchor(m, 'climb-west').ledgeId = 'nope'), /climb climb-west: ledgeId nope names no ledge/],
    ['climb naming a climb', (m) => void (anchor(m, 'climb-west').ledgeId = 'climb-east'), /climb climb-west: ledgeId climb-east names no ledge/],
    ['climb off the wall', (m) => void (anchor(m, 'climb-west').x = -10.6), /climb climb-west: not flush with a solid face/],
    ['climb facing away from the wall', (m) => void (anchor(m, 'climb-west').facing = -Math.PI / 2), /climb climb-west: not flush with a solid face/],
    ['climb facing diagonally', (m) => void (anchor(m, 'climb-east').facing = Math.PI / 4), /climb climb-east: facing .* is not along x or z/],
    ['climb inside the wall', (m) => void (anchor(m, 'climb-east').x = 9.1), /climb climb-east: its climbing box overlaps wall-e-s/],
    ['climb past the wall end', (m) => void (anchor(m, 'climb-west').z = 7.25), /climb climb-west: not flush with a solid face/],
    ['climb top below its ledge', (m) => void (anchor(m, 'climb-east').maxY = 1), /climb climb-east: top 2\.8 is not ledge ledge-east-platform's y 3/],
    ['climb off its ledge segment', (m) => void (anchor(m, 'climb-west').z = 7), /climb climb-west: not on ledge ledge-west-wall's segment/],
    // 14
    ['ledge standing spot inside a wall', (m) => void (anchor(m, 'ledge-west-wall').y = 2), /ledge ledge-west-wall: standing spot .* overlaps wall-w-n/],
    ['ledge standing spot over nothing', (m) => void (anchor(m, 'ledge-mezz-south').facing = Math.PI), /ledge ledge-mezz-south: standing spot .* rests on nothing/],
    ['ledge hanging into the floor', (m) => void Object.assign(anchor(m, 'ledge-catwalk-south'), { z0: -0.75, z1: -0.75 }), /ledge ledge-catwalk-south: a player hanging on it overlaps catwalk/],
    // 15
    ['duplicate anchor id', (m) => void (m.anchors[1].id = m.anchors[0].id), /anchors: duplicate id climb-west/],
    ['duplicate floor id', (m) => void (m.floors[1].id = m.floors[0].id), /floors: duplicate id mezz-west/],
    ['duplicate ramp id', (m) => void m.ramps.push({ ...ramp(m), minX: 12, maxX: 14 }), /ramps: duplicate id stairs-west/],
    // 16
    ['a jump that clears cover', () => {}, /jump apex 1\.225 \+ step 0\.35 reaches the lowest solid top 1\.2/, { jumpSpeeds: [7, 0] }],
    ['a jump that grabs a ledge', () => {}, /ledge ledge-west-wall can be grabbed from a jump/, { jumpSpeeds: [5] }],
    ['a ledge low enough to grab', (m) => void (anchor(m, 'ledge-mezz-south').y = 2.8), /ledge ledge-mezz-south can be grabbed from a jump/],
  ]

  for (const [name, breakIt, expected, limits] of cases) {
    it(`flags: ${name}`, () => {
      const m = copy()
      breakIt(m)
      const v = allUpperViolations(m as GrayboxMap, { ...VLIMITS, ...limits })
      expect(v.some((s) => expected.test(s)), `violations: ${JSON.stringify(v)}`).toBe(true)
    })
  }

  it('flags: a staircase of crates up to the catwalk (the upper level reachable without ramps)', () => {
    const m = copy()
    // Ten 0.5-wide steps rising 0.3 each, west to east, just south of the catwalk.
    for (let k = 0; k < 10; k++) {
      m.solids.push({ id: `step-${k}`, kind: 'cover', min: { x: -3 + 0.5 * k, y: 0, z: -2 }, max: { x: -2.5 + 0.5 * k, y: 0.3 * (k + 1), z: -1 } })
    }
    const v = checkUpperOnlyByRamps(m as GrayboxMap, VLIMITS, wardenSpawn())
    expect(v.some((s) => /without ramps, jump speed 0 reaches floors .*catwalk/.test(s)), `violations: ${JSON.stringify(v)}`).toBe(true)
  })

  it('flags: a floor lowered to a step above the ground', () => {
    const m = copy()
    const f = floor(m, 'platform-east')
    f.min.y = 0.1
    f.max.y = 0.3
    const v = checkUpperOnlyByRamps(m as GrayboxMap, VLIMITS, wardenSpawn())
    expect(v.some((s) => /reaches floors .*platform-east/.test(s)), `violations: ${JSON.stringify(v)}`).toBe(true)
  })

  it('flags: a jump that reaches the upper level, and not a jump that reaches only cover tops', () => {
    const highJump = Math.sqrt(2 * GRAVITY * (UPPER_LEVEL_Y - STEP_HEIGHT + 0.01))
    const v = checkUpperOnlyByRamps(GRAYBOX_MAP, { ...VLIMITS, jumpSpeeds: [highJump] }, wardenSpawn())
    expect(v.some((s) => /reaches floors/.test(s)), `violations: ${JSON.stringify(v)}`).toBe(true)
    // Apex 1: cover tops (1.2) can be stood on, but nothing leads higher.
    expect(checkUpperOnlyByRamps(GRAYBOX_MAP, { ...VLIMITS, jumpSpeeds: [Math.sqrt(2 * GRAVITY * 1.0)] }, wardenSpawn())).toEqual([])
  })
})
