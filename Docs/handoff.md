# Session hand-off

Last updated 2026-10-19 by the director, on the owner's Windows PC (8 GB RAM). Read this before starting work.

## State
- Repo: `Vignex-tech/blacksite` (private), branch `main`. Milestones #1, #9 (M2) and #17 (M3) are done; the last green CI commit is `5c10c44`.
- CI: `.github/workflows/ci.yml` (job `build-and-test`) builds the client and server, then runs Mocha (server), Vitest (`Tests/unit`) and Playwright (`Tests/e2e`). **Nothing counts as done until CI passes** (see `CLAUDE.md`).
- Next: milestone 4 (vertical movement and climbing, see `Docs/phase1-plan.md`). **No M4 issues are filed yet; the owner decides when and how.** Known follow-ups from M3 are in `Docs/backlog.md`.

### Shared contract (`shared/`)
- Plain ESM `.js` runtime files with `.d.ts` types, and `shared/package.json` (`"type": "module"`). The client imports `../../shared/<file>.js` and the server `../../../shared/<file>.js` (from `server/src/rooms/` or `server/src/rules/`).
- `protocol.js`: `ROOM_NAME` (`my_room`), `MOVE_MESSAGE` (`move`), `GROUND_SIZE` (40, centred on 0), `PlayerState` and `GameRoomState`. Added in M3 (#18):
  - `TEAMS`: frozen `['ghost', 'warden']`, equal to the keys of `GRAYBOX_MAP.spawnAreas`; type `Team = 'ghost' | 'warden'`.
  - `MAX_TEAM_SIZE` 4.
  - `TEAM_SPEED`: frozen `{ ghost: 2.4, warden: 2.0 }` world units/s (step per accepted move = speed / 20 Hz, so 0.12 and 0.1).
  - `MoveMessage { dx, dz, yaw? }`: camera-relative intent. `dx` is strafe (+1 right), `dz` forward (+1 forward), each -1..1. Yaw is in radians; 0 faces +z and positive turns toward +x (Babylon `rotation.y`). Forward is (sin yaw, cos yaw) and right is (cos yaw, -sin yaw) on (x, z). A missing yaw keeps the player's current yaw, so at yaw 0 the M2 meaning (W is +z, D is +x) still holds. `dx = dz = 0` with a yaw only turns.
  - `PlayerState { x, z, team, yaw }`: `team` and `yaw` are required (since #22).
- `map.js` / `map.d.ts`: `GRAYBOX_MAP` (id `graybox-1`, deep-frozen) with `bounds` (+-20, from `GROUND_SIZE`), **16 solids** (`kind` `wall` or `cover`, axis-aligned boxes, walls 3 tall and cover 1.2), **4 entrances** into the central building, **spawn areas** `ghost` (outside, south: x -4..4, z -18..-14) and `warden` (inside, north half: x -3..3, z 2..5), and **2 terminals** (`terminal-a`, `terminal-b`; data only, nothing uses them until M6). It also exports `PLAYER_HALF_SIZE` (0.5) and `PLAYER_HEIGHT` (1.8). The axis conventions and the 8 map invariants are written at the top of `map.d.ts`.
- `testhook.d.ts` (types only, no `.js`): the `window.__blacksite` hook (see Client).
- Don't add `../shared` to the server's tsconfig `include` and don't turn the `.js` files into `.ts`. Either change moves `rootDir` to the repo root and breaks the `build/index.js` layout (details in #6's comments).

### Server (`server/`)
- Colyseus 0.18. `server/src/rooms/MyRoom.ts` and `schema/MyRoomState.ts`: `Player { x, z, team, yaw }` in a `players` map keyed by sessionId. `maxClients` is `MAX_CLIENTS` (8 = 2 teams x `MAX_TEAM_SIZE`).
- `server/src/rules/` holds pure rule code with no Colyseus imports:
  - `collision.ts`: `groundSolids` keeps solids whose y range overlaps 0..PLAYER_HEIGHT. `resolveMove` moves on x, then on z, each swept against those solids, so a box stops flush with the first face in its path at any step size and never tunnels. It then clamps the box inside the map bounds. Touching a face isn't overlap, so players slide along walls. Players don't collide with each other.
  - `teams.ts` (`assignTeam`): counts the players currently in the room and picks the team with fewer players; ties go to ghost. If that team already has `MAX_TEAM_SIZE`, the join is refused (onJoin throws). Join options are ignored (a forged `{ team: 'warden' }` does nothing). No rebalancing when someone leaves; a player keeps their team until they leave. A fresh room fills ghost, warden, ghost, warden.
  - `spawn.ts`: `randomSpawnPoint` picks a uniform point in `spawnAreas[team]`, tries up to 50 times to avoid solids, then falls back to the area's centre. Players spawn at yaw `SPAWN_YAW` (0). `joinCount` and `spawnAreaForJoin` are gone.
  - `movement.ts` (`parseMove`, re-exported from `MyRoom.ts`): the whole message is ignored if it isn't a non-array object with finite-number `dx` and `dz`, or if `yaw` is present and isn't a finite number. Ignored messages spend no rate-limit token. Each axis is clamped to -1..1 and the intent length is capped at 1 (so diagonals are normalised). Yaw is wrapped into -pi..pi and stored before the move; the intent is rotated by yaw and scaled by `TEAM_STEP[team]`, then collided and clamped to +-`BOUND` (19.5).
- Token-bucket rate limit per client, server-side only: `MOVE_RATE_HZ` 20, `MOVE_BURST` 3. Every accepted message, turn-only included, spends one token. Over-budget moves are dropped silently, so sustained speed is at most 2.4 (ghost) and 2.0 (warden) units/s.
- `MyRoom.ts` exports `MOVE_RATE_HZ`, `MOVE_BURST`, `BOUND`, `PLAYER_HALF_SIZE` (re-exported from `shared/map.js`), `TEAM_STEP` (frozen, `TEAM_SPEED[team] / MOVE_RATE_HZ`), `MAX_CLIENTS`, `SPAWN_YAW` and `parseMove`. `SPEED` is kept as a legacy export (`=== TEAM_STEP.warden`, 0.1); movement no longer uses it. `Tests/` imports these from `server/build/rooms/MyRoom.js`, so renaming or removing one breaks the tests.
- The server serves `client/dist` with `express.static`, so the whole game runs on one port (2567). `/playground` and `/monitor` are dev-only; with `NODE_ENV=production` both are off.

### Client (`client/`)
- `client/src/map.ts` `buildMap` renders `GRAYBOX_MAP`: the ground sized from `bounds`, one box per solid (`solid-<id>`; walls light grey, cover darker), and a green emissive post per terminal (`terminal-<id>`, no collision). Nothing in `client/` hard-codes the layout, and a unit test checks that.
- `client/src/players.ts` (`createPlayerRenderer(scene)`): graybox shapes built in code. Ghost is a slim dark-violet cylinder (0.7 x 1.8), Warden a bulkier orange box (1 x 1.8 x 1). Each has a yellow emissive nose on local +z near the top, and `body.rotation.y = yaw`. Your own player is tinted blue whatever its team. Until the team is known the player is a small neutral cube; the shape is rebuilt when the team arrives or changes. Mesh names: `player-<id>` and `player-<id>-nose` (a child). Body `metadata` is `{ team, isLocal }`.
- `client/src/cameras.ts` (`createCameraRig`): the mode follows your own team in server state. `overhead` (the old top-down ArcRotateCamera, beta 0.4, radius 56) until the team is known and after disconnect; `third-person` for a Ghost; `first-person` for a Warden.
  - Pointer lock on canvas click; Esc releases it. Only while locked, mouse X turns yaw and mouse Y tilts pitch at **0.0025 rad per pixel**. Pitch is local and never sent. Positive pitch looks down.
  - Ghost: orbits a shoulder point 1.7 up and 0.6 to the right, 3.2 back (camera height floored at 0.3), starting pitch 0.25, limits -0.5..1.0. No camera collision yet.
  - Warden: eye at 1.6 on the player's server x/z, pitch limits -1.4..1.4, near plane 0.05, fov 1.0. **Your own body and nose are hidden in first person** (`isVisible = false`, checked every frame because the mesh can be rebuilt).
  - `#camera-hint` (bottom centre, separate from `#hud`) says "Click to look around (Esc releases the mouse)" in team modes while the pointer isn't locked.
- It joins `my_room` (`client/src/net.ts`). The WebSocket URL comes from `location` (`wss:` on https; on the Vite dev port 5173 it uses port 2567 on the same host).
- Input (`input.ts`, `main.ts`): one shared **20 Hz tick** combines keys and camera yaw. With WASD or arrow keys held it sends `{ dx, dz, yaw }` (keys as -1/0/1, yaw = camera yaw). With no keys held it sends a yaw-only `{ dx: 0, dz: 0, yaw }` only when the camera yaw differs from the last sent yaw by more than 0.01 rad. Nothing is sent when idle, on load or on focus. In overhead mode keys send `{ dx, dz }` with no yaw. Nothing moves locally; meshes follow server state (no smoothing yet).
- The HUD (`#hud`) shows "connecting...", "online, N players, you are a Ghost" (or "a Warden"), "offline" or "disconnected". If WebGL fails to start, the page shows a message instead of a blank canvas.
- **Test hook** (`client/src/testHook.ts`, types in `shared/testhook.d.ts`): `window.__blacksite.snapshot()` returns a fresh plain copy on every call:
  `{ version: 1, connected, sessionId, localTeam, players: [{ id, x, z, isLocal, team, yaw }] (sorted by id), map: { id, renderedSolids }, camera?: { mode, yaw } }`.
  `team` is `Team | null` and `yaw` a number, both from received state only; `localTeam` is the local player's team. `camera` is present once the game scene exists (always, in a browser that loaded) and absent if WebGL failed. After joining, `map` is `{ id: 'graybox-1', renderedSolids: 16 }`; before the map is rendered it is `{ id: null, renderedSolids: 0 }`. The hook is installed before WebGL starts, is frozen and can't be replaced. It ships in the production build and shows only what the client received. `connected` turns true before the players arrive, so poll for the player count. Fields may be added in version 1; bump `version` only when a field is removed or changes meaning.

### Tests
- **Mocha** (`server/test/`): `MyRoom.test.ts`, `collision.test.ts`, `movement.test.ts`, `teams.test.ts`, with helpers in `mapHelpers.ts`. All files share one `@colyseus/testing` server from `server/test/testServer.ts`, because booting a second one in the same process after shutdown breaks match-making.
- **Vitest** (`Tests/unit`): `map`, `mapRender`, `mapSources` (no layout hard-coded in `client/`, no Babylon or browser code in `shared/`), `testHook`, plus from M3 `protocol` (TEAMS, TEAM_SPEED, MAX_TEAM_SIZE, the yaw formula), `players` (shapes, materials, rotation, rebuild on team change, on NullEngine), `cameras` (modes, offsets, 0.0025 rad/px only while locked, pitch limits, reset on disconnect, the hook's `camera`), `input` (keys to dx/dz) and `frames` (the wire-frame decoder on real captured frames).
- **Playwright** (`Tests/playwright.config.ts`) starts the built server in production mode:
  - `server-integration` (`*.integration.spec.ts`, runs first, **2 workers**: the SDK specs only create rooms and join by id): `room.integration.spec.ts` (sync, moves, invalid payloads, spawns, walls, sliding, every entrance, bounds, rate limit, overlap watch) and `teams.integration.spec.ts` (balance 1v1 to 4v4, 9th join refused, leave and rejoin, forged team option, per-team step, camera-relative moves, yaw wrap and validation, turn-only floods rate limited).
  - `chromium` (runs after it, **1 worker**, because every browser page joins the one shared `my_room`): `client-loads`, `server`, `two-players`, `wall-collision`, `map`, `facing` (an SDK client turns; both tabs see the yaw) and `cameras` (the M3 gate: ghost third-person and warden first-person, W at yaw 0, camera-relative W/D after a turn, per-team speed, a rotated wall slide, the moves actually sent on the wire, pointer-lock release, leave and rejoin, network drop back to overhead).
  - Helpers in `Tests/e2e/support/`: `intent.ts` (`worldStep`, the yaw formula), `movement.ts` (`stepFor`), `sdk.ts` (SDK helpers and `Walker`), `hook.ts`, `tabs.ts`, `frames.ts` (decodes the moves a tab sends), `geometry.ts`, `legs.ts`.
  - **Pointer-lock stand-in for headless Linux CI:** in headless Chromium on Linux a real pointer lock fires a mousemove every frame with a bogus first `movementX`, and slows the page enough to drop the move timer to about 13 Hz. So `lockPointer()` clicks the canvas, checks the lock was really granted, releases it and then stands in for it (`document.pointerLockElement` reports the canvas until `exitPointerLock()`); `moveMouse()` dispatches mousemove events with `movementX` on the document. No client code is stubbed.
  - e2e takes about 80 s in CI (32 tests).
- **CI artifact:** every run uploads `Tests/Reports/` as **`graybox-map-screenshot`** (kept 30 days) with 3 screenshots: `graybox-map.png` (overhead, no players), `graybox-ghost-third-person.png` and `graybox-warden-first-person.png`. They're for humans; no test compares pixels. Failed runs also upload `playwright-report`.

## Milestone #1: two tabs join the same room and each sees the other move (done)
Issues #1 to #8, all closed with green CI (last commit `a5c805e`).

## Milestone 2: graybox map, server collision, client test hook (tracking #9, done)
| # | Issue | Agent | Status |
|---|---|---|---|
| 10 | Shared graybox map data contract (`shared/map.js`) | gameplay-engineer | done (738f52e) |
| 11 | Client test hook: read-only `window.__blacksite` snapshot | gameplay-engineer | done (afc4296) |
| 12 | QA: move the two-tab test onto the test hook | qa-build | done (a7da699) |
| 13 | Server: collide moves with map solids, spawn in spawn areas | server-engineer | done (59f9f49) |
| 15 | QA: verify server map collision and spawns | qa-build | done (ba28433) |
| 14 | Client: render the graybox map from shared data | gameplay-engineer | done (9a5ec95) |
| 16 | QA: verify the map data and its rendering | qa-build | done (9c0c0b0) |

## Milestone 3: teams, per-team speed and cameras (tracking #17, done)
All issues closed with green CI; the last green commit is `5c10c44`.
| # | Issue | Agent | Status |
|---|---|---|---|
| 18 | Shared contract: teams, per-team speed, camera yaw on move | gameplay-engineer | done (79c93e6) |
| 19 | QA: make existing tests ready for teams and camera-relative movement | qa-build | done (68360fd) |
| 20 | Server: balanced teams, team spawns, per-team speed, camera-relative moves | server-engineer | done (edf41ec) |
| 21 | QA: verify server teams, spawns, per-team speed and yaw validation | qa-build | done (03b8ebc) |
| 22 | Client: team shapes, facing, team in HUD, team and yaw in test hook | gameplay-engineer | done (dd9b8f7) |
| 23 | QA: verify team and facing in both tabs and in the meshes | qa-build | done (c8aee4e) |
| 24 | Client: Ghost third-person and Warden first-person cameras, camera-relative input | gameplay-engineer | done (1c196e8) |
| 25 | QA: M3 gate, per-team cameras, camera-relative moves, per-team speed | qa-build | done (e63260b, 225756d, a959f86, 5c10c44) |

## Decisions and open questions
- Agents (`.claude/agents/`): director, gameplay-engineer, server-engineer, qa-build. Each edits only its own folders. The main session dispatches issues from the director's hand-off table, because subagents can't start other subagents.
- **Decided:** map data lives in `shared/` (owned by gameplay-engineer) so the server can use it for collision and validation; collision, spawn, team and movement code lives in `server/src/rules/`. No level-builder agent for now (see `Docs/phase1-plan.md`).
- **Decided:** the client test hook `window.__blacksite` ships in the production build and shows only what the client already received.
- **Decided by the owner on #9 (hidden information, rule 2):** every client receives every player's position until M5. In M5 the server adds a line-of-sight filter, reusing the weapon raycast, so Warden clients stop receiving Ghost positions they couldn't see. Test matches before M5 are not cheat-proof.
- **Decided by the owner on #9:** #16 could edit `.github/workflows/ci.yml` to upload the map screenshot artifact (done).
- **In place since M3, owner may still change:** Ghost 2.4 and Warden 2.0 units/s (`TEAM_SPEED`, one place in `shared/protocol.js`); teams balanced on join with ties going to ghost; no rebalancing when someone leaves; clients can't choose a team; everyone spawns facing +z.
- **Open:** Milestone 4 issues are not filed; the owner decides.
- `CLAUDE.md` holds the game brief and the rules every agent follows. The detailed original brief is the owner's master prompt, kept outside the repo.
- Env files: `.env` and `.env.*` are git-ignored; only `server/.env.example` is committed.
- Blender is deferred until the art phase, to save RAM.

## Running and sharing locally
1. `npm run build` in `client/`.
2. `npm run build` in `server/`, then start it with `NODE_ENV=production node build/index.js` (port 2567).
3. `cloudflared tunnel --url http://localhost:2567` prints a temporary `https://*.trycloudflare.com` link. It changes on every run and only works while the PC is on.

Dev work: `npm start` in `server/` (tsx watch) and `npm run dev` in `client/` (port 5173).

Playing: the first joiner is a Ghost (third person), the second a Warden (first person). Click the canvas to look around; Esc releases the mouse.

Tests locally: build the client and server first, then in `Tests/` run `npm run test:unit` and `npm run test:e2e` (outside CI, Playwright reuses a server already running on port 2567).

## Gotchas
- **Run only one agent at a time.** Agents share one working tree and one git index, so a parallel run can commit another agent's work. This happened once: an agent's commit included another agent's staged deletions. Always stage only your own folders (`git add <your folders>`), never `git add -A`.
- **Commit messages say `refs #N`, never `closes #N`.** `closes` makes GitHub close the issue on push, before CI has run. The agent closes its issue itself, with a comment linking the green run.
- **Don't comment on other agents' issues.** The owner's permission settings block it. Put notes for the next agent in your commit message and in the closing comment of your own issue.
- **The 20 Hz send timer shares the main thread with rendering**, and the server doesn't make up for missed ticks. On a slow machine (or headless tabs with software rendering) players move slower than their team speed; two headless tabs at 800x600 ran at about 11-14 Hz. The camera specs use a 320x240 viewport for this reason. Speed tests must allow for the tab's real send rate.
- Headless Chromium on Linux misbehaves under a real pointer lock (see Tests). Windows doesn't, so a camera test can pass locally and fail in CI; use the `lockPointer()` / `moveMouse()` helpers.
- The terminal meshes are named `terminal-terminal-a` and `terminal-terminal-b`, because the mesh name is `terminal-<id>` and the ids already start with `terminal-`. It's cosmetic; tests rely on the `terminal-<id>` pattern, so don't "fix" one side alone.
- On Windows, `npm test` in `server/` passes, then crashes when Mocha exits (`UV_HANDLE_CLOSING` assertion). It works fine on Linux CI, so trust CI.
- Synced numbers travel as float32: compare positions and yaws in tests with a tolerance (about 1e-4), not exact equality. Compare yaws modulo 2 pi: the server wraps them, so pi can arrive as -pi.
- Each client starts with a move budget of 3, and turn-only moves spend it too. A test that sends more than 3 moves back to back without waiting about 50 ms between them will see the later ones ignored.
- On this PC, `gh` is at `C:\Program Files\GitHub CLI\gh.exe` (in Bash: `"/c/Program Files/GitHub CLI/gh.exe"`); run it from inside the repo. Its login (Vignex-tech) has the `repo` and `workflow` scopes. `gh issue view` takes either `--comments` or `--json`, not both.
- Git: user.name is set only in this repo (`Vignex-tech`). There are LF/CRLF warnings on commit; they're harmless.
