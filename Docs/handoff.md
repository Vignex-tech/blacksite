# Session hand-off

Last updated 2026-10-18 by the director, on the owner's Windows PC (8 GB RAM). Read this before starting work.

## State
- Repo: `Vignex-tech/blacksite` (private), branch `main`. Milestone #1 is done; CI passed on `a5c805e`.
- CI: `.github/workflows/ci.yml` (job `build-and-test`) builds the client and server, then runs Mocha (server), Vitest (`Tests/unit`) and Playwright (`Tests/e2e`). **Nothing counts as done until CI passes** (see `CLAUDE.md`).
- Next: milestone 2 (tracking issue #9). The plan for the rest of Phase 1 is in `Docs/phase1-plan.md`.

### Shared contract (`shared/`)
- `shared/protocol.js` (runtime values, plain ESM, no build step) and `shared/protocol.d.ts` (types), with `shared/package.json` (`"type": "module"`). Both sides import `../../shared/protocol.js` (client) or `../../../shared/protocol.js` (from `server/src/rooms/`).
- Contents: `ROOM_NAME` (`my_room`), `MOVE_MESSAGE` (`move`, payload `MoveMessage { dx, dz }`), `GROUND_SIZE` (40, centred on 0), `PlayerState { x, z }` and `GameRoomState`.
- Don't add `../shared` to the server's tsconfig `include` and don't turn the `.js` into `.ts`. Either change moves `rootDir` to the repo root and breaks the `build/index.js` layout (details in #6's comments).

### Client (`client/`)
- A Babylon.js scene (`client/src/scene.ts`): grey ground of `GROUND_SIZE`, a hemispheric light and a fixed overhead `ArcRotateCamera` (mouse only; arrow keys are for movement).
- It joins `my_room` (`client/src/net.ts`). The WebSocket URL comes from `location` (`wss:` on https; on the Vite dev port 5173 it uses port 2567 on the same host).
- WASD or arrow keys send `move` at 20 Hz while held (`client/src/input.ts`, `main.ts`). Nothing moves locally; boxes follow server state.
- Your own box is blue; everyone else's is orange. The HUD (`#hud`) shows "connecting...", "online, N players", "offline" or "disconnected".
- If WebGL fails to start, it shows a message instead of a blank page.

### Server (`server/`)
- Colyseus 0.18. `server/src/rooms/MyRoom.ts` and `schema/MyRoomState.ts`: `Player { x, z }` in a `players` map keyed by sessionId; random spawn within ±`SPAWN_SPREAD` (3); join adds and leave removes.
- The `move` handler validates the payload (an object with finite `dx` and `dz`; anything else is ignored, not fatal), clamps input to -1..1, moves `SPEED` (0.1) per message and clamps to ±`BOUND` (19.5).
- Token-bucket rate limit per client, kept server-side only: `MOVE_RATE_HZ` 20, `MOVE_BURST` 3. Over-budget moves are dropped silently. Sustained speed is at most 2 units/s.
- Constants (`SPEED`, `MOVE_RATE_HZ`, `MOVE_BURST`, `PLAYER_HALF_SIZE`, `BOUND`, `SPAWN_SPREAD`) are exported from `MyRoom.ts`. `Tests/` imports them from `server/build/rooms/MyRoom.js`, so renaming or removing one breaks the tests.
- The server also serves `client/dist` with `express.static`, so the whole game runs on one port (2567). `/playground` and `/monitor` are dev-only; with `NODE_ENV=production` both are off.

### Tests
- Mocha (`server/test/MyRoom.test.ts`): join and leave, moves, invalid payloads, clamping, rate limit with a controlled clock (`room.now`).
- Playwright (`Tests/playwright.config.ts`) starts the built server in production mode and runs two projects with `workers: 1`, because every browser page joins the one shared `my_room`:
  - `server-integration` (`*.integration.spec.ts`, runs first): two real `@colyseus/sdk` clients check state sync, moves, invalid payloads and leave.
  - `chromium` (runs after it): `client-loads.spec.ts`, `server.spec.ts` and `two-players.spec.ts`. The two-tab test reads each tab's view from a screenshot of the canvas, split by colour (blue is own box, orange is the other). That depends on the box colours and the fixed camera; #11 and #12 move it onto a `window.__blacksite` test hook.
- Vitest (`Tests/unit`): no tests yet (`passWithNoTests`); #16 adds the first.

## Milestone #1: two tabs join the same room and each sees the other move (done)
| # | Issue | Agent | Status |
|---|---|---|---|
| 1 | Milestone (tracking) | none | done |
| 2 | Babylon scene: ground, camera, light, a box per player | gameplay-engineer | done (fc9e3b9) |
| 3 | QA: check the scene; start the Colyseus server in Playwright | qa-build | done (32b228a) |
| 4 | Join the shared room, WASD movement, render players; `shared/` contract | gameplay-engineer | done (c5dd6bb) |
| 5 | QA: two-tab Playwright test, each sees the other move | qa-build | done (86660b1) |
| 6 | Server: player state, join/leave and validated move handler | server-engineer | done (5ede98a) |
| 7 | QA: verify server player state, join/leave and move validation | qa-build | done (8340d1e) |
| 8 | Server: per-client move rate limit | server-engineer | done (a5c805e) |

## Milestone 2: graybox map, server collision, client test hook (tracking #9)
Run in this order, one agent at a time:
| # | Issue | Agent | Depends on |
|---|---|---|---|
| 10 | Shared graybox map data contract (`shared/map.js`) | gameplay-engineer | none |
| 11 | Client test hook: read-only `window.__blacksite` snapshot | gameplay-engineer | none |
| 12 | QA: move the two-tab test onto the test hook | qa-build | #11 |
| 13 | Server: collide moves with map solids, spawn in spawn areas | server-engineer | #10, #12 |
| 15 | QA: verify server map collision and spawns | qa-build | #13 |
| 14 | Client: render the graybox map from shared data | gameplay-engineer | #10, #12 |
| 16 | QA: verify the map data and its rendering | qa-build | #10, #14 |

## Decisions and open questions
- Agents (`.claude/agents/`): director, gameplay-engineer, server-engineer, qa-build. Each edits only its own folders. The main session dispatches issues from the director's hand-off table, because subagents can't start other subagents.
- **Decided:** map data lives in `shared/` (owned by gameplay-engineer) so the server can use it for collision and validation; collision code lives in `server/src/rules/`. No level-builder agent for now (see `Docs/phase1-plan.md`).
- **Decided:** the client test hook `window.__blacksite` ships in the production build and exposes only what the client already received.
- **Open, for the owner:** hidden information (rule 2). Every client currently receives every player's position. The director recommends a basic line-of-sight filter in milestone 5 (details in `Docs/phase1-plan.md`).
- `CLAUDE.md` holds the game brief and the rules every agent follows. The detailed original brief is the owner's master prompt, kept outside the repo.
- Env files: `.env` and `.env.*` are git-ignored; only `server/.env.example` is committed.
- Blender is deferred until the art phase, to save RAM.

## Running and sharing locally
1. `npm run build` in `client/`.
2. `npm run build` in `server/`, then start it with `NODE_ENV=production node build/index.js` (port 2567).
3. `cloudflared tunnel --url http://localhost:2567` prints a temporary `https://*.trycloudflare.com` link. It changes on every run and only works while the PC is on.

Dev work: `npm start` in `server/` (tsx watch) and `npm run dev` in `client/` (port 5173).

Tests locally: build client and server first, then in `Tests/` run `npm run test:unit` and `npm run test:e2e` (Playwright reuses a server already on port 2567 outside CI).

## Gotchas
- **Run only one agent at a time.** Agents share one working tree and one git index, so a parallel run can commit another agent's work. This happened once: an agent's commit included another agent's staged deletions. Always stage only your own folders (`git add <your folders>`), never `git add -A`.
- On Windows, `npm test` in `server/` passes, then crashes when Mocha exits (`UV_HANDLE_CLOSING` assertion). It works fine on Linux CI, so trust CI.
- Synced numbers travel as float32: compare positions in tests with a tolerance (about 1e-4), not exact equality.
- Each client starts with a move budget of 3. A test that sends more than 3 moves back to back without waiting about 50 ms between them will see the later ones ignored.
- On this PC, `gh` is at `C:\Program Files\GitHub CLI\gh.exe` (in Bash: `"/c/Program Files/GitHub CLI/gh.exe"`); run it from inside the repo. Its login (Vignex-tech) has the `repo` and `workflow` scopes.
- Git: user.name is set only in this repo (`Vignex-tech`). There are LF/CRLF warnings on commit; they're harmless.
