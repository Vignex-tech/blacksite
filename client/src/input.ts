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

/** Fire and reload bindings by input (decision 15 on #38). One table, like ACTION_KEYS. */
export const FIRE_BINDINGS = Object.freeze({
  /** MouseEvent.button for fire: left mouse, hold to keep firing. */
  fireButton: 0,
  /** KeyboardEvent.code for reload: one `reload` per press. */
  reloadKey: 'KeyR',
})

/**
 * Left mouse fires while held; R reloads once per press. Both work only while
 * `isActive()` is true (the caller says: pointer locked, not overhead, connected,
 * not eliminated). The press that locks the pointer never fires: a mouse
 * button counts as held only if it went down while active, and the lock itself
 * happens on the click after that press. Ctrl, Meta and Alt combinations of R
 * are ignored and not prevented. The caller polls `firing()` on its tick.
 */
export class FireInput {
  private buttonHeld = false
  private reloadHeld = false

  private readonly isActive: () => boolean

  constructor(isActive: () => boolean, onReload: () => void, target: Window = window) {
    this.isActive = isActive
    target.addEventListener('mousedown', (e) => {
      if (e.button === FIRE_BINDINGS.fireButton && this.isActive()) this.buttonHeld = true
    })
    target.addEventListener('mouseup', (e) => {
      if (e.button === FIRE_BINDINGS.fireButton) this.buttonHeld = false
    })
    target.addEventListener('keydown', (e) => {
      if (e.code !== FIRE_BINDINGS.reloadKey || e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      if (e.repeat || this.reloadHeld) return
      this.reloadHeld = true
      if (this.isActive()) onReload()
    })
    target.addEventListener('keyup', (e) => {
      if (e.code === FIRE_BINDINGS.reloadKey) this.reloadHeld = false
    })
    target.addEventListener('blur', () => {
      this.buttonHeld = false
      this.reloadHeld = false
    })
  }

  /** True while the fire button is held and input is still active. */
  firing(): boolean {
    if (this.buttonHeld && !this.isActive()) this.buttonHeld = false // lock lost, died: must press again
    return this.buttonHeld
  }
}

/** Interact (hack) keys by KeyboardEvent.code (M6, #53): hold F; E stays climb. */
export const INTERACT_KEYS: readonly string[] = Object.freeze(['KeyF'])

/**
 * Hold-to-interact. Keydown sends `true` once (auto-repeat and a second keydown
 * are ignored), keyup or blur sends `false`. Nothing is sent while
 * `isActive()` is false (overhead, disconnected, eliminated, a team that can't
 * hack); a press made while inactive sends nothing, and neither does its
 * release. `sync()` (call it every tick) releases a hold that became inactive.
 * Ctrl, Meta and Alt combinations are ignored and not prevented.
 */
export class InteractInput {
  private readonly held = new Set<string>()
  private sent = false

  private readonly isActive: () => boolean
  private readonly onInteract: (active: boolean) => void

  constructor(isActive: () => boolean, onInteract: (active: boolean) => void, target: Window = window) {
    this.isActive = isActive
    this.onInteract = onInteract
    target.addEventListener('keydown', (e) => {
      if (!INTERACT_KEYS.includes(e.code) || e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      if (e.repeat || this.held.has(e.code)) return
      this.held.add(e.code)
      if (this.isActive()) this.press()
    })
    target.addEventListener('keyup', (e) => {
      if (!INTERACT_KEYS.includes(e.code)) return
      this.held.delete(e.code)
      if (this.held.size === 0) this.release()
    })
    target.addEventListener('blur', () => {
      this.held.clear()
      this.release()
    })
  }

  private press(): void {
    if (this.sent) return
    this.sent = true
    this.onInteract(true)
  }

  private release(): void {
    if (!this.sent) return
    this.sent = false
    this.onInteract(false)
  }

  /** Releases a hold whose input went inactive (eliminated, disconnected). */
  sync(): void {
    if (this.sent && !this.isActive()) this.release()
  }
}
