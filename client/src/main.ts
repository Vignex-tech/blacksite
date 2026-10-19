import './style.css'
import { createGameScene, type GameScene } from './scene.ts'
import { ActionInput, FireInput, InteractInput, MovementInput } from './input.ts'
import {
  joinGame,
  onCombatEvents,
  onHackProgress,
  sendAction,
  sendFire,
  sendInteract,
  sendMove,
  sendReload,
  watchRound,
  watchTerminals,
  type PlayerView,
} from './net.ts'
import { climbPrompt, modeText, type LocalPlayerState } from './traversalHint.ts'
import { CAN_HACK, type Team } from '../../shared/protocol.js'
import type { Room } from '@colyseus/sdk'
import { installTestHook } from './testHook.ts'
import { wrapAngle } from './cameras.ts'
import { FirePacer } from './firePacer.ts'
import { createCombatFeedback } from './combat.ts'
import { HACKED_TEXT, hackAlertText, hackBarText, hackPrompt, progressPercent, type TerminalSnapshot } from './hackHint.ts'
import { bannerIsBig, bannerText, isFrozen, resultClass, resultText, timerText, type RoundView } from './roundView.ts'
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
  testHook.setPerf(() => game!.perf.read())
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

  // Round overlays (#72): text from state.round only; the client counts nothing.
  const roundTimer = document.createElement('div')
  roundTimer.id = 'round-timer'
  app.appendChild(roundTimer)
  const roundBanner = document.createElement('div')
  roundBanner.id = 'round-banner'
  app.appendChild(roundBanner)
  const roundResult = document.createElement('div')
  roundResult.id = 'round-result'
  roundResult.hidden = true
  app.appendChild(roundResult)
  let round: RoundView | null = null
  const frozen = (): boolean => isFrozen(round)
  const showRound = (): void => {
    const t = timerText(round)
    if (roundTimer.textContent !== t) roundTimer.textContent = t
    const b = bannerText(round)
    if (roundBanner.textContent !== b) roundBanner.textContent = b
    const big = bannerIsBig(round) ? 'big' : ''
    if (roundBanner.className !== big) roundBanner.className = big
    const r = resultText(round, local?.team ?? null)
    if (roundResult.textContent !== r) roundResult.textContent = r
    const cls = r === '' ? '' : resultClass(round)
    if (roundResult.className !== cls) roundResult.className = cls
    if (roundResult.hidden !== (r === '')) roundResult.hidden = r === ''
  }

  // Hack feedback (#60): prompt, Ghost-only progress bar and the Warden alert.
  // Everything shown comes from received state; nothing is predicted.
  const hackPromptLine = document.createElement('div')
  hackPromptLine.id = 'hack-prompt'
  app.appendChild(hackPromptLine)
  const hackBar = document.createElement('div')
  hackBar.id = 'hack-bar'
  app.appendChild(hackBar)
  const hackAlert = document.createElement('div')
  hackAlert.id = 'hack-alert'
  app.appendChild(hackAlert)
  const terminals = new Map<string, TerminalSnapshot>()
  let hackProgress: number | null = null
  const showHack = (): void => {
    const team = local?.team ?? null
    const p = frozen() ? '' : hackPrompt(local ? { ...local, health: vitals?.health } : null, terminals)
    if (hackPromptLine.textContent !== p) hackPromptLine.textContent = p
    const b = hackBarText(team, hackProgress, terminals)
    if (hackBar.textContent !== b) hackBar.textContent = b
    hackBar.style.setProperty('--progress', `${hackProgress === null ? 0 : progressPercent(hackProgress)}%`)
    const a = hackAlertText(team, terminals)
    if (hackAlert.textContent !== a) hackAlert.textContent = a
    const kind = a === HACKED_TEXT ? 'done' : ''
    if (hackAlert.className !== kind) hackAlert.className = kind
  }
  const showVitals = (): void => {
    const h = healthText(vitals)
    if (healthLine.textContent !== h) healthLine.textContent = h
    const a = ammoText(vitals)
    if (ammoLine.textContent !== a) ammoLine.textContent = a
    const show = !frozen() && crosshairVisible(rig.mode, vitals ? vitals.health : null)
    if (crosshair.hidden === show) crosshair.hidden = !show
  }
  let local: LocalPlayerState | null = null
  const showMode = (): void => {
    const text = modeText(local)
    if (modeLine.textContent !== text) modeLine.textContent = text
    const p = frozen() ? '' : climbPrompt(local)
    if (prompt.textContent !== p) prompt.textContent = p
  }

  // One message per press of Space, E or C; the server decides the outcome.
  new ActionInput((action) => {
    if (room && !frozen()) sendAction(room, action)
  })

  // Hold F to hack: true on keydown, false on keyup. Only a living Ghost in a
  // team camera sends anything; the server decides range and timing.
  const interactActive = (): boolean =>
    room !== null &&
    !frozen() &&
    rig.mode !== 'overhead' &&
    vitals !== null &&
    vitals.team !== null &&
    CAN_HACK[vitals.team] &&
    !isEliminated(vitals.health)
  const interactInput = new InteractInput(interactActive, (active) => {
    if (room) sendInteract(room, active)
  })

  // Fire (hold left mouse) and reload (R), only while the pointer is locked,
  // in a team camera, connected and alive. The client sends aim only; the
  // server decides ammo, cooldown and hits. Feedback comes from server events.
  const combatActive = (): boolean =>
    room !== null &&
    !frozen() &&
    rig.mode !== 'overhead' &&
    document.pointerLockElement === canvas &&
    vitals !== null &&
    vitals.team !== null &&
    !isEliminated(vitals.health)
  const fireInput = new FireInput(combatActive, () => {
    if (room && !frozen()) sendReload(room)
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
    showHack()
    showRound()
    showMode()
    interactInput.sync()
    hint.textContent = rig.mode !== 'overhead' && !locked ? 'Click to look around (Esc releases the mouse)' : ''
    if (!room || frozen()) return // frozen by the round: the server would ignore it
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
        showHack()
        showRound()
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
      watchTerminals(joined, (id, status, alert) => {
        terminals.set(id, { status, alert })
        testHook.setTerminal(id, status, alert)
        view.terminals.update(id, status)
        showHack()
      })
      watchRound(joined, (r) => {
        round = r
        testHook.setRound(r)
        showRound()
        showMode()
        showVitals()
        showHack()
      })
      onHackProgress(joined, (progress) => {
        hackProgress = progress
        testHook.setHackProgress(progress)
        showHack()
      })
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
        terminals.clear()
        hackProgress = null
        round = null
        testHook.setRound(null)
        view.terminals.reset()
        interactInput.sync()
        showMode()
        showVitals()
        showHack()
        showRound()
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
