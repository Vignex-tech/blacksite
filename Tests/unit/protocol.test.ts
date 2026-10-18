import { describe, expect, it } from 'vitest'
import { MAX_TEAM_SIZE, TEAMS, TEAM_SPEED } from '../../shared/protocol.js'
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
