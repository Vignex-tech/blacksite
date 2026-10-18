# Blacksite

- `client/`: Vite, TypeScript and Babylon.js. `server/`: Colyseus with Mocha tests. `shared/`: types used by both. `Tests/`: Vitest unit tests and Playwright browser tests.
- **Start by reading `Docs/handoff.md`**: current state, open decisions, and how to run and share the game.
- Agents live in `.claude/agents/`. Each one edits only its own folders and reports back by committing.

## Definition of done
No agent's work, and no change of any kind, counts as done until the GitHub Actions CI check (`.github/workflows/ci.yml`) passes on the pushed commit. CI builds the client and the server and runs every test.
