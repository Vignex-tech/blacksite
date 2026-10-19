import type { AssetLoader } from './assets/assetLoader.ts'

/**
 * Loading screen (M8, #79): a small overlay with a progress bar, shown while
 * models download. It never blocks input, and the game is playable behind it
 * with the graybox fallback (a failed asset just ends its part of the load).
 */

/** Overall progress of the loads in flight, 0..1 (pure, for tests). */
export class LoadTracker {
  private readonly loads = new Map<number, number>()
  private next = 0

  get active(): boolean {
    return this.loads.size > 0
  }

  /** Mean progress of the loads in flight (1 when none). */
  get fraction(): number {
    if (this.loads.size === 0) return 1
    let sum = 0
    for (const f of this.loads.values()) sum += f
    return sum / this.loads.size
  }

  begin(): number {
    const token = this.next++
    this.loads.set(token, 0)
    return token
  }

  progress(token: number, fraction: number): void {
    if (this.loads.has(token)) this.loads.set(token, Math.max(0, Math.min(1, fraction)))
  }

  end(token: number): void {
    this.loads.delete(token)
  }
}

export interface LoadingScreen {
  /** Wraps a loader so every load it starts is shown on the screen. */
  track(loader: AssetLoader): AssetLoader
  dispose(): void
}

export function createLoadingScreen(parent: HTMLElement): LoadingScreen {
  const tracker = new LoadTracker()
  const root = document.createElement('div')
  root.id = 'loading'
  root.hidden = true
  const label = document.createElement('div')
  label.id = 'loading-label'
  label.textContent = 'Loading'
  const bar = document.createElement('div')
  bar.id = 'loading-bar'
  const fill = document.createElement('div')
  fill.id = 'loading-fill'
  bar.appendChild(fill)
  root.append(label, bar)
  parent.appendChild(root)

  const render = (): void => {
    root.hidden = !tracker.active
    fill.style.width = `${Math.round(tracker.fraction * 100)}%`
  }

  return {
    track: (loader) => ({
      async loadModel(id, onProgress) {
        const token = tracker.begin()
        render()
        try {
          return await loader.loadModel(id, (f) => {
            tracker.progress(token, f)
            render()
            onProgress?.(f)
          })
        } finally {
          tracker.end(token)
          render()
        }
      },
    }),
    dispose: () => root.remove(),
  }
}
