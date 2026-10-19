# Phase 1 plan: graybox

Written 2026-10-18 by the director. Phase 1 ends at the graybox gate in `CLAUDE.md`:

> Two players on different devices join a room over the tunnel link, play Ghost and Warden with basic movement, climbing, weapon damage and one hackable terminal, and finish a timed round.

Milestones #1 (two tabs join one room and see each other move), #9 (graybox map, server collision, test hook), #17 (teams, per-team speed and cameras) and #26 (vertical movement and climbing) are done; #38 (weapons and the visibility filter) and #53 (the hackable terminal) are done. The milestones below run in order. Each one starts with its `shared/` contract and its server-authority work, because the server decides everything (rule 1). The client renders and sends inputs; qa-build verifies each piece before the next one starts. Only the next milestone has GitHub issues; later ones are filed when the one before passes its gate.

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

### Milestone 5: weapons and damage (tracking issue #38, issues #39 to #51, done, CI green on b4d84c4)
- **Status:** done. Issues #39 to #51 plus bugs #52 and #37 are closed with green CI (commits c887a4f, d6ad21e, 031b41b, 23ee723, c2f43de, 2db344e, 5285938, f3e0069, f279335, 6ca8598, 5adf386, 057fe6e, 521c42a, b4d84c4). Residual filter leaks were accepted by the main session on #38. Follow-ups are in `Docs/backlog.md`; the current state is in `Docs/handoff.md`.
- **Goal:** players can shoot and be hurt and eliminated, with every hit decided by the server, and Warden clients stop being sent Ghosts they cannot see.
- **Order:** `shared/` first: a fire message (aim yaw and pitch only), a reload message, `health`, `ammo` and `reloading` in player state, weapon stats for HUD display, and shot, hit and damage events (#39). Then server: hitscan raycast against solids, floors, ramps, the ground and player volumes at their y, fire-rate cooldown, magazine and damage (#41); reload and elimination lock-out (#43). Warden rifle; Ghost suppressed sidearm with low damage, so the Ghost is fragile but not helpless (rule 4). Then the visibility filter as its own issue (#46), reusing the raycast. Then client: crosshair, health and ammo HUD, eliminated look, players that appear and vanish (#48), then the fire and reload bindings with shot and hit feedback (#50). qa-build makes the tests ready before the server changes state (#40) and again before the filter (#45), and verifies every step.
- **Hidden information (decided on #9):** the server stops sending a Warden client the Ghosts it can't see (line of sight from its eye to the Ghost's box, or within a short range). A hidden Ghost is absent from that client's state; the test hook then shows only the filtered state. Mechanism: Colyseus 0.18 `StateView`, to be confirmed by the server-engineer on #46.
- **Run order (one agent at a time):**

  | Order | # | Issue | Agent | Depends on |
  |---|---|---|---|---|
  | 1 | #39 | Shared contract: fire, reload, health, ammo, weapon stats, hit events | gameplay-engineer | none |
  | 2 | #40 | QA: make existing tests ready for health, ammo and new messages | qa-build | #39 |
  | 3 | #41 | Server: hitscan fire, cooldown, magazine and damage | server-engineer | #39, #40 |
  | 4 | #42 | QA: verify fire, walls, cooldown, ammo and damage | qa-build | #41 |
  | 5 | #43 | Server: reload and elimination lock-out | server-engineer | #41, #42 |
  | 6 | #44 | QA: verify reload, kills and eliminated players | qa-build | #43 |
  | 7 | #45 | QA: make existing tests ready for the visibility filter | qa-build | #44 |
  | 8 | #46 | Server: hide Ghosts from Wardens who cannot see them | server-engineer | #41, #45 |
  | 9 | #47 | QA: verify the visibility filter in state and on the wire | qa-build | #46 |
  | 10 | #48 | Client: crosshair, health and ammo HUD, eliminated state, players that appear and vanish | gameplay-engineer | #43, #46, #47 |
  | 11 | #49 | QA: verify HUD, crosshair, hook fields and vanishing players in both tabs | qa-build | #48 |
  | 12 | #50 | Client: fire and reload bindings, shot and hit feedback | gameplay-engineer | #48, #49 |
  | 13 | #51 | QA: M5 gate in real tabs | qa-build | #50 |

- **Proposed defaults (the owner can change them; each is one constant or one function):** health Ghost 100, Warden 150; Warden rifle 25 damage, 150 ms, magazine 30, reload 2000 ms, range 40; Ghost suppressed sidearm 15 damage, 300 ms, magazine 12, reload 1500 ms, range 25; unlimited reserve ammo and no auto-reload; no headshots; friendly fire off; fire from the eye (1.6) with no spread or recoil and no lag compensation; eliminated players stay as frozen grey bodies with no respawn and no free camera until M7; no fall damage; Warden filter = line of sight from its own eye to any sample point of the Ghost's box, or within 2.0 units, with no view cone, per client; Ghosts see everyone; Warden shots are heard by all, Ghost shots only by Ghosts; fire and reload share a rate bucket (10/s, burst 3); left mouse fires only while the pointer is locked, R reloads. The full list is on #38.
- **Agents:** gameplay-engineer (#39, #48, #50), server-engineer (#41, #43, #46), qa-build (#40, #42, #44, #45, #47, #49, #51).
- **Gate:** shots through walls never hit; fire rate and ammo are enforced on the server (a forged rapid-fire client is capped); a Ghost dies in fewer hits than a Warden; an eliminated player cannot move, act or shoot; a Warden client is not sent the position of a Ghost behind a wall.
- **Not in M5:** respawn and rounds (M7), terminals (M6), lag compensation, headshots, recoil, spectator camera, gadgets, flashlight and sound cues (Phase 2).

### Milestone 6: one hackable terminal (tracking issue #53, issues #54 to #62, done, CI green on efc5f7f)
- **Status:** done. Issues #54 to #62 plus bug #63 are closed with green CI (commits 00bbb3c, 24633ab, e82d4ed, a93b417, 822a1e8, 6e4f377, e6149f4, 2acb41e, efc5f7f, cde5928). The main session approved all defaults while the owner was away. e2e grew to 4.8 min in CI, so M7 starts with #65. Follow-ups are in `Docs/backlog.md`.
- **Goal:** a Ghost can hack one data terminal by holding interact in range, and the Warden can interrupt it.
- **Order:** `shared/` first: the interact message (`{ active }`, no terminal id), terminal state (`status`, `alert`), the hack constants and the active terminal id (#54). qa-build makes the tests ready (#55). Then server: range, team and mode checks, progress over server time, decay, completion (#56); interruptions (moving, damage, elimination, leaving range or the ground) and what a Warden learns (#58). Then client: terminal marker, prompt, progress bar, Warden alert, F binding (#60). Each is followed by a qa-build issue, ending with the real-tab gate (#62).
- **Run order (one agent at a time):**

  | Order | # | Issue | Agent | Depends on |
  |---|---|---|---|---|
  | 1 | #54 | Shared contract: interact message, hack constants, terminal state, active terminal | gameplay-engineer | none |
  | 2 | #55 | QA: make existing tests ready for terminal state and the interact message | qa-build | #54 |
  | 3 | #56 | Server: hack the active terminal over server time | server-engineer | #54, #55 |
  | 4 | #57 | QA: verify the server hack, range, team and forged interacts | qa-build | #56 |
  | 5 | #58 | Server: hack interruptions and what Wardens learn | server-engineer | #56, #57 |
  | 6 | #59 | QA: verify interruptions and the Warden information limit on the wire | qa-build | #58 |
  | 7 | #60 | Client: terminal marker, hack prompt and bar, Warden alert, F binding | gameplay-engineer | #58, #59 |
  | 8 | #61 | QA: verify the terminal UI and input | qa-build | #60 |
  | 9 | #62 | QA: M6 gate in real tabs | qa-build | #61 |

- **Proposed defaults (the owner can change them; each is one constant):** active terminal `terminal-a`; hack 10 s; range 1.5; hold F; Ghosts only, no stacking; interrupted by leaving range, moving, damage, elimination or leaving the ground; progress is kept and then decays at half the gain rate; `interact` bucket 4/s burst 2. Wardens learn only `hacking`/`alert` (after 3 s) and `hacked`, never progress or the hacker; Ghosts get their progress in a Ghost-only message. The full list is on #53.
- **Agents:** gameplay-engineer (#54, #60), server-engineer (#56, #58), qa-build (#55, #57, #59, #61, #62).
- **Gate:** a Ghost in range completes the hack in the configured time; out of range, as a Warden, or while hit, progress does not advance; a forged interact from across the map is rejected; a Warden client is never told the progress or the hacker.
- **Not in M6:** the win, the round timer and the terminal reset (M7), the extraction step and the second active terminal (Phase 2).

### Milestone 7: timed round, win and loss (tracking issue #64, issues #65 to #74, done, CI green on cfb4a71)
- **Status:** done. Issues #65 to #74 plus bugs #75 and #76 are closed with green CI ([gate run](https://github.com/Vignex-tech/blacksite/actions/runs/39309864854)). Commits: b11d5bb and c987eb6 (#65), 866a123 (#66), 868fa34 (#67), d09049f (#68), 7770d1a (#69), a4b7e7e (#75), dcfbf5b (#70), ff499aa (#71), 52b0ca8 (#72), 4e37ee6 (#76), d45ebb0 (#73), cfb4a71 (#74). CI e2e is sharded into 4 jobs, slowest about 1.9 min. The main session approved all defaults while the owner was away. Follow-ups are in `Docs/backlog.md`.
- **Goal:** a round starts, runs on a server timer (about 7 min live), ends with a winner and a visible result, and resets.
- **Order:** first cut e2e time (#65). `shared/` next: phases, settings, result, round state (#66). Then qa-build readiness plus a second test server with short timers (#67), the server state machine (#68), win conditions and terminal reset (#70), then the client timer, banner and result screen (#72). A QA issue follows each, ending with the gate (#74).
- **Run order (one agent at a time):**

  | Order | # | Issue | Agent | Depends on |
  |---|---|---|---|---|
  | 1 | #65 | QA: cut e2e time to 3.3 min without losing gate coverage | qa-build | none |
  | 2 | #66 | Shared contract: round phases, settings, result and round state | gameplay-engineer | none |
  | 3 | #67 | QA: make existing tests ready for round state and a round-enabled test server | qa-build | #65, #66 |
  | 4 | #68 | Server: round state machine, timers, reset and input lock-out | server-engineer | #66, #67 |
  | 5 | #69 | QA: verify round phases, lock-out, reset and startup-only config | qa-build | #68 |
  | 6 | #70 | Server: win conditions, edge cases and terminal reset | server-engineer | #68, #69 |
  | 7 | #71 | QA: verify every outcome, edge cases and reset on the wire | qa-build | #70 |
  | 8 | #72 | Client: round timer, phase banner, result screen and HUD tidy | gameplay-engineer | #70, #71 |
  | 9 | #73 | QA: verify the round UI and client behaviour | qa-build | #72 |
  | 10 | #74 | QA: M7 gate in real tabs, all outcomes within the e2e budget | qa-build | #73 |

- **Proposed defaults (the owner can change them):** countdown 10 s, live 420 s, result 10 s; start with 1 Ghost and 1 Warden; inputs frozen outside live; full reset at each countdown (spawns, health, ammo, terminals, hack); mid-round joiners sit out; a team emptying aborts the round with no winner; Ghosts win on hack, Wardens on all Ghosts gone or time out, with step order hack, elimination, timer. **Short timers for tests** come only from the server's startup environment (`BLACKSITE_ROUND_PRESET`: `open` for the main test server so old specs never wait, `fast` on a second server for round specs), never from a client (rule 1). Both teams see the same public round fields; no alive counts or hack progress. e2e budget: cut to <= 3.3 min first, M7 adds <= 40 s, ceiling 4.0 min.
- **Agents:** gameplay-engineer (#66, #72), server-engineer (#68, #70), qa-build (#65, #67, #69, #71, #73, #74).
- **Gate:** an integration test plays full rounds with SDK clients and short timers and reaches each outcome (hack complete, Ghost eliminated, time out); the clients show the timer and the result; round settings cannot be set by a client.
- **Not in M7:** respawns, series and scores, lobbies and ready-up, extraction, spectator camera.

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
