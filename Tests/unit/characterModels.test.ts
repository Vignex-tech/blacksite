import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import { createPlayerRenderer } from '../../client/src/players.ts'
import type { PlayerPose } from '../../client/src/net.ts'
import { parseGlb } from './support/glb.ts'
import { bytesOf, createFileLoader, MODEL_FILES } from './support/modelFiles.ts'

// #83: the shipped character glb files, inspected from their JSON chunk, and
// attached through a file-backed loader on NullEngine.

const info = (file: string) => parseGlb(bytesOf(file))

/** Dimensions of each embedded PNG (IHDR), from the glb binary chunk. */
function pngSizes(file: string): { w: number; h: number }[] {
  const b = Buffer.from(bytesOf(file))
  const jsonLen = b.readUInt32LE(12)
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString()) as {
    images?: { bufferView: number; mimeType: string }[]
    bufferViews: { byteOffset?: number }[]
  }
  const bin = b.subarray(20 + jsonLen + 8)
  return (json.images ?? []).map((im) => {
    expect(im.mimeType).toBe('image/png')
    const off = json.bufferViews[im.bufferView].byteOffset ?? 0
    expect(bin.subarray(off + 1, off + 4).toString()).toBe('PNG')
    return { w: bin.readUInt32BE(off + 16), h: bin.readUInt32BE(off + 20) }
  })
}

const nodeNames = (file: string): string[] => (info(file).json.nodes as { name?: string }[]).map((n) => n.name ?? '')
const WEAPON_NODES = ['muzzle', 'grip', 'light_mount', 'rifle', 'weapon', 'gun']

const GHOST_CLIPS = ['idle', 'walk', 'run', 'jump', 'fall', 'land', 'hit', 'crouch_idle', 'crouch_walk', 'mantle']
const WARDEN_CLIPS = ['idle', 'walk', 'run', 'jump', 'fall', 'land', 'hit', 'idle_rifle', 'walk_rifle', 'run_rifle', 'fire', 'reload']

describe('character glb files (#81)', () => {
  it('mesh_ghost has every required clip, one 23-joint skin and no weapon node', () => {
    const g = info('mesh_ghost.glb')
    expect(g.animations).toEqual(expect.arrayContaining(GHOST_CLIPS))
    expect(g.json.skins).toHaveLength(1)
    expect(g.json.skins[0].joints).toHaveLength(23)
    const names = nodeNames('mesh_ghost.glb').map((n) => n.toLowerCase())
    for (const w of WEAPON_NODES) expect(names, `Ghost has a "${w}" node`).not.toContain(w)
    expect(names.some((n) => /rifle|weapon|gun|pistol/.test(n))).toBe(false)
    expect(g.animations.some((a) => a.endsWith('_rifle') || a === 'fire' || a === 'reload')).toBe(false)
  })

  it('mesh_warden has every required clip including the rifle ones, and a 23-joint skin', () => {
    const w = info('mesh_warden.glb')
    expect(w.animations).toEqual(expect.arrayContaining(WARDEN_CLIPS))
    expect(w.json.skins).toHaveLength(1)
    expect(w.json.skins[0].joints).toHaveLength(23)
    expect(nodeNames('mesh_warden.glb')).toContain('hand_r') // the rifle mounts here
  })

  it('mesh_rifle has the muzzle, grip and light_mount nodes and no animation', () => {
    const r = info('mesh_rifle.glb')
    expect(nodeNames('mesh_rifle.glb')).toEqual(expect.arrayContaining(['muzzle', 'grip', 'light_mount']))
    expect(r.animations).toEqual([])
    expect(r.json.skins ?? []).toEqual([])
  })

  it('triangle counts are within the art-plan budgets (Ghost 4000, Warden 5000, rifle 1500)', () => {
    expect(info('mesh_ghost.glb').triangles).toBeLessThanOrEqual(4000)
    expect(info('mesh_warden.glb').triangles).toBeLessThanOrEqual(5000)
    expect(info('mesh_rifle.glb').triangles).toBeLessThanOrEqual(1500)
  })

  it('every file is self-contained with a 512 px embedded PNG at most, and needs no extension loader', () => {
    for (const f of ['mesh_ghost.glb', 'mesh_warden.glb', 'mesh_rifle.glb']) {
      const i = info(f)
      expect(i.externalUris, f).toEqual([])
      expect(i.extensionsRequired, f).toEqual([]) // no Draco, KTX2 or meshopt: the client registers none
      const sizes = pngSizes(f)
      expect(sizes.length, f).toBeGreaterThan(0)
      for (const s of sizes) {
        expect(s.w, f).toBeLessThanOrEqual(512)
        expect(s.h, f).toBeLessThanOrEqual(512)
      }
    }
  })

  it('the Warden is built from more geometry than the Ghost (a bulkier silhouette)', () => {
    expect(info('mesh_warden.glb').triangles).toBeGreaterThan(info('mesh_ghost.glb').triangles)
  })
})

describe('models attach through a file-backed loader (NullEngine)', () => {
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
  const pose = (team: 'ghost' | 'warden', extra: Partial<PlayerPose> = {}): PlayerPose => ({ team, yaw: 0, ...extra })
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20))
    expect(cond()).toBe(true)
  }

  it('a Ghost gets visual-<id> with skinned meshes, no rifle, and hides the graybox body', async () => {
    const r = createPlayerRenderer(scene, createFileLoader(scene))
    r.upsertPlayer('g1', 1, 2, false, pose('ghost'))
    await until(() => r.visual('g1') !== undefined)
    const visual = r.visual('g1')!
    expect(visual.name).toBe('visual-g1')
    expect(visual.parent).toBe(r.mesh('g1'))
    expect(r.mesh('g1')!.visibility).toBe(0)
    const meshes = visual.getChildMeshes(false)
    expect(meshes.length).toBeGreaterThan(0)
    expect(meshes.filter((m) => m.getTotalVertices() > 0).filter((m) => !m.name.startsWith('visual-g1-') || m.isPickable).map((m) => [m.name, m.isPickable])).toEqual([])
    expect(meshes.some((m) => m.skeleton)).toBe(true)
    expect(visual.getDescendants(false).some((n) => /rifle/.test(n.name))).toBe(false)
  })

  it('a Warden gets visual-<id> and the rifle mounted on its right hand', async () => {
    const r = createPlayerRenderer(scene, createFileLoader(scene))
    r.upsertPlayer('w1', 0, 0, false, pose('warden'))
    await until(() => r.visual('w1') !== undefined)
    await until(() => r.visual('w1')!.getDescendants(false).some((n) => n.name === 'visual-w1-rifle_mount'))
    const mount = r.visual('w1')!.getDescendants(false).find((n) => n.name === 'visual-w1-rifle_mount')!
    expect(mount.parent?.name).toBe('visual-w1-hand_r')
    expect(mount.getDescendants(false).some((n) => n.name === 'visual-w1-muzzle')).toBe(true)
  })

  it('a missing file keeps the graybox body visible and attaches nothing', async () => {
    const r = createPlayerRenderer(scene, createFileLoader(scene, { ...MODEL_FILES, 'character-ghost': 'mesh_not_there.glb' }))
    r.upsertPlayer('g1', 0, 0, false, pose('ghost'))
    await new Promise((res) => setTimeout(res, 150))
    expect(r.visual('g1')).toBeUndefined()
    expect(r.mesh('g1')!.visibility).toBeGreaterThan(0)
    expect(r.mesh('g1')!.isVisible).toBe(true)
  })
})
