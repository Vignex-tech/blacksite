import assert from "assert";
import { GRAYBOX_MAP } from "../../shared/map.js";
import { VISIBILITY_NEAR } from "../../shared/protocol.js";
import { segmentBlocked, type BallisticWorld } from "../src/rules/ballistics.js";
import { MAX_RAYS_PER_PAIR, SAMPLE_OFFSETS, canSee, type Viewable } from "../src/rules/visibility.js";

const WORLD: BallisticWorld = { solids: GRAYBOX_MAP.solids, floors: GRAYBOX_MAP.floors, ramps: GRAYBOX_MAP.ramps };
const warden = (id: string, x: number, y: number, z: number): Viewable => ({ id, team: "warden", x, y, z });
const ghost = (id: string, x: number, y: number, z: number): Viewable => ({ id, team: "ghost", x, y, z });

describe("visibility (pure)", () => {
  it("a Ghost sees everyone, wherever they are", () => {
    const g = ghost("g", 8, 0, -12);
    assert.ok(canSee(WORLD, g, warden("w", 8, 0, -5)));
    assert.ok(canSee(WORLD, g, ghost("g2", -8.5, 3, 4)));
  });

  it("everyone sees themselves and their teammates, a Warden's Warden behind a wall included", () => {
    const w = warden("w", 8, 0, -12);
    assert.ok(canSee(WORLD, w, w));
    assert.ok(canSee(WORLD, w, warden("w2", 8, 0, -5)));
    const g = ghost("g", 8, 0, -12);
    assert.ok(canSee(WORLD, g, g));
  });

  it("a Warden does not see a Ghost behind a solid wall", () => {
    assert.strictEqual(canSee(WORLD, warden("w", 8, 0, -12), ghost("g", 8, 0, -5)), false);
  });

  it("the near range sees through a wall, and stops just beyond VISIBILITY_NEAR", () => {
    // Ghost at z -7 (south wall z -8..-7.5 between). Centre distance is the z gap.
    const g = ghost("g", 8, 0, -7);
    assert.ok(canSee(WORLD, warden("w", 8, 0, -7 - (VISIBILITY_NEAR - 0.05)), g));
    assert.strictEqual(canSee(WORLD, warden("w", 8, 0, -7 - (VISIBILITY_NEAR + 0.05)), g), false);
  });

  it("near range is 3D: a Ghost on the floor above is not near", () => {
    // 2.5 apart in height only, but the slab (y 2.8..3) is between them.
    assert.strictEqual(canSee(WORLD, warden("w", -8.5, 0, 0), ghost("g", -8.5, 3, 0.5)), false);
    // Same plan position, 1.9 apart in 3D: near, so sent through the floor.
    assert.ok(canSee(WORLD, warden("w", -8.5, 1.1, 0), ghost("g", -8.5, 3, 0)));
  });

  it("a floor above blocks the line", () => {
    assert.strictEqual(canSee(WORLD, warden("w", -8.5, 0, 0), ghost("g", -8.5, 3, 4)), false);
  });

  it("a ramp blocks the line to a Ghost under the landing", () => {
    assert.strictEqual(canSee(WORLD, warden("w", -6.6, 0, -1), ghost("g", -6.6, 0, 6.7)), false);
  });

  it("open ground is visible at any range", () => {
    assert.ok(canSee(WORLD, warden("w", 15, 0, -9), ghost("g", 15, 0, -14)));
    assert.ok(canSee(WORLD, warden("w", -17, 0, 17), ghost("g", 17, 0, 17)));
  });

  it("a Ghost behind low cover is seen by its head over the cover (centre blocked)", () => {
    const w = warden("w", 0, 0, -1);
    const g = ghost("g", 0, 0, -5);
    // The centre line is blocked by cover-low-wall (1.2 tall)...
    assert.ok(segmentBlocked(WORLD, { x: 0, y: 1.6, z: -1 }, { x: 0, y: 0.9, z: -5 }));
    // ...but the head clears it.
    assert.ok(canSee(WORLD, w, g));
  });

  it("the doorway line x = 0 shows a Ghost south of the doorway to a Warden inside", () => {
    assert.ok(canSee(WORLD, warden("w", 0, 0, 3), ghost("g", 0, 0, -10)));
  });

  it("a Warden on the stairs sees a Ghost the eye-to-centre ray reaches", () => {
    const w = warden("w", -6.6, 1.6, 3);
    const g = ghost("g", -0.9, 0, -6);
    const eye = { x: w.x, y: w.y + 1.6, z: w.z };
    assert.ok(!segmentBlocked(WORLD, eye, { x: g.x, y: g.y + 0.9, z: g.z }));
    assert.ok(canSee(WORLD, w, g));
  });

  it("a Ghost peeking past a pillar corner is seen by a shoulder point (centre blocked)", () => {
    const w = warden("w", -5, 0, 0);
    const g = ghost("g", -4.2, 0, 5);
    assert.ok(segmentBlocked(WORLD, { x: -5, y: 1.6, z: 0 }, { x: -4.2, y: 0.9, z: 5 }));
    assert.ok(canSee(WORLD, w, g));
  });

  it("partial cover: a Ghost whose feet alone are in line is seen", () => {
    // A wall from y 0.3 up, right in front of the Ghost: only the feet line passes under it.
    const world: BallisticWorld = {
      solids: [{ id: "gap-wall", kind: "wall", min: { x: -5, y: 0.3, z: 9.9 }, max: { x: 5, y: 3, z: 10 } }],
      floors: [],
      ramps: [],
    };
    const w = warden("w", 0, 0, 0);
    const g = ghost("g", 0, 0, 10.5);
    const eye = { x: 0, y: 1.6, z: 0 };
    const clear = SAMPLE_OFFSETS.filter((o) => !segmentBlocked(world, eye, { x: g.x + o.x, y: g.y + o.y, z: g.z + o.z }));
    assert.strictEqual(clear.length, 1);
    assert.strictEqual(clear[0].y, 0.1);
    assert.ok(canSee(world, w, g));
    // Closing the gap hides it.
    const closed: BallisticWorld = { ...world, solids: [{ ...world.solids[0], min: { x: -5, y: 0, z: 9.9 } }] };
    assert.strictEqual(canSee(closed, w, g), false);
  });

  it("an eliminated Warden sees by its own eye like a live one, and viewers are told apart by id", () => {
    // Health is not an input: the same positions give the same answer.
    assert.strictEqual(canSee(WORLD, warden("dead", 8, 0, -12), ghost("g", 8, 0, -5)), false);
    assert.ok(canSee(WORLD, warden("dead", 15, 0, -9), ghost("g", 15, 0, -14)));
  });

  it("uses a bounded set of samples", () => {
    assert.ok(MAX_RAYS_PER_PAIR >= 3 && MAX_RAYS_PER_PAIR <= 10);
    const ys = SAMPLE_OFFSETS.map((o) => o.y);
    assert.ok(ys.includes(0.9) && ys.some((y) => y > 1.6) && ys.includes(0.1));
  });
});
