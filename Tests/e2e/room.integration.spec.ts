import { expect, test } from '@playwright/test'
import { Client, type Room } from '@colyseus/sdk'
import { MOVE_MESSAGE, ROOM_NAME, type GameRoomState, type PlayerState } from '../../shared/protocol.js'
// Built server constants (server/build exists: Playwright's webServer runs it).
import { BOUND, SPAWN_SPREAD, SPEED } from '../../server/build/rooms/MyRoom.js'

// Two real @colyseus/sdk clients (Node, no browser) against the production
// server that Playwright's webServer starts. This project runs before the
// browser project (see playwright.config.ts), so no browser page can
// joinOrCreate into these rooms and change the player counts.

const port = Number(process.env.E2E_PORT ?? 2567)
const endpoint = `ws://localhost:${port}`

/** Synced numbers are float32 on the wire. */
const EPS = 1e-4
/** Upper bound for a single state wait; a failure, never a delay. */
const WAIT_MS = 5_000

type GameRoom = Room<any, GameRoomState>

function pos(room: GameRoom, sessionId: string): PlayerState {
  const p = room.state.players.get(sessionId)
  if (!p) throw new Error(`player ${sessionId} missing from ${room.sessionId}'s state`)
  return { x: p.x, z: p.z }
}

/** Resolves once `predicate(room.state)` holds, checking now and on every state change. */
function waitForState(room: GameRoom, what: string, predicate: (s: GameRoomState) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (s: GameRoomState) => {
      let ok = false
      try {
        ok = !!s && predicate(s)
      } catch {
        ok = false
      }
      if (ok) {
        clearTimeout(timer)
        room.onStateChange.remove(check)
        resolve()
      }
    }
    const timer = setTimeout(() => {
      room.onStateChange.remove(check)
      reject(new Error(`timed out after ${WAIT_MS} ms waiting for: ${what}`))
    }, WAIT_MS)
    room.onStateChange(check)
    check(room.state)
  })
}

const sizeIs = (n: number) => (s: GameRoomState) => s.players?.size === n

/** A creates a fresh room, B joins it by id; both see 2 players. */
async function joinPair() {
  const a = (await new Client(endpoint).create(ROOM_NAME)) as GameRoom
  const b = (await new Client(endpoint).joinById(a.roomId)) as GameRoom
  await waitForState(a, 'A sees 2 players', sizeIs(2))
  await waitForState(b, 'B sees 2 players', sizeIs(2))
  return { a, b }
}

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => (r.connection.isOpen ? r.leave().catch(() => {}) : undefined)))
})

test('two clients join the same room, each sees 2 players keyed by sessionId near spawn', async () => {
  const { a, b } = await joinPair()
  open.push(a, b)
  expect(a.roomId).toBe(b.roomId)
  expect(a.sessionId).not.toBe(b.sessionId)

  for (const room of [a, b]) {
    for (const id of [a.sessionId, b.sessionId]) {
      const p = pos(room, id)
      expect(Math.abs(p.x)).toBeLessThanOrEqual(SPAWN_SPREAD + EPS)
      expect(Math.abs(p.z)).toBeLessThanOrEqual(SPAWN_SPREAD + EPS)
    }
  }
  // Both clients agree on both positions.
  for (const id of [a.sessionId, b.sessionId]) {
    expect(pos(a, id).x).toBeCloseTo(pos(b, id).x, 4)
    expect(pos(a, id).z).toBeCloseTo(pos(b, id).z, 4)
  }
})

test("A's move { dx: 1, dz: 0 } moves A by SPEED on x as seen by B, and not B", async () => {
  const { a, b } = await joinPair()
  open.push(a, b)
  const a0 = pos(b, a.sessionId)
  const b0 = pos(b, b.sessionId)

  a.send(MOVE_MESSAGE, { dx: 1, dz: 0 })
  await waitForState(b, "B sees A's x change", () => Math.abs(pos(b, a.sessionId).x - a0.x) > EPS)

  const a1 = pos(b, a.sessionId)
  expect(Math.abs(a1.x - (a0.x + SPEED))).toBeLessThan(EPS)
  expect(Math.abs(a1.z - a0.z)).toBeLessThan(EPS)
  const b1 = pos(b, b.sessionId)
  expect(Math.abs(b1.x - b0.x)).toBeLessThan(EPS)
  expect(Math.abs(b1.z - b0.z)).toBeLessThan(EPS)
})

test('malformed and out-of-range moves do not move A or disconnect it', async () => {
  const { a, b } = await joinPair()
  open.push(a, b)
  let aLeft: number | undefined
  a.onLeave((code) => (aLeft = code))
  const a0 = pos(b, a.sessionId)

  for (const payload of [{ dx: 'x' }, { dx: 'x', dz: 1 }, { dx: 1, dz: null }, {}, 'move', 42, [1, 1], null]) {
    a.send(MOVE_MESSAGE, payload as never)
  }
  // Messages from one client are handled in order. This sentinel moves only z,
  // so once B sees it, every malformed message above has been handled too.
  // x must be unchanged and z must have moved by exactly one SPEED.
  a.send(MOVE_MESSAGE, { dx: 0, dz: 1 })
  await waitForState(b, "B sees A's sentinel z move", () => Math.abs(pos(b, a.sessionId).z - a0.z) > EPS)

  let a1 = pos(b, a.sessionId)
  expect(Math.abs(a1.x - a0.x)).toBeLessThan(EPS)
  expect(Math.abs(a1.z - (a0.z + SPEED))).toBeLessThan(EPS)

  // Out-of-range input is clamped to -1..1: at most SPEED per message.
  a.send(MOVE_MESSAGE, { dx: -1000, dz: 0 })
  await waitForState(b, "B sees A's clamped x move", () => Math.abs(pos(b, a.sessionId).x - a0.x) > EPS)
  a1 = pos(b, a.sessionId)
  expect(Math.abs(a1.x - (a0.x - SPEED))).toBeLessThan(EPS)
  expect(Math.abs(a1.x)).toBeLessThanOrEqual(BOUND)

  expect(a.connection.isOpen).toBe(true)
  expect(aLeft).toBeUndefined()
})

test("closing A drops B's player count to 1", async () => {
  const { a, b } = await joinPair()
  open.push(b)
  const aId = a.sessionId

  await a.leave()
  await waitForState(b, 'B sees 1 player', sizeIs(1))
  expect(b.state.players.get(aId)).toBeUndefined()
  expect(b.state.players.get(b.sessionId)).toBeDefined()
})
