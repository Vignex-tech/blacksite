// File-backed model loader for NullEngine tests (#83): reads the real glb from
// client/public/assets, so tests exercise the shipped files, not fakes.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetContainer } from '../../../client/node_modules/@babylonjs/core/assetContainer.js'
import type { Scene } from '../../../client/node_modules/@babylonjs/core/scene.js'
import { TransformNode } from '../../../client/node_modules/@babylonjs/core/Meshes/transformNode.js'
import { LoadAssetContainerAsync } from '../../../client/node_modules/@babylonjs/core/Loading/sceneLoader.js'
import '../../../client/node_modules/@babylonjs/loaders/glTF/2.0/glTFLoader.js'
import { wrapInstance, type AssetLoader } from '../../../client/src/assets/assetLoader.ts'

export const CHAR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'client', 'public', 'assets', 'characters')

export const MODEL_FILES: Record<string, string> = {
  'character-ghost': 'mesh_ghost.glb',
  'character-warden': 'mesh_warden.glb',
  'weapon-rifle': 'mesh_rifle.glb',
}

export const bytesOf = (file: string): Uint8Array => new Uint8Array(readFileSync(join(CHAR_DIR, file)))

/** Same instancing as the client's createAssetLoader, but the bytes come from disk. A missing file loads as null. */
export function createFileLoader(scene: Scene, files: Record<string, string> = MODEL_FILES): AssetLoader {
  const containers = new Map<string, Promise<AssetContainer | null>>()
  return {
    async loadModel(id) {
      const file = files[id]
      if (!file || !existsSync(join(CHAR_DIR, file))) return null
      let pending = containers.get(id)
      if (!pending) {
        pending = LoadAssetContainerAsync(bytesOf(file) as unknown as string, scene, { pluginExtension: '.glb' }).catch(() => null)
        containers.set(id, pending)
      }
      const container = await pending
      if (!container) return null
      const inst = container.instantiateModelsToScene((n) => n, false)
      const root = inst.rootNodes[0]
      if (!(root instanceof TransformNode)) return null
      for (const g of inst.animationGroups) g.stop()
      return wrapInstance(root, inst.rootNodes, inst.skeletons, inst.animationGroups)
    },
  }
}
