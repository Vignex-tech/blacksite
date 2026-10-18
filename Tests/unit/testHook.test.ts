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
    first.players.push({ id: 'z', x: 0, z: 0, isLocal: false, team: null, yaw: 0 })
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

  // #23: team, yaw and localTeam (#22), still version 1.
  it('copies team and yaw per player and localTeam from the local player', () => {
    const { rec, hook, view, inner } = setup()
    rec.setConnected('b')
    view.upsertPlayer('a', 1, 2, false, { team: 'ghost', yaw: 1.25 })
    view.upsertPlayer('b', 3, 4, true, { team: 'warden', yaw: -Math.PI })
    // The pose is passed through to the view unchanged.
    expect(inner.upsertPlayer).toHaveBeenLastCalledWith('b', 3, 4, true, { team: 'warden', yaw: -Math.PI })
    const s = hook.snapshot()
    expect(s.version).toBe(1)
    expect(s.localTeam).toBe('warden')
    // Matched, not compared exactly: fields may be added in version 1 (y and
    // mode per player from #33, new map counts), so only these are pinned (#28).
    expect(s.players).toMatchObject([
      { id: 'a', x: 1, z: 2, isLocal: false, team: 'ghost', yaw: 1.25 },
      { id: 'b', x: 3, z: 4, isLocal: true, team: 'warden', yaw: -Math.PI },
    ])
    // The version-1 fields are all there.
    expect(Object.keys(s)).toEqual(expect.arrayContaining(['connected', 'localTeam', 'map', 'players', 'sessionId', 'version']))

    // Turning and changing team show up in the next snapshot.
    view.upsertPlayer('a', 1, 2, false, { team: 'ghost', yaw: -0.5 })
    view.upsertPlayer('b', 3, 4, true, { team: 'ghost', yaw: 0 })
    const t = hook.snapshot()
    expect(t.players.map((p) => [p.id, p.team, p.yaw])).toEqual([
      ['a', 'ghost', -0.5],
      ['b', 'ghost', 0],
    ])
    expect(t.localTeam).toBe('ghost')
  })

  it('gives team null and yaw 0 without a pose, and localTeam null without a local player or its team', () => {
    const { rec, hook, view } = setup()
    expect(hook.snapshot().localTeam).toBeNull()
    rec.setConnected('me')
    view.upsertPlayer('other', 0, 0, false, { team: 'warden', yaw: 2 })
    // Another player's team is never reported as yours.
    expect(hook.snapshot().localTeam).toBeNull()
    view.upsertPlayer('me', 0, 0, true)
    let s = hook.snapshot()
    expect(s.players.find((p) => p.id === 'me')).toMatchObject({ id: 'me', x: 0, z: 0, isLocal: true, team: null, yaw: 0 })
    expect(s.localTeam).toBeNull()
    view.upsertPlayer('me', 0, 0, true, { team: null, yaw: 0.3 })
    s = hook.snapshot()
    expect(s.players.find((p) => p.id === 'me')).toMatchObject({ team: null, yaw: 0.3 })
    expect(s.localTeam).toBeNull()
    view.upsertPlayer('me', 0, 0, true, { team: 'ghost', yaw: 0.3 })
    expect(hook.snapshot().localTeam).toBe('ghost')
    // Disconnecting clears localTeam with the players.
    rec.setDisconnected()
    expect(hook.snapshot()).toMatchObject({ connected: false, players: [], localTeam: null })
  })

  it('still returns fresh copies with team and yaw: editing them changes nothing', () => {
    const { rec, hook, view } = setup()
    rec.setConnected('a')
    view.upsertPlayer('a', 1, 2, true, { team: 'ghost', yaw: 0.75 })
    const first = hook.snapshot()
    first.players[0].team = 'warden'
    first.players[0].yaw = 3
    first.localTeam = 'warden'
    const next = hook.snapshot()
    expect(next.players).not.toBe(first.players)
    expect(next.players[0]).not.toBe(first.players[0])
    expect(next).toMatchObject({
      version: 1,
      connected: true,
      sessionId: 'a',
      players: [{ id: 'a', x: 1, z: 2, isLocal: true, team: 'ghost', yaw: 0.75 }],
      localTeam: 'ghost',
      map: { id: null, renderedSolids: 0 },
    })
  })
})
