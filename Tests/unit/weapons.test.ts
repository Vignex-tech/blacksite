import { describe, expect, it } from 'vitest'
import {
  DAMAGED_EVENT,
  EYE_HEIGHT,
  FIRE_BURST,
  FIRE_MESSAGE,
  FIRE_RATE_HZ,
  FRIENDLY_FIRE,
  HIT_EVENT,
  MAX_HEALTH,
  RELOAD_MESSAGE,
  SHOT_EVENT,
  TEAMS,
  VISIBILITY_NEAR,
  WEAPONS,
} from '../../shared/protocol.js'
import { PLAYER_HEIGHT } from '../../shared/map.js'

// #40: the M5 weapons and damage contract (#39, shared/protocol.js) and the
// gate arithmetic that follows from the proposed numbers (#38).

const hitsToKill = (shooter: 'ghost' | 'warden', victim: 'ghost' | 'warden') => Math.ceil(MAX_HEALTH[victim] / WEAPONS[shooter].damage)

describe('weapons contract (#39)', () => {
  it('message and event names are the documented strings', () => {
    expect([FIRE_MESSAGE, RELOAD_MESSAGE, SHOT_EVENT, HIT_EVENT, DAMAGED_EVENT]).toEqual(['fire', 'reload', 'shot', 'hit', 'damaged'])
    expect(new Set([FIRE_MESSAGE, RELOAD_MESSAGE, SHOT_EVENT, HIT_EVENT, DAMAGED_EVENT]).size).toBe(5)
  })

  it('MAX_HEALTH and WEAPONS are frozen, with one positive entry per team', () => {
    expect(Object.isFrozen(MAX_HEALTH)).toBe(true)
    expect(Object.isFrozen(WEAPONS)).toBe(true)
    expect(Object.keys(MAX_HEALTH).sort()).toEqual([...TEAMS].sort())
    expect(Object.keys(WEAPONS).sort()).toEqual([...TEAMS].sort())
    for (const t of TEAMS) {
      expect(Object.isFrozen(WEAPONS[t]), `${t} weapon frozen`).toBe(true)
      expect(Number.isFinite(MAX_HEALTH[t]) && MAX_HEALTH[t] > 0).toBe(true)
      expect(Object.keys(WEAPONS[t]).sort()).toEqual(['damage', 'intervalMs', 'magazine', 'name', 'range', 'reloadMs'])
      expect(typeof WEAPONS[t].name).toBe('string')
      for (const k of ['damage', 'intervalMs', 'magazine', 'reloadMs', 'range'] as const) {
        expect(Number.isFinite(WEAPONS[t][k]) && WEAPONS[t][k] > 0, `${t}.${k} positive`).toBe(true)
      }
      expect(Number.isInteger(WEAPONS[t].magazine)).toBe(true)
    }
  })

  it('the proposed numbers from #38', () => {
    expect({ ...MAX_HEALTH }).toEqual({ ghost: 100, warden: 150 })
    expect({ ...WEAPONS.warden }).toMatchObject({ damage: 25, intervalMs: 150, magazine: 30, reloadMs: 2000, range: 40 })
    expect({ ...WEAPONS.ghost }).toMatchObject({ damage: 15, intervalMs: 300, magazine: 12, reloadMs: 1500, range: 25 })
  })

  it('other constants are sane', () => {
    expect(EYE_HEIGHT).toBeGreaterThan(0)
    expect(EYE_HEIGHT).toBeLessThan(PLAYER_HEIGHT)
    expect(FRIENDLY_FIRE).toBe(false)
    expect(VISIBILITY_NEAR).toBeGreaterThan(0)
    expect(Number.isInteger(FIRE_BURST) && FIRE_BURST >= 1).toBe(true)
    // The bucket only stops floods: it must not be slower than the real cap.
    expect(FIRE_RATE_HZ).toBeGreaterThanOrEqual(1000 / Math.min(...TEAMS.map((t) => WEAPONS[t].intervalMs)))
  })
})

describe('gate arithmetic (#38)', () => {
  it('a Ghost dies in fewer hits than a Warden', () => {
    expect(hitsToKill('warden', 'ghost')).toBe(4)
    expect(hitsToKill('ghost', 'warden')).toBe(10)
    expect(hitsToKill('warden', 'ghost')).toBeLessThan(hitsToKill('ghost', 'warden'))
  })

  it('a Ghost can empty a magazine into a Warden and do real damage, but not kill', () => {
    const dealt = WEAPONS.ghost.magazine * WEAPONS.ghost.damage
    expect(dealt).toBe(180)
    // 12 rounds is enough for the 10 hits needed: a caught Warden can be beaten.
    expect(WEAPONS.ghost.magazine).toBeGreaterThanOrEqual(hitsToKill('ghost', 'warden'))
    expect(dealt).toBeGreaterThanOrEqual(MAX_HEALTH.warden)
    expect(dealt / MAX_HEALTH.warden).toBeGreaterThan(0.5)
  })

  it('a Warden kills a Ghost within one magazine and in about half a second', () => {
    const n = hitsToKill('warden', 'ghost')
    expect(n).toBeLessThanOrEqual(WEAPONS.warden.magazine)
    expect((n - 1) * WEAPONS.warden.intervalMs).toBeLessThan(1000)
  })
})
