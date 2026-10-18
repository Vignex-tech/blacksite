// Action message validation (M4, #29). Pure code with no Colyseus dependency.
// The payload contract is ActionMessage in shared/protocol.d.ts.

import { ACTIONS, type Action } from "../../../shared/protocol.js";

/**
 * Validates an `action` payload. Returns the action, or null (ignore the
 * message) unless it is a non-array object whose `action` is one of ACTIONS.
 * Extra fields are never read, so there is nothing else to forge.
 */
export function parseAction(message: unknown): Action | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const { action } = message as Record<string, unknown>;
  if (typeof action !== "string") return null;
  return (ACTIONS as readonly string[]).includes(action) ? (action as Action) : null;
}
