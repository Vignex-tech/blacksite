import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  ACTION_MESSAGE,
  ANCHOR_RANGE,
  ANCHOR_REACH,
  CAN_CLIMB,
  CLIMB_SPEED,
  GRAVITY,
  JUMP_SPEED,
  MAX_FALL_SPEED,
  MAX_TEAM_SIZE,
  MOVEMENT_MODES,
  MOVE_MESSAGE,
  SHIMMY_SPEED,
  STEP_HEIGHT,
  TEAMS,
  TEAM_SPEED,
} from '../../shared/protocol.js'
import { GRAYBOX_MAP } from '../../shared/map.js'
import { allowedSteps, clampIntent, isTeam, teamStep, worldStep, yawOf } from '../e2e/support/intent.ts'

// #18's team contract (shared/protocol.js), checked in #19, and the e2e
// movement helpers (Tests/e2e/support/intent.ts) checked against the
// convention written in shared/protocol.d.ts.

/** The server's move rate (Hz) that the per-message step is derived from (#18). */
const MOVE_RATE_HZ = 20
const EPS = 1e-12

/** Thinnest extent of any solid on x or z. */
const THINNEST_SOLID = Math.min(...GRAYBOX_MAP.solids.flatMap((s) => [s.max.x - s.min.x, s.max.z - s.min.z]))

describe('team contract (#18)', () => {
  it('TEAMS equals the keys of GRAYBOX_MAP.spawnAreas', () => {
    expect([...TEAMS]).toEqual(['ghost', 'warden'])
    expect([...TEAMS].sort()).toEqual(Object.keys(GRAYBOX_MAP.spawnAreas).sort())
  })

  it('TEAM_SPEED has exactly one finite, positive speed per team', () => {
    expect(Object.keys(TEAM_SPEED).sort()).toEqual([...TEAMS].sort())
    for (const t of TEAMS) {
      expect(typeof TEAM_SPEED[t], t).toBe('number')
      expect(Number.isFinite(TEAM_SPEED[t]), t).toBe(true)
      expect(TEAM_SPEED[t], t).toBeGreaterThan(0)
    }
  })

  it('a per-message step is at most 0.5, no thicker than the thinnest solid', () => {
    expect(THINNEST_SOLID).toBeGreaterThanOrEqual(0.5)
    for (const t of TEAMS) {
      const step = TEAM_SPEED[t] / MOVE_RATE_HZ
      expect(step, t).toBeLessThanOrEqual(0.5)
      expect(step, t).toBeLessThanOrEqual(THINNEST_SOLID)
    }
  })

  it('TEAMS and TEAM_SPEED are frozen', () => {
    expect(Object.isFrozen(TEAMS)).toBe(true)
    expect(Object.isFrozen(TEAM_SPEED)).toBe(true)
    expect(() => {
      ;(TEAM_SPEED as Record<string, number>).ghost = 99
    }).toThrow(TypeError)
    expect(() => {
      ;(TEAMS as unknown as string[]).push('spectator')
    }).toThrow(TypeError)
    expect(TEAM_SPEED.ghost).not.toBe(99)
  })

  it('MAX_TEAM_SIZE is an integer of at least 2', () => {
    expect(Number.isInteger(MAX_TEAM_SIZE)).toBe(true)
    expect(MAX_TEAM_SIZE).toBeGreaterThanOrEqual(2)
  })
})

describe('e2e movement helpers (support/intent.ts)', () => {
  const close = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    expect(a.x).toBeCloseTo(b.x, 12)
    expect(a.z).toBeCloseTo(b.z, 12)
  }

  it('yaw 0 maps dx to +x and dz to +z (the M1 and M2 mapping)', () => {
    close(worldStep(1, 0, 0, 1), { x: 1, z: 0 })
    close(worldStep(0, 1, 0, 1), { x: 0, z: 1 })
    close(worldStep(-1, 0, 0, 0.1), { x: -0.1, z: 0 })
  })

  it('forward is (sin yaw, cos yaw) and right is (cos yaw, -sin yaw)', () => {
    for (const yaw of [0, 0.3, Math.PI / 2, -Math.PI / 2, 2, Math.PI, -2.5]) {
      close(worldStep(0, 1, yaw, 1), { x: Math.sin(yaw), z: Math.cos(yaw) })
      close(worldStep(1, 0, yaw, 1), { x: Math.cos(yaw), z: -Math.sin(yaw) })
    }
    // Positive yaw turns toward +x: a quarter turn faces +x, and right is then -z.
    close(worldStep(0, 1, Math.PI / 2, 1), { x: 1, z: 0 })
    close(worldStep(1, 0, Math.PI / 2, 1), { x: 0, z: -1 })
  })

  it('clamps each axis to -1..1 and caps the intent length at 1', () => {
    close(clampIntent(1e9, 0), { x: 1, z: 0 })
    close(clampIntent(-1000, 0.5), { x: -1 / Math.hypot(1, 0.5), z: 0.5 / Math.hypot(1, 0.5) })
    close(clampIntent(1, 1), { x: Math.SQRT1_2, z: Math.SQRT1_2 })
    close(clampIntent(0.3, 0.4), { x: 0.3, z: 0.4 }) // already short: unchanged
    close(clampIntent(1, 1, false), { x: 1, z: 1 })
    for (const [dx, dz] of [
      [1, 1],
      [-1e9, 1e9],
      [0.9, -0.9],
    ]) {
      expect(Math.hypot(...Object.values(worldStep(dx, dz, 1.1, 1)))).toBeLessThanOrEqual(1 + EPS)
    }
  })

  it('allowedSteps is one value for single-axis input and two for diagonals', () => {
    const [u, c] = allowedSteps(1, 0, 0, 0.12)
    close(u, c)
    const [ud, cd] = allowedSteps(1, 1, 0, 0.12)
    close(ud, { x: 0.12, z: 0.12 })
    close(cd, { x: 0.12 * Math.SQRT1_2, z: 0.12 * Math.SQRT1_2 })
  })

  it('teamStep, yawOf and isTeam follow the contract', () => {
    expect(teamStep('ghost', MOVE_RATE_HZ)).toBeCloseTo(TEAM_SPEED.ghost / MOVE_RATE_HZ, 12)
    expect(teamStep('warden', MOVE_RATE_HZ)).toBeCloseTo(TEAM_SPEED.warden / MOVE_RATE_HZ, 12)
    expect(yawOf({})).toBe(0)
    expect(yawOf({ yaw: 1.25 })).toBe(1.25)
    expect(yawOf({ yaw: Number.NaN })).toBe(0)
    expect(isTeam('ghost') && isTeam('warden')).toBe(true)
    expect(isTeam('spectator') || isTeam(undefined) || isTeam('')).toBe(false)
  })
})

// #27's vertical movement contract (shared/protocol.js), checked in #28.
describe('vertical movement contract (#27)', () => {
  /** The server's move and action handling rate (Hz): one climb or shimmy step per tick. */
  const TICK_HZ = 20

  it('MOVEMENT_MODES and ACTIONS are as documented, and frozen', () => {
    expect([...MOVEMENT_MODES]).toEqual(['ground', 'falling', 'climbing', 'hanging'])
    expect([...ACTIONS]).toEqual(['jump', 'climb', 'drop'])
    expect(ACTION_MESSAGE).toBe('action')
    expect(ACTION_MESSAGE).not.toBe(MOVE_MESSAGE)
    for (const list of [MOVEMENT_MODES, ACTIONS]) {
      expect(Object.isFrozen(list)).toBe(true)
      expect(() => (list as unknown as string[]).push('fly')).toThrow(TypeError)
    }
  })

  it('every vertical constant is a finite number, positive where it must be', () => {
    const scalars: Record<string, number> = {
      GRAVITY,
      MAX_FALL_SPEED,
      STEP_HEIGHT,
      CLIMB_SPEED,
      SHIMMY_SPEED,
      ANCHOR_RANGE,
      ANCHOR_REACH,
    }
    for (const [name, v] of Object.entries(scalars)) {
      expect(typeof v, name).toBe('number')
      expect(Number.isFinite(v), name).toBe(true)
      expect(v, name).toBeGreaterThan(0)
    }
    // Jump speeds: one per team, finite, never negative (0 means the team can't jump).
    expect(Object.keys(JUMP_SPEED).sort()).toEqual([...TEAMS].sort())
    for (const t of TEAMS) {
      expect(Number.isFinite(JUMP_SPEED[t]), t).toBe(true)
      expect(JUMP_SPEED[t], t).toBeGreaterThanOrEqual(0)
    }
    expect(JUMP_SPEED.ghost, 'Ghosts can jump').toBeGreaterThan(0)
    // CAN_CLIMB: one boolean per team.
    expect(Object.keys(CAN_CLIMB).sort()).toEqual([...TEAMS].sort())
    for (const t of TEAMS) expect(typeof CAN_CLIMB[t], t).toBe('boolean')
  })

  it('the per-team tables are frozen', () => {
    for (const [name, o] of [
      ['JUMP_SPEED', JUMP_SPEED],
      ['CAN_CLIMB', CAN_CLIMB],
    ] as const) {
      expect(Object.isFrozen(o), name).toBe(true)
      expect(() => {
        ;(o as Record<string, unknown>).warden = 99
      }, name).toThrow(TypeError)
    }
    expect(JUMP_SPEED.warden).not.toBe(99)
    expect(CAN_CLIMB.warden).not.toBe(99)
  })

  it('Wardens can neither jump nor climb; Ghosts can climb', () => {
    expect(JUMP_SPEED.warden).toBe(0)
    expect(CAN_CLIMB.warden).toBe(false)
    expect(CAN_CLIMB.ghost).toBe(true)
  })

  it("for each team the jump apex v^2 / (2 * GRAVITY) plus STEP_HEIGHT is below the lowest cover top", () => {
    const coverTops = GRAYBOX_MAP.solids.filter((s) => s.kind === 'cover').map((s) => s.max.y)
    expect(coverTops.length).toBeGreaterThan(0)
    const lowestCover = Math.min(...coverTops)
    const lowestSolid = Math.min(...GRAYBOX_MAP.solids.map((s) => s.max.y))
    for (const t of TEAMS) {
      const apex = JUMP_SPEED[t] ** 2 / (2 * GRAVITY)
      expect(apex + STEP_HEIGHT, `${t}: apex ${apex} + step`).toBeLessThan(lowestCover)
      expect(apex + STEP_HEIGHT, `${t}: apex ${apex} + step`).toBeLessThan(lowestSolid)
    }
    // The documented value: a Ghost's apex is about 0.51.
    expect(JUMP_SPEED.ghost ** 2 / (2 * GRAVITY)).toBeCloseTo(0.50625, 9)
  })

  it('a climb or shimmy step per tick (speed / 20) is at most 0.5', () => {
    expect(CLIMB_SPEED / TICK_HZ).toBeLessThanOrEqual(0.5)
    expect(SHIMMY_SPEED / TICK_HZ).toBeLessThanOrEqual(0.5)
  })
})
