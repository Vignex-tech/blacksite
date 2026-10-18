import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// Babylon is a dependency of client/, not of Tests/: load it from there so the
// test uses the same module instances as client/src/players.ts.
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import type { AbstractMesh } from '../../client/node_modules/@babylonjs/core/Meshes/abstractMesh.js'
import type { Mesh } from '../../client/node_modules/@babylonjs/core/Meshes/mesh.js'
import { createPlayerRenderer, type PlayerRenderer } from '../../client/src/players.ts'
import { PLAYER_HALF_SIZE, PLAYER_HEIGHT } from '../../shared/map.js'
import type { Team } from '../../shared/protocol.js'

// #23: the client's player meshes (#22, client/src/players.ts) on Babylon's
// NullEngine, with mocked state (no server). Ghost and Warden have different
// shapes and sizes, the body's rotation.y follows the synced yaw, and the
// nose points where the player faces (yaw 0 faces +z, positive turns to +x).

const EPS = 1e-6
let engine: NullEngine
let scene: Scene
let r: PlayerRenderer

beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  r = createPlayerRenderer(scene)
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
})

function worldBox(mesh: AbstractMesh) {
  mesh.computeWorldMatrix(true)
  const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox
  return { min, max, size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z } }
}

function body(id: string): Mesh {
  const m = r.mesh(id)
  if (!m) throw new Error(`no body mesh for ${id}`)
  return m
}

function nose(id: string): AbstractMesh {
  const n = scene.getMeshByName(`player-${id}-nose`)
  if (!n) throw new Error(`no nose mesh for ${id}`)
  return n
}

/** The nose's world position minus the body's, on (x, z), normalised. */
function noseDir(id: string): { x: number; z: number } {
  const b = body(id)
  const n = nose(id)
  b.computeWorldMatrix(true)
  n.computeWorldMatrix(true)
  const bp = b.getAbsolutePosition()
  const np = n.getAbsolutePosition()
  const dx = np.x - bp.x
  const dz = np.z - bp.z
  const len = Math.hypot(dx, dz)
  expect(len, `${id}'s nose sticks out of the body`).toBeGreaterThan(0.1)
  return { x: dx / len, z: dz / len }
}

const pose = (team: Team | null, yaw = 0) => ({ team, yaw })

describe('createPlayerRenderer (client/src/players.ts)', () => {
  it('names the body player-<id> and its nose player-<id>-nose (a child), with { team, isLocal } metadata', () => {
    r.upsertPlayer('g', 1, 2, false, pose('ghost'))
    const b = body('g')
    expect(b.name).toBe('player-g')
    expect(scene.getMeshByName('player-g')).toBe(b)
    expect(nose('g').parent).toBe(b)
    expect(b.metadata).toEqual({ team: 'ghost', isLocal: false })
    expect(b.position.x).toBeCloseTo(1, 6)
    expect(b.position.z).toBeCloseTo(2, 6)
  })

  it('Ghost is a slim cylinder 0.7 wide and Warden a bulkier 1 x 1.8 x 1 box: shapes and sizes differ', () => {
    r.upsertPlayer('g', 0, 0, false, pose('ghost'))
    r.upsertPlayer('w', 5, 0, false, pose('warden'))
    const g = worldBox(body('g'))
    const w = worldBox(body('w'))

    expect(g.size.x).toBeCloseTo(0.7, 5)
    expect(g.size.z).toBeCloseTo(0.7, 5)
    expect(g.size.y).toBeCloseTo(PLAYER_HEIGHT, 5)
    expect(w.size.x).toBeCloseTo(PLAYER_HALF_SIZE * 2, 5)
    expect(w.size.z).toBeCloseTo(PLAYER_HALF_SIZE * 2, 5)
    expect(w.size.y).toBeCloseTo(PLAYER_HEIGHT, 5)
    // Both stand on the ground.
    expect(Math.abs(g.min.y)).toBeLessThan(EPS)
    expect(Math.abs(w.min.y)).toBeLessThan(EPS)

    // Warden is wider and deeper than the Ghost.
    expect(w.size.x).toBeGreaterThan(g.size.x + 0.1)
    expect(w.size.z).toBeGreaterThan(g.size.z + 0.1)

    // Different shapes: a box has 24 vertices (4 per face); a 16-sided
    // cylinder has many more. Neither is the other's mesh.
    const gv = body('g').getTotalVertices()
    const wv = body('w').getTotalVertices()
    expect(wv).toBe(24)
    expect(gv).toBeGreaterThan(wv)
    expect(body('g').geometry).not.toBe(body('w').geometry)
  })

  it('uses ghostMat and wardenMat for other players and localPlayerMat for your own player, whatever its team', () => {
    r.upsertPlayer('g', 0, 0, false, pose('ghost'))
    r.upsertPlayer('w', 3, 0, false, pose('warden'))
    r.upsertPlayer('me', 6, 0, true, pose('warden'))
    r.upsertPlayer('me2', 9, 0, true, pose('ghost'))
    expect(body('g').material?.name).toBe('ghostMat')
    expect(body('w').material?.name).toBe('wardenMat')
    expect(body('me').material?.name).toBe('localPlayerMat')
    expect(body('me2').material?.name).toBe('localPlayerMat')
    expect(body('me').metadata).toEqual({ team: 'warden', isLocal: true })
    // The local player's shape still follows its team.
    expect(worldBox(body('me')).size.x).toBeCloseTo(1, 5)
    expect(worldBox(body('me2')).size.x).toBeCloseTo(0.7, 5)
  })

  it('without a team (no pose, or team null) it is a small neutral cube, rebuilt when the team arrives', () => {
    r.upsertPlayer('a', 0, 0, false)
    r.upsertPlayer('b', 2, 0, false, pose(null, 0))
    for (const id of ['a', 'b']) {
      const box = worldBox(body(id))
      expect(body(id).metadata).toEqual({ team: null, isLocal: false })
      expect(body(id).material?.name).toBe('unknownPlayerMat')
      // A cube smaller than a standing player.
      expect(box.size.y).toBeLessThan(PLAYER_HEIGHT - 0.1)
      expect(Math.abs(box.size.x - box.size.y)).toBeLessThan(1e-5)
      expect(Math.abs(box.size.z - box.size.y)).toBeLessThan(1e-5)
    }

    const before = body('a')
    r.upsertPlayer('a', 0, 0, false, pose('ghost'))
    const after = body('a')
    expect(after).not.toBe(before)
    expect(before.isDisposed()).toBe(true)
    expect(after.metadata).toEqual({ team: 'ghost', isLocal: false })
    expect(worldBox(after).size.y).toBeCloseTo(PLAYER_HEIGHT, 5)
    // Only one body and one nose for the player.
    expect(scene.meshes.filter((m) => m.name === 'player-a')).toHaveLength(1)
    expect(scene.meshes.filter((m) => m.name === 'player-a-nose')).toHaveLength(1)

    // Changing team rebuilds again with the other shape.
    r.upsertPlayer('a', 0, 0, false, pose('warden'))
    expect(body('a').metadata).toEqual({ team: 'warden', isLocal: false })
    expect(worldBox(body('a')).size.x).toBeCloseTo(1, 5)
    expect(scene.meshes.filter((m) => m.name.startsWith('player-a'))).toHaveLength(2)
  })

  it('rotation.y follows the yaw, and the nose points along (sin yaw, cos yaw)', () => {
    const yaws = [0, Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI, Math.PI / 4, -2.5, 1.234]
    for (const team of ['ghost', 'warden'] as const) {
      const id = `${team}-1`
      for (const yaw of yaws) {
        r.upsertPlayer(id, 3, -4, false, pose(team, yaw))
        const b = body(id)
        expect(Math.abs(b.rotation.y - yaw), `${team} rotation.y at yaw ${yaw}`).toBeLessThan(EPS)
        // Only yaw: no pitch or roll.
        expect(b.rotation.x).toBe(0)
        expect(b.rotation.z).toBe(0)
        const d = noseDir(id)
        expect(Math.abs(d.x - Math.sin(yaw)), `${team} nose x at yaw ${yaw}`).toBeLessThan(1e-5)
        expect(Math.abs(d.z - Math.cos(yaw)), `${team} nose z at yaw ${yaw}`).toBeLessThan(1e-5)
        // Turning never moves the body.
        expect(b.position.x).toBeCloseTo(3, 6)
        expect(b.position.z).toBeCloseTo(-4, 6)
      }
      // Turning doesn't rebuild the mesh.
      const kept = body(id)
      r.upsertPlayer(id, 3, -4, false, pose(team, 0.5))
      expect(body(id)).toBe(kept)
    }
  })

  it('at yaw 0 the nose is in front (+z) near the top of the body', () => {
    r.upsertPlayer('w', 0, 0, false, pose('warden', 0))
    const b = worldBox(body('w'))
    const n = worldBox(nose('w'))
    expect(n.max.z).toBeGreaterThan(b.max.z) // sticks out of the front face
    expect(n.min.y).toBeGreaterThan(PLAYER_HEIGHT / 2) // upper half
    expect(n.max.y).toBeLessThanOrEqual(PLAYER_HEIGHT + EPS)
  })

  it('removePlayer disposes the body and its nose', () => {
    r.upsertPlayer('g', 0, 0, false, pose('ghost'))
    r.removePlayer('g')
    expect(r.mesh('g')).toBeUndefined()
    expect(scene.getMeshByName('player-g')).toBeNull()
    expect(scene.getMeshByName('player-g-nose')).toBeNull()
    r.removePlayer('g') // removing twice is harmless
  })
})
