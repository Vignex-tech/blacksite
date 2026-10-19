import { expect, test } from '@playwright/test'
import { ACTION_MESSAGE, FIRE_MESSAGE, MOVE_MESSAGE, RELOAD_MESSAGE, VISIBILITY_NEAR } from '../../shared/protocol.js'
import { EPS, Walker, godView, leaveQuietly, mustSee, pos, teamOf, waitForState, whenGone, whenVisible, type GameRoom } from './support/sdk.js'
import { feetY } from './support/geometry.js'
import { scanFrames, searchable, type Frame } from './support/scan.js'
import { track, type Sample } from './support/track.js'
import { centreOf, eyeOf, hasLineOfSight, visibilityOf, type Body } from './support/visibility.js'
import { framesOf, joinWire } from './support/wire.js'

// The M5 visibility filter (#46), verified in state and on the wire (#47).
// Decision 11 on #38: a Warden client is sent a Ghost only if the Ghost is
// within VISIBILITY_NEAR (box centres) or a straight line from the Warden's eye
// to a sample point of the Ghost's box is not blocked; a Ghost client is sent
// everyone; every client gets itself and its teammates.
//
// "On the wire": every client here is a WireClient (support/wire.ts) that keeps
// the raw frames it received, and support/scan.ts searches them for the hidden
// Ghost's session id and for its coordinates as float32 and float64, both byte
// orders. A scan only covers frames received while the Ghost was hidden for a
// while (a window starts 250 ms after the Warden's decoded state lost the
// Ghost, so the step in which it left sight is not counted: the one-step leak
// accepted on #47). Each scan has a positive control: the same search finds the
// id and the coordinates in the frames of a client that was sent the Ghost.
//
// Placements are only 'visible' or 'hidden' by visibilityOf (support/
// visibility.ts), never grazing cases. Coordinates are not round numbers, so a
// float32 pattern can't match unrelated bytes (scan.ts `searchable`).
//
// Per Docs/handoff.md: problems are collected in arrays and asserted once,
// after the SDK clients have left; spawns are random, so every test reads the
// positions it was given; headless timing is the real 20 Hz.

test.describe.configure({ mode: 'parallel' })

const open: GameRoom[] = []
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Longer than one 50 ms step plus a patch: after this a client holds what the filter allows. */
const SETTLE_MS = 250

interface Flag {
  t: number
  has: boolean
}

/** Whether `room`'s state holds player `id`, recorded on every state change. */
function watchHas(room: GameRoom, id: string): Flag[] {
  const flags: Flag[] = []
  const take = () => flags.push({ t: Date.now(), has: room.state.players.has(id) })
  room.onStateChange(take)
  take()
  return flags
}

const bodyOf = (s: Sample): Body => ({ x: s.x, y: s.y, z: s.z })

/** The sample in force at time `t` (the last one at or before it). */
function at(samples: Sample[], t: number): Sample {
  let out = samples[0]
  for (const s of samples) if (s.t <= t) out = s
  return out
}

/**
 * Everything one hidden stretch needs to be judged after the clients left:
 * the Ghost's own samples, the Warden's, what the Warden's state held, and the
 * Warden's raw frames.
 */
interface Watch {
  gid: string
  ghost: Sample[]
  warden: Sample[]
  has: Flag[]
  frames: Frame[]
}

/**
 * Problems in the stretch `from`..`to` (Node time) for a Ghost that must stay
 * hidden: a sample the helper calls 'visible' (a bad placement), a state that
 * held the Ghost, and any trace of its id or coordinates in the raw frames.
 * Also returns how many distinct coordinates were searched, so a test can
 * require that the scan was not vacuous.
 */
function hiddenProblems(name: string, w: Watch, from: number, to: number): { problems: string[]; searched: number } {
  const problems: string[] = []
  // Samples are only recorded when the position changes: a still Ghost is the sample in force at `from`.
  const inside = [at(w.ghost, from), ...w.ghost.filter((s) => s.t > from && s.t <= to)]
  if (inside.length === 0) problems.push(`${name}: no Ghost sample in the window`)
  for (const s of inside) {
    if (visibilityOf(bodyOf(at(w.warden, s.t)), bodyOf(s)) === 'visible') problems.push(`${name}: bad placement, ${s.x},${s.y},${s.z} is visible to the Warden`)
  }
  for (const f of w.has) if (f.t >= from && f.t <= to && f.has) problems.push(`${name}: the Warden's decoded state held the Ghost at ${f.t - from} ms`)

  // Coordinates the Warden may legitimately have been sent (samples taken while it held the Ghost), and its own.
  const legit = new Set<number>()
  for (const s of w.ghost) if (w.has.some((f) => f.has && Math.abs(f.t - s.t) < 200)) for (const v of [s.x, s.y, s.z]) legit.add(v)
  for (const s of w.warden) for (const v of [s.x, s.y, s.z]) legit.add(v)
  const values = [...new Set(inside.flatMap((s) => [s.x, s.y, s.z]))].filter((v) => !legit.has(v) && searchable(v))
  const hits = scanFrames(w.frames, { ids: [w.gid], values, from, to })
  for (const h of hits.slice(0, 5)) problems.push(`${name}: the Warden received ${h.what} at ${h.t - from} ms`)
  return { problems, searched: values.length }
}

/** True if `a` and `b` (a player as two clients hold it) agree on x, y and z within EPS. */
function sameSpot(a: unknown, b: unknown): boolean {
  const p = a as { x: number; y?: number; z: number } | undefined
  const q = b as { x: number; y?: number; z: number } | undefined
  return !!p && !!q && Math.abs(p.x - q.x) < EPS && Math.abs(feetY(p) - feetY(q)) < EPS && Math.abs(p.z - q.z) < EPS
}

/** Resolves once `viewer` holds player `id` at exactly the spot `owner` (that player's own client) reports. */
function sameAsOwn(viewer: GameRoom, owner: GameRoom, id: string) {
  return waitForState(viewer, `${viewer.sessionId} holds ${id} where ${id} says it is`, (s) => sameSpot(s.players.get(id), owner.state.players.get(id)))
}

// Not round numbers (scan.ts), clear of every obstacle, chosen from the map:
// the south wall is z -8..-7.5 with a doorway at x -1.5..1.5.
const WX = 2.65 // the Warden's x: clear of cover-low-wall (x <= 2) and pillar-ne (x >= 4.5)
const GZ = -14.21 // the Ghost's z in the south yard
const BEHIND = { x: 6.13, z: GZ } // behind the south wall for every Warden at x = WX, z 2..5
const EAST = { x: 11.47, z: GZ } // behind the south wall and the east wall
const NEAR_W_Z = -6.9 // the Warden flush inside the south wall
const NEAR_G_Z = -8.6 // the Ghost flush outside it: 1.7 from the Warden, a wall between
const FAR_G_Z = -9.4 // 2.5 from the Warden, the same wall between

test('south wall: hidden at spawn and behind the wall, appears on the doorway line, hidden again, shown within VISIBILITY_NEAR behind a wall; its id and coordinates never reach the Warden while hidden', async () => {
  test.setTimeout(90_000)
  const [g, w] = await joinWire(2, open)
  const gid = g.sessionId
  const wid = w.sessionId
  const gw = new Walker(g, 'ghost', { ground: false })
  const ww = new Walker(w, 'warden', { ground: false })
  const ghost = track(g, gid)
  const warden = track(w, wid)
  const wHas = watchHas(w, gid) // the Warden's view of the Ghost
  const gHas = watchHas(g, wid) // the Ghost's view of the Warden
  const watch: Watch = { gid, ghost: ghost.samples, warden: warden.samples, has: wHas, frames: framesOf(w) }
  const facts: string[] = []
  const wardenAtSpawn = { ...pos(g, wid) }
  const ghostAtSpawn = { ...pos(g, gid) }

  // Spawn: the Ghost is outside, the Warden inside. Spawns are random, so what the Warden holds must match the helper when it is sure.
  await sleep(SETTLE_MS)
  const spawnClass = visibilityOf(wardenAtSpawn, ghostAtSpawn)
  const spawnHeld = w.state.players.has(gid)
  if (spawnClass === 'hidden') {
    if (spawnHeld) facts.push('spawn: hidden Ghost held by the Warden')
    for (const h of scanFrames(framesOf(w), { ids: [gid], values: [ghostAtSpawn.x, ghostAtSpawn.z] })) facts.push(`spawn: the Warden received ${h.what}`)
  } else if (spawnClass === 'visible' && !spawnHeld) facts.push('spawn: visible Ghost not held by the Warden')

  // The Warden steps to x = WX (z kept); the Ghost goes behind the south wall.
  const wz0 = ww.pos.z
  await Promise.all([ww.walkTo({ x: WX, z: wz0 }), gw.walkTo(BEHIND)])
  const wardenHere = { x: WX, z: wz0 }
  facts.push(`behind the south wall is ${visibilityOf(wardenHere, BEHIND)}`)
  await whenGone(w, gid)
  await sleep(SETTLE_MS)
  const w1From = Date.now()
  await sleep(400)
  const w1To = Date.now()

  // Into line of sight: the point on the line from the Warden's eye through the middle of the doorway.
  const A = { x: -WX * ((-GZ - 7.75) / (wz0 + 7.75)), z: GZ }
  let appearedAt = 0
  const appeared = whenVisible(w, gid).then(() => (appearedAt = Date.now()))
  await gw.walkTo(A)
  await appeared
  await sameAsOwn(w, g, gid)
  await sleep(150)
  facts.push(`the doorway line is ${visibilityOf(wardenHere, A)}`)
  const seenAt = { ...pos(w, gid) }
  const ownAt = { ...pos(g, gid) }
  const controlHits = scanFrames(framesOf(w), { ids: [gid], values: [ownAt.x], from: appearedAt - 300 })

  // Hidden again, while the Warden walks south to the wall and the Ghost runs along it, out of sight.
  await gw.walkTo(BEHIND)
  await whenGone(w, gid)
  await sleep(SETTLE_MS)
  const w2From = Date.now()
  await Promise.all([
    ww.walkTo({ x: WX, z: NEAR_W_Z }),
    (async () => {
      await gw.walkTo(EAST)
      await gw.walkTo(BEHIND)
    })(),
  ])
  await sleep(150)
  const w2To = Date.now()
  const wardenNear = { x: WX, z: NEAR_W_Z }

  // Within VISIBILITY_NEAR, a wall between: sent. Further away, the same wall: not.
  await gw.walkTo({ x: WX, z: NEAR_G_Z })
  await whenVisible(w, gid)
  await sameAsOwn(w, g, gid)
  const nearG = { ...pos(g, gid) }
  const nearSeen = { ...pos(w, gid) }
  const nearDistance = Math.hypot(nearG.x - WX, nearG.z - NEAR_W_Z)
  facts.push(`near: a wall between, line of sight ${hasLineOfSight(eyeOf(wardenNear), centreOf(nearG))}, ${visibilityOf(wardenNear, nearG)}`)
  await gw.walkTo({ x: WX, z: FAR_G_Z })
  await whenGone(w, gid)
  await sleep(SETTLE_MS)
  const w3From = Date.now()
  await sleep(300)
  const w3To = Date.now()
  facts.push(`far: ${visibilityOf(wardenNear, { x: WX, z: FAR_G_Z })}`)

  const w1 = hiddenProblems('Ghost behind the south wall', watch, w1From, w1To)
  const w2 = hiddenProblems('Ghost running along the wall', watch, w2From, w2To)
  const w3 = hiddenProblems('Ghost behind the wall, beyond VISIBILITY_NEAR', watch, w3From, w3To)
  const ghostLostWarden = gHas.filter((f) => !f.has).length
  const ghostHolds = g.state.players.size
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect([...gw.violations, ...ww.violations]).toEqual([])
  expect(facts.filter((f) => f.startsWith('spawn'))).toEqual([])
  expect(facts).toContain('behind the south wall is hidden')
  expect(facts).toContain('the doorway line is visible')
  expect(facts).toContain('near: a wall between, line of sight false, visible')
  expect(facts).toContain('far: hidden')
  expect(nearDistance, 'inside VISIBILITY_NEAR').toBeLessThan(VISIBILITY_NEAR)
  expect(NEAR_W_Z - FAR_G_Z, 'beyond VISIBILITY_NEAR').toBeGreaterThan(VISIBILITY_NEAR)
  // Hidden stretches: nothing in state, nothing on the wire.
  expect(w1.problems).toEqual([])
  expect(w2.problems).toEqual([])
  expect(w3.problems).toEqual([])
  expect(w2.searched, 'the run along the wall searched real coordinates').toBeGreaterThan(8)
  // Positive control: the same scan finds the Ghost when it was sent.
  expect(controlHits.some((h) => h.what.startsWith('session id')), "the Warden received the Ghost's id while it could see it").toBe(true)
  expect(controlHits.some((h) => h.what.includes(`${ownAt.x}`)), "the Warden received the Ghost's x while it could see it").toBe(true)
  // What is seen is exact.
  for (const [what, seen, own] of [
    ['on the doorway line', seenAt, ownAt],
    ['near, behind the wall', nearSeen, nearG],
  ] as const) {
    expect(seen.x, `${what}: x`).toBeCloseTo(own.x, 4)
    expect(seen.z, `${what}: z`).toBeCloseTo(own.z, 4)
    expect(feetY(seen), `${what}: y`).toBeCloseTo(feetY(own), 4)
    expect(seen.team).toBe('ghost')
  }
  // The Ghost always held the Warden, and the room holds exactly the two of them for it.
  expect(ghostLostWarden, 'the Ghost always held the Warden').toBe(0)
  expect(ghostHolds).toBe(2)
})

test('west wall: hidden while walking, climbing and hanging outside the building and on the upper level behind a pillar; shown when the Warden steps into line of sight; exact positions; nothing on the wire', async () => {
  test.setTimeout(120_000)
  const [g, w] = await joinWire(2, open)
  const gid = g.sessionId
  const gw = new Walker(g, 'ghost', { ground: false })
  const ww = new Walker(w, 'warden', { ground: false })
  const ghost = track(g, gid)
  const warden = track(w, w.sessionId)
  const wHas = watchHas(w, gid)
  const watch: Watch = { gid, ghost: ghost.samples, warden: warden.samples, has: wHas, frames: framesOf(w) }
  const own = () => g.state.players.get(gid) as unknown as { x: number; y: number; z: number; mode: string }
  const mode = (m: string) => waitForState(g, `the Ghost is ${m}`, () => own().mode === m)

  // The Warden stands inside the building behind the north-west pillar; the Ghost goes to the west yard.
  const W3 = { x: -3, z: 3.5 }
  const UP = { x: -3, z: 1.5 } // from here the mezzanine is in line of sight
  const YARD = { x: -11.47, z: 4.51 }
  await Promise.all([ww.walkTo(W3), gw.walkTo(YARD)])
  await whenGone(w, gid)
  await sleep(SETTLE_MS)
  const aFrom = Date.now()

  // climb-west: east into the wall, climb, hang, then mantle onto the mezzanine at UPPER_LEVEL_Y.
  await gw.push(1, 0, 40)
  g.send(ACTION_MESSAGE, { action: 'climb' })
  await mode('climbing')
  for (let i = 0; i < 40 && own().mode === 'climbing'; i++) await gw.attachedStep(0, 1)
  await mode('hanging')
  const hanging = { x: own().x, y: feetY(own()), z: own().z }
  await sleep(400)
  g.send(ACTION_MESSAGE, { action: 'climb' })
  await mode('ground')
  await sleep(500)
  const aTo = Date.now()
  const mezz = { x: own().x, y: feetY(own()), z: own().z }

  // The Ghost is on the upper level: floors and the pillar hide it from W3; from UP the Warden sees it.
  const fromBehindPillar = visibilityOf(W3, mezz)
  await ww.walkTo(UP)
  const fromStairs = visibilityOf(UP, mezz)
  await whenVisible(w, gid)
  await sameAsOwn(w, g, gid)
  const seen = { ...pos(w, gid) }
  const ownNow = { ...pos(g, gid) }
  // And back behind the pillar: gone again.
  await ww.walkTo(W3)
  await whenGone(w, gid)
  const goneAgain = !w.state.players.has(gid)
  const a = hiddenProblems('west yard, climb, hang and mezzanine', watch, aFrom, aTo)
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect([...gw.violations, ...ww.violations]).toEqual([])
  expect(hanging.y, 'hanging outside the building').toBeGreaterThan(1)
  expect(hanging.x, 'hanging outside the west wall').toBeLessThan(-10)
  expect(mezz.y, 'on the upper level').toBeCloseTo(3, 4)
  expect(fromBehindPillar, 'the mezzanine is hidden from behind the pillar').toBe('hidden')
  expect(fromStairs, 'the mezzanine is visible from UP').toBe('visible')
  expect(a.problems).toEqual([])
  expect(a.searched, 'the climb searched real coordinates').toBeGreaterThan(10)
  expect(seen.x).toBeCloseTo(ownNow.x, 4)
  expect(seen.z).toBeCloseTo(ownNow.z, 4)
  expect(feetY(seen)).toBeCloseTo(feetY(ownNow), 4)
  expect(goneAgain).toBe(true)
})

test('four players: a Ghost sees everyone, a Warden itself, its teammate and each Ghost exactly when it is in sight; forged join options and messages widen nothing; hidden Ghosts never reach the wire', async () => {
  test.setTimeout(60_000)
  // The server ignores join options; these ask for the opposite team and every kind of extra view.
  const rooms = await joinWire(4, open, (i) => ({
    team: i % 2 === 0 ? 'warden' : 'ghost',
    role: 'warden',
    seeAll: true,
    visible: true,
    viewAll: true,
    god: true,
    x: 0,
    y: 0,
    z: 0,
  }))
  const teams = rooms.map(teamOf)
  const god = godView(rooms)
  const where = new Map(rooms.map((r) => [r.sessionId, { ...pos(god, r.sessionId) }]))
  await sleep(SETTLE_MS)

  const problems: string[] = []
  let sure = 0
  function check(label: string) {
    for (const v of rooms) {
      const vt = teamOf(v)
      for (const t of rooms) {
        if (t === v) continue
        const held = v.state.players.has(t.sessionId)
        const tt = teamOf(t)
        if (mustSee(vt, tt)) {
          if (!held) problems.push(`${label}: ${vt} ${v.sessionId} must hold ${tt} ${t.sessionId}`)
        } else {
          const c = visibilityOf(where.get(v.sessionId)!, where.get(t.sessionId)!)
          if (c === 'hidden' && held) problems.push(`${label}: warden ${v.sessionId} holds hidden Ghost ${t.sessionId}`)
          if (c === 'visible' && !held) problems.push(`${label}: warden ${v.sessionId} lacks visible Ghost ${t.sessionId}`)
          if (label === 'at spawn' && c !== 'unsure') sure++
        }
        if (held && !sameSpot(v.state.players.get(t.sessionId), where.get(t.sessionId))) problems.push(`${label}: ${v.sessionId} holds ${t.sessionId} at a wrong spot`)
      }
      if (vt === 'ghost' && v.state.players.size !== 4) problems.push(`${label}: Ghost ${v.sessionId} holds ${v.state.players.size} players, not 4`)
      if (!v.state.players.has(v.sessionId)) problems.push(`${label}: ${v.sessionId} lacks itself`)
    }
  }
  check('at spawn')

  // Forged payloads from the Wardens on the message types the room knows: a team, a position, a view, a fire at an id.
  // None changes who is seen or where anyone is. (A message type the room does not know is refused by Colyseus itself,
  // which closes the sender's connection with code 4002; that is not tested here.)
  const wardens = rooms.filter((r) => teamOf(r) === 'warden')
  for (const r of wardens) {
    r.send(MOVE_MESSAGE, { dx: 0, dz: 0, x: 0, y: 0, z: 0, team: 'ghost', mode: 'hanging' })
    r.send(MOVE_MESSAGE, { dx: 0, dz: 0, yaw: 0, visible: true, viewAll: true, near: 1000, targets: rooms.map((t) => t.sessionId) })
    r.send(ACTION_MESSAGE, { action: 'climb', team: 'ghost', x: 0, z: 0, visible: true })
    r.send(FIRE_MESSAGE, { yaw: 0, pitch: 0, target: rooms[0].sessionId, team: 'ghost', origin: { x: 0, y: 1.6, z: 0 } })
    r.send(RELOAD_MESSAGE, { team: 'ghost', ammo: 1000 })
  }
  await sleep(SETTLE_MS * 2)
  check('after forged messages')
  rooms.forEach((r, i) => {
    if (teamOf(r) !== teams[i]) problems.push(`room ${i} changed team to ${teamOf(r)}`)
  })

  // On the wire: a Warden's frames never carry a Ghost that was hidden from it (nobody moved, so for the whole run).
  const wireProblems: string[] = []
  for (const v of wardens) {
    const mine = where.get(v.sessionId)!
    for (const t of rooms.filter((r) => teamOf(r) === 'ghost')) {
      const p = where.get(t.sessionId)!
      if (visibilityOf(mine, p) !== 'hidden') continue
      const values = [p.x, p.z].filter((x) => x !== mine.x && x !== mine.z)
      for (const h of scanFrames(framesOf(v), { ids: [t.sessionId], values })) wireProblems.push(`${v.sessionId} received ${h.what} of hidden Ghost ${t.sessionId}`)
    }
  }
  // Positive control: a Ghost client's frames carry every other player's id and x.
  const controls: string[] = []
  for (const v of rooms.filter((r) => teamOf(r) === 'ghost')) {
    for (const t of rooms) {
      if (t === v) continue
      const p = where.get(t.sessionId)!
      const found = scanFrames(framesOf(v), { ids: [t.sessionId], values: [p.x] })
      if (!found.some((h) => h.what.startsWith('session id'))) controls.push(`${v.sessionId} never received the id of ${t.sessionId}`)
      if (searchable(p.x) && !found.some((h) => h.what.includes(`${p.x}`))) controls.push(`${v.sessionId} never received x of ${t.sessionId}`)
    }
  }
  await Promise.all(open.splice(0).map((r) => leaveQuietly(r)))

  expect(teams, 'join order: Ghost, Warden, Ghost, Warden, whatever the options say').toEqual(['ghost', 'warden', 'ghost', 'warden'])
  expect(problems).toEqual([])
  expect(wireProblems).toEqual([])
  expect(controls).toEqual([])
  // Random spawns: only a loose bound that the checks had something to say.
  expect(sure, 'some Warden-Ghost pairs were clearly hidden or visible at spawn').toBeGreaterThan(0)
})
