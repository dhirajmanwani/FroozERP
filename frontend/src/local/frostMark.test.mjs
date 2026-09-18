import test from "node:test";
import assert from "node:assert/strict";

import {
  FROST_MARK_LOBES,
  FROST_MARK_SIZE,
  circlePath,
  frostMarkGeometry,
  isAxisAngle,
  pointAt,
  polygonPath,
  signedArea,
} from "./frostMark.js";

// What these are for.
//
// A mark is not like the rest of this layer: nothing throws when it is wrong, no number comes out
// different, and the app keeps working. It just looks wrong, at 66 pixels, in the corner of a
// screen somebody stopped noticing weeks ago. So the properties that decide whether it looks right
// are pinned here instead of being left to the eye: the eight lobes evenly spaced, nothing drawn
// outside the field it is drawn in, and every hole wound against the body it is cut from.
//
// The winding one is the only true trap. A hole wound the same way as its body does not fail, it
// fills in — so the lattice silently becomes a solid disc and the mark turns back into roughly the
// circle it replaced.

const centreOf = (point) => Math.hypot(point.x - FROST_MARK_SIZE / 2, point.y - FROST_MARK_SIZE / 2);

test("the mark has eight lobes, evenly spaced", () => {
  const { lobes } = frostMarkGeometry();
  assert.equal(lobes.length, FROST_MARK_LOBES);
  const gaps = lobes.slice(1).map((lobe, index) => Number((lobe.angle - lobes[index].angle).toFixed(6)));
  assert.deepEqual([...new Set(gaps)], [45], "the lobes must sit one eighth of a turn apart");
});

test("no lobe sits on an axis, so two straddle the top", () => {
  // The half-step offset is what makes this a rosette rather than a compass rose, and it is the
  // first thing that would be lost by someone "tidying" the angles to 0, 45, 90.
  const { lobes } = frostMarkGeometry();
  for (const lobe of lobes) {
    assert.ok(!isAxisAngle(lobe.angle), `a lobe at ${lobe.angle}° points straight up, down or sideways`);
  }
});

test("every lobe is the same size and the same distance out", () => {
  const { lobes } = frostMarkGeometry();
  const distances = lobes.map((lobe) => Number(centreOf(lobe).toFixed(3)));
  assert.equal(new Set(distances).size, 1, `lobes sit at ${[...new Set(distances)].join(", ")} from the middle`);
  assert.equal(new Set(lobes.map((lobe) => lobe.radius)).size, 1);
  assert.equal(new Set(lobes.map((lobe) => lobe.ball)).size, 1);
});

test("a ball fits inside its socket, and the socket inside its ring", () => {
  // Get this wrong in either direction and the lobe stops reading as a ball in a ring: too big a
  // ball hides the ring, too small a socket hides the ball.
  const { lobes } = frostMarkGeometry();
  for (const lobe of lobes) {
    assert.ok(lobe.ball < lobe.socket, "the ball must sit inside the socket cut for it");
    assert.ok(lobe.socket < lobe.radius, "the socket must leave a ring around it");
  }
});

test("adjacent lobes meet without swallowing each other", () => {
  // They touch in the reference, which is what makes the outline a continuous rosette rather than
  // eight separate dots. Touching is wanted; a lobe whose centre falls inside its neighbour is not.
  const { lobes } = frostMarkGeometry();
  const first = lobes[0];
  const second = lobes[1];
  const gap = Math.hypot(first.cx - second.cx, first.cy - second.cy);
  assert.ok(gap > first.radius, `neighbouring lobes are ${gap.toFixed(2)} apart and would merge into one blob`);
  assert.ok(gap < first.radius * 2, "neighbouring lobes must overlap enough to read as one outline");
});

test("nothing is drawn outside the field it is drawn in", () => {
  // A radius raised past the edge does not error, it clips — and a clipped mark looks like a mark
  // with one flat side, which reads as a rendering bug rather than as a design.
  const mark = frostMarkGeometry();
  assert.ok(mark.extent < FROST_MARK_SIZE / 2, `the mark reaches ${mark.extent} of a ${FROST_MARK_SIZE / 2} half-field`);
  for (const lobe of mark.lobes) {
    for (const edge of [lobe.cx - lobe.radius, lobe.cy - lobe.radius]) {
      assert.ok(edge > 0, "a lobe crosses the top or left edge");
    }
    for (const edge of [lobe.cx + lobe.radius, lobe.cy + lobe.radius]) {
      assert.ok(edge < FROST_MARK_SIZE, "a lobe crosses the bottom or right edge");
    }
  }
});

test("the lattice sits between the cap and the rim, touching neither", () => {
  // A diamond that reaches under the cap is invisible; one that reaches past the body's edge stops
  // being a hole and opens the outline instead. Both are decisions, and neither is this one.
  const mark = frostMarkGeometry();
  const bodyEdge = Math.min(...mark.octagon.map(centreOf)) * Math.cos(Math.PI / FROST_MARK_LOBES);
  for (const diamond of mark.diamonds) {
    const radii = diamond.points.map(centreOf);
    assert.ok(Math.min(...radii) > mark.capRadius, `a diamond at ${diamond.angle}° runs under the cap`);
    assert.ok(Math.max(...radii) < bodyEdge, `a diamond at ${diamond.angle}° breaks through the rim`);
  }
});

test("the four diamonds on the axes are the long ones", () => {
  // The reference's up/down/left/right spurs. Without the difference the lattice is eight identical
  // lozenges and the mark loses its orientation.
  const { diamonds } = frostMarkGeometry();
  const lengthOf = (diamond) => Math.max(...diamond.points.map(centreOf)) - Math.min(...diamond.points.map(centreOf));
  const onAxis = diamonds.filter((diamond) => isAxisAngle(diamond.angle));
  const offAxis = diamonds.filter((diamond) => !isAxisAngle(diamond.angle));
  assert.equal(onAxis.length, 4);
  assert.equal(offAxis.length, 4);
  assert.ok(lengthOf(onAxis[0]) > lengthOf(offAxis[0]), "the axis diamonds must be the longer pair");
});

test("a polygon is wound the way it was asked for, whatever order its corners came in", () => {
  // The point of computing the winding rather than trusting the caller: the same four corners,
  // written either way round, have to come out as the same path once a direction is asked for.
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const backwards = [...square].reverse();
  assert.ok(signedArea(square) > 0, "this square runs clockwise in a y-down space");
  assert.ok(signedArea(backwards) < 0);

  for (const clockwise of [true, false]) {
    assert.equal(
      polygonPath(square, { clockwise }),
      polygonPath(backwards, { clockwise }),
      "the corner order the caller happened to use must not change the result",
    );
  }
  assert.notEqual(
    polygonPath(square, { clockwise: true }),
    polygonPath(square, { clockwise: false }),
    "the two windings must produce different paths, or nothing can be pierced",
  );
});

test("a circle's winding shows up in its sweep flag", () => {
  // Two arcs that differ only in this flag are the difference between a ring and a filled disc.
  assert.match(circlePath(50, 50, 10, { clockwise: true }), /A 10 10 0 1 1 /);
  assert.match(circlePath(50, 50, 10, { clockwise: false }), /A 10 10 0 1 0 /);
});

test("every hole in the body is wound against it", () => {
  // The property the whole mark rests on. Counted from the path itself rather than from the code
  // that built it, so a later edit that appends a subpath by hand is held to the same rule.
  const mark = frostMarkGeometry();
  const subpaths = mark.body.split("M ").filter(Boolean).map((part) => `M ${part.trim()}`);

  const arcs = subpaths.filter((part) => part.includes("A "));
  const solidArcs = arcs.filter((part) => / 0 1 1 /.test(part));
  const hollowArcs = arcs.filter((part) => / 0 1 0 /.test(part));
  assert.equal(solidArcs.length, FROST_MARK_LOBES, "one filled ring per lobe");
  assert.equal(hollowArcs.length, FROST_MARK_LOBES, "one socket cut out of each");

  const polygons = subpaths.filter((part) => !part.includes("A "));
  const areas = polygons.map((part) => {
    const numbers = part.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const points = [];
    for (let index = 0; index < numbers.length; index += 2) points.push({ x: numbers[index], y: numbers[index + 1] });
    return signedArea(points);
  });
  assert.equal(areas.length, FROST_MARK_LOBES + 1, "the octagon body and one diamond per web");
  assert.ok(areas[0] > 0, "the body octagon must be wound solid");
  for (const area of areas.slice(1)) {
    assert.ok(area < 0, "a diamond wound with the body fills in instead of piercing it");
  }
});

test("the shape can be retuned without escaping its own field", () => {
  // The knobs exist so the mark can be adjusted; this is the guard rail on adjusting them. A lobe
  // orbit pushed out far enough to clip is caught here rather than on a shopkeeper's screen.
  const wide = frostMarkGeometry({ lobeOrbit: 36, lobeOuterRadius: 13 });
  assert.equal(wide.extent, 49);
  assert.ok(wide.extent < FROST_MARK_SIZE / 2);
  const tooWide = frostMarkGeometry({ lobeOrbit: 44, lobeOuterRadius: 13 });
  assert.ok(tooWide.extent > FROST_MARK_SIZE / 2, "the extent must report an overflow rather than hide it");
});

test("a point on the rim is where trigonometry says it is", () => {
  assert.deepEqual(pointAt(0, 10), { x: 60, y: 50 });
  assert.deepEqual(pointAt(90, 10), { x: 50, y: 60 });
  assert.deepEqual(pointAt(180, 10), { x: 40, y: 50 });
});
