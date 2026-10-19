import assert from "assert";
import {
  GRAYBOX_MAP,
  PLAYER_HALF_SIZE,
  PLAYER_HEIGHT,
  UPPER_LEVEL_Y,
  type Anchor,
  type ClimbAnchor,
  type LedgeAnchor,
  type Solid,
} from "../../shared/map.js";
import { ANCHOR_RANGE, ANCHOR_REACH, CAN_CLIMB, type MovementMode } from "../../shared/protocol.js";
import { CLIMB_STEP, MANTLE_DISTANCE, SHIMMY_STEP } from "../src/rooms/MyRoom.js";
import { climbMove, grab, letGo, mantle, nearestOnLedge, shimmy, type ClimbBody } from "../src/rules/climbing.js";
import type { World } from "../src/rules/vertical.js";
import { WORLD, assertClear3 } from "./verticalHelpers.js";

const EPS = 1e-9;
const ANCHORS = GRAYBOX_MAP.anchors;
const CLIMBS = ANCHORS.filter((a): a is ClimbAnchor => a.kind === "climb");
const LEDGES = ANCHORS.filter((a): a is LedgeAnchor => a.kind === "ledge");

function anchor(id: string): Anchor {
  const a = ANCHORS.find((v) => v.id === id);
  if (!a) throw new Error(`no anchor ${id}`);
  return a;
}
const ledge = (id: string) => anchor(id) as LedgeAnchor;
const climbAnchor = (id: string) => anchor(id) as ClimbAnchor;

function body(x: number, z: number, y = 0, mode: MovementMode = "ground"): ClimbBody {
  return { x, y, z, mode, vy: 0, yaw: 0, anchorId: null };
}

function copy(b: ClimbBody): ClimbBody {
  return { ...b };
}

/** Horizontal distance from (x, z) to an anchor (its point, or its segment). */
function distTo(a: Anchor, x: number, z: number): number {
  if (a.kind === "climb") return Math.hypot(a.x - x, a.z - z);
  const p = nearestOnLedge(a, x, z);
  return Math.hypot(p.x - x, p.z - z);
}

function midpoint(l: LedgeAnchor) {
  return { x: (l.x0 + l.x1) / 2, z: (l.z0 + l.z1) / 2 };
}

/** A body hanging from `l` at its point nearest (x, z). */
function hanging(l: LedgeAnchor, x = midpoint(l).x, z = midpoint(l).z): ClimbBody {
  const p = nearestOnLedge(l, x, z);
  return { x: p.x, y: l.y - PLAYER_HEIGHT, z: p.z, mode: "hanging", vy: 0, yaw: l.facing, anchorId: l.id };
}

/** The point of a ledge (in eighths of its segment) farthest from every climb anchor. */
function farFromClimbs(l: LedgeAnchor) {
  let best = midpoint(l);
  let bestD = -1;
  for (let t = 0; t <= 1; t += 0.125) {
    const p = { x: l.x0 + (l.x1 - l.x0) * t, z: l.z0 + (l.z1 - l.z0) * t };
    const d = Math.min(...CLIMBS.map((a) => Math.hypot(a.x - p.x, a.z - p.z)));
    if (d > bestD) { best = p; bestD = d; }
  }
  return best;
}

function onSegment(l: LedgeAnchor, b: { x: number; z: number }): boolean {
  return distTo(l, b.x, b.z) < 1e-9;
}

describe("climbing rules (pure)", () => {
  it("exports the climb and shimmy steps and the mantle distance", () => {
    assert.ok(Math.abs(CLIMB_STEP - 0.075) < EPS);
    assert.ok(Math.abs(SHIMMY_STEP - 0.05) < EPS);
    assert.strictEqual(MANTLE_DISTANCE, 2 * PLAYER_HALF_SIZE);
  });

  it("a Ghost at each climb anchor attaches: snapped to its x, z and facing, in 'climbing'", () => {
    for (const a of CLIMBS) {
      // Up to ANCHOR_RANGE away, on the open side (behind the anchor).
      const back = ANCHOR_RANGE - 0.01;
      const b = body(a.x - back * Math.sin(a.facing), a.z - back * Math.cos(a.facing));
      b.yaw = 2;
      assert.ok(grab(WORLD, ANCHORS, b, CAN_CLIMB.ghost), a.id);
      assert.deepStrictEqual(
        { x: b.x, y: b.y, z: b.z, mode: b.mode, yaw: b.yaw, anchorId: b.anchorId },
        { x: a.x, y: a.minY, z: a.z, mode: "climbing", yaw: a.facing, anchorId: a.id },
      );
      assertClear3(b, a.id);
    }
  });

  it("a falling Ghost with its hands in reach grabs each ledge, snapped onto the segment", () => {
    for (const l of LEDGES) {
      // Away from climb anchors (a climb anchor in range would win).
      const m = farFromClimbs(l);
      // Half a unit out on the hang side, hands just under the reach limit.
      const b = body(m.x - 0.5 * Math.sin(l.facing), m.z - 0.5 * Math.cos(l.facing), l.y - PLAYER_HEIGHT + ANCHOR_REACH - 0.01, "falling");
      b.vy = -3;
      assert.ok(grab(WORLD, ANCHORS, b, true), l.id);
      assert.strictEqual(b.mode, "hanging", l.id);
      assert.strictEqual(b.anchorId, l.id);
      assert.strictEqual(b.yaw, l.facing);
      assert.strictEqual(b.vy, 0);
      assert.ok(Math.abs(b.y - (l.y - PLAYER_HEIGHT)) < EPS);
      assert.ok(onSegment(l, b), `${l.id} at (${b.x}, ${b.z})`);
      assertClear3(b, l.id);
    }
  });

  it("refuses a ledge whose hands are out of reach (above or below)", () => {
    const l = ledge("ledge-catwalk-south");
    const m = midpoint(l);
    for (const dy of [ANCHOR_REACH + 0.01, -(ANCHOR_REACH + 0.01), 1.8]) {
      const b = body(m.x, m.z, l.y - PLAYER_HEIGHT + dy, "falling");
      const before = copy(b);
      assert.strictEqual(grab(WORLD, ANCHORS, b, true), false, `dy ${dy}`);
      assert.deepStrictEqual(b, before);
    }
    // From the ground below the catwalk (or at a jump's apex) the ledge is out of reach.
    for (const y of [0, 0.5]) {
      const b = body(m.x, m.z, y, y === 0 ? "ground" : "falling");
      assert.strictEqual(grab(WORLD, ANCHORS, b, true), false, `y ${y}`);
    }
  });

  it("refuses a climb anchor whose feet range is out of reach", () => {
    const a = climbAnchor("climb-west");
    const b = body(a.x, a.z, a.maxY + ANCHOR_REACH + 0.11, "falling");
    const before = copy(b);
    assert.strictEqual(grab(WORLD, ANCHORS, b, true), false);
    assert.deepStrictEqual(b, before);
    // Just inside the reach it attaches, with the feet clamped to maxY.
    const c = body(a.x, a.z, a.maxY + ANCHOR_REACH - 0.01, "falling");
    assert.ok(grab(WORLD, ANCHORS, c, true));
    assert.strictEqual(c.mode, "climbing");
    assert.strictEqual(c.y, a.maxY);
  });

  it("refuses a climb one unit beyond ANCHOR_RANGE from every anchor, at any height", () => {
    let checked = 0;
    for (const a of ANCHORS) {
      const ref = a.kind === "climb" ? { x: a.x, z: a.z } : midpoint(a);
      for (let k = 0; k < 16; k++) {
        const ang = (k * Math.PI) / 8;
        const x = ref.x + (ANCHOR_RANGE + 1) * Math.sin(ang);
        const z = ref.z + (ANCHOR_RANGE + 1) * Math.cos(ang);
        if (Math.min(...ANCHORS.map((o) => distTo(o, x, z))) < ANCHOR_RANGE + 1 - EPS) continue;
        for (const y of [0, 0.3, 0.6, 1.2, 1.8, 2.4]) {
          const b = body(x, z, y, y === 0 ? "ground" : "falling");
          const before = copy(b);
          assert.strictEqual(grab(WORLD, ANCHORS, b, true), false, `${a.id} (${x}, ${y}, ${z})`);
          assert.deepStrictEqual(b, before);
          checked++;
        }
      }
    }
    assert.ok(checked >= ANCHORS.length * 6, `${checked} checks`);
  });

  it("refuses every climb for a team that can't climb, exactly on each anchor, and from attached modes", () => {
    assert.strictEqual(CAN_CLIMB.warden, false);
    for (const a of ANCHORS) {
      const b = a.kind === "climb" ? body(a.x, a.z, a.minY) : { ...hanging(a), mode: "falling" as MovementMode, anchorId: null };
      const before = copy(b);
      assert.strictEqual(grab(WORLD, ANCHORS, b, CAN_CLIMB.warden), false, a.id);
      assert.deepStrictEqual(b, before);
    }
    const h = hanging(ledge("ledge-west-wall"));
    assert.strictEqual(grab(WORLD, ANCHORS, h, true), false, "grab while hanging");
  });

  it("climbs up at the step, clamped, then hangs from the anchor's ledge at maxY", () => {
    for (const a of CLIMBS) {
      const b = body(a.x, a.z);
      assert.ok(grab(WORLD, ANCHORS, b, true));
      let moves = 0;
      while (b.mode === "climbing" && moves < 100) {
        const y0 = b.y;
        climbMove(WORLD, ANCHORS, b, CLIMB_STEP);
        moves++;
        if (b.mode === "climbing") assert.ok(Math.abs(b.y - Math.min(a.maxY, y0 + CLIMB_STEP)) < EPS);
        assert.ok(b.y <= a.maxY + EPS && b.y >= a.minY - EPS);
        assertClear3(b, a.id);
      }
      assert.strictEqual(moves, Math.ceil((a.maxY - a.minY) / CLIMB_STEP - 1e-9), a.id);
      const l = ledge(a.ledgeId);
      assert.strictEqual(b.mode, "hanging");
      assert.strictEqual(b.anchorId, l.id);
      assert.strictEqual(b.yaw, l.facing);
      assert.ok(Math.abs(b.y - (l.y - PLAYER_HEIGHT)) < EPS);
      assert.ok(onSegment(l, b));
    }
  });

  it("climbs down to minY onto the ground and stands; a zero step changes nothing", () => {
    const a = climbAnchor("climb-east");
    const b = body(a.x, a.z, 0.6, "falling");
    assert.ok(grab(WORLD, ANCHORS, b, true));
    assert.strictEqual(climbMove(WORLD, ANCHORS, b, 0), false);
    for (let i = 0; i < 20 && b.mode === "climbing"; i++) climbMove(WORLD, ANCHORS, b, -CLIMB_STEP);
    assert.strictEqual(b.mode, "ground");
    assert.strictEqual(b.y, 0);
    assert.strictEqual(b.anchorId, null);
    assert.strictEqual(b.x, a.x);
    assert.strictEqual(b.z, a.z);
  });

  it("shimmies along the segment (+dx to the right of the ledge's facing) and stays clamped to it", () => {
    for (const l of LEDGES) {
      const b = hanging(l);
      const right = { x: Math.cos(l.facing), z: -Math.sin(l.facing) };
      const x0 = b.x, z0 = b.z;
      assert.ok(shimmy(WORLD, ANCHORS, b, SHIMMY_STEP), l.id);
      assert.ok(Math.abs(b.x - (x0 + right.x * SHIMMY_STEP)) < EPS && Math.abs(b.z - (z0 + right.z * SHIMMY_STEP)) < EPS, `${l.id} direction`);
      const len = Math.hypot(l.x1 - l.x0, l.z1 - l.z0);
      for (const dir of [1, -1]) {
        for (let i = 0; i < Math.ceil(len / SHIMMY_STEP) + 20; i++) {
          shimmy(WORLD, ANCHORS, b, dir * SHIMMY_STEP);
          assert.ok(onSegment(l, b), `${l.id} at (${b.x}, ${b.z})`);
          assert.strictEqual(b.mode, "hanging");
          assert.ok(Math.abs(b.y - (l.y - PLAYER_HEIGHT)) < EPS);
          assertClear3(b, l.id);
        }
        // At an end: one of the segment's endpoints.
        const atEnd = [[l.x0, l.z0], [l.x1, l.z1]].some(([x, z]) => Math.abs(b.x - x) < EPS && Math.abs(b.z - z) < EPS);
        assert.ok(atEnd, `${l.id} end (${b.x}, ${b.z})`);
        assert.strictEqual(shimmy(WORLD, ANCHORS, b, dir * SHIMMY_STEP), false, "no further");
      }
    }
  });

  it("mantles from every point of every ledge onto the upper level, in 'ground'", () => {
    for (const l of LEDGES) {
      for (let t = 0; t <= 1; t += 0.125) {
        const b = hanging(l, l.x0 + (l.x1 - l.x0) * t, l.z0 + (l.z1 - l.z0) * t);
        const x0 = b.x, z0 = b.z;
        assert.ok(mantle(WORLD, ANCHORS, b), `${l.id} t ${t}`);
        assert.strictEqual(b.mode, "ground");
        assert.strictEqual(b.anchorId, null);
        assert.strictEqual(b.y, UPPER_LEVEL_Y);
        assert.ok(Math.abs(b.x - (x0 + MANTLE_DISTANCE * Math.sin(l.facing))) < EPS);
        assert.ok(Math.abs(b.z - (z0 + MANTLE_DISTANCE * Math.cos(l.facing))) < EPS);
        assertClear3(b, `${l.id} t ${t}`);
      }
    }
  });

  it("refuses a mantle with no room, and one onto a wall top with no authored floor", () => {
    const l = ledge("ledge-west-wall");
    // A box on the mezzanine right where the mantle would stand.
    const crate: Solid = { id: "test-crate", kind: "cover", min: { x: -10, y: UPPER_LEVEL_Y, z: 4 }, max: { x: -9, y: UPPER_LEVEL_Y + 1.2, z: 5 } };
    const crowded: World = { ...WORLD, solids: [...WORLD.solids, crate] };
    const b = hanging(l, l.x0, 4.5);
    const before = copy(b);
    assert.strictEqual(mantle(crowded, ANCHORS, b), false);
    assert.deepStrictEqual(b, before);
    // Shimmying clear of the crate makes room again.
    for (let i = 0; i < 40; i++) shimmy(crowded, ANCHORS, b, -SHIMMY_STEP);
    assert.ok(b.z >= 6 - EPS);
    assert.ok(mantle(crowded, ANCHORS, b));
    assert.strictEqual(b.y, UPPER_LEVEL_Y);

    // A ledge along the outside of wall-w-s, where only the wall top is above.
    const bare: LedgeAnchor = { id: "test-bare", kind: "ledge", x0: -10.5, z0: -6, x1: -10.5, z1: -3, y: 3, facing: Math.PI / 2 };
    const h = hanging(bare);
    const hb = copy(h);
    assert.strictEqual(mantle(WORLD, [...ANCHORS, bare], h), false);
    assert.deepStrictEqual(h, hb);
  });

  it("drop lets go only when attached; mantle and shimmy only work while hanging", () => {
    const h = hanging(ledge("ledge-mezz-south"));
    h.vy = 5;
    assert.ok(letGo(h));
    assert.strictEqual(h.mode, "falling");
    assert.strictEqual(h.vy, 0);
    assert.strictEqual(h.anchorId, null);

    const a = climbAnchor("climb-west");
    const c = body(a.x, a.z);
    grab(WORLD, ANCHORS, c, true);
    assert.ok(letGo(c));
    assert.strictEqual(c.mode, "falling");

    for (const mode of ["ground", "falling"] as MovementMode[]) {
      const b = body(15, -14, mode === "ground" ? 0 : 1, mode);
      const before = copy(b);
      assert.strictEqual(letGo(b), false);
      assert.strictEqual(mantle(WORLD, ANCHORS, b), false);
      assert.strictEqual(shimmy(WORLD, ANCHORS, b, SHIMMY_STEP), false);
      assert.strictEqual(climbMove(WORLD, ANCHORS, b, CLIMB_STEP), false);
      assert.deepStrictEqual(b, before, mode);
    }
  });
});
