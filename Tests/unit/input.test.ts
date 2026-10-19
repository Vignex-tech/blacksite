import { describe, expect, it } from 'vitest'
import { ACTION_KEYS, ActionInput, MovementInput } from '../../client/src/input.ts'
import { ACTIONS, type Action } from '../../shared/protocol.js'

// #25: the keys-to-intent half of the client's input-to-message mapping
// (client/src/input.ts, #24). W/S are forward/back (dz +1/-1) and A/D strafe
// (dx -1/+1), relative to the camera; the server turns them by the yaw. The
// other half (the yaw sent, yaw-only sends when turning, the 20 Hz tick) runs
// inside client/src/main.ts and needs a browser, so it is checked on the wire
// in e2e/cameras.spec.ts (support/frames.ts).

function setup() {
  const target = new EventTarget()
  const input = new MovementInput(target as unknown as Window)
  const key = (type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent(type, { code, cancelable: true, ...init })
    target.dispatchEvent(e)
    return e
  }
  return {
    input,
    down: (code: string, init?: KeyboardEventInit) => key('keydown', code, init),
    up: (code: string) => key('keyup', code),
    blur: () => target.dispatchEvent(new Event('blur')),
  }
}

describe('MovementInput: held keys to camera-relative intent', () => {
  it('sends nothing with no key held', () => {
    expect(setup().input.direction()).toBeNull()
  })

  it.each([
    ['KeyW', { dx: 0, dz: 1 }],
    ['ArrowUp', { dx: 0, dz: 1 }],
    ['KeyS', { dx: 0, dz: -1 }],
    ['ArrowDown', { dx: 0, dz: -1 }],
    ['KeyA', { dx: -1, dz: 0 }],
    ['ArrowLeft', { dx: -1, dz: 0 }],
    ['KeyD', { dx: 1, dz: 0 }],
    ['ArrowRight', { dx: 1, dz: 0 }],
  ])('%s maps to %o (forward is dz, strafe right is dx)', (code, want) => {
    const t = setup()
    t.down(code)
    expect(t.input.direction()).toEqual(want)
    t.up(code)
    expect(t.input.direction()).toBeNull()
  })

  it('combines two keys into a diagonal of unit components (the server caps the length)', () => {
    const t = setup()
    t.down('KeyW')
    t.down('KeyD')
    expect(t.input.direction()).toEqual({ dx: 1, dz: 1 })
    t.up('KeyW')
    expect(t.input.direction()).toEqual({ dx: 1, dz: 0 })
    t.down('KeyS')
    t.down('KeyA')
    t.up('KeyD')
    expect(t.input.direction()).toEqual({ dx: -1, dz: -1 })
  })

  it('opposite keys cancel out, and holding the same direction twice is still 1', () => {
    const t = setup()
    t.down('KeyW')
    t.down('KeyS')
    expect(t.input.direction()).toBeNull()
    t.down('KeyA')
    t.down('KeyD')
    expect(t.input.direction()).toBeNull()
    const u = setup()
    u.down('KeyW')
    u.down('ArrowUp')
    expect(u.input.direction()).toEqual({ dx: 0, dz: 1 })
  })

  it('ignores other keys and shortcuts with Ctrl, Meta or Alt, and keeps arrow keys from scrolling', () => {
    const t = setup()
    t.down('KeyQ')
    t.down('Space')
    expect(t.input.direction()).toBeNull()
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const e = t.down('KeyW', mod)
      expect(e.defaultPrevented, `shortcut ${JSON.stringify(mod)} is left to the browser`).toBe(false)
    }
    expect(t.input.direction()).toBeNull()
    expect(t.down('ArrowUp').defaultPrevented).toBe(true)
  })

  it('drops every held key when the window loses focus (no stuck keys)', () => {
    const t = setup()
    t.down('KeyW')
    t.down('KeyD')
    t.blur()
    expect(t.input.direction()).toBeNull()
  })

  it('returns a fresh object each call, so a caller cannot change the held state', () => {
    const t = setup()
    t.down('KeyW')
    const d = t.input.direction()!
    d.dz = 5
    expect(t.input.direction()).toEqual({ dx: 0, dz: 1 })
  })
})

// #36: the key-to-action half (client/src/input.ts ActionInput, #35). Space
// jumps, E climbs (attach, grab, mantle), C drops. One callback per press:
// auto-repeat and a second keydown before keyup are ignored, and Ctrl, Meta
// and Alt combinations are left to the browser. The e2e gate
// (e2e/m4-gate.spec.ts) checks the same on the wire.
function actions() {
  const target = new EventTarget()
  const sent: Action[] = []
  new ActionInput((a) => sent.push(a), target as unknown as Window)
  const key = (type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent(type, { code, cancelable: true, ...init })
    target.dispatchEvent(e)
    return e
  }
  return {
    sent,
    down: (code: string, init?: KeyboardEventInit) => key('keydown', code, init),
    up: (code: string) => key('keyup', code),
    press: (code: string, init?: KeyboardEventInit) => {
      const e = key('keydown', code, init)
      key('keyup', code)
      return e
    },
    blur: () => target.dispatchEvent(new Event('blur')),
  }
}

describe('ActionInput: action keys to one action per press', () => {
  it('binds exactly Space, E and C to jump, climb and drop, and every binding is a shared action', () => {
    expect({ ...ACTION_KEYS }).toEqual({ Space: 'jump', KeyE: 'climb', KeyC: 'drop' })
    expect(Object.isFrozen(ACTION_KEYS)).toBe(true)
    expect([...new Set(Object.values(ACTION_KEYS))].sort()).toEqual([...ACTIONS].sort())
  })

  it.each([
    ['Space', 'jump'],
    ['KeyE', 'climb'],
    ['KeyC', 'drop'],
  ] as const)('a press of %s sends %s once, and prevents the default (Space never scrolls)', (code, want) => {
    const t = actions()
    const e = t.down(code)
    expect(t.sent).toEqual([want])
    expect(e.defaultPrevented).toBe(true)
    t.up(code)
    expect(t.sent).toEqual([want])
  })

  it('sends one action per press: two presses send two, in order', () => {
    const t = actions()
    t.press('KeyE')
    t.press('KeyE')
    t.press('Space')
    t.press('KeyC')
    expect(t.sent).toEqual(['climb', 'climb', 'jump', 'drop'])
  })

  it('ignores auto-repeat: repeat keydowns and a second keydown before keyup send nothing more', () => {
    const t = actions()
    t.down('KeyE')
    const r1 = t.down('KeyE', { repeat: true })
    t.down('KeyE', { repeat: true })
    t.down('KeyE') // no repeat flag, but the key was never released
    expect(t.sent).toEqual(['climb'])
    expect(r1.defaultPrevented, 'repeats are still kept from the page').toBe(true)
    t.up('KeyE')
    t.down('KeyE')
    expect(t.sent).toEqual(['climb', 'climb'])
  })

  it('a repeat keydown with no earlier press sends nothing (a key held while the tab took focus)', () => {
    const t = actions()
    t.down('Space', { repeat: true })
    expect(t.sent).toEqual([])
  })

  it('keys are independent: holding E does not block C or Space', () => {
    const t = actions()
    t.down('KeyE')
    t.down('KeyC')
    t.down('Space')
    t.down('KeyE', { repeat: true })
    expect(t.sent).toEqual(['climb', 'drop', 'jump'])
  })

  it('ignores Ctrl, Meta and Alt combinations and leaves them to the browser; Shift is not a modifier here', () => {
    const t = actions()
    for (const code of ['Space', 'KeyE', 'KeyC']) {
      for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { ctrlKey: true, shiftKey: true }]) {
        const e = t.down(code, mod)
        expect(e.defaultPrevented, `${code} with ${JSON.stringify(mod)} is left to the browser`).toBe(false)
        t.up(code)
      }
    }
    expect(t.sent).toEqual([])
    // A modified press doesn't count as held, so the next plain press fires.
    t.down('KeyC', { ctrlKey: true })
    t.down('KeyC')
    expect(t.sent).toEqual(['drop'])
  })

  it('ignores other keys (movement keys, Enter, KeyQ, Digit1) and does not prevent them', () => {
    const t = actions()
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'Enter', 'KeyQ', 'Digit1', 'ShiftLeft']) {
      expect(t.down(code).defaultPrevented, code).toBe(false)
    }
    expect(t.sent).toEqual([])
  })

  it('matches by code, not by key: an E key event without code KeyE sends nothing', () => {
    const t = actions()
    const target = new EventTarget()
    const sent: Action[] = []
    new ActionInput((a) => sent.push(a), target as unknown as Window)
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: '', cancelable: true }))
    target.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Numpad0', cancelable: true }))
    expect(sent).toEqual([])
    expect(t.sent).toEqual([])
  })

  it('a blur releases held keys, so the next press after refocus fires', () => {
    const t = actions()
    t.down('KeyE')
    t.blur()
    t.down('KeyE')
    expect(t.sent).toEqual(['climb', 'climb'])
  })

  it('does not throw on inherited property names used as codes', () => {
    const t = actions()
    for (const code of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) t.down(code)
    expect(t.sent).toEqual([])
  })
})
