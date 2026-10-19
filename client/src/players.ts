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
import type { AssetLoader, LoadedModel } from './assets/assetLoader.ts'
import { createCharacterAnimator, type CharacterAnimator } from './assets/animation.ts'
import { Quaternion } from '@babylonjs/core/Maths/math.vector'

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

/** Model id of the Warden's rifle (M8, #82). */
export const RIFLE_MODEL_ID = 'weapon-rifle'

/** Where the rifle root sits under the Warden's `hand_r` (recipe from the manifest, #81). */
const RIFLE_MOUNT_POSITION: readonly [number, number, number] = [-0.0037, -0.1641, -0.0281]
const RIFLE_MOUNT_ROTATION: readonly [number, number, number, number] = [-0.0066, 0.7695, 0.6381, 0.0249]

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
  /** The server fired this player's weapon: plays the fire clip on a Warden model. */
  shot(id: string): void
  /** What a player's model is playing now (a clip name or a procedural pose), if a model is attached. */
  animation(id: string): string | undefined
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
  const animators = new Map<string, CharacterAnimator>()

  /** Render-side motion tracker: speed comes from changes in synced position, never from input. */
  interface Track {
    x: number
    y: number
    z: number
    t: number
    moveT: number
    speed: number
    vy: number
    mode: NonNullable<PlayerPose['mode']>
    health: number
    reloading: boolean
  }
  const tracks = new Map<string, Track>()
  const SPEED_SMOOTH = 0.5
  /** After this long without a position change the player counts as standing still. */
  const STILL_AFTER_MS = 250
  const track = (id: string, x: number, y: number, z: number, pose: PlayerPose | undefined): void => {
    const now = performance.now()
    let tr = tracks.get(id)
    if (!tr) {
      tr = { x, y, z, t: now, moveT: -1e9, speed: 0, vy: 0, mode: 'ground', health: Number.POSITIVE_INFINITY, reloading: false }
      tracks.set(id, tr)
    }
    const dtMs = now - tr.t
    if (dtMs >= 15) {
      const dt = dtMs / 1000
      const horizontal = Math.hypot(x - tr.x, z - tr.z) / dt
      const vertical = (y - tr.y) / dt
      if (horizontal > 1e-3 || Math.abs(vertical) > 1e-3) {
        tr.speed += (horizontal - tr.speed) * SPEED_SMOOTH
        tr.vy += (vertical - tr.vy) * SPEED_SMOOTH
        tr.moveT = now
      }
      tr.x = x
      tr.y = y
      tr.z = z
      tr.t = now
    }
    tr.mode = pose?.mode ?? 'ground'
    tr.health = pose?.health ?? tr.health
    tr.reloading = pose?.reloading ?? false
  }

  /** Mounts the rifle under the Warden's right hand (the model's nodes keep their file names). */
  const mountRifle = (id: string, body: Mesh, character: LoadedModel, rifle: LoadedModel): void => {
    const hand = character.nodes.get('hand_r')
    if (!hand) {
      rifle.dispose()
      return
    }
    const mount = new TransformNode(`visual-${id}-rifle_mount`, scene)
    mount.parent = hand
    mount.position.set(...RIFLE_MOUNT_POSITION)
    mount.rotationQuaternion = new Quaternion(...RIFLE_MOUNT_ROTATION)
    rifle.root.parent = mount
    for (const n of rifle.root.getDescendants(false)) n.name = `visual-${id}-${n.name}`
    for (const m of rifle.root.getChildMeshes(false)) {
      m.isPickable = false
      m.isVisible = body.isVisible
    }
    body.onDisposeObservable.add(() => rifle.dispose())
  }

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

      // Animation: starts a clip right away (the bind pose is a T-pose) and then
      // follows the tracked, synced state every frame.
      const animator = createCharacterAnimator(model, kind)
      animators.set(id, animator)
      const tick = (): void => {
        const tr = tracks.get(id)
        if (tr) {
          if (performance.now() - tr.moveT > STILL_AFTER_MS) {
            tr.speed = 0
            tr.vy = 0
          }
          animator.observe({ mode: tr.mode, speed: tr.speed, vy: tr.vy, health: tr.health, reloading: tr.reloading })
        }
        animator.update(scene.getEngine().getDeltaTime() / 1000)
      }
      animator.update(0)
      const obs = scene.onBeforeRenderObservable.add(tick)
      body.onDisposeObservable.add(() => {
        scene.onBeforeRenderObservable.remove(obs)
        animator.dispose()
        if (animators.get(id) === animator) animators.delete(id)
      })
      if (kind === 'warden' && model.nodes.has('hand_r')) {
        void loader.loadModel(RIFLE_MODEL_ID).then((rifle) => {
          if (!rifle) return
          if (body.isDisposed() || bodies.get(id) !== body) rifle.dispose()
          else mountRifle(id, body, model, rifle)
        })
      }
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
    track(id, x, pose?.y ?? 0, z, pose)
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
    tracks.delete(id)
  }

  return {
    upsertPlayer,
    removePlayer,
    mesh: (id) => bodies.get(id),
    visual: (id) => visuals.get(id),
    shot: (id) => animators.get(id)?.shot(),
    animation: (id) => animators.get(id)?.current(),
  }
}
