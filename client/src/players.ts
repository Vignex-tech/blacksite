import type { Scene } from '@babylonjs/core/scene'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { PLAYER_HALF_SIZE, PLAYER_HEIGHT } from '../../shared/map.js'
import type { Team } from '../../shared/protocol.js'
import { isEliminated } from './vitals.ts'
import type { PlayerPose, PlayerView } from './net.ts'
import type { AssetLoader } from './assets/assetLoader.ts'

/**
 * Graybox player shapes, built in code (no assets). Purely visual: they follow
 * server state only and never move anything locally.
 *
 * - Ghost: a slim, dark cylinder.
 * - Warden: a bulkier box, as wide as the collision box.
 * - Unknown team (state not received yet): a small neutral cube.
 *
 * Each body has a bright "nose" child at head height on its local +z, and
 * the body's `rotation.y` is the synced yaw, so the nose points where the
 * player faces (yaw 0 faces +z). The feet are at the synced `y` (M4), in
 * every movement mode; nothing is predicted locally. Your own player has a blue tint whatever its
 * team; the others use their team colour.
 *
 * Mesh names: body `player-<id>`, nose `player-<id>-nose`. The body's
 * `metadata` is `{ team, isLocal }` (`PlayerMeshMetadata`).
 *
 * Visual models (M8, #79): when an `AssetLoader` is given, a Ghost or Warden
 * body asks it for the model `character-<team>`. A loaded model becomes a
 * `visual-<id>` TransformNode parented to the body (so it follows the body's
 * position and yaw), all its meshes non-pickable. The graybox stays visible
 * until the model is ready, then is hidden with `visibility = 0` (never
 * `isVisible`, which the first-person code owns). If loading fails the graybox
 * stays. A team change rebuilds the body, which drops the old model and
 * loads the new team's.
 */

/** Model id for a team's character. */
export function characterModelId(team: Team): string {
  return `character-${team}`
}

type ShapeKind = Team | 'unknown'

/** Body width (x) and depth (z) per shape. Ghost is a cylinder of that diameter. */
const BODY_WIDTH: Record<ShapeKind, number> = {
  ghost: 0.7,
  warden: PLAYER_HALF_SIZE * 2,
  unknown: PLAYER_HALF_SIZE * 2,
}
const BODY_HEIGHT: Record<ShapeKind, number> = {
  ghost: PLAYER_HEIGHT,
  warden: PLAYER_HEIGHT,
  unknown: PLAYER_HALF_SIZE * 2,
}
/** An eliminated body lies flat: this tall. */
const FLAT_HEIGHT = 0.3
const NOSE_SIZE = 0.25
const NOSE_LENGTH = 0.4

export interface PlayerMeshMetadata {
  team: Team | null
  isLocal: boolean
  /** Present (true) only when received health is 0 or less: the body is drawn flat and grey. */
  eliminated?: true
}

export interface PlayerRenderer extends PlayerView {
  /** The body mesh of a player, if rendered (for tests and debugging). */
  mesh(id: string): Mesh | undefined
  /** The `visual-<id>` node of a player whose model is attached, if any. */
  visual(id: string): TransformNode | undefined
}

function material(scene: Scene, name: string, diffuse: Color3, emissive = Color3.Black()): StandardMaterial {
  const mat = new StandardMaterial(name, scene)
  mat.diffuseColor = diffuse
  mat.emissiveColor = emissive
  mat.specularColor = Color3.Black() // no white glare on top faces seen from above
  mat.freeze()
  return mat
}

export function createPlayerRenderer(scene: Scene, loader?: AssetLoader): PlayerRenderer {
  const teamMats: Record<ShapeKind, StandardMaterial> = {
    ghost: material(scene, 'ghostMat', new Color3(0.3, 0.24, 0.46), new Color3(0.06, 0.04, 0.1)),
    warden: material(scene, 'wardenMat', new Color3(0.9, 0.45, 0.15)),
    unknown: material(scene, 'unknownPlayerMat', new Color3(0.8, 0.8, 0.8)),
  }
  const localMat = material(scene, 'localPlayerMat', new Color3(0.2, 0.75, 0.95), new Color3(0.05, 0.2, 0.3))
  const deadMat = material(scene, 'eliminatedMat', new Color3(0.32, 0.32, 0.34))
  const noseMat = material(scene, 'noseMat', new Color3(1, 0.9, 0.3), new Color3(0.5, 0.45, 0.1))

  const bodies = new Map<string, Mesh>()
  const visuals = new Map<string, TransformNode>()

  const build = (id: string, kind: ShapeKind, isLocal: boolean, eliminated: boolean): Mesh => {
    const width = BODY_WIDTH[kind]
    const height = eliminated ? FLAT_HEIGHT : BODY_HEIGHT[kind]
    const body =
      kind === 'ghost' && !eliminated
        ? CreateCylinder(`player-${id}`, { height, diameter: width, tessellation: 16 }, scene)
        : CreateBox(`player-${id}`, { width, height, depth: width }, scene)
    body.material = eliminated ? deadMat : isLocal ? localMat : teamMats[kind]
    body.position.y = height / 2
    const metadata: PlayerMeshMetadata = { team: kind === 'unknown' ? null : kind, isLocal }
    if (eliminated) metadata.eliminated = true
    body.metadata = metadata

    const nose = CreateBox(`player-${id}-nose`, { width: NOSE_SIZE, height: NOSE_SIZE, depth: NOSE_LENGTH }, scene)
    nose.material = eliminated ? deadMat : noseMat
    nose.parent = body
    // Sticks out of the body's front (+z) near the top.
    nose.position.set(0, height / 2 - NOSE_SIZE, width / 2 + NOSE_LENGTH / 2 - NOSE_SIZE / 2)
    return body
  }

  /** Loads the team's model for `body` and attaches it; the graybox stays if that fails. */
  const attachVisual = (id: string, body: Mesh, kind: Team, height: number): void => {
    if (!loader) return
    void loader.loadModel(characterModelId(kind)).then((model) => {
      if (!model) return
      // The body was removed, rebuilt (team change, elimination) or disposed meanwhile.
      if (body.isDisposed() || bodies.get(id) !== body) {
        model.dispose()
        return
      }
      const visual = new TransformNode(`visual-${id}`, scene)
      visual.parent = body
      visual.position.y = -height / 2 // the body's origin is its centre; the model's is its feet
      model.root.parent = visual
      // Model nodes are named after this player, and never pickable.
      for (const n of model.root.getDescendants(false)) n.name = `visual-${id}-${n.name}`
      for (const m of model.root.getChildMeshes(false)) {
        m.isPickable = false
        m.isVisible = body.isVisible // your own body in first person stays hidden (scene.ts)
      }
      body.visibility = 0
      for (const child of body.getChildMeshes(true)) {
        if (child.name === `player-${id}-nose`) child.visibility = 0
      }
      body.onDisposeObservable.add(() => model.dispose())
      visuals.set(id, visual)
      body.onDisposeObservable.add(() => {
        if (visuals.get(id) === visual) visuals.delete(id)
      })
    })
  }

  const upsertPlayer = (id: string, x: number, z: number, isLocal = false, pose?: PlayerPose): void => {
    const kind: ShapeKind = pose?.team ?? 'unknown'
    const eliminated = pose?.health !== undefined && isEliminated(pose.health)
    let body = bodies.get(id)
    const meta = body?.metadata as PlayerMeshMetadata | undefined
    if (body && ((meta?.team ?? 'unknown') !== kind || (meta?.eliminated === true) !== eliminated)) {
      body.dispose() // team arrived or changed, or eliminated: rebuild with the right shape
      body = undefined
    }
    if (!body) {
      body = build(id, kind, isLocal, eliminated)
      bodies.set(id, body)
      if (kind !== 'unknown' && !eliminated) attachVisual(id, body, kind, BODY_HEIGHT[kind])
    }
    body.position.x = x
    // Feet at the server's y (the body's origin is its centre).
    body.position.y = (pose?.y ?? 0) + (eliminated ? FLAT_HEIGHT : BODY_HEIGHT[kind]) / 2
    body.position.z = z
    body.rotation.y = pose?.yaw ?? 0
  }

  const removePlayer = (id: string): void => {
    const body = bodies.get(id)
    if (!body) return
    body.dispose() // also disposes the nose (child)
    bodies.delete(id)
  }

  return { upsertPlayer, removePlayer, mesh: (id) => bodies.get(id), visual: (id) => visuals.get(id) }
}
