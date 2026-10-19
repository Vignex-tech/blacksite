# Phase 1 plan: graybox

Written 2026-10-18 by the director. Phase 1 ends at the graybox gate in `CLAUDE.md`:

> Two players on different devices join a room over the tunnel link, play Ghost and Warden with basic movement, climbing, weapon damage and one hackable terminal, and finish a timed round.

Milestones #1 (two tabs join one room and see each other move), #9 (graybox map, server collision, test hook), #17 (teams, per-team speed and cameras) and #26 (vertical movement and climbing) are done. The milestones below run in order. Each one starts with its `shared/` contract and its server-authority work, because the server decides everything (rule 1). The client renders and sends inputs; qa-build verifies each piece before the next one starts. Only the next milestone has GitHub issues; later ones are filed when the one before passes its gate.

## Milestones

### Milestone 2: graybox map, server collision, client test hook (tracking issue #9, done, CI green on 9c0c0b0)
- **Goal:** both clients render the same authored ground floor from `shared/` map data, the server stops players walking through walls, and tests read state through `window.__blacksite` instead of pixel colours.
- **Agents:** gameplay-engineer (map contract #10, test hook #11, map rendering #14), server-engineer (collision and spawn areas #13), qa-build (#12, #15, #16).
- **Gate:** the server never lets a player overlap a solid, players slide along walls and use every entrance, players spawn in spawn areas, each tab renders every solid, and the two-tab test no longer depends on colours or the camera. CI green.

### Milestone 3: teams, spawns and cameras (tracking issue #17, done, CI green on 5c10c44)
- **Status:** done. Issues #18 to #25 are closed with green CI (commits 79c93e6, 68360fd, edf41ec, 03b8ebc, dd9b8f7, c8aee4e, 1c196e8, e63260b, 225756d, a959f86, 5c10c44). Follow-ups are in `Docs/backlog.md`; the current state is in `Docs/handoff.md`.
- **Goal:** the server assigns each joiner a team, and each team gets its own camera and its own speed.
- **Contract (#18, `shared/protocol.js`):** `TEAMS` (`ghost`, `warden`, equal to the map's spawn area keys), `MAX_TEAM_SIZE` 4, `TEAM_SPEED` in units/s (proposed Ghost 2.4, Warden 2.0), `team` and `yaw` in player state, and `move { dx, dz, yaw? }` as camera-relative intent. `dx` is strafe and `dz` forward, and yaw 0 faces +z with positive yaw turning toward +x (Babylon's `rotation.y`). A missing yaw keeps the player's current one, so with yaw 0 the M2 meaning (W is +z, D is +x) still holds. A yaw-only move turns the player.
- **Server authority (#20):** teams are assigned from the players currently in the room (fewer players wins, ties go to ghost, join options ignored, up to 4v4, no rebalancing on leave). This replaces `spawnAreaForJoin`, whose join counter never went down. Spawns use `spawnAreas[team]` with yaw 0. Yaw must be finite (otherwise the message is ignored) and is wrapped to -pi..pi. The intent is clamped, its length capped at 1, rotated by yaw and scaled by the team's step (`TEAM_SPEED / MOVE_RATE_HZ`). The rate limit (turning included) and collision are unchanged.
- **Client (#22, #24):** a distinct graybox shape per team rotated by yaw, the team in the HUD, then the Ghost third-person over-the-shoulder camera and the Warden first-person camera (pointer lock, mouse turns yaw, pitch stays local). Input sends keys and the camera yaw only; nothing moves locally. The test hook stays version 1 and gains `team`, `yaw`, `localTeam` and `camera { mode, yaw }`, all additive.
- **Keeping CI green:** qa-build first makes the existing tests contract-driven (#19): per-team step, the world-step formula, tolerant diagonals, a yaw-0 precondition in browser tests and `toMatchObject` on the hook. Each later change then lands with tests that already accept it, and each gameplay or server issue is followed by a qa-build issue (#21, #23, #25).
- **Agents:** gameplay-engineer (#18, #22, #24), server-engineer (#20), qa-build (#19, #21, #23, #25).
- **Gate:** in two tabs, one player is a Ghost in third person and one is a Warden in first person; moves follow the camera; the server enforces each team's speed; leaving and rejoining keeps teams balanced. Tests use the hook and SDK clients only.
- **Not in M3:** hidden-information filtering (M5, decided on #9), climbing, weapons, terminals.

### Milestone 4: vertical movement and climbing (tracking issue #26, done, CI green on 79c0c6c)
- **Status:** done. Issues #27 to #36 are closed with green CI (commits 78a1cbf, 0f81fdd, 5469c69, 3eff652, 9dae692, 83303ab, 261cfaa, 977b793, e2df25b, 79c0c6c). The owner approved every proposed default on #26; solid tops are not walkable (decided by the main session on #26). Follow-ups are in `Docs/backlog.md` (including open issue #37); the current state is in `Docs/handoff.md`.
- **Goal:** the Ghost climbs and hangs from ledges on authored anchors only; the Warden reaches the upper level by stairs and cannot climb.
- **Order:** `shared/` first: `y` and a movement mode (ground, falling, climbing, ledge hang) in player state; input messages for jump, climb and drop; the map gains one upper service level, stairs or ramps, one overhead traversal route and traversal anchors (rule 5). Then server: gravity, floors at different heights, walking on ramps, the climb and ledge-hang state machine, which is only allowed for Ghosts and only at an anchor in range, plus anchor validation. Then client: render the upper level and anchors, input bindings, simple state feedback (no animation yet).
- **Contract (#27):** `MOVEMENT_MODES` (`ground`, `falling`, `climbing`, `hanging`); `y` and `mode` in `PlayerState` (optional until #33); `ACTION_MESSAGE` `'action'` with `{ action: 'jump' | 'climb' | 'drop' }`, which carries no anchor id or position (the server picks the anchor from the player's own position). Vertical constants in `shared/protocol.js`: `GRAVITY`, `MAX_FALL_SPEED`, `JUMP_SPEED` per team, `STEP_HEIGHT`, `CLIMB_SPEED`, `SHIMMY_SPEED`, `ANCHOR_RANGE`, `ANCHOR_REACH` and `CAN_CLIMB`. The map gains `UPPER_LEVEL_Y` and the new lists `floors`, `ramps` and `anchors` (climb and ledge). `solids` is unchanged, so no behaviour changes until the server reads the new lists.
- **Keeping CI green:** qa-build first makes the existing tests height-aware (#28): a y-aware overlap watch, map invariants limited to the ground band, routes that avoid ramps and anchors, and new invariant and reachability tests for the new map data. Each later change then lands with tests that already accept it, and each server or client issue is followed by a qa-build issue.
- **Run order (one agent at a time):**

  | Order | # | Issue | Agent | Depends on |
  |---|---|---|---|---|
  | 1 | #27 | Shared contract: height, movement modes, actions, upper level and traversal anchors | gameplay-engineer | none |
  | 2 | #28 | QA: make existing tests ready for height, floors, ramps and anchors | qa-build | #27 |
  | 3 | #29 | Server: gravity, floors, ramps, Ghost jump and y-aware collision | server-engineer | #27, #28 |
  | 4 | #30 | QA: verify server stairs, floors, falling, jumps and action validation | qa-build | #29 |
  | 5 | #31 | Server: climb and ledge-hang state machine, Ghosts only, at authored anchors | server-engineer | #27, #29, #30 |
  | 6 | #32 | QA: verify climbing, hanging, drop, forged climbs and Warden refusal | qa-build | #31 |
  | 7 | #33 | Client: render upper level, stairs and anchors; players at height; y and mode in test hook | gameplay-engineer | #29, #31, #32 |
  | 8 | #34 | QA: verify upper-level rendering and player height in both tabs | qa-build | #33 |
  | 9 | #35 | Client: jump, climb and drop key bindings, mode feedback in the HUD | gameplay-engineer | #33, #34 |
  | 10 | #36 | QA: M4 gate, Ghost climbs via anchors, hangs and drops; Warden takes stairs and is refused | qa-build | #35 |

- **Proposed defaults (the owner can change them; each is one constant):** gravity 20 u/s^2 and max fall speed 20; Ghost jump speed 4.5 (apex about 0.5); Wardens can't jump; step height 0.35; climb speed 1.5 and shimmy speed 1.0 u/s; anchor range 0.8 and ledge reach 0.6; upper level at y 3; no railings; no fall damage (there is no health until M5); action rate limit 5 per second with a burst of 2; keys Space (jump), E (climb, grab, mantle) and C (drop). The full list is on #26.
- **Agents:** gameplay-engineer (#27, #33, #35), server-engineer (#29, #31), qa-build (#28, #30, #32, #34, #36).
- **Gate:** a Ghost reaches the upper level only through anchors and can hang from a ledge and drop; a Warden reaches it only by stairs and is refused when trying to climb; a forged climb message far from an anchor is rejected.
- **Not in M4:** animation, ceiling hanging and Shadow Drop (Phase 2), fall damage (M5), camera collision (backlog).

### Milestone 5: weapons and damage
- **Goal:** players can shoot and be hurt and eliminated, with every hit decided by the server.
- **Order:** `shared/` first: a fire message (aim direction only), a reload message, `health` and `ammo` in player state, weapon stats for HUD display. Then server: hitscan raycast against the map's solids and player volumes, fire-rate cooldown, magazine and reload, damage, elimination (an eliminated player is out for the round). Warden rifle; Ghost suppressed sidearm with low damage, so the Ghost is fragile but not helpless (rule 4). Then client: crosshair, shot and hit feedback, health and ammo in the HUD.
- **Agents:** gameplay-engineer, server-engineer, qa-build.
- **Hidden information (decided on #9):** in this milestone the server also stops sending a Warden client the positions of Ghosts it can't see, reusing the hitscan raycast (line of sight, or within a short range). The test hook then shows only what the filtered state contains.
- **Gate:** shots through walls never hit; fire rate and ammo are enforced on the server (a forged rapid-fire client is capped); a Ghost dies in fewer hits than a Warden; an eliminated player cannot move or shoot; a Warden client is not sent the position of a Ghost behind a wall.

### Milestone 6: one hackable terminal
- **Goal:** a Ghost can hack one data terminal by holding interact in range, and the Warden can interrupt it.
- **Order:** `shared/` first: interact start and stop messages, terminal state (progress, who is hacking) and the hack duration constant. Then server: range and team checks, progress over server time, interruption on leaving range, taking damage or elimination, progress keeps or decays (to decide in the issue), completion. Only one terminal from the map is active in Phase 1. Then client: terminal marker, interact prompt, progress bar.
- **Agents:** gameplay-engineer, server-engineer, qa-build.
- **Gate:** a Ghost in range completes the hack in the configured time; out of range, as a Warden, or while hit, progress does not advance; a forged interact from across the map is rejected.

### Milestone 7: timed round, win and loss
- **Goal:** a round starts, runs on a configurable timer, ends with a winner and resets.
- **Order:** `shared/` first: round phase (waiting, countdown, live, ended), time left, winner, and the round settings shape. Then server: the round state machine, with every timer configurable (default about 7 minutes; tests use seconds). Ghosts win when the terminal hack completes. Wardens win when every Ghost is eliminated or time runs out. Positions, health and ammo reset for the next round. Then client: round timer, round result screen, the simple HUD tidied up.
- **Agents:** gameplay-engineer, server-engineer, qa-build.
- **Gate:** an integration test plays full rounds with SDK clients and a short timer and reaches each outcome (hack complete, Ghost eliminated, time out); the clients show the timer and the result.

### Milestone 8: Phase 1 gate, two devices over the tunnel
- **Goal:** prove the `CLAUDE.md` graybox gate on real hardware.
- **Work:** qa-build adds a scripted end-to-end round with two browser pages (one Ghost, one Warden) and measures the first-load size against the 30 MB budget. The owner runs the game through `cloudflared` and plays one full round from two different devices (two computers; phone controls are a release-prep feature). Bugs become issues for the owning agent. The director updates `Docs/handoff.md` and marks Phase 1 done.
- **Gate:** the `CLAUDE.md` Phase 1 gate, confirmed by the owner, with CI green.

## Deferred out of Phase 1
These are in the owner's original brief for the vertical slice. They are not needed for the graybox gate, so they move to later phases:
- **Phase 2 (core asymmetry):** the Warden flashlight, several controllable lights, ceiling hanging and Shadow Drop, sound cues, stealth visibility, one gadget per side, the second active data terminal, and the extraction step after a hack. In Phase 1 the Ghosts win as soon as the hack completes.
- **Phase 3:** hostage grab, restraint, escape and rescue, silent takedowns.
- **Phase 4:** real models, animation, audio and the final HUD style.

Kept in Phase 1 because they are cheap: multiple entrances, Ghost and Warden spawn areas, two terminal placements in the map data (only one active), and the upper service level with one overhead route (milestone 4, because climbing needs somewhere to go).

## Decisions
- **Map data lives in `shared/`** (`shared/map.js` + `map.d.ts`, plain data with no Babylon code), owned by gameplay-engineer. The server imports it for collision, spawns and validation (anchors, terminal ranges); the client imports it to render. Collision and validation code stays in `server/src/rules/`, owned by server-engineer. There is no level-builder agent.
- **Test hook:** `window.__blacksite.snapshot()` returns a copy of what the client already knows. It ships in the production build because Playwright tests the production build. It must never expose more than the server sent that client, so it cannot leak hidden information.
- **Graybox player shapes:** boxes until milestone 3, then a simple distinct shape per team. No assets in Phase 1.
- **Room name:** keep `my_room` for now; it is a single constant in `shared/protocol.js` and can be renamed later at no cost.

## Recommendations for the owner
1. **Hidden information (rule 2): decided by the owner on #9.** Until M5 every client receives every player's position, so test matches before M5 are not cheat-proof. In M5 the server adds a line-of-sight filter that reuses the weapon raycast.
2. **No new agent is needed for Phase 1.** The graybox map is one small data file. A level-design agent (owning map data and, later, `Art/` layouts) is worth reconsidering in Phase 2, when lights, sound zones and a second map make map work large enough to need its own owner.
3. **Run one agent at a time** (see the gotcha in `Docs/handoff.md`). Each milestone's issues are listed in run order on its tracking issue.
