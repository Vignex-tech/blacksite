// Line of sight and visibility for the M5 hidden-information filter (#45).
//
// The filter (#46, decision 11 on #38): a Warden client is sent a Ghost only
// when the Ghost is within VISIBILITY_NEAR (3D distance between box centres) or
// a straight line from that Warden's eye to a sample point of the Ghost's box
// (at least centre, head and feet) is not blocked by a solid, floor or ramp.
// A Ghost client is sent everyone, and a client always gets itself and its own
// teammates.
//
// What a spec may assume about who sees whom (see also `mustSee` in sdk.ts):
//   ghost viewer  -> everyone                       (always)
//   warden viewer -> itself and other Wardens        (always)
//   warden viewer -> a Ghost                         (only near, or with line of sight)
// So a spec must never read a Ghost from a Warden client unless it first put
// them in line of sight (check it with `visibilityOf` below), and must read
// "the truth" about any player from a Ghost client (`godView` in sdk.ts) or
// from the player's own client.
//
// How to use these helpers:
//   - Pick placements with `visibilityOf(warden, ghost)`: 'visible' means the
//     server must send the Ghost, 'hidden' means it must not, 'unsure' means
//     the answer depends on the server's exact sample points (a grazing ray or
//     a distance near VISIBILITY_NEAR): don't assert on it either way.
//   - Wait for a player with `whenVisible(room, id)` (support/sdk.ts) rather
//     than for a player count.
//   - `hasLineOfSight(from, to)` works on raw points when a spec needs an
//     exact ray (for example "the shot's line is blocked").
//
// This is computed from shared/map.js independently of server code. Floors and
// solids are tested as exact boxes; a ramp's wedge by sampling along the ray
// every RAY_STEP units (good enough to place players, not a reference
// implementation).

import { EYE_HEIGHT, VISIBILITY_NEAR } from '../../../shared/protocol.js'
import { PLAYER_HEIGHT } from '../../../shared/map.js'
import { OBSTACLES, PLAYER_HALF_SIZE, feetY, rampHeightAt, type Obstacle, type Placed } from './geometry.js'

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** A player as the helpers need it: x, z and (optionally) the feet height `y`. */
export type Body = Placed

/** Spacing of the checks along a ray through a ramp wedge. */
const RAY_STEP = 0.02
/** A ray that only touches a face (within this) is not blocked. */
const TOUCH = 1e-9

/** The player's eye: EYE_HEIGHT above the feet. */
export function eyeOf(p: Body): Vec3 {
  return { x: p.x, y: feetY(p) + EYE_HEIGHT, z: p.z }
}

/** The centre of the player's box. */
export function centreOf(p: Body): Vec3 {
  return { x: p.x, y: feetY(p) + PLAYER_HEIGHT / 2, z: p.z }
}

/**
 * The sample points every server choice should include: centre, head and feet
 * (just inside the box, so a floor or the ground doesn't hide them).
 */
export function coreSamples(p: Body): Vec3[] {
  const y = feetY(p)
  return [
    { x: p.x, y: y + PLAYER_HEIGHT / 2, z: p.z },
    { x: p.x, y: y + PLAYER_HEIGHT - 0.1, z: p.z },
    { x: p.x, y: y + 0.1, z: p.z },
  ]
}

/** A dense set (box corners and face centres at three heights, plus the core), for "can anything see it". */
export function denseSamples(p: Body): Vec3[] {
  const y = feetY(p)
  const h = PLAYER_HALF_SIZE - 0.01
  const out: Vec3[] = []
  for (const dy of [0.02, PLAYER_HEIGHT / 2, PLAYER_HEIGHT - 0.02]) {
    for (const dx of [-h, 0, h]) {
      for (const dz of [-h, 0, h]) out.push({ x: p.x + dx, y: y + dy, z: p.z + dz })
    }
  }
  return out
}

function segmentHitsBox(a: Vec3, b: Vec3, min: Vec3, max: Vec3): boolean {
  let t0 = 0
  let t1 = 1
  for (const k of ['x', 'y', 'z'] as const) {
    const d = b[k] - a[k]
    if (Math.abs(d) < 1e-12) {
      if (a[k] <= min[k] + TOUCH || a[k] >= max[k] - TOUCH) return false
      continue
    }
    let near = (min[k] - a[k]) / d
    let far = (max[k] - a[k]) / d
    if (near > far) [near, far] = [far, near]
    t0 = Math.max(t0, near)
    t1 = Math.min(t1, far)
    if (t0 >= t1 - TOUCH) return false
  }
  return t1 - t0 > TOUCH
}

function segmentHitsRamp(a: Vec3, b: Vec3, o: Obstacle): boolean {
  const r = o.ramp!
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / RAY_STEP))
  for (let i = 1; i < n; i++) {
    const t = i / n
    const x = a.x + (b.x - a.x) * t
    const y = a.y + (b.y - a.y) * t
    const z = a.z + (b.z - a.z) * t
    if (x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ && y >= 0 && y < rampHeightAt(r, x, z) - TOUCH) return true
  }
  return false
}

/** Ids of the solids, floors and ramps that block the straight segment `from` -> `to`. */
export function blockers(from: Vec3, to: Vec3): string[] {
  return OBSTACLES.filter((o) => {
    if (o.ramp) return segmentHitsRamp(from, to, o)
    return segmentHitsBox(from, to, { x: o.rect.minX, y: o.minY, z: o.rect.minZ }, { x: o.rect.maxX, y: o.maxY, z: o.rect.maxZ })
  }).map((o) => o.id)
}

/** True if nothing blocks the straight segment from -> to. */
export function hasLineOfSight(from: Vec3, to: Vec3): boolean {
  return blockers(from, to).length === 0
}

/** 3D distance between the centres of two players' boxes. */
export function centreDistance(a: Body, b: Body): number {
  const p = centreOf(a)
  const q = centreOf(b)
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
}

/** Slack around VISIBILITY_NEAR inside which 'near' is not asserted either way. */
const NEAR_MARGIN = 0.25

export type Visibility = 'visible' | 'hidden' | 'unsure'

/**
 * Whether the filter must send `target` (a Ghost) to `viewer` (a Warden):
 * - 'visible': the target is clearly near (inside VISIBILITY_NEAR less a margin)
 *   or the ray from the viewer's eye to the target's centre is clear. A server
 *   whose sample set includes the centre must send it.
 * - 'hidden': the target is clearly far (beyond VISIBILITY_NEAR plus a margin)
 *   and the ray from the eye to none of denseSamples(target) is clear.
 * - 'unsure': anything else. Don't assert on it.
 */
export function visibilityOf(viewer: Body, target: Body): Visibility {
  const d = centreDistance(viewer, target)
  const eye = eyeOf(viewer)
  if (d < VISIBILITY_NEAR - NEAR_MARGIN) return 'visible'
  if (hasLineOfSight(eye, centreOf(target))) return 'visible'
  if (d > VISIBILITY_NEAR + NEAR_MARGIN && !denseSamples(target).some((s) => hasLineOfSight(eye, s))) return 'hidden'
  return 'unsure'
}

/** True if `visibilityOf(viewer, target)` is 'visible'. */
export const clearlyVisible = (viewer: Body, target: Body) => visibilityOf(viewer, target) === 'visible'

/** True if `visibilityOf(viewer, target)` is 'hidden'. */
export const clearlyHidden = (viewer: Body, target: Body) => visibilityOf(viewer, target) === 'hidden'
