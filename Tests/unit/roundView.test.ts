// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { ROUND_PHASES, ROUND_WIN_REASONS } from '../../shared/protocol.js'
import { installTestHook } from '../../client/src/testHook.ts'
import { watchRound } from '../../client/src/net.ts'
import {
  COUNTDOWN_BIG_SECONDS,
  RESULT_REASON_TEXT,
  WAITING_TEXT,
  bannerIsBig,
  bannerText,
  isFrozen,
  resultClass,
  resultText,
  timerText,
  type RoundView,
} from '../../client/src/roundView.ts'
import type { BlacksiteTestHook } from '../../shared/testhook.js'

// The round UI rules of #72, verified in #73. The browser side is in
// e2e/round.rounds.tabs.spec.ts.

const r = (o: Partial<RoundView> = {}): RoundView => ({ phase: 'live', roundNumber: 1, secondsLeft: 0, winner: '', winReason: '', ...o })

describe('timerText', () => {
  it('formats M:SS in countdown and live', () => {
    expect(timerText(r({ secondsLeft: 420 }))).toBe('7:00')
    expect(timerText(r({ secondsLeft: 60 }))).toBe('1:00')
    expect(timerText(r({ secondsLeft: 59 }))).toBe('0:59')
    expect(timerText(r({ secondsLeft: 9 }))).toBe('0:09')
    expect(timerText(r({ secondsLeft: 1 }))).toBe('0:01')
    expect(timerText(r({ phase: 'countdown', secondsLeft: 10 }))).toBe('0:10')
    expect(timerText(r({ secondsLeft: 61 }))).toBe('1:01')
  })
  it('rounds down to whole seconds and treats junk as nothing', () => {
    expect(timerText(r({ secondsLeft: 59.9 }))).toBe('0:59')
    expect(timerText(r({ secondsLeft: 0.9 }))).toBe('')
    expect(timerText(r({ secondsLeft: -5 }))).toBe('')
    expect(timerText(r({ secondsLeft: Number.NaN }))).toBe('')
    expect(timerText(r({ secondsLeft: Number.POSITIVE_INFINITY }))).toBe('')
  })
  it('is empty with no state, with 0 seconds (open preset), in waiting and in ended', () => {
    expect(timerText(null)).toBe('')
    expect(timerText(r({ secondsLeft: 0 }))).toBe('')
    expect(timerText(r({ phase: 'waiting', secondsLeft: 30 }))).toBe('')
    expect(timerText(r({ phase: 'ended', secondsLeft: 8 }))).toBe('')
  })
})

describe('bannerText and bannerIsBig', () => {
  it('shows waiting, countdown and nothing else', () => {
    expect(bannerText(r({ phase: 'waiting' }))).toBe(WAITING_TEXT)
    expect(WAITING_TEXT).toBe('Waiting for players')
    expect(bannerText(r({ phase: 'countdown', roundNumber: 3, secondsLeft: 7 }))).toBe('Round 3 starts in 7')
    expect(bannerText(r({ phase: 'countdown', roundNumber: 1, secondsLeft: 2.6 }))).toBe('Round 1 starts in 2')
    expect(bannerText(r({ phase: 'live', secondsLeft: 100 }))).toBe('')
    expect(bannerText(r({ phase: 'ended', winner: 'ghost', winReason: 'hacked' }))).toBe('')
    expect(bannerText(null)).toBe('')
  })
  it('is big only for the last 1 to 3 seconds of a countdown', () => {
    expect(COUNTDOWN_BIG_SECONDS).toBe(3)
    const big = (phase: RoundView['phase'], s: number) => bannerIsBig(r({ phase, secondsLeft: s }))
    expect(big('countdown', 4)).toBe(false)
    expect(big('countdown', 3)).toBe(true)
    expect(big('countdown', 2)).toBe(true)
    expect(big('countdown', 1)).toBe(true)
    expect(big('countdown', 1.4)).toBe(true)
    expect(big('countdown', 0.5)).toBe(false)
    expect(big('countdown', 0)).toBe(false)
    expect(big('live', 2)).toBe(false)
    expect(big('waiting', 2)).toBe(false)
    expect(bannerIsBig(null)).toBe(false)
  })
})

describe('resultText and resultClass', () => {
  const ended = (winner: RoundView['winner'], winReason: RoundView['winReason'], secondsLeft = 8): RoundView =>
    r({ phase: 'ended', winner, winReason, secondsLeft })

  it('has a headline for every win reason', () => {
    expect(Object.keys(RESULT_REASON_TEXT).sort()).toEqual([...ROUND_WIN_REASONS].sort())
    expect(resultText(ended('ghost', 'hacked'), 'ghost')).toBe('Ghosts win: terminal hacked\nYou win\nNext round in 8')
    expect(resultText(ended('warden', 'ghosts_eliminated'), 'warden')).toBe('Wardens win: all Ghosts eliminated\nYou win\nNext round in 8')
    expect(resultText(ended('warden', 'time_out'), 'ghost')).toBe('Wardens win: time ran out\nYou lose\nNext round in 8')
  })
  it('says You win or You lose from the local team, and nothing without one', () => {
    expect(resultText(ended('ghost', 'hacked'), 'warden')).toContain('You lose')
    expect(resultText(ended('ghost', 'hacked'), 'ghost')).toContain('You win')
    const none = resultText(ended('ghost', 'hacked'), null)
    expect(none).not.toMatch(/You (win|lose)/)
    expect(none).toBe('Ghosts win: terminal hacked\nNext round in 8')
  })
  it('omits the next-round line when no seconds are left', () => {
    expect(resultText(ended('ghost', 'hacked', 0), 'ghost')).toBe('Ghosts win: terminal hacked\nYou win')
    expect(resultText(ended('ghost', 'hacked', Number.NaN), 'ghost')).not.toContain('Next round')
  })
  it('is empty outside ended and after an abort (no winner or no reason)', () => {
    for (const phase of ROUND_PHASES.filter((p) => p !== 'ended')) {
      expect(resultText(r({ phase: phase as RoundView['phase'], winner: 'ghost', winReason: 'hacked', secondsLeft: 5 }), 'ghost')).toBe('')
    }
    expect(resultText(ended('', ''), 'ghost')).toBe('')
    expect(resultText(ended('ghost', ''), 'ghost')).toBe('')
    expect(resultText(ended('', 'hacked'), 'ghost')).toBe('')
    expect(resultText(null, 'ghost')).toBe('')
    expect(resultText(ended('ghost', 'bogus' as RoundView['winReason']), 'ghost')).toBe('')
  })
  it('classes the overlay by the winning team only in ended with a reason', () => {
    expect(resultClass(ended('ghost', 'hacked'))).toBe('ghost')
    expect(resultClass(ended('warden', 'time_out'))).toBe('warden')
    expect(resultClass(ended('', ''))).toBe('')
    expect(resultClass(r({ phase: 'live', winner: 'ghost', winReason: 'hacked' }))).toBe('')
    expect(resultClass(null)).toBe('')
  })
})

describe('isFrozen', () => {
  it('is frozen in every phase but live, and not frozen before state arrives', () => {
    expect(isFrozen({ phase: 'waiting' })).toBe(true)
    expect(isFrozen({ phase: 'countdown' })).toBe(true)
    expect(isFrozen({ phase: 'ended' })).toBe(true)
    expect(isFrozen({ phase: 'live' })).toBe(false)
    expect(isFrozen(null)).toBe(false)
    expect(ROUND_PHASES.filter((p) => isFrozen({ phase: p as RoundView['phase'] }))).toEqual(['waiting', 'countdown', 'ended'])
  })
})

describe('watchRound (state.round to the view)', () => {
  function fakeRoom(round: unknown) {
    const room = {
      state: { round } as { round?: unknown } | undefined,
      cb: null as null | (() => void),
      onStateChange(f: () => void) {
        room.cb = f
      },
    }
    return room
  }
  it('reads at once, then on every state change, and validates fields', () => {
    const room = fakeRoom({ phase: 'countdown', roundNumber: 2, secondsLeft: 4, winner: '', winReason: '' })
    const seen: RoundView[] = []
    watchRound(room as never, (v) => seen.push(v))
    expect(seen).toEqual([{ phase: 'countdown', roundNumber: 2, secondsLeft: 4, winner: '', winReason: '' }])
    room.state!.round = { phase: 'ended', roundNumber: 2, secondsLeft: 3, winner: 'warden', winReason: 'time_out', extra: 1 }
    room.cb!()
    expect(seen[1]).toEqual({ phase: 'ended', roundNumber: 2, secondsLeft: 3, winner: 'warden', winReason: 'time_out' })
    room.state!.round = { phase: 'ended', roundNumber: 'x', secondsLeft: Number.NaN, winner: 'nobody', winReason: 'cheated' }
    room.cb!()
    expect(seen[2]).toEqual({ phase: 'ended', roundNumber: 0, secondsLeft: 0, winner: '', winReason: '' })
  })
  it('ignores a missing round, a non-object and an unknown phase', () => {
    const room = fakeRoom(undefined)
    const fn = vi.fn()
    watchRound(room as never, fn)
    room.cb!()
    room.state!.round = 'live'
    room.cb!()
    room.state!.round = { phase: 'bogus', roundNumber: 1, secondsLeft: 1, winner: '', winReason: '' }
    room.cb!()
    room.state = undefined
    room.cb!()
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('the test hook round field', () => {
  function setup() {
    const target = {} as Window
    const rec = installTestHook(target)
    const hook = (target as unknown as { __blacksite: BlacksiteTestHook }).__blacksite
    return { rec, hook }
  }
  it('is absent before state, safe to read, and a copy once set', () => {
    const { rec, hook } = setup()
    expect(hook.snapshot().round).toBeUndefined()
    expect('round' in hook.snapshot()).toBe(false)
    const v = r({ phase: 'countdown', roundNumber: 1, secondsLeft: 2 })
    rec.setRound(v)
    const s = hook.snapshot()
    expect(s.round).toEqual({ phase: 'countdown', roundNumber: 1, secondsLeft: 2, winner: '', winReason: '' })
    s.round!.phase = 'live'
    v.secondsLeft = 99
    expect(hook.snapshot().round).toMatchObject({ phase: 'countdown', secondsLeft: 2 })
    expect(hook.snapshot().version).toBe(1)
  })
  it('follows each phase and is cleared on disconnect and on setRound(null)', () => {
    const { rec, hook } = setup()
    for (const phase of ROUND_PHASES) {
      rec.setRound(r({ phase: phase as RoundView['phase'], roundNumber: 4 }))
      expect(hook.snapshot().round?.phase).toBe(phase)
    }
    rec.setRound(null)
    expect(hook.snapshot().round).toBeUndefined()
    rec.setRound(r({ phase: 'ended', winner: 'ghost', winReason: 'hacked' }))
    rec.setConnected('me')
    rec.setDisconnected()
    expect(hook.snapshot().round).toBeUndefined()
    expect(hook.snapshot().connected).toBe(false)
  })
})

describe('client sources', () => {
  const ROOT = fileURLToPath(new URL('../../', import.meta.url))
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const main = strip(readFileSync(join(ROOT, 'client/src/main.ts'), 'utf8'))

  it('keeps the existing element ids and adds the three round ones', () => {
    for (const id of ['hud', 'mode', 'health', 'ammo', 'crosshair', 'hack-prompt', 'hack-bar', 'hack-alert', 'climb-prompt', 'camera-hint', 'round-timer', 'round-banner', 'round-result']) {
      expect(main, id).toContain(`'${id}'`)
    }
  })
  it('gates every send on the freeze and keeps the interact release', () => {
    expect(main).toMatch(/if \(room && !frozen\(\)\) sendAction/)
    expect(main).toMatch(/if \(room && !frozen\(\)\) sendReload/)
    expect(main).toMatch(/const interactActive[\s\S]*?!frozen\(\)/)
    expect(main).toMatch(/const combatActive[\s\S]*?!frozen\(\)/)
    expect(main).toMatch(/if \(!room \|\| frozen\(\)\) return/)
    expect(main).toMatch(/interactInput\.sync\(\)/)
  })
  it('reads no round setting from location, the URL, a message or the environment', () => {
    for (const f of ['roundView.ts', 'net.ts', 'main.ts', 'testHook.ts']) {
      const t = strip(readFileSync(join(ROOT, 'client/src', f), 'utf8'))
      expect(t, f).not.toMatch(/PRESET|countdownMs|liveMs|endedMs|minPlayersPerTeam|DEFAULT_ROUND_SETTINGS/)
      expect(t, f).not.toMatch(/(URLSearchParams|searchParams|import\.meta\.env)[^\n]*round/i)
      expect(t, f).not.toMatch(/round[^\n]*(URLSearchParams|searchParams|import\.meta\.env)/i)
    }
  })
})
