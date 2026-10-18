import assert from "assert";
import { GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT, UPPER_LEVEL_Y } from "../../shared/map.js";
import { GRAVITY, JUMP_SPEED, MAX_FALL_SPEED, STEP_HEIGHT, type MovementMode } from "../../shared/protocol.js";
import { SIM_RATE_HZ, TEAM_STEP } from "../src/rooms/MyRoom.js";
import { moveBody, rampTopOver, startJump, stepFall, supportHeight, type Body } from "../src/rules/vertical.js";
import { WORLD, assertClear3, floor, ramp, rng } from "./verticalHelpers.js";
import { solid } from "./mapHelpers.js";

const EPS = 1e-9;
const DT = 1 / SIM_RATE_HZ;
const W = TEAM_STEP.warden;
const G = TEAM_STEP.ghost;
const APEX = JUMP_SPEED.ghost ** 2 / (2 * GRAVITY);
/** An open spot with more than 3 units of clearance in every direction. */
const OPEN = { x: 15, z: -14 };

const STAIRS = ramp("stairs-west");
const STAIRS_X = (STAIRS.minX + STAIRS.maxX) / 2;
const LANDING = floor("landing-nw");
const CATWALK = floor("catwalk");

function body(x: number, z: number, y = 0, mode: MovementMode = "ground"): Body {
  return { x, y, z, mode, vy: 0 };
}

/** Simulation steps until the body is on the ground again (at most `max`); returns the steps and the highest y. */
function fallUntilGround(b: Body, max = 200) {
  let steps = 0;
  let top = b.y;
  while (b.mode === "falling" && steps < max) {
    stepFall(WORLD, b, DT);
    top = Math.max(top, b.y);
    assertClear3(b, `fall step ${steps}`);
    steps++;
  }
  return { steps, top };
}

describe("vertical rules (pure)", () => {
  it("stands on the ground at y 0 with no nudge, under the catwalk and the mezzanine too", () => {
    for (const p of [OPEN, { x: 0, z: -0.25 }, { x: -8.5, z: 3 }, { x: 0, z: 3 }]) {
      assert.strictEqual(supportHeight(WORLD, p.x, p.z, STEP_HEIGHT), 0);
      const b = body(p.x, p.z);
      for (let i = 0; i < 20; i++) stepFall(WORLD, b, DT);
      assert.deepStrictEqual(b, body(p.x, p.z));
    }
  });

  it("moves exactly by the delta on the flat ground, as in M3", () => {
    const b = body(OPEN.x, OPEN.z);
    moveBody(WORLD, b, W, -W);
    assert.ok(Math.abs(b.x - (OPEN.x + W)) < EPS && Math.abs(b.z - (OPEN.z - W)) < EPS);
    assert.strictEqual(b.y, 0);
    assert.strictEqual(b.mode, "ground");
  });

  it("stops flush with a wall face on the ground, at any step size", () => {
    const wall = solid("wall-s-w"); // z -8..-7.5
    for (const step of [0.05, W, G, 0.3, 5, 100]) {
      const b = body(-5, wall.min.z - PLAYER_HALF_SIZE - 0.05);
      moveBody(WORLD, b, 0, step);
      assert.strictEqual(b.z, wall.min.z - PLAYER_HALF_SIZE, `step ${step}`);
      assert.strictEqual(b.y, 0);
    }
  });

  it("a Warden walks up the stairs to the upper level, then onto the mezzanine", () => {
    const b = body(STAIRS_X, -0.3);
    let maxRise = 0;
    while (b.z < (LANDING.min.z + LANDING.max.z) / 2) {
      const before = b.y;
      moveBody(WORLD, b, 0, W);
      maxRise = Math.max(maxRise, b.y - before);
      assert.strictEqual(b.mode, "ground", `at z ${b.z}`);
      assertClear3(b, "stairs up");
    }
    assert.ok(Math.abs(b.y - UPPER_LEVEL_Y) < EPS, `y ${b.y}`);
    assert.ok(maxRise <= STEP_HEIGHT);
    // West along the landing onto the mezzanine.
    for (let i = 0; i < 25; i++) {
      moveBody(WORLD, b, -W, 0);
      assert.strictEqual(b.mode, "ground");
      assert.ok(Math.abs(b.y - UPPER_LEVEL_Y) < EPS);
      assertClear3(b, "landing to mezzanine");
    }
    assert.ok(b.x < LANDING.min.x, `reached the mezzanine at x ${b.x}`);
  });

  it("follows the ramp down without falling mid-ramp, back to y 0", () => {
    const b = body(STAIRS_X, (LANDING.min.z + LANDING.max.z) / 2, UPPER_LEVEL_Y);
    while (b.z > STAIRS.minZ - 1) {
      moveBody(WORLD, b, 0, -W);
      assert.strictEqual(b.mode, "ground", `at z ${b.z}, y ${b.y}`);
      assertClear3(b, "stairs down");
    }
    assert.strictEqual(b.y, 0);
  });

  it("walks off the upper level's edge, falls and lands on the ground", () => {
    const b = body(0, (CATWALK.min.z + CATWALK.max.z) / 2, UPPER_LEVEL_Y);
    let moves = 0;
    while (b.mode === "ground" && moves < 50) {
      moveBody(WORLD, b, 0, -W);
      moves++;
    }
    assert.strictEqual(b.mode, "falling");
    assert.strictEqual(b.y, UPPER_LEVEL_Y);
    // It left the catwalk: the box no longer overlaps its footprint.
    assert.ok(b.z + PLAYER_HALF_SIZE <= CATWALK.min.z + EPS);
    const { steps } = fallUntilGround(b);
    assert.strictEqual(b.mode, "ground");
    assert.strictEqual(b.y, 0);
    assert.ok(steps > 1 && steps < 30, `${steps} steps`);
  });

  it("lands on a floor top with a swept fall, even at max fall speed (no tunnelling through slabs)", () => {
    const b = body(0, (CATWALK.min.z + CATWALK.max.z) / 2, UPPER_LEVEL_Y + 7, "falling");
    b.vy = -MAX_FALL_SPEED;
    fallUntilGround(b);
    assert.strictEqual(b.mode, "ground");
    assert.strictEqual(b.y, UPPER_LEVEL_Y);
    // The fall speed is capped.
    const c = body(OPEN.x, OPEN.z, 50, "falling");
    for (let i = 0; i < 40; i++) stepFall(WORLD, c, DT);
    assert.ok(c.vy >= -MAX_FALL_SPEED - EPS);
  });

  it("the side of a ramp blocks like a wall", () => {
    // East of the stairs' high part, walking west into its side.
    const z = STAIRS.maxZ - 1;
    const b = body(STAIRS.maxX + PLAYER_HALF_SIZE + 0.25, z);
    for (let i = 0; i < 10; i++) moveBody(WORLD, b, -W, 0);
    assert.strictEqual(b.x, STAIRS.maxX + PLAYER_HALF_SIZE);
    assert.strictEqual(b.y, 0);
    assert.strictEqual(b.mode, "ground");
  });

  it("the edge of a floor blocks like a wall from the stairs, and a player under a floor walks freely", () => {
    const mezz = floor("mezz-west");
    // Halfway up the stairs, walking west: the mezzanine's slab is at head height.
    const z = (STAIRS.minZ + STAIRS.maxZ) / 2;
    const b = body(STAIRS_X, z);
    b.y = rampTopOver(STAIRS, b.x, b.z);
    for (let i = 0; i < 10; i++) moveBody(WORLD, b, -W, 0);
    assert.strictEqual(b.x, mezz.max.x + PLAYER_HALF_SIZE);
    assert.strictEqual(b.mode, "ground");
    assertClear3(b, "against the mezzanine edge");

    // Under the catwalk, all the way along it, on the ground.
    const u = body(-4, (CATWALK.min.z + CATWALK.max.z) / 2);
    for (let i = 0; i < 90; i++) moveBody(WORLD, u, W, 0);
    assert.ok(Math.abs(u.x - (-4 + 90 * W)) < 1e-6, `x ${u.x}`);
    assert.strictEqual(u.y, 0);
    assert.strictEqual(u.mode, "ground");
  });

  it("solid tops are not walkable: from the mezzanine the west wall top can't be walked along", () => {
    const wall = solid("wall-w-n"); // x -10..-9.5, top at UPPER_LEVEL_Y
    const b = body(-8.5, 4.5, UPPER_LEVEL_Y);
    for (let i = 0; i < 40; i++) moveBody(WORLD, b, -W, 0);
    // The box may overhang the edge but must still overlap the mezzanine.
    assert.ok(b.x - PLAYER_HALF_SIZE < wall.max.x, `x ${b.x}`);
    assert.ok(b.x + PLAYER_HALF_SIZE > wall.max.x, `x ${b.x}`);
    assert.strictEqual(b.mode, "ground");
    assert.strictEqual(b.y, UPPER_LEVEL_Y);
  });

  it("a Ghost jump rises at most JUMP_SPEED^2 / (2 GRAVITY) and lands back on the ground", () => {
    const b = body(OPEN.x, OPEN.z);
    assert.ok(startJump(b, JUMP_SPEED.ghost));
    assert.strictEqual(b.mode, "falling");
    const { top } = fallUntilGround(b);
    assert.ok(top > 0.3 && top <= APEX + JUMP_SPEED.ghost * DT, `apex ${top}`);
    assert.ok(top <= APEX + EPS, `apex ${top} (sampled exactly on the parabola)`);
    assert.strictEqual(b.y, 0);
    assert.strictEqual(b.mode, "ground");
  });

  it("refuses a jump for a team with jump speed 0 and a jump in the air", () => {
    const w = body(OPEN.x, OPEN.z);
    assert.strictEqual(startJump(w, JUMP_SPEED.warden), false);
    assert.deepStrictEqual(w, body(OPEN.x, OPEN.z));
    const g = body(OPEN.x, OPEN.z);
    startJump(g, JUMP_SPEED.ghost);
    stepFall(WORLD, g, DT);
    const vy = g.vy;
    assert.strictEqual(startJump(g, JUMP_SPEED.ghost), false);
    assert.strictEqual(g.vy, vy);
  });

  it("a jump can't land on cover", () => {
    const cover = solid("cover-yard-s");
    const z = (cover.min.z + cover.max.z) / 2;
    const b = body(cover.max.x + PLAYER_HALF_SIZE + 0.05, z);
    startJump(b, JUMP_SPEED.ghost);
    while (b.mode === "falling") {
      moveBody(WORLD, b, -G, 0);
      stepFall(WORLD, b, DT);
      assertClear3(b, "jump at cover");
    }
    assert.strictEqual(b.x, cover.max.x + PLAYER_HALF_SIZE);
    assert.strictEqual(b.y, 0);
  });

  it("a jump from the ground can't reach the upper level, and the head stops under a floor", () => {
    // Under the catwalk's south edge, jumping and pushing north under it.
    const b = body(0, CATWALK.min.z - 0.6);
    startJump(b, JUMP_SPEED.ghost);
    while (b.mode === "falling") {
      moveBody(WORLD, b, 0, G);
      stepFall(WORLD, b, DT);
      assert.ok(b.y + PLAYER_HEIGHT <= CATWALK.min.y + EPS);
      assertClear3(b, "jump under the catwalk");
    }
    assert.strictEqual(b.y, 0);

    // At the foot of the stairs, where the catwalk is close overhead.
    const c = body(STAIRS_X, STAIRS.minZ + 0.45);
    c.y = rampTopOver(STAIRS, c.x, c.z);
    const y0 = c.y;
    startJump(c, JUMP_SPEED.ghost);
    let top = c.y;
    while (c.mode === "falling") {
      stepFall(WORLD, c, DT);
      top = Math.max(top, c.y);
      assertClear3(c, "jump on the stairs");
    }
    assert.ok(top <= CATWALK.min.y - PLAYER_HEIGHT + EPS, `head hit at ${top}`);
    assert.ok(top < y0 + APEX, "the head check cut the jump short");
    assert.ok(Math.abs(c.y - y0) < EPS);
  });

  it("random walks with jumps, both teams, never overlap a solid, floor or ramp and never leave the bounds", () => {
    const random = rng(2929);
    const starts = [
      ...[0, 1, 2, 3].map(() => ({ x: (random() * 2 - 1) * 18, z: (random() * 2 - 1) * 18, y: 0 })),
      { x: STAIRS_X, z: STAIRS.minZ - 0.5, y: 0 },
      { x: 0, z: (CATWALK.min.z + CATWALK.max.z) / 2, y: UPPER_LEVEL_Y },
      { x: -8.5, z: 3, y: UPPER_LEVEL_Y },
      { x: 8, z: 0, y: UPPER_LEVEL_Y },
      { x: STAIRS_X, z: 5, y: rampTopOver(STAIRS, STAIRS_X, 5) },
    ];
    let reachedUpper = 0;
    for (const team of ["ghost", "warden"] as const) {
      for (const [w, s] of starts.entries()) {
        const b = body(s.x, s.z, s.y);
        try { assertClear3(b, "start"); } catch { continue; }
        for (let i = 0; i < 1500; i++) {
          const yaw = random() * 2 * Math.PI;
          const step = TEAM_STEP[team] * (random() < 0.1 ? 0 : 1);
          if (random() < 0.05) startJump(b, JUMP_SPEED[team]);
          moveBody(WORLD, b, Math.sin(yaw) * step, Math.cos(yaw) * step);
          assertClear3(b, `${team} walk ${w} move ${i}`);
          stepFall(WORLD, b, DT);
          assertClear3(b, `${team} walk ${w} step ${i}`);
          if (b.mode === "ground") {
            assert.ok(
              Math.abs(b.y - supportHeight(WORLD, b.x, b.z, b.y + EPS)) < EPS,
              `${team} walk ${w} step ${i}: grounded at ${b.y} with no surface`,
            );
          }
          if (b.y >= UPPER_LEVEL_Y - EPS) reachedUpper++;
        }
      }
    }
    assert.ok(reachedUpper > 0);
  });

  it("huge moves at height never tunnel through anything", () => {
    const random = rng(77);
    for (let i = 0; i < 200; i++) {
      const upper = random() < 0.5;
      const b = upper
        ? body(-9.5 + random() * 15.5, -1 + random() * 1.5, UPPER_LEVEL_Y)
        : body((random() * 2 - 1) * 19, (random() * 2 - 1) * 19);
      if (upper && supportHeight(WORLD, b.x, b.z, UPPER_LEVEL_Y) !== UPPER_LEVEL_Y) continue;
      try { assertClear3(b, "start"); } catch { continue; }
      const dx = (random() * 2 - 1) * 30;
      const dz = (random() * 2 - 1) * 30;
      // The same move in 0.01 steps (x, then z) must end in the same place.
      const small = { ...b };
      const n = 1000;
      for (let k = 0; k < n; k++) moveBody(WORLD, small, dx / n, 0);
      for (let k = 0; k < n; k++) moveBody(WORLD, small, 0, dz / n);
      moveBody(WORLD, b, dx, dz);
      assertClear3(b, `move ${i}`);
      assert.ok(Math.abs(b.x - small.x) < 1e-3 && Math.abs(b.z - small.z) < 1e-3,
        `move ${i}: big (${b.x}, ${b.z}) vs small steps (${small.x}, ${small.z})`);
      fallUntilGround(b);
    }
  });
});
