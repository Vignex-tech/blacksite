import './style.css'
import { createGameScene } from './scene.ts'

const app = document.querySelector<HTMLDivElement>('#app')!
const canvas = document.createElement('canvas')
canvas.id = 'game-canvas'
app.appendChild(canvas)

const hud = document.createElement('div')
hud.id = 'hud'
hud.textContent = 'Blacksite - offline (local preview)'
app.appendChild(hud)

try {
  const game = createGameScene(canvas)
  // Local placeholder until #4 connects to the server.
  game.upsertPlayer('local', 0, 0)
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
