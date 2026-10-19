import { MAX_HEALTH, WEAPONS, type Team } from '../../shared/protocol.js'
import type { CameraMode } from '../../shared/testhook.js'

// Health, ammo and crosshair display rules (M5, #48). Pure functions with no
// Babylon or DOM code so they can be unit-tested. Everything here is shown
// from the state the server sent; nothing is predicted or decided locally.

/** What the HUD knows about the local player, from received state. */
export interface LocalVitals {
  team: Team | null
  health: number
  ammo: number
  reloading: boolean
}

/** True when received health says the player is eliminated (`health <= 0`). */
export const isEliminated = (health: number): boolean => health <= 0

/** Safe values for a player whose state lacks (or has bad) health, ammo or reloading. */
export function defaultVitals(team: Team | null): { health: number; ammo: number; reloading: boolean } {
  return {
    health: team ? MAX_HEALTH[team] : MAX_HEALTH.ghost,
    ammo: team ? WEAPONS[team].magazine : 0,
    reloading: false,
  }
}

/** Health readout, e.g. `HP 100/150`, or `Eliminated`. Empty before local state arrives. */
export function healthText(v: LocalVitals | null): string {
  if (!v || !v.team) return ''
  if (isEliminated(v.health)) return 'Eliminated'
  return `HP ${Math.max(0, Math.round(v.health))}/${MAX_HEALTH[v.team]}`
}

/**
 * Ammo readout, e.g. `Ammo 30/30`; `Reloading...` while reloading; `R: reload`
 * when the magazine is empty. Empty before local state arrives and when
 * eliminated.
 */
export function ammoText(v: LocalVitals | null): string {
  if (!v || !v.team || isEliminated(v.health)) return ''
  if (v.reloading) return 'Reloading...'
  if (v.ammo <= 0) return 'R: reload'
  return `Ammo ${Math.round(v.ammo)}/${WEAPONS[v.team].magazine}`
}

/**
 * The crosshair shows in the first-person and third-person cameras, never in
 * overhead mode, and never for an eliminated local player.
 */
export function crosshairVisible(mode: CameraMode, localHealth: number | null): boolean {
  if (mode === 'overhead') return false
  return localHealth === null || !isEliminated(localHealth)
}
