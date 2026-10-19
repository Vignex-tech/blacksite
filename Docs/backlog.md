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

- **#37, tsc errors in `server/test/MyRoomClimbing.test.ts`** (server-engineer, **filed, open**). `npx tsc --noEmit` in `server/` reports 2 type errors (lines 94-95). Mocha runs through tsx, so CI doesn't catch them; consider a type-check step for server tests in CI (qa-build owns `.github/`) (from #33).
- **E2E suite time** (qa-build, maybe gameplay-engineer or server-engineer). The full e2e suite takes about 2.3 min in CI (2.6-2.7 min locally), mostly walks limited by the 20 Hz move rate. Options: shorter routes, spawning SDK clients nearer their start points through a test-only room option, or more parallel rooms. Any server-side shortcut must be off in production (from #30, #32, #36).
- **Shimmy can't cross between adjacent ledges** (server-engineer, shared map if needed). `ledge-mezz-south` and `ledge-catwalk-south` meet at x -7.5, but a hanging Ghost stops at the segment end; there is no transfer between ledges (from #31).
- **No feedback when a mantle is blocked** (gameplay-engineer, maybe server-engineer). A refused `climb` while hanging changes nothing and the player gets no cue. The client could show a hint when a mantle would be refused, or the server could send a refusal reason (from #31).
- **The nose pokes about 0.1 into walls** (gameplay-engineer). When a player is flush against a wall or slab, the yellow nose mesh sticks into it (from M3, noted again on #33 and #34).
- **Ramp side-face normal** (gameplay-engineer, cosmetic). On the ramp mesh, the corner vertex at the low end of each side face belongs only to a zero-area triangle, so its normal is (0, 0, 0). Nothing visible (from #34).
- **No persistent "Space: jump" hint** (gameplay-engineer). `#climb-prompt` only shows `E: climb` near an anchor; there is no key hint while on the ground (from #35).
- **The yaw-following camera swings when grabbing an anchor** (gameplay-engineer). A grab snaps the server yaw to the anchor's facing, and the third-person camera follows it, so the view swings abruptly. Smooth the transition or keep the camera's own yaw while attached (from M4 hand checks).
