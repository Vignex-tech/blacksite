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
