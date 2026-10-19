import './style.css'
import { createGameScene, type GameScene } from './scene.ts'
import { MovementInput } from './input.ts'
import { joinGame, sendMove, type PlayerView } from './net.ts'
import type { Team } from '../../shared/protocol.js'
import type { Room } from '@colyseus/sdk'
import { installTestHook } from './testHook.ts'
import { wrapAngle } from './cameras.ts'

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

  // One shared 20 Hz tick: held keys are camera-relative intent (strafe dx,
  // forward dz) sent with the camera yaw; with no key held, a yaw-only move
  // is sent only when the camera turned. The server decides the actual step.
  // `lastSentYaw` starts at the camera's starting yaw (the server's), so
  // nothing is sent until a key is pressed or the mouse turns the camera.
  let lastSentYaw: number | null = null
  setInterval(() => {
    const locked = document.pointerLockElement === canvas
    hint.textContent = rig.mode !== 'overhead' && !locked ? 'Click to look around (Esc releases the mouse)' : ''
    if (!room) return
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
      joined.onLeave(() => {
        room = null
        localTeam = null
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
