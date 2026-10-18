// Camera-relative movement intent: validation and the world step, following
// the formula documented on MoveMessage in shared/protocol.d.ts. Pure
// functions with no Colyseus dependency.

/** A validated move: dx, dz clamped to -1..1 with length at most 1, yaw wrapped. */
export interface ParsedMove {
  dx: number;
  dz: number;
  /** Wrapped into -pi..pi; undefined when the message had no yaw. */
  yaw?: number;
}

const TWO_PI = 2 * Math.PI;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Wraps a finite angle in radians into -pi..pi. */
export function wrapYaw(yaw: number): number {
  // `%` is exact on doubles, so this stays accurate even for huge inputs.
  let r = (yaw + Math.PI) % TWO_PI;
  if (r < 0) r += TWO_PI;
  return clamp(r - Math.PI, -Math.PI, Math.PI);
}

/**
 * Validates a `move` payload. Returns null (ignore the whole message) unless
 * it is an object with finite-number `dx` and `dz` and, if `yaw` is present
 * (not undefined), a finite-number `yaw`. Clamps each axis to -1..1, caps the
 * intent's length at 1 and wraps yaw into -pi..pi.
 */
export function parseMove(message: unknown): ParsedMove | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const { dx, dz, yaw } = message as Record<string, unknown>;
  if (!isFiniteNumber(dx) || !isFiniteNumber(dz)) return null;
  if (yaw !== undefined && !isFiniteNumber(yaw)) return null;
  let x = clamp(dx, -1, 1);
  let z = clamp(dz, -1, 1);
  const length = Math.hypot(x, z);
  if (length > 1) {
    x /= length;
    z /= length;
  }
  const move: ParsedMove = { dx: x, dz: z };
  if (isFiniteNumber(yaw)) move.yaw = wrapYaw(yaw);
  return move;
}

/**
 * World displacement on (x, z) for intent (dx strafe, dz forward) at facing
 * `yaw`, scaled by `step`. Forward is (sin yaw, cos yaw), right is
 * (cos yaw, -sin yaw).
 */
export function worldStep(dx: number, dz: number, yaw: number, step: number): { x: number; z: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    x: (dx * c + dz * s) * step,
    z: (-dx * s + dz * c) * step,
  };
}
