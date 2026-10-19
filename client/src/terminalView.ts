import type { Scene } from '@babylonjs/core/scene'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { ACTIVE_TERMINAL_ID, GRAYBOX_MAP, type GrayboxMap } from '../../shared/map.js'
import type { TerminalStatus } from '../../shared/protocol.js'

// Terminal post colours (M6, #60): the active terminal is bright green, the
// inactive one dim grey, and a hacked terminal turns amber. Mesh names stay
// `terminal-<id>` (built by buildMap); this only swaps their materials.

export type TerminalLook = 'active' | 'inactive' | 'hacked'

/** Look of a terminal from its id and the status received for it. */
export function terminalLook(id: string, status: TerminalStatus | undefined): TerminalLook {
  if (id !== ACTIVE_TERMINAL_ID) return 'inactive'
  return status === 'hacked' ? 'hacked' : 'active'
}

export interface TerminalView {
  /** Applies the received status of terminal `id` (unknown ids are ignored). */
  update(id: string, status: TerminalStatus): void
  /** Back to the starting look (no status received). */
  reset(): void
}

function mat(scene: Scene, name: string, diffuse: Color3, emissive: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene)
  m.diffuseColor = diffuse
  m.emissiveColor = emissive
  m.specularColor = Color3.Black()
  m.freeze()
  return m
}

/** Gives the already-built terminal posts their active, dim or hacked material. */
export function createTerminalView(scene: Scene, map: GrayboxMap = GRAYBOX_MAP): TerminalView {
  const mats: Record<TerminalLook, StandardMaterial> = {
    active: mat(scene, 'terminalActiveMat', new Color3(0.2, 0.8, 0.35), new Color3(0.1, 0.45, 0.15)),
    // Dim, but not black: still readable in the dark (rule 7).
    inactive: mat(scene, 'terminalDimMat', new Color3(0.3, 0.3, 0.32), new Color3(0.07, 0.07, 0.08)),
    hacked: mat(scene, 'terminalHackedMat', new Color3(0.95, 0.72, 0.2), new Color3(0.55, 0.38, 0.05)),
  }
  const apply = (id: string, status: TerminalStatus | undefined): void => {
    const mesh = scene.getMeshByName(`terminal-${id}`)
    if (mesh) mesh.material = mats[terminalLook(id, status)]
  }
  const reset = (): void => {
    for (const t of map.terminals) apply(t.id, undefined)
  }
  reset()
  return {
    update(id, status) {
      if (map.terminals.some((t) => t.id === id)) apply(id, status)
    },
    reset,
  }
}
