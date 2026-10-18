# Blacksite

BLACKSITE: Shadow Protocol is a browser-based, online 2v2 asymmetric stealth shooter. Players open a link and play; nothing to install.
Original IP only. Do not copy characters, logos, maps, sounds or animations from existing games.

- `client/`: Vite, TypeScript and Babylon.js. `server/`: Colyseus with Mocha tests. `shared/`: types used by both. `Tests/`: Vitest unit tests and Playwright browser tests.
- **Start by reading `Docs/handoff.md`**: current state, open decisions, and how to run and share the game.
- Agents live in `.claude/agents/`. Each one edits only its own folders and reports back by committing.

## Definition of done
No agent's work, and no change of any kind, counts as done until the GitHub Actions CI check (`.github/workflows/ci.yml`) passes on the pushed commit. CI builds the client and the server and runs every test.

## The game
Two teams with completely different gameplay.
- **Ghosts** (infiltrators): third-person over-the-shoulder camera, parkour, ledge hanging, ceiling hanging, hacking, silent takedowns, hostage grabs. Fast and mobile, but fragile against gunfire.
- **Wardens** (defenders): first-person, weapon, flashlight, sound-based tracking, defensive gadgets. Tougher, but they cannot climb.

Ghosts must hack one of two data terminals and complete the extraction before the round timer ends. Wardens must stop them or eliminate them.
Default mode is 2v2, built so 3v3 and 4v4 can come later. Rounds last about 7 minutes; every timer is configurable.

Signature mechanics, in build order after the graybox: **Shadow Drop** (ceiling ambush takedown), **flashlight**, **sound cues**, **hostage grab**.

## Rules every agent follows
1. **The server is authoritative.** Clients send inputs only. The server decides movement limits, hits, damage, hacks, grabs, takedowns, cooldowns, ammo, objective progress and the winner. Never trust a client message; validate type, range and timing.
2. **Do not leak hidden information.** Never send a Ghost's position to a Warden client that could not see or hear it.
3. **No wallhacks disguised as features.** Wardens get uncertain sound cues and alerts, never permanent enemy markers.
4. **Every strong mechanic needs a counter.**
5. **Ghosts climb only on authored traversal anchors**, never arbitrary surfaces.
6. **A hostage grab is a tense interaction, not an automatic win.** It must be escapable or rescuable under clear rules.
7. **Readability beats realism.** Darkness must never make a player completely unreadable.
8. **Keep the first load small** (target under 30 MB, to be tuned) so slow connections can play.
9. **The client derives its server URL from `location`** (`wss:` on https), never a hard-coded `localhost`, because the game is shared through an https tunnel.

## Folder map
- `client/src/`: the browser game (planned subfolders `gameplay/`, `ui/`, `net/`)
- `server/src/`: Colyseus rooms (`rooms/`) and game rules (`rules/`, planned)
- `shared/`: types and constants used by both client and server, including room names and message shapes. No Babylon.js or browser-only code here.
- `Tests/`: Vitest (`unit/`) and Playwright (`e2e/`); test reports go in `Tests/Reports/`
- `Docs/`: hand-off note, backlog, design notes, performance budget
- `Manifests/assets.json`: every asset's name, source, path, budgets and status (from the art phase)
- Later, for art: `client/public/assets/` (glTF models, textures, audio) and `Art/` (source files)

## Naming
- Code: camelCase variables and functions, PascalCase types and classes.
- Message and state types are defined once, in `shared/`. Never redefine them in `client/` or `server/`.
- Asset files: lowercase snake_case with a prefix: `mesh_`, `tex_`, `anim_`, `sfx_`.

## Roadmap
Each phase ends with a gate; do not start a later phase's work before the current gate passes.
1. **Graybox (current):** two players on different devices join a room over the tunnel link, play Ghost and Warden with basic movement, climbing, weapon damage and one hackable terminal, and finish a timed round.
2. **Core asymmetry:** Shadow Drop, flashlight, sound cues, stealth visibility, one gadget per side.
3. **Hostage:** the grab, restraint, escape, rescue and takedown, tested under simulated latency.
4. **Art and atmosphere:** low-poly dark-lit style, glTF assets, audio, UI.
5. **Online:** public hosting, lobbies, reconnection.
6. **Alpha** testing, then 7. **release prep** (tutorial, phone controls, accessibility).

## Hard limits
- No secrets, keys or credentials in the repo. Real values go in `.env` files, which are git-ignored; commit only `.env.example`.
- No new dependency without saying why in the commit message.
- Do not delete files you did not create without asking.
- Never claim something works unless it was actually run.
