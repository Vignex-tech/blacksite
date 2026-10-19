import './style.css'
import { createGameScene, type GameScene } from './scene.ts'
import { ActionInput, FireInput, MovementInput } from './input.ts'
import { joinGame, onCombatEvents, sendAction, sendFire, sendMove, sendReload, type PlayerView } from './net.ts'
import { climbPrompt, modeText, type LocalPlayerState } from './traversalHint.ts'
import type { Team } from '../../shared/protocol.js'
import type { Room } from '@colyseus/sdk'
import { installTestHook } from './testHook.ts'
import { wrapAngle } from './cameras.ts'
import { FirePacer } from './firePacer.ts'
import { createCombatFeedback } from './combat.ts'
import { ammoText, crosshairVisible, healthText, isEliminated, type LocalVitals } from './vitals.ts'

/** How often a held movement key sends a "move" message. */
const MOVE_SEND_HZ = 20

/** A camera turn smaller than this (radians) doesn't send a yaw-only move. */
const YAW_SEND_EPSILON = 0.01

/** HUD wording for each team. */
const TEAM_LABEL: Record<Team, string> = { ghost: 'a Ghost', warden: 'a Warden' }

// Test hook on window.__blacksite (also in production builds; see testHook.ts).
const testHook = installTestHook()

const app = document.querySelector<HTMLDivElement>('#app')!
const canvas = document.createElement('canvas')
canvas.id = 'game-canvas'
app.appendChild(canvas)

const hud = document.createElement('div')
hud.id = 'hud'
app.appendChild(hud)
const setStatus = (text: string): void => {
  hud.textContent = `Blacksite - ${text}`
}

let game: GameScene | null = null
try {
  game = createGameScene(canvas)
} catch (err) {
  // No WebGL: show a message instead of a blank page.
  canvas.remove()
  hud.remove()
  const msg = document.createElement('p')
  msg.className = 'webgl-error'
  msg.textContent = 'Blacksite needs WebGL, which this browser could not start.'
  app.appendChild(msg)
  console.warn('Babylon engine failed to start:', err)
}

if (game) {
  testHook.setMap(game.map.id, game.map.renderedSolids, game.traversal)
  const rig = game.camera
  testHook.setCamera(() => ({ mode: rig.mode, yaw: rig.yaw }))
  start(game)
}

function start(view: GameScene): void {
  const input = new MovementInput()
  let room: Room | null = null

  const rig = view.camera
  const hint = document.createElement('div')
  hint.id = 'camera-hint'
  app.appendChild(hint)

  // Movement mode feedback (#35), separate from #hud so its text keeps its
  // format. Display only, from the local player's server state.
  const modeLine = document.createElement('div')
  modeLine.id = 'mode'
  app.appendChild(modeLine)
  const prompt = document.createElement('div')
  prompt.id = 'climb-prompt'
  app.appendChild(prompt)
  // Health and ammo readouts and the crosshair (#48): display only, from the
  // local player's received state. Empty before it arrives and after disconnect.
  const healthLine = document.createElement('div')
  healthLine.id = 'health'
  app.appendChild(healthLine)
  const ammoLine = document.createElement('div')
  ammoLine.id = 'ammo'
  app.appendChild(ammoLine)
  const crosshair = document.createElement('div')
  crosshair.id = 'crosshair'
  crosshair.hidden = true
  app.appendChild(crosshair)
  let vitals: LocalVitals | null = null
  const showVitals = (): void => {
    const h = healthText(vitals)
    if (healthLine.textContent !== h) healthLine.textContent = h
    const a = ammoText(vitals)
    if (ammoLine.textContent !== a) ammoLine.textContent = a
    const show = crosshairVisible(rig.mode, vitals ? vitals.health : null)
    if (crosshair.hidden === show) crosshair.hidden = !show
  }
  let local: LocalPlayerState | null = null
  const showMode = (): void => {
    const text = modeText(local)
    if (modeLine.textContent !== text) modeLine.textContent = text
    const p = climbPrompt(local)
    if (prompt.textContent !== p) prompt.textContent = p
  }

  // One message per press of Space, E or C; the server decides the outcome.
  new ActionInput((action) => {
    if (room) sendAction(room, action)
  })

  // Fire (hold left mouse) and reload (R), only while the pointer is locked,
  // in a team camera, connected and alive. The client sends aim only; the
  // server decides ammo, cooldown and hits. Feedback comes from server events.
  const combatActive = (): boolean =>
    room !== null &&
    rig.mode !== 'overhead' &&
    document.pointerLockElement === canvas &&
    vitals !== null &&
    vitals.team !== null &&
    !isEliminated(vitals.health)
  const fireInput = new FireInput(combatActive, () => {
    if (room) sendReload(room)
  })
  const pacer = new FirePacer()
  const feedback = createCombatFeedback(view.scene, app)

  // One shared 20 Hz tick: held keys are camera-relative intent (strafe dx,
  // forward dz) sent with the camera yaw; with no key held, a yaw-only move
  // is sent only when the camera turned. The server decides the actual step.
  // `lastSentYaw` starts at the camera's starting yaw (the server's), so
  // nothing is sent until a key is pressed or the mouse turns the camera.
  let lastSentYaw: number | null = null
  setInterval(() => {
    const locked = document.pointerLockElement === canvas
    showVitals()
    hint.textContent = rig.mode !== 'overhead' && !locked ? 'Click to look around (Esc releases the mouse)' : ''
    if (!room) return
    if (fireInput.firing() && vitals && vitals.team && vitals.ammo > 0 && !vitals.reloading) {
      if (pacer.due(performance.now(), vitals.team)) {
        sendFire(room, rig.yaw, -rig.pitch) // camera pitch is positive down; the wire is positive up
      }
    }
    const keys = input.direction()
    if (rig.mode === 'overhead') {
      lastSentYaw = null
      if (keys) sendMove(room, keys) // no yaw: the server keeps the current facing
      return
    }
    const yaw = rig.yaw
    if (lastSentYaw === null) lastSentYaw = yaw
    const turned = Math.abs(wrapAngle(yaw - lastSentYaw)) > YAW_SEND_EPSILON
    if (keys || turned) {
      sendMove(room, { dx: keys?.dx ?? 0, dz: keys?.dz ?? 0, yaw })
      lastSentYaw = yaw
    }
  }, 1000 / MOVE_SEND_HZ)

  let playerCount: number | null = null
  let localTeam: Team | null = null
  const showOnline = (): void =>
    setStatus(
      playerCount === null
        ? 'online, waiting for player state'
        : `online, ${playerCount} player${playerCount === 1 ? '' : 's'}` +
            (localTeam ? `, you are ${TEAM_LABEL[localTeam]}` : ''),
    )

  // Watches the local player's team (as received from room state) for the HUD.
  const inner = testHook.wrapView(view)
  const watched: PlayerView = {
    upsertPlayer(id, x, z, isLocal = false, pose) {
      inner.upsertPlayer(id, x, z, isLocal, pose)
      // The camera follows your own player's server position only.
      if (isLocal) rig.setLocalPlayer(id, x, z, pose?.team ?? null, pose?.yaw ?? 0, pose?.y ?? 0)
      if (isLocal) {
        local = { team: pose?.team ?? null, mode: pose?.mode ?? 'ground', x, y: pose?.y ?? 0, z }
        showMode()
        vitals = pose?.team
          ? { team: pose.team, health: pose.health ?? 1, ammo: pose.ammo ?? 0, reloading: pose.reloading ?? false }
          : null
        showVitals()
      }
      if (isLocal && pose && pose.team !== localTeam) {
        localTeam = pose.team
        if (room) showOnline()
      }
    },
    removePlayer: (id) => inner.removePlayer(id),
  }

  setStatus('connecting...')
  joinGame(watched, (count) => {
    playerCount = count
    if (room) showOnline()
  })
    .then((joined) => {
      room = joined
      testHook.setConnected(joined.sessionId)
      showOnline()
      onCombatEvents(joined, {
        onShot: (e) => {
          testHook.recordEvent('shot')
          feedback.shot(e, joined.sessionId)
        },
        onHit: (e) => {
          testHook.recordEvent(e.killed ? 'kill' : 'hit')
          if (e.killed) testHook.recordEvent('hit')
          feedback.hit(e)
        },
        onDamaged: (e) => {
          testHook.recordEvent('damaged')
          feedback.damaged(e)
        },
      })
      joined.onLeave(() => {
        room = null
        localTeam = null
        local = null
        vitals = null
        showMode()
        showVitals()
        rig.reset()
        testHook.setDisconnected()
        setStatus('disconnected from server')
      })
      joined.onError((code, message) => console.warn('Room error', code, message))
    })
    .catch((err: unknown) => {
      setStatus('offline (could not reach the server)')
      console.warn('Could not join the game room:', err)
    })
}
