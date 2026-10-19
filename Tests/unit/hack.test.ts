import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '../../client/node_modules/@babylonjs/core/Engines/nullEngine.js'
import { Scene } from '../../client/node_modules/@babylonjs/core/scene.js'
import type { StandardMaterial } from '../../client/node_modules/@babylonjs/core/Materials/standardMaterial.js'
import { INTERACT_KEYS, InteractInput } from '../../client/src/input.ts'
import { ALERT_TEXT, HACKED_TEXT, HACK_PROMPT, hackAlertText, hackBarText, hackPrompt, progressPercent, type TerminalSnapshot } from '../../client/src/hackHint.ts'
import { createTerminalView, terminalLook } from '../../client/src/terminalView.ts'
import { buildMap } from '../../client/src/map.ts'
import { installTestHook } from '../../client/src/testHook.ts'
import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP } from '../../shared/map.js'
import { HACK_RANGE } from '../../shared/protocol.js'
import type { BlacksiteTestHook } from '../../shared/testhook.js'

// #61: the M6 hack feedback of the client (#60, which added no tests): the
// hold-F input, the pure hint text rules, the terminal materials (NullEngine)
// and the test hook's terminals / hack fields. Browser side: e2e/hack.tabs.spec.ts.

const T = GRAYBOX_MAP.terminals.find((t) => t.id === ACTIVE_TERMINAL_ID)!
const OTHER = GRAYBOX_MAP.terminals.find((t) => t.id !== ACTIVE_TERMINAL_ID)!
const terms = (status: 'idle' | 'hacking' | 'hacked', alert = false): Map<string, TerminalSnapshot> =>
  new Map([[ACTIVE_TERMINAL_ID, { status, alert }]])
const at = (dx: number, over: object = {}) => ({ team: 'ghost' as const, mode: 'ground' as const, x: T.x + dx, y: 0, z: T.z, health: 100, ...over })

describe('InteractInput', () => {
  function setup(active = { on: true }) {
    const target = new EventTarget()
    const sent: boolean[] = []
    const input = new InteractInput(() => active.on, (a) => sent.push(a), target as unknown as Window)
    const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit = {}, code = 'KeyF') => {
      const e = new KeyboardEvent(type, { code, cancelable: true, ...init })
      target.dispatchEvent(e)
      return e
    }
    return { input, active, sent, key, blur: () => target.dispatchEvent(new Event('blur')) }
  }

  it('binds F only', () => {
    expect(INTERACT_KEYS).toEqual(['KeyF'])
    expect(Object.isFrozen(INTERACT_KEYS)).toBe(true)
  })

  it('hold sends true once, ignoring repeats and a second keydown, release sends false once', () => {
    const t = setup()
    t.key('keydown')
    t.key('keydown', { repeat: true })
    t.key('keydown')
    expect(t.sent).toEqual([true])
    t.key('keyup')
    t.key('keyup')
    expect(t.sent).toEqual([true, false])
    t.key('keydown')
    expect(t.sent).toEqual([true, false, true])
  })

  it('blur releases a hold; blur with no hold sends nothing', () => {
    const t = setup()
    t.blur()
    expect(t.sent).toEqual([])
    t.key('keydown')
    t.blur()
    expect(t.sent).toEqual([true, false])
  })

  it('other keys (E, R) send nothing', () => {
    const t = setup()
    t.key('keydown', {}, 'KeyE')
    t.key('keyup', {}, 'KeyE')
    expect(t.sent).toEqual([])
  })

  it('ctrl, meta and alt combinations are ignored and not prevented; plain F is prevented', () => {
    const t = setup()
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(t.key('keydown', init).defaultPrevented).toBe(false)
    }
    expect(t.sent).toEqual([])
    expect(t.key('keydown').defaultPrevented).toBe(true)
  })

  it('sends nothing while inactive (overhead, disconnected, eliminated, Warden), and a press made then does not resume', () => {
    const t = setup({ on: false })
    t.key('keydown')
    t.active.on = true
    t.input.sync()
    t.key('keyup')
    expect(t.sent).toEqual([])
  })

  it('sync() releases a hold that became inactive, once', () => {
    const t = setup()
    t.key('keydown')
    t.input.sync()
    expect(t.sent).toEqual([true])
    t.active.on = false
    t.input.sync()
    t.input.sync()
    t.key('keyup')
    expect(t.sent).toEqual([true, false])
  })
})

describe('hackPrompt', () => {
  it('shows for a living Ghost on the ground within HACK_RANGE, boundary included', () => {
    expect(hackPrompt(at(0), terms('idle'))).toBe(HACK_PROMPT)
    expect(hackPrompt(at(HACK_RANGE), terms('idle'))).toBe(HACK_PROMPT)
    expect(hackPrompt(at(HACK_RANGE + 0.01), terms('idle'))).toBe('')
  })
  it('is empty for a Warden, no team, no local player, other modes, the dead and a hacked terminal', () => {
    expect(hackPrompt(at(0, { team: 'warden' }), terms('idle'))).toBe('')
    expect(hackPrompt(at(0, { team: null }), terms('idle'))).toBe('')
    expect(hackPrompt(null, terms('idle'))).toBe('')
    expect(hackPrompt(at(0, { mode: 'ledge' }), terms('idle'))).toBe('')
    expect(hackPrompt(at(0, { health: 0 }), terms('idle'))).toBe('')
    expect(hackPrompt(at(0), terms('hacked'))).toBe('')
  })
  it('still shows while the terminal is hacking, and without terminal state', () => {
    expect(hackPrompt(at(0), terms('hacking'))).toBe(HACK_PROMPT)
    expect(hackPrompt(at(0), new Map())).toBe(HACK_PROMPT)
  })
})

describe('hackBarText', () => {
  it('Ghost: Hack N% rounded, clamped; empty at 0, before a message, or when not finite', () => {
    expect(hackBarText('ghost', 0.456, terms('hacking'))).toBe('Hack 46%')
    expect(hackBarText('ghost', 1, terms('hacking'))).toBe('Hack 100%')
    expect(hackBarText('ghost', 5, terms('hacking'))).toBe('Hack 100%')
    expect(hackBarText('ghost', -1, terms('hacking'))).toBe('')
    expect(hackBarText('ghost', 0, terms('hacking'))).toBe('')
    expect(hackBarText('ghost', 0.004, terms('hacking'))).toBe('')
    expect(hackBarText('ghost', null, terms('hacking'))).toBe('')
    expect(hackBarText('ghost', Number.NaN, terms('hacking'))).toBe('')
    expect(progressPercent(Number.POSITIVE_INFINITY)).toBe(0)
  })
  it('is empty once hacked', () => {
    expect(hackBarText('ghost', 1, terms('hacked'))).toBe('')
  })
  it('Warden and no team: never any text, whatever the progress', () => {
    for (const p of [null, 0, 0.5, 1]) {
      expect(hackBarText('warden', p, terms('hacking', true))).toBe('')
      expect(hackBarText(null, p, terms('hacking'))).toBe('')
    }
  })
})

describe('hackAlertText', () => {
  it('Warden sees Terminal alarm only while the alert flag is set', () => {
    expect(hackAlertText('warden', terms('hacking', true))).toBe(ALERT_TEXT)
    expect(ALERT_TEXT).toBe('Terminal alarm')
    expect(hackAlertText('warden', terms('hacking', false))).toBe('')
    expect(hackAlertText('warden', terms('idle'))).toBe('')
    expect(hackAlertText('warden', new Map())).toBe('')
  })
  it('a Ghost or unknown team never sees the alarm', () => {
    expect(hackAlertText('ghost', terms('hacking', true))).toBe('')
    expect(hackAlertText(null, terms('hacking', true))).toBe('')
  })
  it('everyone sees Terminal hacked once hacked, in place of the alarm', () => {
    expect(HACKED_TEXT).toBe('Terminal hacked')
    for (const team of ['ghost', 'warden', null] as const) expect(hackAlertText(team, terms('hacked', true))).toBe(HACKED_TEXT)
  })
  it('the texts name no position or direction', () => {
    expect(ALERT_TEXT + HACKED_TEXT + HACK_PROMPT).not.toMatch(/\d|north|south|east|west|left|right|behind/i)
  })
})

describe('terminal looks and materials', () => {
  it('terminalLook', () => {
    expect(terminalLook(ACTIVE_TERMINAL_ID, undefined)).toBe('active')
    expect(terminalLook(ACTIVE_TERMINAL_ID, 'hacking')).toBe('active')
    expect(terminalLook(ACTIVE_TERMINAL_ID, 'hacked')).toBe('hacked')
    expect(terminalLook(OTHER.id, 'hacked')).toBe('inactive')
    expect(terminalLook(OTHER.id, undefined)).toBe('inactive')
  })

  let engine: NullEngine
  let scene: Scene
  beforeEach(() => {
    engine = new NullEngine()
    scene = new Scene(engine)
  })
  afterEach(() => {
    scene.dispose()
    engine.dispose()
  })
  const mat = (id: string) => scene.getMeshByName(`terminal-${id}`)!.material as StandardMaterial

  it('active green, other dim, hacked amber; reset restores; unknown ids ignored', () => {
    buildMap(scene, GRAYBOX_MAP)
    const view = createTerminalView(scene)
    expect(mat(ACTIVE_TERMINAL_ID).name).toBe('terminalActiveMat')
    expect(mat(OTHER.id).name).toBe('terminalDimMat')
    view.update(ACTIVE_TERMINAL_ID, 'hacked')
    expect(mat(ACTIVE_TERMINAL_ID).name).toBe('terminalHackedMat')
    expect(mat(OTHER.id).name).toBe('terminalDimMat')
    view.update(OTHER.id, 'hacked')
    expect(mat(OTHER.id).name).toBe('terminalDimMat')
    view.update('nope', 'hacked')
    view.reset()
    expect(mat(ACTIVE_TERMINAL_ID).name).toBe('terminalActiveMat')
    const d = mat(ACTIVE_TERMINAL_ID).diffuseColor
    expect(d.g).toBeGreaterThan(d.r)
    const h = (view.update(ACTIVE_TERMINAL_ID, 'hacked'), mat(ACTIVE_TERMINAL_ID).diffuseColor)
    expect(h.r).toBeGreaterThan(h.b)
    // Rule 7: the dim terminal is not black.
    const o = mat(OTHER.id)
    expect(o.diffuseColor.r + o.diffuseColor.g + o.diffuseColor.b + o.emissiveColor.r + o.emissiveColor.g + o.emissiveColor.b).toBeGreaterThan(0.3)
  })
})

describe('test hook terminals and hack', () => {
  function setup() {
    const target = {} as Window
    const rec = installTestHook(target)
    return { rec, hook: (target as unknown as { __blacksite: BlacksiteTestHook }).__blacksite }
  }
  it('starts empty: no terminals, hack null', () => {
    const { hook } = setup()
    expect(hook.snapshot()).toMatchObject({ terminals: [], hack: null })
  })
  it('lists terminals sorted by id, updates in place, and reports the progress', () => {
    const { rec, hook } = setup()
    rec.setTerminal('terminal-b', 'idle', false)
    rec.setTerminal('terminal-a', 'hacking', true)
    rec.setTerminal('terminal-b', 'hacked', false)
    rec.setHackProgress(0.25)
    expect(hook.snapshot()).toMatchObject({
      terminals: [
        { id: 'terminal-a', status: 'hacking', alert: true, active: true },
        { id: 'terminal-b', status: 'hacked', alert: false, active: false },
      ],
      hack: { progress: 0.25 },
    })
  })
  it('clears both on disconnect, and the snapshot is a copy', () => {
    const { rec, hook } = setup()
    rec.setConnected('a')
    rec.setTerminal('terminal-a', 'idle', false)
    rec.setHackProgress(0.5)
    const s = hook.snapshot()
    s.terminals!.length = 0
    expect(hook.snapshot().terminals).toHaveLength(1)
    rec.setDisconnected()
    expect(hook.snapshot()).toMatchObject({ terminals: [], hack: null })
  })
})
