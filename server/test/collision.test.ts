import assert from "assert";

import { GRAYBOX_MAP, PLAYER_HALF_SIZE, PLAYER_HEIGHT, type Solid } from "../../shared/map.js";
import { SPEED, BOUND } from "../src/rooms/MyRoom.js";
import { SOLIDS, FACE_EPS, solid, inRect, assertClear } from "./mapHelpers.js";
import { groundSolids, overlapsAny, overlapsSolid, resolveMove } from "../src/rules/collision.js";
import { randomSpawnPoint, spawnAreaForJoin } from "../src/rules/spawn.js";

const BOUNDS = GRAYBOX_MAP.bounds;

/**
 * How far a player must be able to walk from any spawn point in +x, +z and -x
 * without being blocked. Tests/ rely on it: the two-tab test walks more than
 * 0.3 in +x and +z, and the integration tests move one SPEED in +x, +z and -x.
 */
const SPAWN_WALK_CLEARANCE = 0.5;

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("collision rules (pure)", () => {
  it("collides with every current solid and skips solids above the player's height", () => {
    assert.strictEqual(SOLIDS.length, GRAYBOX_MAP.solids.length);
    const upper: Solid = { id: "upper", kind: "wall", min: { x: 0, y: PLAYER_HEIGHT, z: 0 }, max: { x: 1, y: 4, z: 1 } };
    const low: Solid = { id: "low", kind: "cover", min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0.2, z: 1 } };
    assert.deepStrictEqual(groundSolids([upper, low]).map((s) => s.id), ["low"]);
  });

  it("moves exactly by the delta in open space", () => {
    const p = resolveMove({ x: -15, z: 15 }, SPEED, -SPEED, SOLIDS, BOUNDS);
    assert.strictEqual(p.x, -15 + SPEED);
    assert.strictEqual(p.z, 15 - SPEED);
  });

  it("stops flush with a wall face, however large the step (no tunnelling)", () => {
    // wall-s-w spans z -8..-7.5 (0.5 thick, the thinnest walls).
    for (const step of [SPEED, 0.49, 0.5, 1, 5, 100]) {
      const north = resolveMove({ x: -5, z: -8.55 }, 0, step, SOLIDS, BOUNDS);
      assert.ok(Math.abs(north.z - (-8 - PLAYER_HALF_SIZE)) < FACE_EPS, `step ${step}: z ${north.z}`);
      assert.ok(!overlapsAny(north.x, north.z, SOLIDS));
      const south = resolveMove({ x: -5, z: -6.95 }, 0, -step, SOLIDS, BOUNDS);
      assert.ok(Math.abs(south.z - (-7.5 + PLAYER_HALF_SIZE)) < FACE_EPS, `step ${step}: z ${south.z}`);
    }
    // wall-w-n spans x -10..-9.5.
    const east = resolveMove({ x: -12, z: 4 }, 100, 0, SOLIDS, BOUNDS);
    assert.ok(Math.abs(east.x - (-10 - PLAYER_HALF_SIZE)) < FACE_EPS);
  });

  it("slides along a wall when moving diagonally into it", () => {
    const p = resolveMove({ x: -5, z: -8.5 }, SPEED, SPEED, SOLIDS, BOUNDS);
    assert.ok(Math.abs(p.x - (-5 + SPEED)) < FACE_EPS);
    assert.ok(Math.abs(p.z - -8.5) < FACE_EPS);
    const q = resolveMove({ x: -10.5, z: 4 }, SPEED, -SPEED, SOLIDS, BOUNDS);
    assert.ok(Math.abs(q.x - -10.5) < FACE_EPS);
    assert.ok(Math.abs(q.z - (4 - SPEED)) < FACE_EPS);
  });

  it("holds in an inner corner and slides round an outer corner", () => {
    // Inner south-west corner of the building: walls at z <= -7.5 and x <= -9.5.
    let p = { x: -8.95, z: -6.95 };
    for (let i = 0; i < 20; i++) p = resolveMove(p, -SPEED, -SPEED, SOLIDS, BOUNDS);
    assert.ok(Math.abs(p.x - -9) < FACE_EPS && Math.abs(p.z - -7) < FACE_EPS, `${p.x}, ${p.z}`);
    assertClear(p, "inner corner");

    // Outer corner of pillar-nw (x -5.5..-4.5, z 3..4), approached diagonally.
    const pillar = solid("pillar-nw");
    p = { x: pillar.min.x - PLAYER_HALF_SIZE - 0.05, z: pillar.min.z - PLAYER_HALF_SIZE - 0.05 };
    for (let i = 0; i < 15; i++) {
      p = resolveMove(p, SPEED, SPEED, SOLIDS, BOUNDS);
      assertClear(p, `outer corner step ${i}`);
    }
    // Exactly diagonal into the corner: x resolves first, so it ends up south
    // of the pillar, flush with its south face, having slid east.
    assert.ok(Math.abs(p.z - (pillar.min.z - PLAYER_HALF_SIZE)) < FACE_EPS);
    assert.ok(p.x > pillar.min.x);
  });

  it("keeps the box inside the ground at the outer bound corners", () => {
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      let p = { x: sx * (BOUND - 0.25), z: sz * (BOUND - 0.25) };
      for (let i = 0; i < 10; i++) p = resolveMove(p, sx, sz, SOLIDS, BOUNDS);
      assert.deepStrictEqual(p, { x: sx * BOUND, z: sz * BOUND });
    }
  });

  it("never ends inside a solid on random walks at max input", () => {
    const random = rng(1234);
    for (let walk = 0; walk < 200; walk++) {
      let p = { x: 0, z: 0 };
      do {
        p = { x: (random() * 2 - 1) * BOUND, z: (random() * 2 - 1) * BOUND };
      } while (overlapsAny(p.x, p.z, SOLIDS));
      for (let i = 0; i < 200; i++) {
        const dx = [-1, 0, 1][Math.floor(random() * 3)] * SPEED;
        const dz = [-1, 0, 1][Math.floor(random() * 3)] * SPEED;
        p = resolveMove(p, dx, dz, SOLIDS, BOUNDS);
        assertClear(p, `walk ${walk} step ${i}`);
      }
    }
  });

  it("never tunnels through any solid with huge steps", () => {
    const random = rng(99);
    for (let i = 0; i < 5000; i++) {
      let p = { x: 0, z: 0 };
      do {
        p = { x: (random() * 2 - 1) * BOUND, z: (random() * 2 - 1) * BOUND };
      } while (overlapsAny(p.x, p.z, SOLIDS));
      const q = resolveMove(p, (random() * 2 - 1) * 50, (random() * 2 - 1) * 50, SOLIDS, BOUNDS);
      assertClear(q, `jump ${i}`);
      // The x leg is swept along z = p.z and the z leg along x = q.x: check
      // no solid lies strictly between start and end on either leg.
      for (const s of SOLIDS) {
        if (p.z + PLAYER_HALF_SIZE > s.min.z && p.z - PLAYER_HALF_SIZE < s.max.z) {
          const lo = Math.min(p.x, q.x) - PLAYER_HALF_SIZE;
          const hi = Math.max(p.x, q.x) + PLAYER_HALF_SIZE;
          assert.ok(!(hi > s.min.x && lo < s.max.x), `x leg of jump ${i} crosses ${s.id}`);
        }
        if (q.x + PLAYER_HALF_SIZE > s.min.x && q.x - PLAYER_HALF_SIZE < s.max.x) {
          const lo = Math.min(p.z, q.z) - PLAYER_HALF_SIZE;
          const hi = Math.max(p.z, q.z) + PLAYER_HALF_SIZE;
          assert.ok(!(hi > s.min.z && lo < s.max.z), `z leg of jump ${i} crosses ${s.id}`);
        }
      }
    }
  });
});

describe("spawn rules (pure)", () => {
  it("alternates ghost and warden spawn areas by join order", () => {
    assert.deepStrictEqual([0, 1, 2, 3].map(spawnAreaForJoin), ["ghost", "warden", "ghost", "warden"]);
  });

  it("1000 spawns per area are all inside the area and clear of solids", () => {
    for (const name of ["ghost", "warden"] as const) {
      const area = GRAYBOX_MAP.spawnAreas[name];
      for (let i = 0; i < 1000; i++) {
        const p = randomSpawnPoint(area, SOLIDS);
        assert.ok(inRect(p, area), `${name} spawn (${p.x}, ${p.z}) outside its area`);
        assertClear(p, `${name} spawn`);
      }
    }
  });

  it("falls back to a clear point if random points keep hitting a solid", () => {
    const area = { minX: 0, maxX: 4, minZ: 0, maxZ: 4 };
    const block: Solid = { id: "b", kind: "wall", min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 3, z: 1 } };
    const p = randomSpawnPoint(area, [block], () => 0); // always the blocked corner
    assert.deepStrictEqual(p, { x: 2, z: 2 });
  });

  it(`every spawn point can walk ${SPAWN_WALK_CLEARANCE} in +x, +z and -x unblocked`, () => {
    for (const [name, area] of Object.entries(GRAYBOX_MAP.spawnAreas)) {
      // Analytic check: every box reachable that way, from anywhere in the
      // area, stays clear of solids and inside the ground.
      const reach = {
        minX: area.minX - PLAYER_HALF_SIZE - SPAWN_WALK_CLEARANCE,
        maxX: area.maxX + PLAYER_HALF_SIZE + SPAWN_WALK_CLEARANCE,
        minZ: area.minZ - PLAYER_HALF_SIZE,
        maxZ: area.maxZ + PLAYER_HALF_SIZE + SPAWN_WALK_CLEARANCE,
      };
      for (const s of SOLIDS) {
        const hits = reach.maxX > s.min.x && reach.minX < s.max.x && reach.maxZ > s.min.z && reach.minZ < s.max.z;
        assert.ok(!hits, `${name} spawn area's walk clearance overlaps ${s.id}`);
      }
      assert.ok(reach.minX >= BOUNDS.minX && reach.maxX <= BOUNDS.maxX && reach.minZ >= BOUNDS.minZ && reach.maxZ <= BOUNDS.maxZ);

      // Behavioural check on a grid including the area's edges and corners.
      const n = 8;
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n; j++) {
          const p = { x: area.minX + (i / n) * (area.maxX - area.minX), z: area.minZ + (j / n) * (area.maxZ - area.minZ) };
          for (const [dx, dz] of [[SPEED, 0], [0, SPEED], [-SPEED, 0]]) {
            const q = resolveMove(p, dx, dz, SOLIDS, BOUNDS);
            assert.ok(Math.abs(q.x - (p.x + dx)) < 1e-12 && Math.abs(q.z - (p.z + dz)) < 1e-12, `${name} (${p.x}, ${p.z}) one move blocked`);
          }
          let w = p;
          const steps = Math.round(SPAWN_WALK_CLEARANCE / SPEED);
          for (let k = 0; k < steps; k++) w = resolveMove(w, SPEED, SPEED, SOLIDS, BOUNDS);
          assert.ok(Math.abs(w.x - (p.x + SPAWN_WALK_CLEARANCE)) < 1e-9 && Math.abs(w.z - (p.z + SPAWN_WALK_CLEARANCE)) < 1e-9, `${name} (${p.x}, ${p.z}) walk blocked`);
        }
      }
    }
  });
});
