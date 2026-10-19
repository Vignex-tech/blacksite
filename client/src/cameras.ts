import type { Scene } from '@babylonjs/core/scene'
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { TargetCamera } from '@babylonjs/core/Cameras/targetCamera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Team } from '../../shared/protocol.js'
import type { CameraMode } from '../../shared/testhook.js'

/**
 * Per-team cameras (#24). Purely visual: the rig follows your own player's
 * server position and never moves anything. Its yaw is what input.ts sends
 * as the move intent's facing; pitch stays local.
 *
 * - overhead: the fixed map view, until your team is known or while
 *   disconnected.
 * - third-person (Ghost): behind and above the right shoulder.
 * - first-person (Warden): at eye height, own body hidden.
 *
 * The yaw starts at your player's server yaw (0 at spawn) and changes only on
 * mouse input while the pointer is locked (click the canvas; Esc releases).
 * Convention as in shared/protocol: yaw 0 faces +z, positive turns toward +x
 * (Babylon's rotation.y). Positive pitch looks down.
 */

/** Radians of turn per pixel of mouse movement. */
const MOUSE_SENSITIVITY = 0.0025
/** First person: eye height above the player's feet (its server y). */
const EYE_HEIGHT = 1.6
const FIRST_PERSON_PITCH = { min: -1.4, max: 1.4 }
/** Third person: the point the camera orbits, relative to the player's feet. */
const SHOULDER_HEIGHT = 1.7
const SHOULDER_RIGHT = 0.6
/** Third person: distance from the shoulder point back along the view. */
const THIRD_PERSON_DISTANCE = 3.2
/** Third person starts looking slightly down at the player. */
const THIRD_PERSON_START_PITCH = 0.25
const THIRD_PERSON_PITCH = { min: -0.5, max: 1.0 }
/** Third person: the camera never goes below this height (the ground). */
const MIN_CAMERA_HEIGHT = 0.3

const MODE_FOR_TEAM: Record<Team, CameraMode> = { ghost: 'third-person', warden: 'first-person' }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Wraps an angle into -pi..pi. */
export function wrapAngle(a: number): number {
  const t = (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return t - Math.PI
}

export interface CameraRig {
  readonly mode: CameraMode
  /** Camera yaw in radians (wrapped to -pi..pi); 0 in overhead mode. */
  readonly yaw: number
  /** Camera pitch in radians, local convention: positive looks DOWN. 0 in overhead mode. */
  readonly pitch: number
  /**
   * Your own player as received from server state (`y` is its feet height,
   * 0 if omitted). The first call with a known team switches to that team's
   * camera, starting at `serverYaw`. The shoulder point and the eye follow `y`.
   */
  setLocalPlayer(id: string, x: number, z: number, team: Team | null, serverYaw: number, y?: number): void
  /** Back to the overhead camera (disconnected). */
  reset(): void
  /** The local player's id while a team camera is active (its mesh may be hidden). */
  readonly localId: string | null
  dispose(): void
}

export function createCameraRig(scene: Scene, canvas: HTMLCanvasElement, overhead: ArcRotateCamera): CameraRig {
  const eye = new TargetCamera('playerCamera', Vector3.Zero(), scene)
  eye.minZ = 0.05
  eye.fov = 1.0

  let mode: CameraMode = 'overhead'
  let yaw = 0
  let pitch = 0
  let localId: string | null = null
  const pos = new Vector3()

  const pitchLimits = () => (mode === 'first-person' ? FIRST_PERSON_PITCH : THIRD_PERSON_PITCH)

  const place = (): void => {
    if (mode === 'overhead') return
    eye.rotation.set(pitch, yaw, 0)
    if (mode === 'first-person') {
      eye.position.set(pos.x, pos.y + EYE_HEIGHT, pos.z)
      return
    }
    // Orbit the right-shoulder point, looking along (yaw, pitch).
    const cp = Math.cos(pitch)
    const lookX = Math.sin(yaw) * cp
    const lookY = -Math.sin(pitch)
    const lookZ = Math.cos(yaw) * cp
    const pivotX = pos.x + Math.cos(yaw) * SHOULDER_RIGHT
    const pivotZ = pos.z - Math.sin(yaw) * SHOULDER_RIGHT
    eye.position.set(
      pivotX - lookX * THIRD_PERSON_DISTANCE,
      Math.max(MIN_CAMERA_HEIGHT, pos.y + SHOULDER_HEIGHT - lookY * THIRD_PERSON_DISTANCE),
      pivotZ - lookZ * THIRD_PERSON_DISTANCE,
    )
  }

  const setMode = (next: CameraMode): void => {
    if (next === mode) return
    const wasOverhead = mode === 'overhead'
    mode = next
    if (next === 'overhead') {
      if (document.pointerLockElement === canvas) document.exitPointerLock()
      scene.activeCamera = overhead
      overhead.attachControl(canvas, true)
    } else if (wasOverhead) {
      overhead.detachControl()
      scene.activeCamera = eye
    }
  }

  const onMouseMove = (e: MouseEvent): void => {
    if (mode === 'overhead' || document.pointerLockElement !== canvas) return
    yaw = wrapAngle(yaw + e.movementX * MOUSE_SENSITIVITY)
    const lim = pitchLimits()
    pitch = clamp(pitch + e.movementY * MOUSE_SENSITIVITY, lim.min, lim.max)
    place()
  }
  const onClick = (): void => {
    if (mode === 'overhead' || document.pointerLockElement === canvas) return
    // Newer browsers return a promise that rejects if the lock is refused
    // (e.g. right after Esc); that's not an error worth reporting.
    const result = canvas.requestPointerLock() as unknown as Promise<void> | undefined
    result?.catch?.(() => {})
  }
  document.addEventListener('mousemove', onMouseMove)
  canvas.addEventListener('click', onClick)

  return {
    get mode() {
      return mode
    },
    get yaw() {
      return yaw
    },
    get pitch() {
      return mode === 'overhead' ? 0 : pitch
    },
    get localId() {
      return mode === 'overhead' ? null : localId
    },
    setLocalPlayer(id, x, z, team, serverYaw, y = 0) {
      pos.set(x, Number.isFinite(y) ? y : 0, z)
      if (mode === 'overhead' && team) {
        // Start the team camera at the player's server facing.
        localId = id
        yaw = wrapAngle(Number.isFinite(serverYaw) ? serverYaw : 0)
        const next = MODE_FOR_TEAM[team]
        setMode(next)
        pitch = next === 'third-person' ? THIRD_PERSON_START_PITCH : 0
      } else if (team && MODE_FOR_TEAM[team] !== mode) {
        setMode(MODE_FOR_TEAM[team])
        const lim = pitchLimits()
        pitch = clamp(pitch, lim.min, lim.max)
      }
      place()
    },
    reset() {
      setMode('overhead')
      yaw = 0
      pitch = 0
      localId = null
    },
    dispose() {
      document.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('click', onClick)
      eye.dispose()
    },
  }
}
