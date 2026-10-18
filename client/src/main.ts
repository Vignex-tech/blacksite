import './style.css'
import { createGameScene, type GameScene } from './scene.ts'
import { MovementInput } from './input.ts'
import { joinGame, sendMove } from './net.ts'
import type { Room } from '@colyseus/sdk'
import { installTestHook } from './testHook.ts'

/** How often a held movement key sends a "move" message. */
const MOVE_SEND_HZ = 20

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

if (game) start(game)

function start(view: GameScene): void {
  const input = new MovementInput()
  let room: Room | null = null

  setInterval(() => {
    const move = input.direction()
    if (room && move) sendMove(room, move)
  }, 1000 / MOVE_SEND_HZ)

  let playerCount: number | null = null
  const showOnline = (): void =>
    setStatus(
      playerCount === null
        ? 'online, waiting for player state'
        : `online, ${playerCount} player${playerCount === 1 ? '' : 's'}`,
    )

  setStatus('connecting...')
  joinGame(testHook.wrapView(view), (count) => {
    playerCount = count
    if (room) showOnline()
  })
    .then((joined) => {
      room = joined
      testHook.setConnected(joined.sessionId)
      showOnline()
      joined.onLeave(() => {
        room = null
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
