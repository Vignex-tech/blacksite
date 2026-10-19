import type { Scene } from '@babylonjs/core/scene'
import { CreateLines } from '@babylonjs/core/Meshes/Builders/linesBuilder'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { DamagedEvent, HitEvent, ShotEvent } from '../../shared/protocol.js'

// Shot, hit and damage feedback (M5, #50). Pure rendering of server events:
// graybox lines and DOM overlays, short-lived, no assets. Nothing here decides
// anything.

/** How long a tracer line stays, in ms. */
const TRACER_MS = 70
/** How long the hit marker and the damage flash stay, in ms. */
const HIT_MARKER_MS = 140
const DAMAGE_FLASH_MS = 220
/** Local shooter's tracer starts this far below the eye so it is visible. */
const OWN_TRACER_DROP = 0.3

const TRACER_COLOR = { warden: new Color3(1, 0.85, 0.4), ghost: new Color3(0.4, 0.9, 1) }

export interface CombatFeedback {
  shot(e: ShotEvent, localId: string | null): void
  hit(e: HitEvent): void
  damaged(e: DamagedEvent): void
}

export function createCombatFeedback(scene: Scene, app: HTMLElement): CombatFeedback {
  const marker = document.createElement('div')
  marker.id = 'hit-marker'
  marker.hidden = true
  app.appendChild(marker)
  const flash = document.createElement('div')
  flash.id = 'damage-flash'
  flash.hidden = true
  app.appendChild(flash)

  let markerTimer: ReturnType<typeof setTimeout> | undefined
  let flashTimer: ReturnType<typeof setTimeout> | undefined

  return {
    shot(e, localId) {
      const drop = e.shooter === localId ? OWN_TRACER_DROP : 0
      const line = CreateLines(
        'tracer',
        { points: [new Vector3(e.origin.x, e.origin.y - drop, e.origin.z), new Vector3(e.end.x, e.end.y, e.end.z)] },
        scene,
      )
      line.color = TRACER_COLOR[e.team] ?? TRACER_COLOR.warden
      line.isPickable = false
      setTimeout(() => line.dispose(), TRACER_MS)
    },
    hit(e) {
      marker.className = e.killed ? 'kill' : ''
      marker.hidden = false
      clearTimeout(markerTimer)
      markerTimer = setTimeout(() => (marker.hidden = true), HIT_MARKER_MS)
    },
    damaged() {
      flash.hidden = false
      clearTimeout(flashTimer)
      flashTimer = setTimeout(() => (flash.hidden = true), DAMAGE_FLASH_MS)
    },
  }
}
