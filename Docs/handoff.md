# Session hand-off

Last updated 2026-10-18 by the local Claude Code session on the owner's Windows PC (8 GB RAM). Read this before starting work.

## State
- Repo: `Vignex-tech/blacksite` (private), branch `main`. CI passed on `4cb23f9`.
- CI: `.github/workflows/ci.yml` (job `build-and-test`) builds the client and server, then runs Mocha (server), Vitest (`Tests/unit`) and Playwright (`Tests/e2e`). **Nothing counts as done until CI passes** (see `CLAUDE.md`).
- Client: still the Vite vanilla-ts starter. `@babylonjs/core` is installed but not used yet.
- Server: the Colyseus 0.18 starter (`my_room`, a single `mySynchronizedProperty`). It now also serves `client/dist` with `express.static`, so the whole game runs on one port (2567). The playground moved to `/playground`, and it and `/monitor` are dev-only. With `NODE_ENV=production` both are off.

## Milestone #1: two tabs join the same room and each sees the other move
| # | Issue | Agent | Status |
|---|---|---|---|
| 1 | Milestone (tracking) | none | blocked on server work |
| 2 | Babylon scene: ground, camera, light, a box per player | gameplay-engineer | ready to start |
| 3 | QA: check the scene; start the Colyseus server in Playwright | qa-build | after #2 |
| 4 | Join the shared room, WASD movement, render players | gameplay-engineer | after #2 and #3, plus server work |
| 5 | QA: two-page Playwright test where each sees the other move | qa-build | after #4, plus server work |

Note on #4: the client must derive its WebSocket URL from `location` (wss on https), not hard-code `ws://localhost:2567`, because the game is shared through an https tunnel.

## Decisions and open questions
- Agents (`.claude/agents/`): director, gameplay-engineer, qa-build. Each edits only its own folders. The main session dispatches issues from the director's hand-off table, because subagents can't start other subagents.
- **Open:** a server-engineer agent was planned for "after the client works", but milestone #1 needs server work (see `Docs/backlog.md`). The owner hasn't decided whether to add it now (recommended) or allow a one-off exception.
- Blender is deferred until the art phase, to save RAM.

## Running and sharing locally
1. `npm run build` in `client/`.
2. `npm run build` in `server/`, then start it with `NODE_ENV=production node build/index.js` (port 2567).
3. `cloudflared tunnel --url http://localhost:2567` prints a temporary `https://*.trycloudflare.com` link. It changes on every run and only works while the PC is on.

Dev work: `npm start` in `server/` (tsx watch) and `npm run dev` in `client/` (port 5173).

## Gotchas
- On Windows, `npm test` in `server/` passes, then crashes when Mocha exits (`UV_HANDLE_CLOSING` assertion). It works fine on Linux CI, so trust CI.
- On this PC, `gh` is at `C:\Program Files\GitHub CLI\gh.exe`. Its login (Vignex-tech) has the `repo` and `workflow` scopes.
- Git: user.name is set only in this repo (`Vignex-tech`). There are LF/CRLF warnings on commit; they're harmless.
