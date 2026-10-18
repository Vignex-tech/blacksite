// Analysis of one held-key "leg" recorded by the in-page sampler
// (support/tabs.ts startSampler): where the player went, how fast, and whether
// the server's rate limit held at every moment. Pure functions over samples.

import { expect } from '@playwright/test'
import { BOUND, MOVE_BURST, MOVE_RATE_HZ } from '../../../server/build/rooms/MyRoom.js'
import { ROUTE_MARGIN, feetY, groundProblems, hazardsAt, overlapping, type Point } from './geometry.js'
import type { Sample } from './tabs.js'

export interface LegTrack {
  /** Samples of player `id` only: page time and position. */
  points: { t: number; x: number; z: number; yaw: number }[]
}

export function track(samples: Sample[], id: string): LegTrack {
  const points = samples.flatMap((s) => {
    const p = s.players.find((v) => v.id === id)
    return p ? [{ t: s.t, x: p.x, z: p.z, yaw: p.yaw }] : []
  })
  return { points }
}

export interface LegResult {
  start: Point
  end: Point
  /** Straight-line displacement start -> end. */
  distance: number
  /** Heading of the displacement as a yaw (0 = +z, positive toward +x). */
  heading: number
  /** distance / step: the number of accepted full-input moves (an integer when nothing collided). */
  moves: number
  /** Speed between the first and the last observed position change (units/s); NaN if fewer than 2 changes. */
  sustainedSpeed: number
  /** Page times of the first and last observed change. */
  firstChange: number
  lastChange: number
}

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.z - a.z)

export function analyse(leg: LegTrack, step: number): LegResult {
  const pts = leg.points
  if (pts.length < 2) throw new Error(`only ${pts.length} samples of the player`)
  const start = { x: pts[0].x, z: pts[0].z }
  const last = pts[pts.length - 1]
  const end = { x: last.x, z: last.z }
  const changes: number[] = []
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x !== pts[i - 1].x || pts[i].z !== pts[i - 1].z) changes.push(i)
  }
  const distance = dist(start, end)
  const heading = Math.atan2(end.x - start.x, end.z - start.z)
  let sustainedSpeed = NaN
  let firstChange = NaN
  let lastChange = NaN
  if (changes.length >= 2) {
    const f = pts[changes[0]]
    const l = pts[changes[changes.length - 1]]
    firstChange = f.t
    lastChange = l.t
    sustainedSpeed = dist(f, l) / ((l.t - f.t) / 1000)
  }
  return { start, end, distance, heading, moves: distance / step, sustainedSpeed, firstChange, lastChange }
}

/**
 * Fails if, between any two samples at least `minWindowMs` apart, the player
 * covered more than the rate limit allows: (MOVE_RATE_HZ * dt + MOVE_BURST + 1) * step.
 * The +1 covers a move accepted just before the window's first sample shows it.
 */
export function expectNeverFasterThanLimit(leg: LegTrack, step: number, who: string, minWindowMs = 300): void {
  const pts = leg.points
  let worst = 0
  let worstAt = ''
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dt = pts[j].t - pts[i].t
      if (dt < minWindowMs) continue
      const allowed = (MOVE_RATE_HZ * (dt / 1000) + MOVE_BURST + 1) * step
      const ratio = dist(pts[i], pts[j]) / allowed
      if (ratio > worst) {
        worst = ratio
        worstAt = `${dist(pts[i], pts[j]).toFixed(3)} units in ${dt.toFixed(0)} ms (allowed ${allowed.toFixed(3)})`
      }
    }
  }
  expect(worst, `${who} never outruns the rate limit; worst window: ${worstAt}`).toBeLessThanOrEqual(1)
}

/**
 * Fails if any sample of any player overlaps an obstacle (y-aware: solids,
 * floors and ramps, at the sample's y, default 0) or leaves the bounds.
 */
export function expectNoOverlap(samples: Sample[], who: string): void {
  const bad: string[] = []
  for (const s of samples) {
    for (const p of s.players) {
      const hit = overlapping(p)
      if (hit.length) bad.push(`${p.id} at ${p.x},${feetY(p)},${p.z} overlaps ${hit.map((h) => h.id).join(',')}`)
      if (Math.abs(p.x) > BOUND + 1e-4 || Math.abs(p.z) > BOUND + 1e-4) bad.push(`${p.id} at ${p.x},${p.z} is out of bounds`)
    }
  }
  expect(bad.slice(0, 5), `${who}: no player ever overlaps a solid or leaves the bounds (${bad.length} bad samples)`).toEqual([])
}

/**
 * Fails if any sample of any player is off the ground (y other than 0 or a
 * mode other than 'ground', when the snapshot has them) or inside a route
 * hazard (ramp, covered pocket, climb spot; support/geometry.ts). Browser
 * routes are ground routes.
 */
export function expectGroundRoute(samples: Sample[], who: string): void {
  const bad: string[] = []
  for (const s of samples) {
    for (const p of s.players) {
      for (const g of groundProblems(p)) bad.push(`${p.id} at ${p.x},${p.z}: ${g}`)
      const hz = hazardsAt(p, 0)
      if (hz.length) bad.push(`${p.id} at ${p.x},${p.z} is in ${hz.join(',')}`)
    }
  }
  expect(bad.slice(0, 5), `${who}: every player stays on the ground and out of ramps, pockets and climb spots (${bad.length} bad samples)`).toEqual([])
}

/**
 * True if a player box moving on the ground in a straight line from `from`
 * along unit direction (sin yaw, cos yaw) stays clear of every obstacle and
 * route hazard (with ROUTE_MARGIN) and inside the bounds for `distance`
 * units (checked every 0.02 units).
 */
export function pathClear(from: Point, yaw: number, distance: number): boolean {
  const dx = Math.sin(yaw)
  const dz = Math.cos(yaw)
  for (let d = 0; d <= distance; d += 0.02) {
    const p = { x: from.x + dx * d, z: from.z + dz * d }
    if (overlapping(p, -0.05).length) return false // 0.05 units of margin
    if (hazardsAt(p, ROUTE_MARGIN).length) return false
    if (Math.abs(p.x) > BOUND - 0.01 || Math.abs(p.z) > BOUND - 0.01) return false
  }
  return true
}
