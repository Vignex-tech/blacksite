import type { Scene } from '@babylonjs/core/scene'
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
// glTF 2.0 loader only (registers the .glb/.gltf plugin). No Draco, KTX2 or
// meshopt extension is imported, so nothing is ever fetched from a CDN.
import '@babylonjs/loaders/glTF/2.0/glTFLoader.js'

/**
 * Asset loading foundation (M8, #79). A model is loaded by id; the result is a
 * root node, its animation groups and its named nodes, or `null` on failure
 * (the caller then keeps its graybox fallback).
 */
export interface LoadedModel {
  /** Root of this instance; not parented to anything until the caller does so. */
  root: TransformNode
  /** This instance's animation groups (stopped). */
  animationGroups: AnimationGroup[]
  /** Every transform node under `root` by name (bones' nodes, attachment points). */
  nodes: ReadonlyMap<string, TransformNode>
  /** Disposes this instance. Safe to call twice. */
  dispose(): void
}

/** Called with 0..1 while a model is downloading. */
export type ProgressCallback = (fraction: number) => void

export interface AssetLoader {
  /** Resolves to a new instance of the model, or `null` if it is unknown or failed. Never rejects. */
  loadModel(id: string, onProgress?: ProgressCallback): Promise<LoadedModel | null>
}

/** Always fails: what unit tests use to assert the graybox fallback. */
export function createFailingLoader(): AssetLoader {
  return { loadModel: () => Promise.resolve(null) }
}

/**
 * Model ids to file paths, relative to the page (through `BASE_URL`, so it
 * works behind the https tunnel). Empty until the art lands: #82 adds the
 * character models here. An id that is not listed loads as `null` without any
 * request (so no 404 reaches the console).
 */
export const MODEL_URLS: Readonly<Record<string, string>> = {}

/** URL for a file under `assets/`, relative to the app base. */
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}assets/${path}`
}

/**
 * The real loader. Each model file is fetched once; every `loadModel` call
 * instantiates it again (own skeleton and animation groups), so several players
 * of one team share the download. A failed file is logged once and never retried.
 */
export function createAssetLoader(scene: Scene, urls: Readonly<Record<string, string>> = MODEL_URLS): AssetLoader {
  const containers = new Map<string, Promise<AssetContainer | null>>()
  const listeners = new Map<string, Set<ProgressCallback>>()

  const fetchContainer = (id: string, url: string): Promise<AssetContainer | null> =>
    LoadAssetContainerAsync(url, scene, {
      onProgress: (e) => {
        if (!e.lengthComputable || e.total <= 0) return
        for (const cb of listeners.get(id) ?? []) cb(Math.min(1, e.loaded / e.total))
      },
    }).catch((err: unknown) => {
      console.warn(`Asset "${id}" failed to load (${url}); using the fallback.`, err)
      return null
    })

  return {
    async loadModel(id, onProgress) {
      const url = urls[id]
      if (!url) return null
      let pending = containers.get(id)
      if (!pending) {
        pending = fetchContainer(id, url)
        containers.set(id, pending)
      }
      if (onProgress) {
        let set = listeners.get(id)
        if (!set) listeners.set(id, (set = new Set()))
        set.add(onProgress)
      }
      const container = await pending
      if (onProgress) listeners.get(id)?.delete(onProgress)
      if (!container) return null
      try {
        const inst = container.instantiateModelsToScene((name) => name, false)
        const root = inst.rootNodes[0]
        if (!(root instanceof TransformNode)) {
          for (const n of inst.rootNodes) n.dispose()
          return null
        }
        for (const g of inst.animationGroups) g.stop()
        return wrapInstance(root, inst.rootNodes, inst.skeletons, inst.animationGroups)
      } catch (err) {
        console.warn(`Asset "${id}" could not be instantiated; using the fallback.`, err)
        return null
      }
    },
  }
}

/** Wraps an instantiated model. Exported so tests can build a model from nodes they made. */
export function wrapInstance(
  root: TransformNode,
  rootNodes: { dispose(): void }[] = [root],
  skeletons: { dispose(): void }[] = [],
  animationGroups: AnimationGroup[] = [],
): LoadedModel {
  const nodes = new Map<string, TransformNode>()
  for (const n of root.getDescendants(false)) if (n instanceof TransformNode) nodes.set(n.name, n)
  let disposed = false
  return {
    root,
    animationGroups,
    nodes,
    dispose() {
      if (disposed) return
      disposed = true
      for (const g of animationGroups) g.dispose()
      for (const s of skeletons) s.dispose()
      for (const n of rootNodes) n.dispose()
    },
  }
}
