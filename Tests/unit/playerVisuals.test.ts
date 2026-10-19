import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import { TransformNode } from '../../client/node_modules/@babylonjs/core/Meshes/transformNode.js'
import { CreateBox } from '../../client/node_modules/@babylonjs/core/Meshes/Builders/boxBuilder.js'
import type { AbstractMesh } from '../../client/node_modules/@babylonjs/core/Meshes/abstractMesh.js'
import { createPlayerRenderer, characterModelId, type PlayerRenderer } from '../../client/src/players.ts'
import { createFailingLoader, wrapInstance, type AssetLoader, type LoadedModel } from '../../client/src/assets/assetLoader.ts'
import type { PlayerPose } from '../../client/src/net.ts'

// #80: model attach logic of the player renderer (#79) on NullEngine with an
// injected loader (no network, no glTF parsing). A model is a root node with a
// few meshes, built in memory and wrapped with wrapInstance().

let engine: NullEngine
let scene: Scene

beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})
afterEach(() => {
  scene.dispose()
  engine.dispose()
})

/** Same as the first-person code in client/src/scene.ts (setVisible): body, nose and every descendant. */
function setBodyVisible(body: AbstractMesh, visible: boolean): void {
  body.isVisible = visible
  for (const child of body.getChildMeshes()) child.isVisible = visible
}

interface FakeModel {
  model: LoadedModel
  meshes: AbstractMesh[]
  disposed: () => boolean
}

function makeModel(label: string): FakeModel {
  const root = new TransformNode(`root-${label}`, scene)
  const hips = new TransformNode('Hips', scene)
  hips.parent = root
  const meshes = ['Body', 'Hood'].map((n) => {
    const m = CreateBox(`${label}-${n}`, { size: 0.5 }, scene)
    m.parent = n === 'Hood' ? hips : root
    m.isPickable = true // art files come with pickable meshes; the renderer must switch it off
    return m
  })
  const wrapped = wrapInstance(root)
  let gone = false
  const model: LoadedModel = {
    ...wrapped,
    dispose() {
      gone = true
      wrapped.dispose()
    },
  }
  return { model, meshes, disposed: () => gone }
}

/** A loader whose models resolve when the test says so. */
function controlledLoader() {
  const requests: { id: string; resolve: (m: LoadedModel | null) => void }[] = []
  const loader: AssetLoader = {
    loadModel: (id) => new Promise((resolve) => requests.push({ id, resolve })),
  }
  return { loader, requests }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))
const pose = (team: 'ghost' | 'warden', extra: Partial<PlayerPose> = {}): PlayerPose => ({ team, yaw: 0, ...extra })

describe('player model attach (#79, #80)', () => {
  let r: PlayerRenderer

  it('uses character-<team> as the model id', () => {
    expect(characterModelId('ghost')).toBe('character-ghost')
    expect(characterModelId('warden')).toBe('character-warden')
  })

  it('attaches a model as visual-<id> under player-<id>, with renamed, non-pickable meshes', async () => {
    const { loader, requests } = controlledLoader()
    r = createPlayerRenderer(scene, loader)
    r.upsertPlayer('p1', 2, 3, false, pose('ghost', { yaw: 1 }))
    expect(requests.map((q) => q.id)).toEqual(['character-ghost'])
    expect(r.visual('p1')).toBeUndefined() // not ready yet

    const fake = makeModel('g')
    requests[0].resolve(fake.model)
    await flush()

    const body = r.mesh('p1')!
    const visual = r.visual('p1')!
    expect(visual).toBeDefined()
    expect(visual.name).toBe('visual-p1')
    expect(visual.parent).toBe(body)
    expect(fake.model.root.parent).toBe(visual)
    // The model follows the body: position and yaw stay on player-<id>.
    expect(body.name).toBe('player-p1')
    expect(body.position.x).toBe(2)
    expect(body.rotation.y).toBe(1)

    for (const m of fake.meshes) {
      expect(m.name.startsWith('visual-p1-'), m.name).toBe(true)
      expect(m.isPickable, `${m.name} pickable`).toBe(false)
    }
    expect(fake.model.root.getDescendants(false).filter((n) => n instanceof TransformNode).every((n) => n.name.startsWith('visual-p1-'))).toBe(true)

    // The reserved prefix stays on the graybox only: player-p1 and its nose.
    const playerNamed = scene.meshes.filter((m) => m.name.startsWith('player-')).map((m) => m.name)
    expect(playerNamed.sort()).toEqual(['player-p1', 'player-p1-nose'])
  })

  it('model meshes are never hit by a pick ray', async () => {
    const { loader, requests } = controlledLoader()
    r = createPlayerRenderer(scene, loader)
    r.upsertPlayer('p1', 0, 0, false, pose('warden'))
    const fake = makeModel('w')
    requests[0].resolve(fake.model)
    await flush()
    for (const m of fake.meshes) m.position.set(0, 1, 0)
    // Only the model's own meshes are pickable-tested: the graybox body is hidden by visibility 0 but still pickable.
    const pickable = scene.meshes.filter((m) => m.isPickable && m.name.startsWith('visual-'))
    expect(pickable).toEqual([])
  })

  it('keeps the graybox visible until the model is ready, then hides it with visibility (not isVisible)', async () => {
    const { loader, requests } = controlledLoader()
    r = createPlayerRenderer(scene, loader)
    r.upsertPlayer('p1', 0, 0, false, pose('warden'))
    const body = r.mesh('p1')!
    const nose = scene.getMeshByName('player-p1-nose')!
    expect(body.visibility).toBe(1)
    expect(nose.visibility).toBe(1)

    await flush()
    expect(body.visibility, 'still loading').toBe(1)

    requests[0].resolve(makeModel('w').model)
    await flush()
    expect(body.visibility).toBe(0)
    expect(nose.visibility).toBe(0)
    expect(body.isVisible, 'isVisible belongs to the first-person code').toBe(true)
  })

  it('keeps the graybox when the load fails, and when there is no loader', async () => {
    const { loader, requests } = controlledLoader()
    r = createPlayerRenderer(scene, loader)
    r.upsertPlayer('p1', 0, 0, false, pose('ghost'))
    requests[0].resolve(null)
    await flush()
    expect(r.visual('p1')).toBeUndefined()
    expect(r.mesh('p1')!.visibility).toBe(1)

    const failing = createPlayerRenderer(scene, createFailingLoader())
    failing.upsertPlayer('p2', 0, 0, false, pose('warden'))
    await flush()
    expect(failing.visual('p2')).toBeUndefined()
    expect(failing.mesh('p2')!.visibility).toBe(1)

    const plain = createPlayerRenderer(scene)
    plain.upsertPlayer('p3', 0, 0, false, pose('ghost'))
    await flush()
    expect(plain.visual('p3')).toBeUndefined()
    expect(plain.mesh('p3')!.visibility).toBe(1)
  })

  it('does not ask for a model before the team is known, nor for an eliminated player', async () => {
    const { loader, requests } = controlledLoader()
    r = createPlayerRenderer(scene, loader)
    r.upsertPlayer('p1', 0, 0, false) // no pose: unknown team
    r.upsertPlayer('p2', 0, 0, false, pose('warden', { health: 0 }))
    await flush()
    expect(requests).toEqual([])
    expect(r.visual('p1')).toBeUndefined()
    expect(r.visual('p2')).toBeUndefined()
  })

  it('re-attaches on a team change: the old model goes, the new team model loads', async () => {
    const { loader, requests } = controlledLoader()
    r = createPlayerRenderer(scene, loader)
    r.upsertPlayer('p1', 0, 0, false, pose('ghost'))
    const ghost = makeModel('g')
    requests[0].resolve(ghost.model)
    await flush()
    expect(r.visual('p1')).toBeDefined()

    r.upsertPlayer('p1', 0, 0, false, pose('warden'))
    expect(ghost.disposed(), 'ghost model disposed with the old body').toBe(true)
    expect(r.visual('p1'), 'no model until the new one is ready').toBeUndefined()
    expect(r.mesh('p1')!.visibility, 'new graybox visible while loading').toBe(1)
    expect(requests.map((q) => q.id)).toEqual(['character-ghost', 'character-warden'])

    const warden = makeModel('w')
    requests[1].resolve(warden.model)
    await flush()
    const visual = r.visual('p1')!
    expect(visual.name).toBe('visual-p1')
    expect(visual.parent).toBe(r.mesh('p1'))
    expect(warden.meshes.every((m) => m.name.startsWith('visual-p1-'))).toBe(true)
    expect(scene.getTransformNodeByName('visual-p1')).toBe(visual) // exactly one live visual-p1
    expect(scene.transformNodes.filter((n) => n.name === 'visual-p1')).toHaveLength(1)
  })

  it('discards a model that arrives after its body was rebuilt or removed', async () => {
    const { loader, requests } = controlledLoader()
    r = createPlayerRenderer(scene, loader)
    r.upsertPlayer('p1', 0, 0, false, pose('ghost'))
    r.upsertPlayer('p1', 0, 0, false, pose('warden')) // team change while the ghost model loads
    const late = makeModel('late')
    requests[0].resolve(late.model)
    await flush()
    expect(late.disposed()).toBe(true)
    expect(r.visual('p1')).toBeUndefined()
    expect(r.mesh('p1')!.visibility).toBe(1)

    r.removePlayer('p1')
    const late2 = makeModel('late2')
    requests[1].resolve(late2.model)
    await flush()
    expect(late2.disposed()).toBe(true)
    expect(r.visual('p1')).toBeUndefined()
  })

  it('removing a player disposes its model and visual node', async () => {
    const { loader, requests } = controlledLoader()
    r = createPlayerRenderer(scene, loader)
    r.upsertPlayer('p1', 0, 0, false, pose('warden'))
    const fake = makeModel('w')
    requests[0].resolve(fake.model)
    await flush()
    r.removePlayer('p1')
    expect(fake.disposed()).toBe(true)
    expect(r.visual('p1')).toBeUndefined()
    expect(scene.meshes.filter((m) => m.name.startsWith('visual-'))).toEqual([])
  })

  it('an eliminated player loses the model and shows the flat body', async () => {
    const { loader, requests } = controlledLoader()
    r = createPlayerRenderer(scene, loader)
    r.upsertPlayer('p1', 0, 0, false, pose('warden', { health: 100 }))
    const fake = makeModel('w')
    requests[0].resolve(fake.model)
    await flush()
    r.upsertPlayer('p1', 0, 0, false, pose('warden', { health: 0 }))
    expect(fake.disposed()).toBe(true)
    expect(r.visual('p1')).toBeUndefined()
    expect(requests).toHaveLength(1) // no new request for the dead body
    expect(r.mesh('p1')!.visibility).toBe(1)
  })

  it('first-person self-hiding covers a model attached before and after the hide', async () => {
    const { loader, requests } = controlledLoader()
    r = createPlayerRenderer(scene, loader)
    r.upsertPlayer('me', 0, 0, true, pose('warden'))
    const early = makeModel('early')
    requests[0].resolve(early.model)
    await flush()
    const body = r.mesh('me')!

    // Model already attached, then the camera goes first person.
    setBodyVisible(body, false)
    for (const m of early.meshes) expect(m.isVisible, `${m.name} hidden with the body`).toBe(false)

    // Back to third person: everything shows again.
    setBodyVisible(body, true)
    for (const m of early.meshes) expect(m.isVisible, `${m.name} shown again`).toBe(true)

    // Hidden first, then the model arrives: it inherits the body's hidden state.
    r.upsertPlayer('me', 0, 0, true, pose('ghost'))
    const rebuilt = r.mesh('me')!
    setBodyVisible(rebuilt, false)
    const late = makeModel('late')
    requests[1].resolve(late.model)
    await flush()
    expect(r.visual('me')).toBeDefined()
    for (const m of late.meshes) expect(m.isVisible, `${m.name} arrives hidden`).toBe(false)
    // Another player's model is unaffected.
    r.upsertPlayer('other', 5, 5, false, pose('ghost'))
    const o = makeModel('o')
    requests[2].resolve(o.model)
    await flush()
    for (const m of o.meshes) expect(m.isVisible).toBe(true)
  })
})
