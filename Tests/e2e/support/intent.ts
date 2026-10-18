// Movement maths of the #18 contract (shared/protocol.d.ts, MoveMessage),
// written here independently of server code so tests check the server rather
// than reuse it. Pure functions with no server or browser imports, so unit
// tests (Tests/unit/intent.test.ts) can check them against the contract text.
//
// Convention: yaw in radians, 0 faces +z, positive turns toward +x. Forward is
// (sin yaw, cos yaw) and right is (cos yaw, -sin yaw) on (x, z). dx is strafe
// (+1 right) and dz is forward (+1 forward).

import { TEAM_SPEED, TEAMS, type Team } from '../../../shared/protocol.js'

export interface Vec {
  x: number
  z: number
}

/** The fields of a player in synced state or a snapshot that movement depends on. */
export interface MoverLike {
  team?: unknown
  yaw?: unknown
}

const clampUnit = (v: number) => Math.max(-1, Math.min(1, v))

export function isTeam(v: unknown): v is Team {
  return typeof v === 'string' && (TEAMS as readonly string[]).includes(v)
}

/** The player's yaw, or 0 when the field is absent (before #20 syncs it). */
export function yawOf(p: MoverLike): number {
  return typeof p.yaw === 'number' && Number.isFinite(p.yaw) ? p.yaw : 0
}

/** Per-message step of a team at full input: TEAM_SPEED[team] / rateHz. */
export function teamStep(team: Team, rateHz: number): number {
  return TEAM_SPEED[team] / rateHz
}

/**
 * Intent after the server's validation: each axis clamped to -1..1, then the
 * length hypot(dx, dz) capped at 1 (#18). Before #20 the server does not cap,
 * so pass `cap = false` to get today's behaviour.
 */
export function clampIntent(dx: number, dz: number, cap = true): Vec {
  let x = clampUnit(dx)
  let z = clampUnit(dz)
  const len = Math.hypot(x, z)
  if (cap && len > 1) {
    x /= len
    z /= len
  }
  return { x, z }
}

/**
 * World-space displacement (x, z) of one accepted move with no collision:
 *   stepX =  dx * cos(yaw) + dz * sin(yaw)
 *   stepZ = -dx * sin(yaw) + dz * cos(yaw)
 * on the clamped (and, by default, capped) intent, times `step`.
 */
export function worldStep(dx: number, dz: number, yaw: number, step: number, cap = true): Vec {
  const i = clampIntent(dx, dz, cap)
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return { x: (i.x * c + i.z * s) * step, z: (-i.x * s + i.z * c) * step }
}

/**
 * Both displacements a move can produce while the suite must pass before and
 * after #20: uncapped (today) and capped (#18's contract). Identical for
 * single-axis input; they differ only for diagonals.
 */
export function allowedSteps(dx: number, dz: number, yaw: number, step: number): Vec[] {
  return [worldStep(dx, dz, yaw, step, false), worldStep(dx, dz, yaw, step, true)]
}
