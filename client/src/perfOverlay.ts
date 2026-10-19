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

  // `engine._drawCalls.current` keeps adding up across frames in this Babylon
  // version, so the draw calls of one frame are the change over one render.
  let frameStart = 0
  let frameDrawCalls = 0
  const onBefore = scene.onBeforeRenderObservable.add(() => {
    frameStart = engine._drawCalls.current
  })
  const onAfter = scene.onAfterRenderObservable.add(() => {
    const d = engine._drawCalls.current - frameStart
    frameDrawCalls = d >= 0 ? d : engine._drawCalls.current
  })

  const sample = (): BlacksitePerfSnapshot => {
    let indices = 0
    for (const m of scene.getActiveMeshes().data) indices += m ? m.getTotalIndices() : 0
    return {
      fps: Math.round(engine.getFps()),
      drawCalls: frameDrawCalls,
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
      scene.onBeforeRenderObservable.remove(onBefore)
      scene.onAfterRenderObservable.remove(onAfter)
      target.clearInterval(timer)
      target.removeEventListener('keydown', onKey)
      el.remove()
    },
  }
}
