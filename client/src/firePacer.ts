import { WEAPONS, type Team } from '../../shared/protocol.js'

/**
 * Paces fire messages to the weapon's shot interval so the client does not
 * flood the server's fire bucket (10/s, burst 3). This saves traffic only; the
 * server enforces the real cooldown.
 */
export class FirePacer {
  private last = -Infinity

  /** True (and records the send) if a fire message is due at `nowMs` for `team`'s weapon. */
  due(nowMs: number, team: Team): boolean {
    if (nowMs - this.last < WEAPONS[team].intervalMs) return false
    this.last = nowMs
    return true
  }
}
