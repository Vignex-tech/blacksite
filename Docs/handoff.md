# Session hand-off

Last updated 2026-10-18 by the director, on the owner's Windows PC (8 GB RAM). Read this before starting work.

## State
- Repo: `Vignex-tech/blacksite` (private), branch `main`. Milestones #1 and #9 (M2) are done; CI passed on `9c0c0b0`.
- CI: `.github/workflows/ci.yml` (job `build-and-test`) builds the client and server, then runs Mocha (server), Vitest (`Tests/unit`) and Playwright (`Tests/e2e`). **Nothing counts as done until CI passes** (see `CLAUDE.md`).
- Next: milestone 3 (tracking issue #17): teams, per-team speed, camera-relative movement and per-team cameras. The plan for the rest of Phase 1 is in `Docs/phase1-plan.md`.

### Shared contract (`shared/`)
- Plain ESM `.js` runtime files with `.d.ts` types, and `shared/package.json` (`"type": "module"`). The client imports `../../shared/<file>.js` and the server `../../../shared/<file>.js` (from `server/src/rooms/` or `server/src/rules/`).
- `protocol.js`: `ROOM_NAME` (`my_room`), `MOVE_MESSAGE` (`move`, payload `MoveMessage { dx, dz }`), `GROUND_SIZE` (40, centred on 0), `PlayerState { x, z }` and `GameRoomState`. M3 (#18) adds teams, `TEAM_SPEED` and an optional `yaw` on `move`.
- `map.js` / `map.d.ts`: `GRAYBOX_MAP` (id `graybox-1`, deep-frozen) with `bounds` (+-20, from `GROUND_SIZE`), **16 solids** (`kind` `wall` or `cover`, axis-aligned boxes, walls 3 tall and cover 1.2), **4 entrances** into the central building, **spawn areas** `ghost` (outside, south: x -4..4, z -18..-14) and `warden` (inside, north half: x -3..3, z 2..5), and **2 terminals** (`terminal-a`, `terminal-b`; data only, nothing uses them until M6). It also exports `PLAYER_HALF_SIZE` (0.5) and `PLAYER_HEIGHT` (1.8). The axis conventions and the 8 map invariants are written at the top of `map.d.ts`.
- `testhook.d.ts` (types only, no `.js`): the `window.__blacksite` hook (see Client).
- Don't add `../shared` to the server's tsconfig `include` and don't turn the `.js` files into `.ts`. Either change moves `rootDir` to the repo root and breaks the `build/index.js` layout (details in #6's comments).

### Server (`server/`)
- Colyseus 0.18. `server/src/rooms/MyRoom.ts` and `schema/MyRoomState.ts`: `Player { x, z }` in a `players` map keyed by sessionId, with `maxClients` 4.
- `server/src/rules/` holds pure rule code with no Colyseus imports:
  - `collision.ts`: `groundSolids` keeps solids whose y range overlaps 0..PLAYER_HEIGHT. `resolveMove` moves on x, then on z, each swept against those solids, so a box stops flush with the first face in its path at any step size and never tunnels. It then clamps the box inside the map bounds. Touching a face isn't overlap, so players slide along walls. Players don't collide with each other.
  - `spawn.ts`: `spawnAreaForJoin(i)` **alternates ghost, warden, ghost, warden by join order for now**. Its counter (`joinCount` in `MyRoom.ts`) never goes down, so leaving and rejoining can unbalance teams; #20 replaces it with team assignment. `randomSpawnPoint` picks a uniform point in the area, tries up to 50 times to avoid solids, then falls back to the area's centre.
- The `move` handler validates the payload (an object with finite `dx` and `dz`; anything else is ignored, not fatal), clamps the input to -1..1, moves `SPEED` (0.1) per message, collides with the map and clamps to +-`BOUND` (19.5).
- Token-bucket rate limit per client, server-side only: `MOVE_RATE_HZ` 20, `MOVE_BURST` 3. Over-budget moves are dropped silently, so the sustained speed is at most 2 units/s.
- `MyRoom.ts` exports `SPEED`, `MOVE_RATE_HZ`, `MOVE_BURST`, `BOUND` and `PLAYER_HALF_SIZE` (re-exported from `shared/map.js`). `Tests/` imports them from `server/build/rooms/MyRoom.js`, so renaming or removing one breaks the tests. `SPAWN_SPREAD` is gone.
- The server serves `client/dist` with `express.static`, so the whole game runs on one port (2567). `/playground` and `/monitor` are dev-only; with `NODE_ENV=production` both are off.

### Client (`client/`)
- `client/src/map.ts` `buildMap` renders `GRAYBOX_MAP`: the ground sized from `bounds`, one box per solid (`solid-<id>`; walls light grey, cover darker), and a green emissive post per terminal (`terminal-<id>`, no collision). Nothing in `client/` hard-codes the layout, and a unit test checks that.
- Camera: a fixed `ArcRotateCamera`, now more top-down (beta 0.4, radius 56), framing the whole 40 x 40 map so players stay visible over the 3 m walls. Mouse only; the arrow keys are for movement. M3 (#24) replaces it with per-team cameras.
- It joins `my_room` (`client/src/net.ts`). The WebSocket URL comes from `location` (`wss:` on https; on the Vite dev port 5173 it uses port 2567 on the same host).
- WASD or the arrow keys send `move` at 20 Hz while held (`client/src/input.ts`, `main.ts`). Nothing moves locally; boxes follow server state. Your own box is blue and everyone else's is orange.
- The HUD (`#hud`) shows "connecting...", "online, N players", "offline" or "disconnected". If WebGL fails to start, the page shows a message instead of a blank canvas.
- **Test hook** (`client/src/testHook.ts`, types in `shared/testhook.d.ts`): `window.__blacksite.snapshot()` returns a fresh plain copy on every call:
  `{ version: 1, connected, sessionId, players: [{ id, x, z, isLocal }] (sorted by id), map: { id, renderedSolids } }`.
  After joining, `map` is `{ id: 'graybox-1', renderedSolids: 16 }`; before the map is rendered it is `{ id: null, renderedSolids: 0 }`. The hook is installed before WebGL starts, is frozen and can't be replaced. It ships in the production build and shows only what the client received. `connected` turns true before the players arrive, so poll for the player count. Fields may be added in version 1; bump `version` only when a field is removed or changes meaning.

### Tests
- **Mocha** (`server/test/`): `MyRoom.test.ts` (join and leave, moves, invalid payloads, clamping, rate limit with a controlled clock `room.now`, walls, sliding, corners, entrances, spawns, fuzz) and `collision.test.ts` (pure rules).
- **Vitest** (`Tests/unit`, no `passWithNoTests` any more):
  - `map.test.ts`: every invariant in `map.d.ts`, plus reachability (spawns, entrances, terminals) and a check that the entrances are the only ways in. Each check also runs on broken copies of the map.
  - `mapRender.test.ts`: `buildMap` on Babylon's `NullEngine` creates meshes that match the data.
  - `mapSources.test.ts`: a source grep that `client/` hard-codes no layout ids or coordinates and that `shared/` has no Babylon or browser code.
  - `testHook.test.ts`: the hook's snapshot shape and copying.
- **Playwright** (`Tests/playwright.config.ts`) starts the built server in production mode, with `workers: 1` because every browser page joins the one shared `my_room`:
  - `server-integration` (`*.integration.spec.ts`, runs first): real `@colyseus/sdk` clients check sync, moves, invalid payloads, spawn areas, wall stops and sliding, every entrance both ways, bounds and the rate limit, and check every state change for overlap.
  - `chromium` (runs after it): `client-loads`, `server`, `two-players` (both tabs read `snapshot()`), `wall-collision` (holding W stops at the wall face computed from `shared/map.js`) and `map` (both tabs render 16 solids and save a screenshot).
  - e2e takes about 50 s.
- **CI artifact:** every run uploads `Tests/Reports/` as **`graybox-map-screenshot`** (the full map with two players, kept 30 days). It's for humans to look at; no test compares its pixels. Failed runs also upload `playwright-report`.

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

## Milestone 3: teams, per-team speed and cameras (tracking #17)
Run in this order, one agent at a time. #19 adapts the existing tests (which assume one `SPEED`, W is +z, D is +x, and an exact snapshot shape) **before** the server changes movement, so CI never goes red and no agent edits another's folder.
| Order | # | Issue | Agent | Depends on |
|---|---|---|---|---|
| 1 | 18 | Shared contract: teams, per-team speed, camera yaw on move | gameplay-engineer | none |
| 2 | 19 | QA: make existing tests ready for teams and camera-relative movement | qa-build | #18 |
| 3 | 20 | Server: balanced teams, team spawns, per-team speed, camera-relative moves | server-engineer | #18, #19 |
| 4 | 21 | QA: verify server teams, spawns, per-team speed and yaw validation | qa-build | #20 |
| 5 | 22 | Client: team shapes, facing, team in HUD, team and yaw in test hook | gameplay-engineer | #20, #21 |
| 6 | 23 | QA: verify team and facing in both tabs and in the meshes | qa-build | #22 |
| 7 | 24 | Client: Ghost third-person and Warden first-person cameras, camera-relative input | gameplay-engineer | #22, #23 |
| 8 | 25 | QA: M3 gate, per-team cameras, camera-relative moves, per-team speed | qa-build | #24 |

## Decisions and open questions
- Agents (`.claude/agents/`): director, gameplay-engineer, server-engineer, qa-build. Each edits only its own folders. The main session dispatches issues from the director's hand-off table, because subagents can't start other subagents.
- **Decided:** map data lives in `shared/` (owned by gameplay-engineer) so the server can use it for collision and validation; collision and spawn code lives in `server/src/rules/`. No level-builder agent for now (see `Docs/phase1-plan.md`).
- **Decided:** the client test hook `window.__blacksite` ships in the production build and shows only what the client already received.
- **Decided by the owner on #9 (hidden information, rule 2):** every client receives every player's position until M5. In M5 the server adds a line-of-sight filter, reusing the weapon raycast, so Warden clients stop receiving Ghost positions they couldn't see. Test matches before M5 are not cheat-proof.
- **Decided by the owner on #9:** #16 could edit `.github/workflows/ci.yml` to upload the map screenshot artifact (done).
- **Proposed for M3, owner may change:** Ghost 2.4 and Warden 2.0 units/s (`TEAM_SPEED`, one place in `shared/protocol.js`); teams balanced on join with ties going to ghost; no rebalancing when someone leaves; clients can't choose a team; everyone spawns facing +z.
- `CLAUDE.md` holds the game brief and the rules every agent follows. The detailed original brief is the owner's master prompt, kept outside the repo.
- Env files: `.env` and `.env.*` are git-ignored; only `server/.env.example` is committed.
- Blender is deferred until the art phase, to save RAM.

## Running and sharing locally
1. `npm run build` in `client/`.
2. `npm run build` in `server/`, then start it with `NODE_ENV=production node build/index.js` (port 2567).
3. `cloudflared tunnel --url http://localhost:2567` prints a temporary `https://*.trycloudflare.com` link. It changes on every run and only works while the PC is on.

Dev work: `npm start` in `server/` (tsx watch) and `npm run dev` in `client/` (port 5173).

Tests locally: build the client and server first, then in `Tests/` run `npm run test:unit` and `npm run test:e2e` (outside CI, Playwright reuses a server already running on port 2567).

## Gotchas
- **Run only one agent at a time.** Agents share one working tree and one git index, so a parallel run can commit another agent's work. This happened once: an agent's commit included another agent's staged deletions. Always stage only your own folders (`git add <your folders>`), never `git add -A`.
- **Don't comment on other agents' issues.** The owner's permission settings block it. Put notes for the next agent in your commit message and in the closing comment of your own issue.
- The terminal meshes are named `terminal-terminal-a` and `terminal-terminal-b`, because the mesh name is `terminal-<id>` and the ids already start with `terminal-`. It's cosmetic; tests rely on the `terminal-<id>` pattern, so don't "fix" one side alone.
- On Windows, `npm test` in `server/` passes, then crashes when Mocha exits (`UV_HANDLE_CLOSING` assertion). It works fine on Linux CI, so trust CI.
- Synced numbers travel as float32: compare positions in tests with a tolerance (about 1e-4), not exact equality.
- Each client starts with a move budget of 3. A test that sends more than 3 moves back to back without waiting about 50 ms between them will see the later ones ignored.
- On this PC, `gh` is at `C:\Program Files\GitHub CLI\gh.exe` (in Bash: `"/c/Program Files/GitHub CLI/gh.exe"`); run it from inside the repo. Its login (Vignex-tech) has the `repo` and `workflow` scopes.
- Git: user.name is set only in this repo (`Vignex-tech`). There are LF/CRLF warnings on commit; they're harmless.
