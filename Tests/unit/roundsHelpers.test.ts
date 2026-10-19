// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUND_SETTINGS, ROUND_EVENT } from '../../shared/protocol.js'
import { ROUND_FAST, ROUND_PRESETS, collectRoundEvents, roundOf, waitForPhase } from '../e2e/support/rounds'

// #67: the round helpers, and the rule that no round setting can come from a client.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

describe('rounds helpers', () => {
  it('ROUND_FAST matches the preset and is shorter than the defaults', () => {
    expect(ROUND_FAST).toEqual({ countdownMs: 2000, liveMs: 30000, endedMs: 3000, minPlayersPerTeam: 1 })
    expect(ROUND_FAST.liveMs).toBeLessThan(DEFAULT_ROUND_SETTINGS.liveMs)
    expect([...ROUND_PRESETS]).toEqual(['open', 'fast'])
  })

  it('roundOf is undefined before the server sends round state', () => {
    expect(roundOf({ state: {} } as never)).toBeUndefined()
    expect(roundOf({ state: undefined } as never)).toBeUndefined()
    const round = { phase: 'live', roundNumber: 1, secondsLeft: 5, winner: '', winReason: '' }
    expect(roundOf({ state: { round } } as never)).toBe(round)
  })

  it('collectRoundEvents records round events only, in order, until stopped', () => {
    const handlers = new Map<string, (m: unknown) => void>()
    let unsubscribed = false
    const room = {
      onMessage: (t: string, cb: (m: never) => void) => {
        handlers.set(t, cb as (m: unknown) => void)
        return () => void (unsubscribed = true)
      },
    }
    const got = collectRoundEvents(room)
    expect([...handlers.keys()]).toEqual([ROUND_EVENT])
    const send = handlers.get(ROUND_EVENT)!
    send({ phase: 'countdown', roundNumber: 1, winner: '', winReason: '' })
    send({ phase: 'live', roundNumber: 1, winner: '', winReason: '' })
    send(null)
    expect(got.phases()).toEqual(['countdown', 'live'])
    got.stop()
    send({ phase: 'ended', roundNumber: 1, winner: 'ghost', winReason: 'hacked' })
    expect(got.phases()).toEqual(['countdown', 'live'])
    expect(unsubscribed).toBe(true)
  })

  it('waitForPhase resolves when the phase arrives, and says what it saw on timeout', async () => {
    const state: { round?: { phase: string } } = {}
    const room = { state } as never
    setTimeout(() => (state.round = { phase: 'countdown' }), 40)
    setTimeout(() => (state.round = { phase: 'live' }), 120)
    await expect(waitForPhase(room, 'live', 2000)).resolves.toMatchObject({ phase: 'live' })
    await expect(waitForPhase(room, 'ended', 100)).rejects.toThrow(/ended not reached.*saw live/)
    await expect(waitForPhase({ state: {} } as never, 'live', 60)).rejects.toThrow(/no round state/)
  })
})

describe('no round setting is read in client/ or shared/ from location, the URL or a message', () => {
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const files = (dir: string): string[] => {
    const out: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(p)
      }
    }
    walk(join(ROOT, dir))
    return out
  }

  it('nothing mentions the preset variable', () => {
    for (const f of [...files('client/src'), ...files('shared')]) {
      expect(strip(readFileSync(f, 'utf8')), f).not.toMatch(/BLACKSITE_ROUND_PRESET/)
    }
  })

  it('no round setting name appears in a client or shared file that reads location or the URL', () => {
    const settings = /(countdownMs|liveMs|endedMs|minPlayersPerTeam|roundPreset|ROUND_PRESET)/
    for (const f of [...files('client/src'), ...files('shared')]) {
      const t = strip(readFileSync(f, 'utf8'))
      if (!settings.test(t)) continue
      expect(t, f).not.toMatch(/location\.|searchParams|URLSearchParams|document\.URL|import\.meta\.env/)
    }
  })

  it('shared/ never reads process or the environment', () => {
    for (const f of files('shared')) expect(strip(readFileSync(f, 'utf8')), f).not.toMatch(/\bprocess\.env\b/)
  })
})

