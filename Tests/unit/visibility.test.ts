import { describe, expect, it } from 'vitest'
import { EYE_HEIGHT, VISIBILITY_NEAR } from '../../shared/protocol.js'
import { PLAYER_HEIGHT } from '../../shared/map.js'
import {
  blockers,
  centreDistance,
  clearlyHidden,
  clearlyVisible,
  coreSamples,
  eyeOf,
  hasLineOfSight,
  visibilityOf,
} from '../e2e/support/visibility.ts'

// The e2e line-of-sight helpers (Tests/e2e/support/visibility.ts, #45) that
// specs use to place a Warden and a Ghost "in sight" or "out of sight" for the
// M5 hidden-information filter. They are computed from shared/map.js alone,
// so these cases pin them against the real map.

describe('hasLineOfSight / blockers', () => {
  it('a clear ray in the open has no blockers', () => {
    expect(hasLineOfSight({ x: 12, y: 1.6, z: -12 }, { x: 16, y: 0.9, z: -16 })).toBe(true)
  })

  it('the south wall blocks a ray through it, and a ray through the doorway is clear', () => {
    const through = blockers({ x: 3, y: 1.6, z: 3 }, { x: 3, y: 0.9, z: -16 })
    expect(through).toContain('wall-s-e')
    expect(hasLineOfSight({ x: 0, y: 1.6, z: 3 }, { x: 0, y: 0.9, z: -16 })).toBe(true)
  })

  it('a ray skimming over the 1.2 high cover is clear, one through it is not', () => {
    // Eye 1.6 at z 3 to the head (1.7) at z -16 passes over cover-low-wall; to the feet it does not.
    expect(hasLineOfSight({ x: 0, y: 1.6, z: 3 }, { x: 0, y: 1.7, z: -16 })).toBe(true)
    expect(blockers({ x: 0, y: 1.6, z: 3 }, { x: 0, y: 0.1, z: -16 })).toContain('cover-low-wall')
  })

  it('a floor slab blocks a ray that crosses it, a ray above it is clear', () => {
    expect(blockers({ x: 0, y: 1.6, z: -0.2 }, { x: 0, y: 4.78, z: -0.2 })).toContain('catwalk')
    expect(hasLineOfSight({ x: 0, y: 3.5, z: 3 }, { x: 0, y: 3.9, z: -3 })).toBe(true)
  })

  it('a ramp wedge blocks a ray that dips into it', () => {
    // Ground level (0.5) along the stairs: the wedge is 1.36 high at z 3.
    expect(blockers({ x: -6.6, y: 0.5, z: 0.2 }, { x: -6.6, y: 0.5, z: 5 })).toContain('stairs-west')
    expect(hasLineOfSight({ x: -6.6, y: 4.5, z: 0.2 }, { x: -6.6, y: 4.5, z: 5 })).toBe(true)
  })

  it('touching a face is not blocked', () => {
    // Along the top face of the south wall (height 3).
    expect(hasLineOfSight({ x: 5, y: 3, z: -9 }, { x: 5, y: 3, z: -6 })).toBe(true)
  })
})

describe('visibilityOf', () => {
  const warden = { x: 0, z: 3 }

  it('is visible down the south doorway line and hidden behind the wall beside it', () => {
    expect(visibilityOf(warden, { x: 0, z: -16 })).toBe('visible')
    expect(visibilityOf({ x: 3, z: 3 }, { x: 3, z: -16 })).toBe('hidden')
    expect(clearlyVisible(warden, { x: 0, z: -16 })).toBe(true)
    expect(clearlyHidden({ x: 3, z: 3 }, { x: 3, z: -16 })).toBe(true)
  })

  it('a Ghost right behind a wall is visible when it is within VISIBILITY_NEAR, unsure at the edge', () => {
    // Wall z -8..-7.5, viewer inside at z -7, ghost outside at z -8.4: centre distance 1.4.
    const viewer = { x: 3, z: -7 }
    const ghost = { x: 3, z: -8.4 }
    expect(centreDistance(viewer, ghost)).toBeLessThan(VISIBILITY_NEAR)
    expect(visibilityOf(viewer, ghost)).toBe('visible')
    const edge = { x: 3, z: -7 - VISIBILITY_NEAR }
    expect(visibilityOf(viewer, edge)).toBe('unsure')
    expect(visibilityOf(viewer, { x: 3, z: -7 - VISIBILITY_NEAR - 1 })).toBe('hidden')
  })

  it('a Ghost on the catwalk above a Warden is hidden by the slab', () => {
    expect(visibilityOf({ x: 0, z: -0.2 }, { x: 0, y: 3, z: -0.2 })).toBe('hidden')
  })

  it('uses the eye and the core sample points', () => {
    expect(eyeOf({ x: 1, z: 2, y: 3 })).toEqual({ x: 1, y: 3 + EYE_HEIGHT, z: 2 })
    const ys = coreSamples({ x: 0, z: 0 }).map((p) => p.y)
    expect(Math.max(...ys)).toBeLessThan(PLAYER_HEIGHT)
    expect(Math.min(...ys)).toBeGreaterThan(0)
    expect(ys).toContain(PLAYER_HEIGHT / 2)
  })
})
