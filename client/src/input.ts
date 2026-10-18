import type { MoveMessage } from '../../shared/protocol.js'

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
