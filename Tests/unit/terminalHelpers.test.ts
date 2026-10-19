import { describe, expect, it } from 'vitest'
import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP } from '../../shared/map.js'
import { HACK_RANGE } from '../../shared/protocol.js'
import { collectProgress, distanceTo, terminalOf, terminalPlacement, terminalsOf } from '../e2e/support/terminal.ts'
import { GROUND_OBSTACLES, blocks, playerRect } from '../e2e/support/geometry.ts'

// The e2e helpers for M6 (#55), checked here so the server specs (#57 on) can trust them.

describe('terminalPlacement (e2e helper)', () => {
  for (const t of GRAYBOX_MAP.terminals) {
    it(`puts one point just inside and one just outside HACK_RANGE of ${t.id}, on clear ground`, () => {
      const p = terminalPlacement(t.id)
      expect(p.terminal.id).toBe(t.id)
      expect(distanceTo(p.inside, t)).toBeCloseTo(HACK_RANGE - 0.1, 9)
      expect(distanceTo(p.outside, t)).toBeCloseTo(HACK_RANGE + 0.1, 9)
      for (const pt of [p.inside, p.outside]) {
        expect(GROUND_OBSTACLES.filter((o) => blocks(o, playerRect(pt), 0)).map((o) => o.id)).toEqual([])
      }
    })
  }

  it('defaults to the active terminal and throws for an unknown id', () => {
    expect(terminalPlacement().terminal.id).toBe(ACTIVE_TERMINAL_ID)
    expect(() => terminalPlacement('nope')).toThrow(/no terminal nope/)
  })
})

describe('terminalsOf / collectProgress (e2e helpers)', () => {
  type Fake = Parameters<typeof terminalsOf>[0]
  const fake = (terminals?: Map<string, unknown>) => ({ state: { terminals } }) as unknown as Fake

  it('returns [] and undefined while the server sends no terminals', () => {
    expect(terminalsOf(fake())).toEqual([])
    expect(terminalOf(fake())).toBeUndefined()
  })

  it('reads id, status and alert, sorted by id', () => {
    const m = new Map<string, unknown>([
      ['terminal-b', { status: 'idle', alert: false }],
      ['terminal-a', { status: 'hacking', alert: true, extra: 1 }],
    ])
    expect(terminalsOf(fake(m))).toEqual([
      { id: 'terminal-a', status: 'hacking', alert: true },
      { id: 'terminal-b', status: 'idle', alert: false },
    ])
    expect(terminalOf(fake(m))?.status).toBe('hacking')
  })

  it('records hackProgress messages in order', () => {
    let handler: ((m: unknown) => void) | undefined
    const room = { onMessage: (t: string, h: (m: unknown) => void) => void (t === 'hackProgress' && (handler = h)) } as unknown as Fake
    const rec = collectProgress(room)
    handler?.({ progress: 0.1 })
    handler?.({ progress: 0.2 })
    expect(rec.progress).toEqual([{ progress: 0.1 }, { progress: 0.2 }])
  })
})
