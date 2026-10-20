import type { Scene } from '@babylonjs/core/scene'
import type { Camera } from '@babylonjs/core/Cameras/camera'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { PointLight } from '@babylonjs/core/Lights/pointLight'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline'
import { GRAYBOX_MAP } from '../../shared/map.js'
import type { GrayboxMap } from '../../shared/map.js'
import type { GfxSettings } from './graphics.ts'
import { assetUrl } from './assets/assetLoader.ts'

/**
 * Lighting, shadows, fog and sky (M8, #87). Purely visual: nothing here reads
 * or changes a game rule, and every new node is named `fx-` or `decor-`.
 *
 * Light budget (Phase 2 keeps one slot free): any one mesh is lit by at most
 * three lights, so the flashlight can be the fourth.
 *   static map meshes   cool hemispheric ambient + moon + at most one practical lamp
 *   characters          ambient + moon + a camera-side fill light (readable in the dark, rule 7)
 * `low` keeps the cheap pre-art look: the hemispheric light only, linear fog.
 */

const HORIZON = new Color3(0.2, 0.24, 0.31)
const ZENITH = new Color3(0.03, 0.045, 0.1)

/** Practical lights placed on shared map data: which point, colour, and a name. */
interface LampSpec {
  at: 'entrance' | 'terminal'
  index: number
  name: string
  colour: Color3
  height: number
}
const LAMPS: readonly LampSpec[] = [
  // Warm amber maintenance lamp over the south door (flickers a little).
  { at: 'entrance', index: 0, name: 'amber', colour: new Color3(1, 0.62, 0.22), height: 2.7 },
  // Neutral white task light over the second terminal.
  { at: 'terminal', index: 1, name: 'white', colour: new Color3(0.85, 0.92, 1), height: 2.7 },
  // Emergency red over the east door.
  { at: 'entrance', index: 3, name: 'red', colour: new Color3(1, 0.16, 0.12), height: 2.7 },
]
const LAMP_RANGE = 11

export interface Lighting {
  /** Number of local (practical) lights created. */
  readonly localLights: number
  /** The shadow generator (medium and high), else null. */
  readonly shadowGenerator: ShadowGenerator | null
  /** Call once all cameras exist: adds bloom, FXAA and tone mapping on `high`. */
  attachPostEffects(cameras: Camera[]): void
  dispose(): void
}

const STATIC_MESH = /^(solid|floor|ramp)-|^ground$/
const NOT_A_CHARACTER = /^(solid|floor|ramp|anchor|terminal|decor|fx)-|^ground$|^tracer|^camera$/

const isCharacterMesh = (m: AbstractMesh): boolean =>
  !NOT_A_CHARACTER.test(m.name) && m.getClassName() !== 'LinesMesh' && m.getClassName() !== 'InstancedMesh'

function buildSky(scene: Scene): Mesh {
  const W = 1024
  const H = 512
  const tex = new DynamicTexture('fx-sky-tex', { width: W, height: H }, scene, false)
  const ctx = tex.getContext() as CanvasRenderingContext2D
  const css = (c: Color3, a = 1): string => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`
  const paint = (stars: HTMLImageElement | null): void => {
    // The sphere maps v = 0 to the bottom, 1 to the top; the canvas is drawn top-down.
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, css(ZENITH))
    g.addColorStop(0.5, css(HORIZON))
    g.addColorStop(1, css(HORIZON))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    if (stars) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.85
      ctx.drawImage(stars, 0, 0, W, H / 2) // the stars fill the upper half (above the horizon)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      // Fade the stars out near the horizon.
      const fade = ctx.createLinearGradient(0, H * 0.28, 0, H * 0.5)
      fade.addColorStop(0, css(HORIZON, 0))
      fade.addColorStop(1, css(HORIZON, 1))
      ctx.fillStyle = fade
      ctx.fillRect(0, H * 0.28, W, H * 0.22)
    }
    tex.update(false)
  }
  paint(null)
  const img = new Image()
  img.onload = () => paint(img)
  img.onerror = () => {} // the gradient alone is fine
  img.src = assetUrl('effects/tex_sky_stars.webp')

  const sky = CreateSphere('fx-sky', { diameter: 800, segments: 16, sideOrientation: Mesh.BACKSIDE }, scene)
  const mat = new StandardMaterial('fx-skyMat', scene)
  mat.disableLighting = true
  mat.emissiveTexture = tex
  mat.diffuseColor = Color3.Black()
  mat.specularColor = Color3.Black()
  mat.fogEnabled = false
  mat.backFaceCulling = false
  sky.material = mat
  sky.infiniteDistance = true
  sky.isPickable = false
  sky.applyFog = false
  sky.alwaysSelectAsActiveMesh = true
  return sky
}

export function createLighting(scene: Scene, gfx: GfxSettings, map: GrayboxMap = GRAYBOX_MAP): Lighting {
  const disposables: { dispose(): void }[] = []
  const lowTier = !gfx.moonAndSky

  // Fog and clear colour match the horizon, so the far apron melts into the sky.
  scene.clearColor = new Color4(HORIZON.r, HORIZON.g, HORIZON.b, 1)
  scene.fogColor = HORIZON.clone()
  if (gfx.fog === 'full') {
    scene.fogMode = 2 // FOGMODE_EXP2
    scene.fogDensity = 0.009
  } else {
    scene.fogMode = 3 // FOGMODE_LINEAR
    scene.fogStart = 40
    scene.fogEnd = 150
  }

  // Cool ambient with a floor: the ground colour is lit too, so nothing renders black.
  const hemi = new HemisphericLight('light', new Vector3(0, 1, 0), scene)
  hemi.diffuse = new Color3(0.7, 0.76, 0.9)
  hemi.groundColor = new Color3(0.34, 0.36, 0.42)
  hemi.specular = Color3.Black()
  hemi.intensity = lowTier ? 0.9 : 0.62
  disposables.push(hemi)

  if (lowTier) {
    scene.clearColor = new Color4(0.05, 0.06, 0.08, 1)
    scene.fogColor = new Color3(0.05, 0.06, 0.08)
    scene.fogMode = 3
    scene.fogStart = 80
    scene.fogEnd = 400
    return { localLights: 0, shadowGenerator: null, attachPostEffects: () => {}, dispose: () => disposables.forEach((d) => d.dispose()) }
  }

  // Filmic tone mapping with mild contrast (in the material shaders on medium; high uses the pipeline).
  const ip = scene.imageProcessingConfiguration
  ip.toneMappingEnabled = true
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES
  ip.contrast = 1.15
  ip.exposure = 1.05

  const sky = buildSky(scene)
  disposables.push(sky)

  const staticMeshes = scene.meshes.filter((m) => STATIC_MESH.test(m.name))

  // Moon: one directional light, one shadow generator.
  const moon = new DirectionalLight('fx-moon', new Vector3(-0.7, -0.85, 0.45).normalize(), scene)
  moon.diffuse = new Color3(0.72, 0.8, 1)
  moon.specular = new Color3(0.4, 0.45, 0.6)
  moon.intensity = 1.8
  moon.position = moon.direction.scale(-45)
  moon.autoUpdateExtends = false
  moon.orthoLeft = -34
  moon.orthoRight = 34
  moon.orthoBottom = -34
  moon.orthoTop = 34
  moon.shadowMinZ = 5
  moon.shadowMaxZ = 110
  disposables.push(moon)

  let shadowGenerator: ShadowGenerator | null = null
  if (gfx.shadows) {
    const sg = new ShadowGenerator(gfx.shadowMapSize, moon)
    sg.usePercentageCloserFiltering = true
    sg.filteringQuality = gfx.shadowFilter === 'softer' ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW
    sg.bias = 0.0008
    sg.normalBias = 0.03
    sg.darkness = 0.15
    sg.transparencyShadow = false
    sg.getShadowMap()!.refreshRate = Math.max(1, gfx.shadowRefresh)
    sg.getShadowMap()!.renderList!.length = 0
    for (const m of staticMeshes) {
      if (m.name !== 'ground') sg.addShadowCaster(m)
      m.receiveShadows = true
    }
    shadowGenerator = sg
    disposables.push(sg)
  }

  // Practical lights from shared map data; lamp meshes are emissive (cheap fake glow).
  const lamps: { light: PointLight; base: number; flicker: boolean }[] = []
  const lampMats = new Map<string, StandardMaterial>()
  const locals = LAMPS.slice(0, Math.min(gfx.maxLocalLights, LAMPS.length))
  for (const spec of locals) {
    const p = spec.at === 'entrance' ? map.entrances[spec.index] : map.terminals[spec.index]
    if (!p) continue
    const light = new PointLight(`fx-lamp-${spec.name}`, new Vector3(p.x, spec.height, p.z), scene)
    light.diffuse = spec.colour
    light.specular = Color3.Black()
    light.intensity = spec.name === 'red' ? 0.55 : 0.85
    light.range = LAMP_RANGE
    lamps.push({ light, base: light.intensity, flicker: spec.name === 'amber' })
    disposables.push(light)

    let mat = lampMats.get(spec.name)
    if (!mat) {
      mat = new StandardMaterial(`fx-lampMat-${spec.name}`, scene)
      mat.disableLighting = true
      mat.emissiveColor = spec.colour.scale(gfx.bloom ? 1.25 : 1)
      mat.fogEnabled = false
      mat.freeze()
      lampMats.set(spec.name, mat)
    }
    const lamp = CreateBox(`decor-lamp-${spec.name}`, { width: 0.7, height: 0.12, depth: 0.2 }, scene)
    lamp.position.set(p.x, spec.height + 0.15, p.z)
    lamp.material = mat
    lamp.isPickable = false
    lamp.freezeWorldMatrix()
    disposables.push(lamp)
  }
  // Each static mesh takes at most ONE lamp (the nearest that reaches it), keeping every
  // material at ambient + moon + one lamp = 3 lights; the 4th slot is the flashlight's.
  const lampMeshes = new Map<PointLight, AbstractMesh[]>(lamps.map((l) => [l.light, []]))
  for (const m of staticMeshes) {
    m.computeWorldMatrix(true)
    const bb = m.getBoundingInfo().boundingBox
    let best: (typeof lamps)[number] | null = null
    let bestD = Infinity
    for (const l of lamps) {
      const lp = l.light.position
      const dx = Math.max(bb.minimumWorld.x - lp.x, 0, lp.x - bb.maximumWorld.x)
      const dy = Math.max(bb.minimumWorld.y - lp.y, 0, lp.y - bb.maximumWorld.y)
      const dz = Math.max(bb.minimumWorld.z - lp.z, 0, lp.z - bb.maximumWorld.z)
      const d = m.name === 'ground' ? Vector3.Distance(l.light.position, new Vector3(lp.x, 0, lp.z)) : Math.hypot(dx, dy, dz)
      if (d < LAMP_RANGE && d < bestD) {
        best = l
        bestD = d
      }
    }
    if (best) lampMeshes.get(best.light)!.push(m)
  }
  for (const l of lamps) l.light.includedOnlyMeshes = lampMeshes.get(l.light)!

  // Characters: a fill light from the camera side, lighting only characters, so a Ghost in
  // shadow still reads against dark walls (rule 7). No wall-penetrating outline.
  const fill = new DirectionalLight('fx-fill', new Vector3(0, -0.3, 1).normalize(), scene)
  fill.diffuse = new Color3(0.8, 0.85, 1)
  fill.specular = Color3.Black()
  fill.intensity = 0.7
  fill.includedOnlyMeshes = []
  disposables.push(fill)
  const characterMeshes: AbstractMesh[] = []
  const addCharacter = (m: AbstractMesh): void => {
    if (!isCharacterMesh(m)) return
    characterMeshes.push(m)
    fill.includedOnlyMeshes = characterMeshes.slice()
    shadowGenerator?.addShadowCaster(m)
    m.onDisposeObservable.addOnce(() => {
      const i = characterMeshes.indexOf(m)
      if (i >= 0) characterMeshes.splice(i, 1)
      fill.includedOnlyMeshes = characterMeshes.slice()
      shadowGenerator?.removeShadowCaster(m)
    })
  }
  const added = scene.onNewMeshAddedObservable.add(addCharacter)

  const tmp = new Vector3()
  const onFrame = scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera
    if (cam) {
      cam.getDirectionToRef(Vector3.Forward(), tmp)
      tmp.y = tmp.y * 0.5 - 0.25
      fill.direction.copyFrom(tmp.normalize())
    }
    // A subtle flicker on the amber lamp only.
    const t = performance.now() / 1000
    for (const l of lamps) {
      if (l.flicker) l.light.intensity = l.base * (0.94 + 0.04 * Math.sin(t * 7.3) + 0.02 * Math.sin(t * 19.1))
    }
  })

  let pipeline: DefaultRenderingPipeline | null = null
  return {
    localLights: lamps.length,
    shadowGenerator,
    attachPostEffects(cameras) {
      if (!gfx.bloom || pipeline) return
      pipeline = new DefaultRenderingPipeline('fx-pipeline', true, scene, cameras)
      pipeline.fxaaEnabled = true
      pipeline.bloomEnabled = true
      pipeline.bloomThreshold = 0.9 // only the bright emissive lamps and screens bloom
      pipeline.bloomWeight = 0.35
      pipeline.bloomKernel = 48
      pipeline.bloomScale = 0.5
      pipeline.imageProcessingEnabled = true
      pipeline.imageProcessing.toneMappingEnabled = true
      pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES
      pipeline.imageProcessing.contrast = 1.15
      pipeline.imageProcessing.exposure = 1.05
    },
    dispose() {
      scene.onNewMeshAddedObservable.remove(added)
      scene.onBeforeRenderObservable.remove(onFrame)
      pipeline?.dispose()
      for (const d of disposables) d.dispose()
    },
  }
}
