// Fire message validation (M5, #41). Pure code with no Colyseus dependency.
// The payload contract is FireMessage in shared/protocol.d.ts.

import { wrapYaw } from "./movement.js";

/** A validated aim: yaw wrapped into -pi..pi, pitch clamped to -pi/2..pi/2. */
export interface ParsedFire {
  yaw: number;
  pitch: number;
}

/**
 * Validates a `fire` payload. Returns the aim, or null (ignore the message,
 * spend no token) unless it is a non-array object with finite numeric `yaw`
 * and `pitch`. Extra fields are never read.
 */
export function parseFire(message: unknown): ParsedFire | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const { yaw, pitch } = message as Record<string, unknown>;
  if (typeof yaw !== "number" || !Number.isFinite(yaw)) return null;
  if (typeof pitch !== "number" || !Number.isFinite(pitch)) return null;
  const half = Math.PI / 2;
  return { yaw: wrapYaw(yaw), pitch: Math.min(half, Math.max(-half, pitch)) };
}
