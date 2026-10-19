import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIRE_BINDINGS, FireInput } from '../../client/src/input.ts'
import { FirePacer } from '../../client/src/firePacer.ts'
import { WEAPONS } from '../../shared/protocol.js'
import { decodeRoomMessage } from '../e2e/support/frames.ts'

// #51: the fire and reload input of the client (client/src/input.ts FireInput,
// client/src/firePacer.ts, #50). #50 added no unit tests for them. The 20 Hz
// tick in client/src/main.ts needs a browser; its pitch sign is checked on the
// wire in e2e/m5-gate.spec.ts and, here, on the source and the frame decoder.

function setup(active: { on: boolean } = { on: true }) {
  const target = new EventTarget()
  let reloads = 0
  const input = new FireInput(
    () => active.on,
    () => reloads++,
    target as unknown as Window,
  )
  const mouse = (type: 'mousedown' | 'mouseup', button = 0) => target.dispatchEvent(new MouseEvent(type, { button, cancelable: true }))
  const key = (type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent(type, { code, cancelable: true, ...init })
    target.dispatchEvent(e)
    return e
  }
  return {
    input,
    active,
    reloads: () => reloads,
    down: (b = 0) => mouse('mousedown', b),
    up: (b = 0) => mouse('mouseup', b),
    keyDown: (init?: KeyboardEventInit, code: string = FIRE_BINDINGS.reloadKey) => key('keydown', code, init),
    keyUp: (code: string = FIRE_BINDINGS.reloadKey) => key('keyup', code),
    blur: () => target.dispatchEvent(new Event('blur')),
  }
}

describe('FIRE_BINDINGS', () => {
  it('is left mouse and R', () => {
    expect(FIRE_BINDINGS).toEqual({ fireButton: 0, reloadKey: 'KeyR' })
    expect(Object.isFrozen(FIRE_BINDINGS)).toBe(true)
  })
})

describe('FireInput: left mouse fires only while active', () => {
  it('is not firing before any press', () => {
    expect(setup().input.firing()).toBe(false)
  })

  it('the press made while not active (the click that locks the pointer) never fires, even if the lock arrives before the release', () => {
    const t = setup({ on: false })
    t.down()
    expect(t.input.firing()).toBe(false)
    t.active.on = true
    expect(t.input.firing()).toBe(false)
    t.up()
    expect(t.input.firing()).toBe(false)
  })

  it('a press while active fires until the button is released', () => {
    const t = setup()
    t.down()
    expect(t.input.firing()).toBe(true)
    expect(t.input.firing()).toBe(true)
    t.up()
    expect(t.input.firing()).toBe(false)
  })

  it.each([1, 2])('mouse button %i does not fire', (b) => {
    const t = setup()
    t.down(b)
    expect(t.input.firing()).toBe(false)
  })

  it('releasing another button does not stop the fire button', () => {
    const t = setup()
    t.down()
    t.up(2)
    expect(t.input.firing()).toBe(true)
  })

  it('does nothing when inactive (overhead mode, disconnected or eliminated)', () => {
    const t = setup({ on: false })
    t.down()
    t.keyDown()
    t.keyUp()
    expect(t.input.firing()).toBe(false)
    expect(t.reloads()).toBe(0)
  })

  it('stops when input goes inactive mid-hold (lock lost, died) and needs a fresh press', () => {
    const t = setup()
    t.down()
    expect(t.input.firing()).toBe(true)
    t.active.on = false
    expect(t.input.firing()).toBe(false)
    t.active.on = true
    expect(t.input.firing()).toBe(false)
    t.up()
    t.down()
    expect(t.input.firing()).toBe(true)
  })

  it('a blur clears the held button', () => {
    const t = setup()
    t.down()
    t.blur()
    expect(t.input.firing()).toBe(false)
  })
})

describe('FireInput: R reloads once per press', () => {
  it('one reload per press, none for auto-repeat or a second keydown before the keyup', () => {
    const t = setup()
    t.keyDown()
    t.keyDown({ repeat: true })
    t.keyDown({ repeat: true })
    t.keyDown()
    expect(t.reloads()).toBe(1)
    t.keyUp()
    t.keyDown()
    expect(t.reloads()).toBe(2)
  })

  it('prevents default on R but not on other keys', () => {
    const t = setup()
    expect(t.keyDown().defaultPrevented).toBe(true)
    t.keyUp()
    const other = t.keyDown({}, 'KeyQ')
    expect(other.defaultPrevented).toBe(false)
    expect(t.reloads()).toBe(1)
  })

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])('%o + R is ignored and not prevented (Ctrl+R is the browser refresh)', (init) => {
    const t = setup()
    const e = t.keyDown(init)
    expect(e.defaultPrevented).toBe(false)
    expect(t.reloads()).toBe(0)
    t.keyUp()
    t.keyDown()
    expect(t.reloads()).toBe(1)
  })

  it('sends nothing while inactive, and a press that began inactive does not reload later', () => {
    const t = setup({ on: false })
    t.keyDown()
    expect(t.reloads()).toBe(0)
    t.active.on = true
    t.keyDown({ repeat: true })
    expect(t.reloads()).toBe(0)
    t.keyUp()
    t.keyDown()
    expect(t.reloads()).toBe(1)
  })

  it('a blur lets the next press count again', () => {
    const t = setup()
    t.keyDown()
    t.blur()
    t.keyDown()
    expect(t.reloads()).toBe(2)
  })

  it('no handler throws when inactive', () => {
    const t = setup({ on: false })
    expect(() => {
      t.down()
      t.up()
      t.keyDown()
      t.keyUp()
      t.blur()
      t.input.firing()
    }).not.toThrow()
  })
})

describe('FirePacer: fire messages follow the weapon interval', () => {
  it.each(['ghost', 'warden'] as const)('%s: one message per interval, no more', (team) => {
    const iv = WEAPONS[team].intervalMs
    const p = new FirePacer()
    expect(p.due(1000, team)).toBe(true)
    expect(p.due(1000 + iv - 1, team)).toBe(false)
    expect(p.due(1000 + iv, team)).toBe(true)
    expect(p.due(1000 + iv + 1, team)).toBe(false)
  })

  it('a 20 Hz tick over 3 s never sends more than the weapon allows, and sends close to it', () => {
    for (const team of ['ghost', 'warden'] as const) {
      const p = new FirePacer()
      let sent = 0
      for (let t = 0; t <= 3000; t += 50) if (p.due(t, team)) sent++
      const iv = WEAPONS[team].intervalMs
      expect(sent).toBeLessThanOrEqual(Math.floor(3000 / iv) + 1)
      expect(sent).toBeGreaterThanOrEqual(Math.floor(3000 / (Math.ceil(iv / 50) * 50)))
    }
  })

  it('a message that is not due is not recorded: the interval counts from the last sent one', () => {
    const p = new FirePacer()
    p.due(0, 'warden')
    p.due(100, 'warden')
    expect(p.due(150, 'warden')).toBe(true)
  })

  it('uses the team of the call: the Ghost weapon is slower than the Warden rifle', () => {
    const p = new FirePacer()
    p.due(0, 'ghost')
    expect(p.due(WEAPONS.warden.intervalMs, 'ghost')).toBe(false)
    expect(WEAPONS.ghost.intervalMs).toBeGreaterThan(WEAPONS.warden.intervalMs)
  })
})

describe('fire message on the wire: yaw and pitch only, pitch positive up', () => {
  const f64 = (v: number) => {
    const b = new Uint8Array(9)
    b[0] = 0xcb
    new DataView(b.buffer).setFloat64(1, v)
    return [...b]
  }
  const str = (s: string) => [0xa0 | s.length, ...new TextEncoder().encode(s)]
  const fireFrame = (yaw: number, pitch: number) => Uint8Array.from([0x0d, ...str('fire'), 0x82, ...str('yaw'), ...f64(yaw), ...str('pitch'), ...f64(pitch)])

  it('the decoder reads a fire frame with exactly the keys yaw and pitch', () => {
    const m = decodeRoomMessage(fireFrame(1.5, -0.25))
    expect(m).toEqual({ type: 'fire', payload: { yaw: 1.5, pitch: -0.25 } })
    expect(Object.keys(m!.payload as object).sort()).toEqual(['pitch', 'yaw'])
  })

  it('reads an empty reload payload', () => {
    expect(decodeRoomMessage(Uint8Array.from([0x0d, ...str('reload'), 0x80]))).toEqual({ type: 'reload', payload: {} })
  })

  it('main.ts sends the camera pitch negated (the camera is positive down, the wire positive up)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src', 'main.ts'), 'utf8')
    expect(src).toMatch(/sendFire\(\s*room\s*,\s*rig\.yaw\s*,\s*-\s*rig\.pitch\s*\)/)
  })
})
