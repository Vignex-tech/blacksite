import { expect, test } from '@playwright/test'
import { Client } from '@colyseus/sdk'
import { MOVE_MESSAGE, ROOM_NAME } from '../../shared/protocol.js'
import { collectRoundEvents, roundOf, roundPlain } from './support/rounds.js'
import { endpoint, leaveQuietly, waitForState, type GameRoom } from './support/sdk.js'

// Spot check of the `open` preset on the main test server (port 2567, #69): a
// fresh room is `live` at once, with no countdown and no timer, and nothing
// ever ends it. Every other spec relies on this. Added wall time: about 3 s
// in the integration shard (parallel with its other specs).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('on the open server a fresh room is live at once and never ends', async () => {
  const open: GameRoom[] = []
  const g = (await new Client(endpoint).create(ROOM_NAME)) as GameRoom
  open.push(g)
  await waitForState(g, 'sees itself', (s) => !!s.players?.has(g.sessionId))
  const events = collectRoundEvents(g)
  const first = roundPlain(roundOf(g)!)
  // A lone Ghost can move at once.
  const z0 = (g.state.players.get(g.sessionId) as any).z as number
  g.send(MOVE_MESSAGE, { dx: 0, dz: 1, yaw: 0 })
  await waitForState(g, 'the lone Ghost moves', (s) => ((s.players.get(g.sessionId) as any).z as number) > z0 + 0.05)
  const w = (await new Client(endpoint).joinById(g.roomId)) as GameRoom
  open.push(w)
  await waitForState(w, 'warden sees itself', (s) => !!s.players?.has(w.sessionId))
  await sleep(3000)
  const later = [roundPlain(roundOf(g)!), roundPlain(roundOf(w)!)]
  const phases = events.phases()
  const wHealth = (w.state.players.get(w.sessionId) as any).health as number
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(first).toEqual({ phase: 'live', roundNumber: 0, secondsLeft: 0, winner: '', winReason: '' })
  for (const r of later) expect(r).toEqual({ phase: 'live', roundNumber: 0, secondsLeft: 0, winner: '', winReason: '' })
  expect(phases, 'no phase change is ever announced').toEqual([])
  expect(wHealth, 'a joiner in an open room is not sat out').toBeGreaterThan(0)
})
