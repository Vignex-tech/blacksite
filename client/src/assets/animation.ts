import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { MovementMode, Team } from '../../../shared/protocol.js'
import type { LoadedModel } from './assetLoader.ts'

/**
 * Character animation (M8, #82). Purely visual: everything here is derived from
 * synced state (mode, positions, health, reloading) and from server shot
 * events. Nothing is predicted, no root motion is applied and nothing here
 * reaches the server or any gameplay value.
 *
 * `chooseAnimation` is a pure function from an observation to a clip (or a
 * procedural pose); `createCharacterAnimator` is the thin controller that plays
 * it on a loaded model.
 */

export type ClipName =
  | 'idle'
  | 'walk'
  | 'run'
  | 'jump'
  | 'fall'
  | 'land'
  | 'hit'
  | 'crouch_idle'
  | 'crouch_walk'
  | 'mantle'
  | 'idle_rifle'
  | 'walk_rifle'
  | 'run_rifle'
  | 'fire'
  | 'reload'

/** Poses with no clip in the files: built in code. */
export type ProceduralPose = 'climb' | 'hang' | 'shimmy'

/** Short actions that play once over the mode's clip. */
export type OneShot = 'jump' | 'land' | 'mantle' | 'hit' | 'fire' | 'reload'

/** Horizontal speed (u/s) above which a player counts as moving, and above which it runs. */
export const MOVING_SPEED = 0.2
export const RUN_SPEED = 1.25
/** Vertical speed (u/s) of a climb below which the climb pose is held still. */
export const CLIMB_STILL_SPEED = 0.1
/** Sideways speed (u/s) while hanging above which the shimmy pose is used. */
export const SHIMMY_MIN_SPEED = 0.15
/** A vertical rise faster than this off the ground is a jump. */
export const JUMP_RISE_SPEED = 0.5
/** Cross-fade length, seconds. */
export const BLEND_SECONDS = 0.15

export interface AnimObservation {
  team: Team
  mode: MovementMode
  /** Horizontal speed from synced x/z deltas. */
  speed: number
  /** The one-shot that is currently playing, if any. */
  oneShot: OneShot | null
}

export interface AnimChoice {
  clip: ClipName | null
  pose: ProceduralPose | null
  /** Whether a clip loops. */
  loop: boolean
}

const ONE_SHOT_CLIP: Record<OneShot, ClipName> = {
  jump: 'jump',
  land: 'land',
  mantle: 'mantle',
  hit: 'hit',
  fire: 'fire',
  reload: 'reload',
}

/** Pure mapping from state to what should play. */
export function chooseAnimation(o: AnimObservation, available?: ReadonlySet<string>): AnimChoice {
  const has = (c: ClipName): boolean => !available || available.has(c)
  const rifle = o.team === 'warden'
  const pick = (...names: ClipName[]): ClipName | null => names.find(has) ?? null
  const clip = (c: ClipName | null, loop: boolean): AnimChoice => ({ clip: c, pose: null, loop })

  if (o.mode === 'climbing') return { clip: null, pose: 'climb', loop: true }
  if (o.mode === 'hanging') {
    // The mantle plays on the way back to the ground (a one-shot); while hanging it is a pose.
    return { clip: null, pose: o.speed > SHIMMY_MIN_SPEED ? 'shimmy' : 'hang', loop: true }
  }
  if (o.oneShot && o.mode !== 'falling') {
    const c = pick(ONE_SHOT_CLIP[o.oneShot])
    if (c) return clip(c, false)
  }
  if (o.mode === 'falling') {
    if (o.oneShot === 'jump' && has('jump')) return clip('jump', false)
    return clip(pick('fall', 'jump', rifle ? 'idle_rifle' : 'idle', 'idle'), true)
  }
  const moving = o.speed > MOVING_SPEED
  if (!moving) return clip(pick(...(rifle ? (['idle_rifle', 'idle'] as const) : (['idle'] as const))), true)
  const run = o.speed > RUN_SPEED
  if (rifle) return clip(pick(run ? 'run_rifle' : 'walk_rifle', run ? 'run' : 'walk', 'idle_rifle', 'idle'), true)
  return clip(pick(run ? 'run' : 'walk', 'walk', 'idle'), true)
}

const MAX_RATIO = 1.4

/** Playback speed for locomotion clips so feet roughly follow the real speed. */
export function locomotionSpeedRatio(clip: ClipName | null, speed: number): number {
  if (clip === 'walk' || clip === 'walk_rifle') return Math.min(MAX_RATIO, Math.max(0.6, speed / 1.4))
  if (clip === 'run' || clip === 'run_rifle') return Math.min(MAX_RATIO, Math.max(0.6, speed / 3))
  return 1
}

// ---------------------------------------------------------------------------
// Procedural poses (climb, hang, shimmy). The files hold no clips for them, so
// bones are rotated from the bind (T) pose. Rotations are expressed in the
// model's own space (+y up, +z front, +x the model's left) and converted to
// each bone's local rotation, so they do not depend on the rig's bone axes.

/** Posed bones and the child each one points at (its direction is what a pose sets). */
const POSE_CHILD = {
  upperarm_l: 'lowerarm_l',
  upperarm_r: 'lowerarm_r',
  lowerarm_l: 'hand_l',
  lowerarm_r: 'hand_r',
  thigh_l: 'calf_l',
  thigh_r: 'calf_r',
  calf_l: 'foot_l',
  calf_r: 'foot_r',
} as const
type PoseBone = keyof typeof POSE_CHILD
const POSE_BONES = Object.keys(POSE_CHILD) as PoseBone[]

interface BoneBind {
  node: TransformNode
  /** Bind rotation relative to the model root, and the inverse of its parent's. */
  rel: Matrix
  parentInv: Matrix
  /** Bind direction from this bone to its child, in model space. */
  dir: Vector3
}

/** Target direction (model space: +y up, +z front, +x the model's left) per bone. */
type PoseTargets = Partial<Record<PoseBone, Vector3>>

const dirOf = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z).normalize()

/** Where each limb points for a pose at a phase (radians of a limb cycle). */
export function poseTargets(pose: ProceduralPose, phase: number): PoseTargets {
  const s = Math.sin(phase)
  const c = Math.sin(phase + Math.PI)
  const up = (v: number): number => Math.max(0, v)
  if (pose === 'climb') {
    // Arms reach up, alternating; legs step alternately.
    return {
      upperarm_l: dirOf(0.3, 1, 0.1 + 0.4 * s),
      lowerarm_l: dirOf(0.2, 1, 0.3 + 0.4 * s),
      upperarm_r: dirOf(-0.3, 1, 0.1 + 0.4 * c),
      lowerarm_r: dirOf(-0.2, 1, 0.3 + 0.4 * c),
      thigh_l: dirOf(0.05, -1, 0.9 * up(s)),
      calf_l: dirOf(0.05, -1, -0.9 * up(s)),
      thigh_r: dirOf(-0.05, -1, 0.9 * up(c)),
      calf_r: dirOf(-0.05, -1, -0.9 * up(c)),
    }
  }
  // hang and shimmy: both hands up on the hold, body dangling; shimmy adds a sway.
  const sway = pose === 'shimmy' ? 0.35 : 0.08
  return {
    upperarm_l: dirOf(0.12, 1, 0.1),
    lowerarm_l: dirOf(0.12, 1, 0.1),
    upperarm_r: dirOf(-0.12, 1, 0.1),
    lowerarm_r: dirOf(-0.12, 1, 0.1),
    thigh_l: dirOf(0.04, -1, sway * s),
    calf_l: dirOf(0.04, -1, -sway * up(s) - 0.1),
    thigh_r: dirOf(-0.04, -1, sway * c),
    calf_r: dirOf(-0.04, -1, -sway * up(c) - 0.1),
  }
}

export interface ObservedState {
  mode: MovementMode
  /** Horizontal speed (u/s) from position deltas, already smoothed. */
  speed: number
  /** Vertical speed (u/s) from the synced y. */
  vy: number
  health: number
  reloading: boolean
}

export interface CharacterAnimator {
  /** Feed the latest synced state (call whenever the player's state arrives). */
  observe(state: ObservedState): void
  /** The server fired this player's weapon (a `shot` event). */
  shot(): void
  /** Per-frame update. `dt` in seconds. */
  update(dt: number): void
  /** Name of what is playing now (`climb`, `hang`... or a clip name), for tests and debugging. */
  current(): string
  /** Clip names the model has. */
  readonly clips: ReadonlySet<string>
  dispose(): void
}

export function createCharacterAnimator(model: LoadedModel, team: Team): CharacterAnimator {
  const groups = new Map<string, AnimationGroup>()
  for (const g of model.animationGroups) groups.set(g.name, g)
  const clips = new Set(groups.keys())
  for (const g of groups.values()) {
    g.enableBlending = true
    g.blendingSpeed = 1 / (BLEND_SECONDS * 60)
  }

  // Bind data for procedural poses, captured before any clip runs.
  const binds = new Map<PoseBone, BoneBind>()
  const rootInv = new Matrix()
  model.root.computeWorldMatrix(true)
  model.root.getWorldMatrix().invertToRef(rootInv)
  const relRotation = (n: TransformNode): Matrix => {
    n.computeWorldMatrix(true)
    const q = new Quaternion()
    n.getWorldMatrix().multiply(rootInv).decompose(new Vector3(), q, new Vector3())
    return Matrix.FromQuaternionToRef(q, new Matrix())
  }
  const relPosition = (n: TransformNode): Vector3 => Vector3.TransformCoordinates(n.getAbsolutePosition(), rootInv)
  for (const name of POSE_BONES) {
    const node = model.nodes.get(name)
    const child = model.nodes.get(POSE_CHILD[name])
    const parent = node?.parent as TransformNode | null | undefined
    if (!node || !child || !parent || !('computeWorldMatrix' in parent)) continue
    const parentInv = new Matrix()
    relRotation(parent).invertToRef(parentInv)
    const dir = relPosition(child).subtract(relPosition(node)).normalize()
    binds.set(name, { node, rel: relRotation(node), parentInv, dir })
  }
  const poseQ = new Quaternion()
  const delta = new Matrix()
  const applyPose = (targets: PoseTargets): void => {
    for (const [name, target] of Object.entries(targets) as [PoseBone, Vector3][]) {
      const b = binds.get(name)
      if (!b) continue
      // Turn the bind direction onto the target direction (shortest arc, model space).
      Matrix.FromQuaternionToRef(Quaternion.FromUnitVectorsToRef(b.dir, target, new Quaternion()), delta)
      b.rel.multiply(delta).multiply(b.parentInv).decompose(new Vector3(), poseQ, new Vector3())
      b.node.rotationQuaternion = (b.node.rotationQuaternion ?? new Quaternion()).copyFrom(poseQ)
    }
  }

  let state: ObservedState = { mode: 'ground', speed: 0, vy: 0, health: Number.POSITIVE_INFINITY, reloading: false }
  let oneShot: OneShot | null = null
  let playing: AnimationGroup | null = null
  let procedural: ProceduralPose | null = null
  let phase = 0
  let disposed = false

  let restarting = false
  const startOneShot = (kind: OneShot): void => {
    const clip = ONE_SHOT_CLIP[kind]
    if (!groups.has(clip)) return
    // Restart even if the same clip is already running. stop() fires the end
    // observable, which must not clear the one-shot being started.
    const g = groups.get(clip)!
    if (playing === g) {
      restarting = true
      g.stop()
      restarting = false
    }
    playing = null
    oneShot = kind
  }

  for (const g of groups.values()) {
    g.onAnimationGroupEndObservable.add(() => {
      if (!restarting && oneShot && ONE_SHOT_CLIP[oneShot] === g.name) {
        // A reload or a fire clip does not hold the pose past its end.
        oneShot = null
        if (playing === g) playing = null
      }
    })
  }

  const apply = (): void => {
    const choice = chooseAnimation({ team, mode: state.mode, speed: state.speed, oneShot }, clips)
    procedural = choice.pose
    if (choice.pose) {
      if (playing) {
        playing.stop()
        playing = null
      }
      const moving = choice.pose === 'climb' ? Math.abs(state.vy) > CLIMB_STILL_SPEED : state.speed > SHIMMY_MIN_SPEED
      const rate = choice.pose === 'climb' ? Math.abs(state.vy) * 5 : choice.pose === 'shimmy' ? state.speed * 6 : 1
      if (moving || choice.pose === 'hang') phase += rate * lastDt
      applyPose(poseTargets(choice.pose, phase))
      return
    }
    const g = choice.clip ? groups.get(choice.clip) : undefined
    if (!g) return
    if (playing !== g) {
      playing?.stop()
      g.start(choice.loop, locomotionSpeedRatio(choice.clip, state.speed))
      playing = g
    } else {
      g.speedRatio = locomotionSpeedRatio(choice.clip, state.speed)
    }
  }

  let lastDt = 0
  let lastReloading = false

  return {
    clips,
    observe(next) {
      const prev = state
      // Triggers come only from received state changes.
      if (next.health < prev.health - 1e-6 && Number.isFinite(prev.health)) startOneShot('hit')
      else if (next.reloading && !lastReloading) startOneShot('reload')
      else if (prev.mode === 'hanging' && next.mode === 'ground') startOneShot('mantle')
      else if (prev.mode === 'falling' && next.mode === 'ground') startOneShot('land')
      else if (prev.mode === 'ground' && next.mode === 'falling' && next.vy > JUMP_RISE_SPEED) startOneShot('jump')
      lastReloading = next.reloading
      state = next
    },
    shot() {
      startOneShot('fire')
    },
    update(dt) {
      if (disposed) return
      lastDt = dt
      apply()
    },
    current: () => procedural ?? (playing ? playing.name : 'none'),
    dispose() {
      disposed = true
      for (const g of groups.values()) g.stop()
    },
  }
}
