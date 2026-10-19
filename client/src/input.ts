import type { Action, MoveMessage } from '../../shared/protocol.js'

/** Movement keys by KeyboardEvent.code. +z is away from the camera, +x is to its right. */
const KEY_DIRECTIONS: Record<string, MoveMessage> = {
  KeyW: { dx: 0, dz: 1 },
  ArrowUp: { dx: 0, dz: 1 },
  KeyS: { dx: 0, dz: -1 },
  ArrowDown: { dx: 0, dz: -1 },
  KeyA: { dx: -1, dz: 0 },
  ArrowLeft: { dx: -1, dz: 0 },
  KeyD: { dx: 1, dz: 0 },
  ArrowRight: { dx: 1, dz: 0 },
}

/** Tracks held movement keys and reports the combined direction (each component -1, 0 or 1). */
export class MovementInput {
  private readonly held = new Set<string>()

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (!(e.code in KEY_DIRECTIONS) || e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault() // keep arrow keys from scrolling the page
      this.held.add(e.code)
    })
    target.addEventListener('keyup', (e) => this.held.delete(e.code))
    // Keys released while the tab is unfocused never fire keyup, so drop them all.
    target.addEventListener('blur', () => this.held.clear())
  }

  /** Current direction, or null when no movement key is held (or opposite keys cancel out). */
  direction(): MoveMessage | null {
    let dx = 0
    let dz = 0
    for (const code of this.held) {
      dx += KEY_DIRECTIONS[code].dx
      dz += KEY_DIRECTIONS[code].dz
    }
    dx = Math.sign(dx)
    dz = Math.sign(dz)
    return dx === 0 && dz === 0 ? null : { dx, dz }
  }
}

/**
 * Action keys by KeyboardEvent.code (proposed defaults approved on #26):
 * Space jumps, E climbs, grabs a ledge or mantles from hanging, C drops.
 * Each press sends one `{ action }` message; the server decides what happens.
 */
export const ACTION_KEYS: Readonly<Record<string, Action>> = Object.freeze({
  Space: 'jump',
  KeyE: 'climb',
  KeyC: 'drop',
})

/**
 * Turns action key presses into one callback per press. Key auto-repeat is
 * ignored (a key must be released before it fires again), as are Ctrl, Meta
 * and Alt combinations. Space never scrolls the page.
 */
export class ActionInput {
  private readonly held = new Set<string>()

  constructor(onAction: (action: Action) => void, target: Window = window) {
    target.addEventListener('keydown', (e) => {
      const action = Object.prototype.hasOwnProperty.call(ACTION_KEYS, e.code) ? ACTION_KEYS[e.code] : undefined
      if (!action || e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault() // Space would scroll the page
      if (e.repeat || this.held.has(e.code)) return
      this.held.add(e.code)
      onAction(action)
    })
    target.addEventListener('keyup', (e) => this.held.delete(e.code))
    target.addEventListener('blur', () => this.held.clear())
  }
}
