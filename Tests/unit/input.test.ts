import { describe, expect, it } from 'vitest'
import { MovementInput } from '../../client/src/input.ts'

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
