# Backlog

Work the director needs but cannot file as an issue yet, because no agent owns that folder, or because the owner has not yet decided when to schedule it.

## Follow-ups from Milestone 3 (#17)
Not filed as issues. The owner decides when (and whether) they go into a milestone. Owners in brackets.

- **Third-person camera collision** (gameplay-engineer). The Ghost camera sits 3.2 units behind the shoulder and can clip through walls. It should pull in toward the player when a solid is in the way (from #24).
- **Camera smoothing and interpolation** (gameplay-engineer). Meshes and the camera snap to each 20 Hz server update. Interpolate remote players and smooth the local camera follow, without moving the player locally (the server stays authoritative) (from #24).
- **Send timer independent of render frame rate, or server-side compensation** (gameplay-engineer, maybe server-engineer). The client's 20 Hz move timer shares the main thread with rendering, and the server never makes up for missed ticks, so on slow machines players move slower than their team speed (headless tabs measured 11-14 Hz). Options: drive sends from a timer that doesn't depend on frames (for example a worker), or let the server accept a held-key duration within the rate limit. Any server change must keep the per-team speed cap (from #25).
- **Babylon picking on every pointer move** (gameplay-engineer). The scene picks on each pointermove, which is wasted work for a pointer-locked shooter and costly when the browser sends many events. Turn off pointer-move picking (for example `scene.skipPointerMovePicking`) unless something needs it (from #25).
- **First-person hidden own body is untested** (gameplay-engineer to expose, qa-build to test). The Warden's own body and nose are hidden in first person, but the test hook doesn't expose meshes, so no test checks it. Either cover it in the NullEngine `cameras`/`players` unit tests or add an additive version-1 hook field (from #25).
- **`players.ts` doesn't rebuild when `isLocal` changes** (gameplay-engineer). The shape is rebuilt on team change only, so if `isLocal` changes for an existing player id the blue local tint (and the `metadata.isLocal`) stays stale. Rebuild or re-tint on an `isLocal` change too.

## Follow-ups from Milestone 4 (#26)
Not filed as issues unless noted. The owner decides when (and whether) they go into a milestone. Owners in brackets.

- **#37, tsc errors in `server/test/MyRoomClimbing.test.ts`** (server-engineer, **fixed in M5; CI now runs `tsc --noEmit` in `server/`**). `npx tsc --noEmit` in `server/` reports 2 type errors (lines 94-95). Mocha runs through tsx, so CI doesn't catch them; consider a type-check step for server tests in CI (qa-build owns `.github/`) (from #33).
- **E2E suite time** (qa-build, maybe gameplay-engineer or server-engineer). The full e2e suite took about 2.3 min in CI at M4 and is about 3.5 min at M5 (3.7-3.8 min locally), mostly walks limited by the 20 Hz move rate. Options: shorter routes, spawning SDK clients nearer their start points through a test-only room option, or more parallel rooms. Any server-side shortcut must be off in production (from #30, #32, #36).
- **Shimmy can't cross between adjacent ledges** (server-engineer, shared map if needed). `ledge-mezz-south` and `ledge-catwalk-south` meet at x -7.5, but a hanging Ghost stops at the segment end; there is no transfer between ledges (from #31).
- **No feedback when a mantle is blocked** (gameplay-engineer, maybe server-engineer). A refused `climb` while hanging changes nothing and the player gets no cue. The client could show a hint when a mantle would be refused, or the server could send a refusal reason (from #31).
- **The nose pokes about 0.1 into walls** (gameplay-engineer). When a player is flush against a wall or slab, the yellow nose mesh sticks into it (from M3, noted again on #33 and #34).
- **Ramp side-face normal** (gameplay-engineer, cosmetic). On the ramp mesh, the corner vertex at the low end of each side face belongs only to a zero-area triangle, so its normal is (0, 0, 0). Nothing visible (from #34).
- **No persistent "Space: jump" hint** (gameplay-engineer). `#climb-prompt` only shows `E: climb` near an anchor; there is no key hint while on the ground (from #35).
- **The yaw-following camera swings when grabbing an anchor** (gameplay-engineer). A grab snaps the server yaw to the anchor's facing, and the third-person camera follows it, so the view swings abruptly. Smooth the transition or keep the camera's own yaw while attached (from M4 hand checks).

## Follow-ups from Milestone 5 (#38)
Not filed as issues. The owner decides when (and whether) they go into a milestone. Owners in brackets.

- **Ghost third-person crosshair vs the eye ray** (gameplay-engineer, maybe server-engineer). The Ghost camera orbits a shoulder point 3.2 behind, but shots leave the body's eye at 1.6 along the camera yaw and pitch, so the crosshair and the hit point differ at close range. Options: aim from a camera raycast and send that direction (the server still validates) (from #50, #38 item 7).
- **Hanging-kill is covered only in Mocha** (qa-build). A hanging Ghost killed on a ledge falls and settles is tested in `server/test/MyRoomReload.test.ts`, not in e2e, because the walk is long. Accepted by the main session (from #44).
- **One-step visibility leak** (server-engineer). A Ghost that leaves a Warden's sight can still reach that client for up to 50 ms, because views update once per simulation step. Could also re-evaluate on each move message. Room size and join/leave stay observable (Colyseus requires it). Accepted for now (from #46).
- **E2E time budget** (qa-build). About 3.5 min in CI, above the 3 min target. Options: shorter routes, a test-only spawn option that is off in production, more parallel rooms, or splitting the slow serial tab specs (from #51).
- **No spectator camera or respawn** (gameplay-engineer, server-engineer). An eliminated player is a frozen grey body with their own camera until M7 rounds (from #38).
- **Weapon realism left out** (gameplay-engineer, server-engineer). No lag compensation (Phase 3 latency work), no headshots, recoil or spread (from #38).
- **Pixel feedback is not asserted** (qa-build). Tracer, hit marker and damage flash are checked through hook counters only, because headless pointer lock is flaky (from #50).

## Follow-ups from Milestone 6 (#53)
Not filed as issues unless noted. The owner decides when (and whether) they go into a milestone. Owners in brackets.

- **E2E time** (qa-build, **filed as #65, the first M7 issue**). 4.8 min in CI after M6 (budget 4.0). Target 3.3 min, then M7 may add at most 40 s (from #62).
- **Join-time `hackProgress` is missed by SDK and tab clients** (gameplay-engineer or server-engineer). The message goes out before listeners register, so a Ghost client's bar fills only from the first change. Options: resend the current progress once shortly after join, or a Ghost-only view field in state (it must not reach Wardens) (from #56, #61).
- **Test hook has no camera pitch** (gameplay-engineer). An additive `camera.pitch` would remove the baseline-shot trick in `m5-gate` and `m6-gate` (from #63).
- **Ghost-tab hack bar in a real tab** (qa-build). Covered by unit rules and the m6-gate walk; because of the join-time gap the bar is asserted from the first change only (from #61).
- **SDK log noise** (qa-build). `onMessage() not registered for type hackProgress` in e2e output; register `collectProgress` on every Ghost client to silence it (from #57).
- **Second terminal and extraction** (Phase 2). Only `terminal-a` can be hacked; `terminal-b` is dim and inert (from #53).
- **Warden alarm gives no direction** (design, Phase 2). The alarm is a text line only; sound cues come with Phase 2.

## Follow-ups from Milestone 7 (#64)
Not filed as issues. The owner decides when (and whether) they go into a milestone. Owners in brackets.

- **Only the time-out result had real-tab coverage before #74** (qa-build). #73 covered time out in tabs; the hack and elimination results were SDK-only until the m7-gate added all three. Keep new outcomes covered in tabs (from #73, #74).
- **The fast live window in m7-gate is tight** (qa-build). The fast preset's 30 s live window leaves about 9 s spare around the walk (about 10 s) and the 10 s hack. If a slow runner misses it, the failure names the phase reached. Consider a longer `fast` live time or a dedicated preset if it ever flakes (from #74).
- **#76's fully-empty-events case is not fully explained** (qa-build). The fix (record on the Ghost already in the room) removes the join-time race, which reproduced as a missing first event 2 times in 10. CI showed an entirely empty list, which was never reproduced locally. 12 of 12 repeats pass; watch for recurrence (from #76).
- **No spectator camera** (gameplay-engineer, server-engineer). An eliminated or sitting-out player sees a frozen grey body and the round timer until the next reset (from #64, #72).
- **Rounds start automatically with no ready-up, scores or series** (design, Phase 5). A round starts as soon as each team has a player (from #64).
- **Late listeners miss join-time messages** (gameplay-engineer or server-engineer). Both `hackProgress` and the first `round` event can be missed by a client that registers its listener after join. The client reads `state.round`, so the UI is unaffected; see the M6 item on `hackProgress` (from #76).


## Notes from the art plan (M8, #77)
- **Layout toward Research Annex 07** (owner decision, shared/ plus server plus tests): a layout milestone after the art pass is recommended in `Docs/art-plan.md` section 13.
- **Babylon decoders default to a CDN** (Draco, KTX2, meshopt): never enable without self-hosting and counting them in the budget (rule 8).
- **Send timer vs rendering** (existing item): textured, lit scenes slow headless software GL; tests default to `?gfx=low`. If the headless send rate falls under about 15 Hz it becomes a bug for gameplay-engineer.
- **Server cache headers and gzip for assets** (server-engineer, only if the size check shows a need): `express.static` caching and compression for `.glb` and textures.
