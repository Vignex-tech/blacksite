import assert from "assert";
import { GRAYBOX_MAP, PLAYER_HEIGHT } from "../../shared/map.js";
import { EYE_HEIGHT, WEAPONS } from "../../shared/protocol.js";
import { aimDirection, castRay, segmentBlocked, type BallisticWorld } from "../src/rules/ballistics.js";
import { floor, ramp } from "./verticalHelpers.js";

const EMPTY: BallisticWorld = { solids: [], floors: [], ramps: [] };
const box = (id: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
  ({ id, kind: "wall" as const, min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });
const EAST = { x: 1, y: 0, z: 0 };
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

describe("ballistics", () => {
  it("aimDirection: yaw 0 faces +z, positive yaw turns toward +x, positive pitch is up", () => {
    const f = aimDirection(0, 0);
    near(f.x, 0); near(f.y, 0); near(f.z, 1);
    const e = aimDirection(Math.PI / 2, 0);
    near(e.x, 1); near(e.z, 0);
    assert.ok(aimDirection(0, 0.5).y > 0);
    const d = aimDirection(1, -0.7);
    near(Math.hypot(d.x, d.y, d.z), 1);
  });

  it("hits a solid wall and reports distance, id and point", () => {
    const world = { ...EMPTY, solids: [box("wall", 5, 0, -5, 6, 3, 5)] };
    const hit = castRay(world, { x: 0, y: 1.6, z: 0 }, EAST, 40)!;
    assert.strictEqual(hit.kind, "solid");
    assert.strictEqual(hit.id, "wall");
    near(hit.t, 5);
    near(hit.point.x, 5);
  });

  it("cover stops a low shot and lets a high one pass; aiming down onto it hits", () => {
    const world = { ...EMPTY, solids: [box("cover", 5, 0, -5, 6, 1.2, 5)] };
    assert.strictEqual(castRay(world, { x: 0, y: 1.0, z: 0 }, EAST, 40)?.id, "cover");
    assert.strictEqual(castRay(world, { x: 0, y: 1.6, z: 0 }, EAST, 40), null);
    const down = aimDirection(Math.PI / 2, -0.3);
    assert.strictEqual(castRay(world, { x: 0, y: 1.6, z: 0 }, down, 40)?.id, "cover");
  });

  it("a floor slab blocks from above and from below", () => {
    const f = floor("catwalk");
    const x = 0, z = (f.min.z + f.max.z) / 2;
    const above = castRay(GRAYBOX_MAP, { x, y: 5, z }, { x: 0, y: -1, z: 0 }, 40)!;
    assert.strictEqual(above.kind, "floor");
    assert.strictEqual(above.id, "catwalk");
    near(above.point.y, f.max.y);
    const below = castRay(GRAYBOX_MAP, { x, y: 1.6, z }, { x: 0, y: 1, z: 0 }, 40)!;
    assert.strictEqual(below.kind, "floor");
    near(below.point.y, f.min.y);
  });

  it("a ramp is hit on its slope from above and from its side, and passed over above the slope", () => {
    const r = ramp("stairs-west");
    const x = (r.minX + r.maxX) / 2;
    const slope = (z: number) => r.low + ((r.high - r.low) * (z - r.minZ)) / (r.maxZ - r.minZ);
    const down = castRay(GRAYBOX_MAP, { x, y: 5, z: 3 }, { x: 0, y: -1, z: 0 }, 40)!;
    assert.strictEqual(down.id, "stairs-west");
    near(down.point.y, slope(3));
    // Horizontal ray at y 0.5 from the south meets the wedge where the slope reaches 0.5.
    const side = castRay(GRAYBOX_MAP, { x, y: 0.5, z: -2 }, { x: 0, y: 0, z: 1 }, 40)!;
    assert.strictEqual(side.kind, "ramp");
    near(side.point.z, r.minZ + (0.5 / (r.high - r.low)) * (r.maxZ - r.minZ));
    // Above the top of the stairs: nothing in the way along z.
    assert.strictEqual(castRay(GRAYBOX_MAP, { x, y: 3.1, z: -2 }, { x: 0, y: 0, z: 1 }, 5), null);
  });

  it("the ground stops a downward shot", () => {
    const hit = castRay(EMPTY, { x: 0, y: EYE_HEIGHT, z: 0 }, aimDirection(0, -Math.PI / 4), 40)!;
    assert.strictEqual(hit.kind, "ground");
    near(hit.point.y, 0);
    near(hit.t, EYE_HEIGHT / Math.SQRT1_2);
    assert.strictEqual(castRay(EMPTY, { x: 0, y: EYE_HEIGHT, z: 0 }, aimDirection(0, 0.3), 40), null);
  });

  it("hits a player box where it is, including at height and hanging", () => {
    const origin = { x: 0, y: 4.6, z: 0 };
    const upstairs = castRay(EMPTY, origin, EAST, 40, [{ id: "u", x: 5, y: 3, z: 0 }])!;
    assert.strictEqual(upstairs.kind, "player");
    assert.strictEqual(upstairs.id, "u");
    near(upstairs.t, 4.5);
    // Hanging: feet at ledge.y - PLAYER_HEIGHT = 1.2, so the box spans 1.2..3.0.
    const hanging = { id: "h", x: 5, y: 1.2, z: 0 };
    assert.strictEqual(castRay(EMPTY, { x: 0, y: 2.5, z: 0 }, EAST, 40, [hanging])?.id, "h");
    assert.strictEqual(castRay(EMPTY, { x: 0, y: 0.5, z: 0 }, EAST, 40, [hanging]), null);
    assert.strictEqual(castRay(EMPTY, { x: 0, y: 1.2 + PLAYER_HEIGHT + 0.1, z: 0 }, EAST, 40, [hanging]), null);
  });

  it("a wall between shooter and player blocks; the nearest of several hits wins", () => {
    const world = { ...EMPTY, solids: [box("wall", 5, 0, -5, 6, 3, 5)] };
    const o = { x: 0, y: 1.6, z: 0 };
    assert.strictEqual(castRay(world, o, EAST, 40, [{ id: "behind", x: 9, y: 0, z: 0 }])?.kind, "solid");
    assert.strictEqual(castRay(world, o, EAST, 40, [{ id: "front", x: 3, y: 0, z: 0 }])?.id, "front");
    const two = castRay(EMPTY, o, EAST, 40, [{ id: "far", x: 12, y: 0, z: 0 }, { id: "near", x: 6, y: 0, z: 0 }])!;
    assert.strictEqual(two.id, "near");
  });

  it("nothing is hit beyond the range", () => {
    const world = { ...EMPTY, solids: [box("wall", 30, 0, -5, 31, 3, 5)] };
    const o = { x: 0, y: 1.6, z: 0 };
    assert.strictEqual(castRay(world, o, EAST, WEAPONS.ghost.range), null);
    assert.strictEqual(castRay(world, o, EAST, WEAPONS.warden.range)?.id, "wall");
    assert.strictEqual(castRay(EMPTY, o, EAST, 10, [{ id: "p", x: 12, y: 0, z: 0 }]), null);
  });

  it("anchors do not block: a ray along the climb-west strip is not stopped by the anchor", () => {
    const a = GRAYBOX_MAP.anchors.find((v) => v.id === "climb-west") as { x: number; z: number };
    const hit = castRay(GRAYBOX_MAP, { x: a.x, y: 1, z: a.z - 3 }, { x: 0, y: 0, z: 1 }, 6);
    assert.strictEqual(hit, null);
  });

  it("segmentBlocked ignores players and sees solids, floors, ramps", () => {
    const world = { ...EMPTY, solids: [box("wall", 5, 0, -5, 6, 3, 5)] };
    assert.strictEqual(segmentBlocked(world, { x: 0, y: 1.6, z: 0 }, { x: 10, y: 1.6, z: 0 }), true);
    assert.strictEqual(segmentBlocked(world, { x: 0, y: 1.6, z: 0 }, { x: 4, y: 1.6, z: 0 }), false);
    assert.strictEqual(segmentBlocked(world, { x: 0, y: 1.6, z: 0 }, { x: 0, y: 1.6, z: 0 }), false);
    const f = floor("catwalk");
    const z = (f.min.z + f.max.z) / 2;
    assert.strictEqual(segmentBlocked(GRAYBOX_MAP, { x: 0, y: 1.6, z }, { x: 0, y: 4.6, z }), true);
    assert.strictEqual(segmentBlocked(GRAYBOX_MAP, { x: 15, y: 1.6, z: -14 }, { x: 15, y: 1.6, z: -9 }), false);
    const r = ramp("stairs-west");
    const x = (r.minX + r.maxX) / 2;
    assert.strictEqual(segmentBlocked(GRAYBOX_MAP, { x, y: 0.5, z: -2 }, { x, y: 0.5, z: 3 }), true);
  });
});
