import type { Engine } from '@babylonjs/core/Engines/engine'
import type { Scene } from '@babylonjs/core/scene'
import type { BlacksitePerfSnapshot } from '../../shared/testhook.js'

/**
 * Dev overlay (M8, #79): F3 toggles fps, draw calls and active triangles. The
 * same numbers feed the test hook's `perf` field. Read-only; no gameplay.
 */
export interface PerfMeter {
  /** Latest numbers (zeros until the first sample). */
  read(): BlacksitePerfSnapshot
  dispose(): void
}

export function createPerfMeter(engine: Engine, scene: Scene, parent: HTMLElement, target: Window = window): PerfMeter {
  const el = document.createElement('div')
  el.id = 'perf'
  el.hidden = true
  parent.appendChild(el)

  const sample = (): BlacksitePerfSnapshot => {
    let indices = 0
    for (const m of scene.getActiveMeshes().data) indices += m ? m.getTotalIndices() : 0
    return {
      fps: Math.round(engine.getFps()),
      drawCalls: engine._drawCalls.current,
      activeTriangles: Math.round(indices / 3),
    }
  }

  let last: BlacksitePerfSnapshot = { fps: 0, drawCalls: 0, activeTriangles: 0 }
  const timer = target.setInterval(() => {
    last = sample()
    if (!el.hidden) el.textContent = `fps ${last.fps}  draws ${last.drawCalls}  tris ${last.activeTriangles}`
  }, 500)

  const onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'F3') return
    e.preventDefault()
    el.hidden = !el.hidden
    if (!el.hidden) el.textContent = `fps ${last.fps}  draws ${last.drawCalls}  tris ${last.activeTriangles}`
  }
  target.addEventListener('keydown', onKey)

  return {
    read: () => ({ ...last }),
    dispose: () => {
      target.clearInterval(timer)
      target.removeEventListener('keydown', onKey)
      el.remove()
    },
  }
}
