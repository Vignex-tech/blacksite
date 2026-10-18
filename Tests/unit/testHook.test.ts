import { describe, expect, it, vi } from 'vitest'
import { installTestHook } from '../../client/src/testHook.ts'
import type { BlacksiteTestHook } from '../../shared/testhook.js'

// Unit checks of the client test hook (#11), verified in #12. The browser side
// is covered by Tests/e2e/two-players.spec.ts.
//
// Snapshots are checked with toMatchObject on the version-1 fields (arrays
// still match length and order), because fields may be added in version 1
// (#22 adds team and yaw). `version` itself is still checked to be 1.

/** A fresh stand-in for `window` (the real one can only take the hook once). */
function setup() {
  const target = {} as Window
  const rec = installTestHook(target)
  const hook = (target as unknown as { __blacksite: BlacksiteTestHook }).__blacksite
  const view = { upsertPlayer: vi.fn(), removePlayer: vi.fn() }
  return { target, rec, hook, view: rec.wrapView(view), inner: view }
}

describe('window.__blacksite test hook', () => {
  it('starts disconnected with no players and no map', () => {
    const { hook } = setup()
    expect(hook.snapshot()).toMatchObject({
      version: 1,
      connected: false,
      sessionId: null,
      players: [],
      map: { id: null, renderedSolids: 0 },
    })
  })

  it('mirrors players sorted by id and passes updates through to the view', () => {
    const { rec, hook, view, inner } = setup()
    rec.setConnected('b')
    view.upsertPlayer('c', 1.5, -2, false)
    view.upsertPlayer('b', 0.1, 0.2, true)
    view.upsertPlayer('a', 3, 4)
    expect(inner.upsertPlayer).toHaveBeenCalledTimes(3)
    expect(inner.upsertPlayer).toHaveBeenLastCalledWith('a', 3, 4, false)

    const s = hook.snapshot()
    expect(s.connected).toBe(true)
    expect(s.sessionId).toBe('b')
    expect(s.players).toMatchObject([
      { id: 'a', x: 3, z: 4, isLocal: false },
      { id: 'b', x: 0.1, z: 0.2, isLocal: true },
      { id: 'c', x: 1.5, z: -2, isLocal: false },
    ])

    view.upsertPlayer('c', 9, 9, false)
    view.removePlayer('a')
    expect(inner.removePlayer).toHaveBeenCalledWith('a')
    expect(hook.snapshot().players.map((p) => [p.id, p.x, p.z])).toEqual([
      ['b', 0.1, 0.2],
      ['c', 9, 9],
    ])
  })

  it('returns a fresh copy on every call', () => {
    const { rec, hook, view } = setup()
    rec.setConnected('a')
    view.upsertPlayer('a', 1, 2, true)
    const first = hook.snapshot()
    first.connected = false
    first.players[0].x = 1000
    first.players.push({ id: 'z', x: 0, z: 0, isLocal: false })
    first.map.renderedSolids = 5
    const next = hook.snapshot()
    expect(next).not.toBe(first)
    expect(next).toMatchObject({
      version: 1,
      connected: true,
      sessionId: 'a',
      players: [{ id: 'a', x: 1, z: 2, isLocal: true }],
      map: { id: null, renderedSolids: 0 },
    })
  })

  it('clears players and sessionId on disconnect', () => {
    const { rec, hook, view } = setup()
    rec.setConnected('a')
    view.upsertPlayer('a', 1, 2, true)
    rec.setDisconnected()
    expect(hook.snapshot()).toMatchObject({ connected: false, sessionId: null, players: [] })
  })

  it('is read-only: the hook is frozen and cannot be replaced', () => {
    const { target, hook } = setup()
    expect(Object.isFrozen(hook)).toBe(true)
    const desc = Object.getOwnPropertyDescriptor(target, '__blacksite')!
    expect(desc).toMatchObject({ writable: false, configurable: false, enumerable: false })
    // Test files are ES modules (strict mode), so assignment throws.
    expect(() => {
      ;(target as unknown as { __blacksite: unknown }).__blacksite = null
    }).toThrow(TypeError)
    expect(() => {
      ;(hook as unknown as { snapshot: unknown }).snapshot = () => null
    }).toThrow(TypeError)
    expect((target as unknown as { __blacksite: unknown }).__blacksite).toBe(hook)
  })
})
