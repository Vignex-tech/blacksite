# Phase 1 plan: graybox

Written 2026-10-18 by the director. Phase 1 ends at the graybox gate in `CLAUDE.md`:

> Two players on different devices join a room over the tunnel link, play Ghost and Warden with basic movement, climbing, weapon damage and one hackable terminal, and finish a timed round.

Milestone #1 (two tabs join one room and see each other move) is done. The milestones below run in order. Each one starts with its `shared/` contract and its server-authority work, because the server decides everything (rule 1). The client renders and sends inputs; qa-build verifies each piece before the next one starts. Only the next milestone has GitHub issues; later ones are filed when the one before passes its gate.

## Milestones

### Milestone 2: graybox map, server collision, client test hook (tracking issue #9)
- **Goal:** both clients render the same authored ground floor from `shared/` map data, the server stops players walking through walls, and tests read state through `window.__blacksite` instead of pixel colours.
- **Agents:** gameplay-engineer (map contract #10, test hook #11, map rendering #14), server-engineer (collision and spawn areas #13), qa-build (#12, #15, #16).
- **Gate:** the server never lets a player overlap a solid, players slide along walls and use every entrance, players spawn in spawn areas, each tab renders every solid, and the two-tab test no longer depends on colours or the camera. CI green.

### Milestone 3: teams, spawns and cameras
- **Goal:** the server assigns each joiner a team, and each team gets its own camera and movement.
- **Order:** `shared/` first (Team type, `team` and `yaw` in player state, the move message carries the camera yaw so input is camera-relative, per-team speed constants for HUD display only). Then server: team assignment balanced across 2v2 (graybox tests use 1v1), team spawn areas, per-team speed, yaw validated and clamped. Then client: Ghost third-person over-the-shoulder camera, Warden first-person camera with pointer lock, a distinct graybox shape per team, team shown in the HUD. Test hook gains `team` and `yaw`.
- **Agents:** gameplay-engineer, server-engineer, qa-build.
- **Gate:** in two tabs, one player is a Ghost in third person and one is a Warden in first person; moves follow the camera; the server enforces each team's speed. Tests use the hook only.
- **Open decision for the owner:** hidden information (rule 2). Today every client is sent every player's position. See "Decisions" below.

### Milestone 4: vertical movement and climbing
- **Goal:** the Ghost climbs and hangs from ledges on authored anchors only; the Warden reaches the upper level by stairs and cannot climb.
- **Order:** `shared/` first: `y` and a movement mode (ground, falling, climbing, ledge hang) in player state; input messages for jump, climb and drop; the map gains one upper service level, stairs or ramps, one overhead traversal route and traversal anchors (rule 5). Then server: gravity, floors at different heights, walking on ramps, the climb and ledge-hang state machine, which is only allowed for Ghosts and only at an anchor in range, plus anchor validation. Then client: render the upper level and anchors, input bindings, simple state feedback (no animation yet).
- **Agents:** gameplay-engineer, server-engineer, qa-build.
- **Gate:** a Ghost reaches the upper level only through anchors and can hang from a ledge and drop; a Warden reaches it only by stairs and is refused when trying to climb; a forged climb message far from an anchor is rejected.

### Milestone 5: weapons and damage
- **Goal:** players can shoot and be hurt and eliminated, with every hit decided by the server.
- **Order:** `shared/` first: a fire message (aim direction only), a reload message, `health` and `ammo` in player state, weapon stats for HUD display. Then server: hitscan raycast against the map's solids and player volumes, fire-rate cooldown, magazine and reload, damage, elimination (an eliminated player is out for the round). Warden rifle; Ghost suppressed sidearm with low damage, so the Ghost is fragile but not helpless (rule 4). Then client: crosshair, shot and hit feedback, health and ammo in the HUD.
- **Agents:** gameplay-engineer, server-engineer, qa-build.
- **Gate:** shots through walls never hit; fire rate and ammo are enforced on the server (a forged rapid-fire client is capped); a Ghost dies in fewer hits than a Warden; an eliminated player cannot move or shoot.

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
1. **Hidden information (rule 2), needs a decision before milestone 3.** The server sends every player's position to every client. Once teams exist, a modified Warden client could see Ghosts through walls. Options: (a) accept it for the graybox only, document it, and make per-client filtering the first item of Phase 2 alongside stealth visibility; or (b) add a basic filter in milestone 5, where the server already raycasts against the map: Wardens are sent a Ghost's position only with line of sight or within a short range. The director recommends (b), because the rule says "never" and the raycast exists by then; until milestone 5, (a) applies.
2. **No new agent is needed for Phase 1.** The graybox map is one small data file. A level-design agent (owning map data and, later, `Art/` layouts) is worth reconsidering in Phase 2, when lights, sound zones and a second map make map work large enough to need its own owner.
3. **Run one agent at a time** (see the gotcha in `Docs/handoff.md`). Each milestone's issues are listed in run order on its tracking issue.
