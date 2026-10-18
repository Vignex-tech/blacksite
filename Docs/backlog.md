# Backlog

Work the director needs but cannot file as an issue yet, because no agent owns that folder.

## Server work for milestone #1 (ready to file: server-engineer agent now exists)

Milestone #1 ("Two browser tabs join the same room and each sees the other move") cannot be accepted until this lands. File this as the server-engineer's first issue (label `agent:server-engineer`), paired with a qa-build check, and link both from #1. Remove this section once filed.

Contract: the client side (#4) codes against the types in `shared/` (room name, `MoveMessage`, player shape). The server must use the same contract and import it from `shared/` rather than redefining it. That may need a `server/tsconfig*.json` change so `tsc` accepts files outside `server/src`.

1. **Player state schema** in `server/src/rooms/schema/MyRoomState.ts`:
   - a `Player` schema with `x: number` and `z: number` (both default 0),
   - `MyRoomState` gets `players: map(Player)` keyed by `client.sessionId`.
   - The template's `mySynchronizedProperty` can be removed (update `server/test/MyRoom.test.ts` if it relies on it).
2. **Join/leave** in `server/src/rooms/MyRoom.ts`:
   - `onJoin`: add a `Player` at a spawn point (e.g. small random x/z offset so boxes do not overlap) to `state.players` under `client.sessionId`.
   - `onLeave`: delete `client.sessionId` from `state.players`.
   - Keep the room name `my_room` in `app.config.ts` (it matches `ROOM_NAME` in `shared/`).
3. **`move` message handler** in `MyRoom.messages`:
   - `move: (client, { dx, dz })`: clamp `dx`/`dz` to -1..1 (reject non-numbers), then move that client's player by `dx * SPEED`, `dz * SPEED` (e.g. `SPEED = 0.1` units per message), and clamp to the ground bounds.
   - Server is authoritative; clients never set positions directly.
   - Remove the template's `yourMessageType` handler.
4. **Mocha tests** in `server/test/MyRoom.test.ts` (with `@colyseus/testing`):
   - two clients join: `state.players` has 2 entries keyed by their session ids,
   - a `move` message from client A changes A's x/z and not B's,
   - client A leaves: `state.players` has 1 entry.
5. CI green on the delivering commit; then #5's two-page Playwright test can go in.
