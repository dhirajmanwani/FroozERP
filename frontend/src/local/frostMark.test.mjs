import test from "node:test";
import assert from "node:assert/strict";

import {
  FLAKE_ARMS,
  FROST_MARK_LOBES,
  FROST_MARK_SIZE,
  circlePath,
  frostMarkGeometry,
  isAxisAngle,
  pointAt,
  polygonPath,
  signedArea,
  snowflakePath,
} from "./frostMark.js";

// What these are for.
//
// A mark is not like the rest of this layer: nothing throws when it is wrong, no number comes out
// different, and the app keeps working. It just looks wrong, at 66 pixels, in the corner of a
// screen somebody stopped noticing weeks ago. So the properties that decide whether it looks right
// are pinned here instead of being left to the eye: the eight lobes evenly spaced and squared to
// the frame, nothing drawn outside the field it is drawn in, every stone landing in the pocket the
// gold leaves for it, and both holes in the gold wound against it.
//
// The winding one is the only true trap. A hole wound the same way as its body does not fail, it
// fills in — so the frame becomes a solid octagon, the centre ring swallows its own face, and the
// mark turns back into roughly the disc it replaced.

const CENTRE = FROST_MARK_SIZE / 2;
const radiusOf = (point) => Math.hypot(point.x - CENTRE, point.y - CENTRE);
const angleOf = (point) => (Math.atan2(point.y - CENTRE, point.x - CENTRE) * 180) / Math.PI;
const angleGap = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

test("the mark has eight lobes, evenly spaced", () => {
  const { lobes } = frostMarkGeometry();
  assert.equal(lobes.length, FROST_MARK_LOBES);
  const gaps = lobes.slice(1).map((lobe, index) => Number((lobe.angle - lobes[index].angle).toFixed(6)));
  assert.deepEqual([...new Set(gaps)], [45], "the lobes must sit one eighth of a turn apart");
});

test("a lobe points straight up, and four sit on the axes", () => {
  // The reference is squared to its own frame: a stone at twelve o'clock, one at six, one at each
  // side. Rotate the ring by half a step and it becomes a pinwheel — still eight lobes, no longer
  // this mark.
  const { lobes } = frostMarkGeometry();
  const top = lobes.find((lobe) => lobe.cy < CENTRE && Math.abs(lobe.cx - CENTRE) < 0.001);
  assert.ok(top, "no lobe sits directly above the middle");
  assert.equal(lobes.filter((lobe) => isAxisAngle(lobe.angle)).length, 4);
});

test("every lobe is the same size and the same distance out", () => {
  const { lobes } = frostMarkGeometry();
  const distances = lobes.map((lobe) => Number(radiusOf({ x: lobe.cx, y: lobe.cy }).toFixed(3)));
  assert.equal(new Set(distances).size, 1, `lobes sit at ${[...new Set(distances)].join(", ")} from the middle`);
  assert.equal(new Set(lobes.map((lobe) => lobe.bezel)).size, 1);
  assert.equal(new Set(lobes.map((lobe) => lobe.gem)).size, 1);
});

test("a cabochon sits inside the bezel that holds it", () => {
  // Get this wrong in either direction and the lobe stops reading as a stone in a ring: too big a
  // stone hides the gold, too small a one turns the lobe into a gold disc with a dot on it.
  const { lobes } = frostMarkGeometry();
  for (const lobe of lobes) {
    assert.ok(lobe.gem < lobe.bezel, "the stone must leave a bezel around it");
    assert.ok(lobe.gem > lobe.bezel * 0.6, "the bezel must read as a rim, not as the whole lobe");
  }
});

test("the lobes stand clear of each other, and the frame is what joins them", () => {
  // In this reference the bezels do not touch: the octagonal frame runs between them and the gap
  // is where the stones show. Lobes pushed together far enough to overlap would swallow that gap
  // and the rim would read as one lumpy ring.
  const mark = frostMarkGeometry();
  const [first, second] = mark.lobes;
  const gap = Math.hypot(first.cx - second.cx, first.cy - second.cy);
  assert.ok(gap > first.bezel * 2, `neighbouring bezels are ${gap.toFixed(2)} apart and overlap each other`);
  // The frame's corners land on the lobes, which is what welds the ring shut.
  const corners = mark.frameOuter.map(radiusOf);
  assert.ok(Math.max(...corners) > radiusOf({ x: first.cx, y: first.cy }) - first.bezel,
    "the frame must reach the bezels it is meant to join");
});

test("nothing is drawn outside the field it is drawn in", () => {
  // A radius raised past the edge does not error, it clips — and a clipped mark looks like a mark
  // with one flat side, which reads as a rendering bug rather than as a design.
  const mark = frostMarkGeometry();
  assert.ok(mark.extent < FROST_MARK_SIZE / 2, `the mark reaches ${mark.extent} of a ${FROST_MARK_SIZE / 2} half-field`);
  for (const lobe of mark.lobes) {
    for (const edge of [lobe.cx - lobe.bezel, lobe.cy - lobe.bezel]) {
      assert.ok(edge > 0, "a lobe crosses the top or left edge");
    }
    for (const edge of [lobe.cx + lobe.bezel, lobe.cy + lobe.bezel]) {
      assert.ok(edge < FROST_MARK_SIZE, "a lobe crosses the bottom or right edge");
    }
  }
});

test("every inset stone lands in the pocket the gold leaves for it", () => {
  // The stones are drawn on top of the gold, so one that strays is not clipped — it is painted
  // over the frame or the spoke it overlaps, and the gold silently grows a green bite out of it.
  const mark = frostMarkGeometry();
  const frameEdge = mark.frameInner.map(radiusOf)[0] * Math.cos(Math.PI / FROST_MARK_LOBES);
  const spokeHalfWidth = Math.hypot(
    mark.spokes[0].points[0].x - mark.spokes[0].points[3].x,
    mark.spokes[0].points[0].y - mark.spokes[0].points[3].y,
  ) / 2;

  assert.equal(mark.gems.length, FROST_MARK_LOBES * 2, "two rings of stones, one per sector each");
  for (const gem of mark.gems) {
    for (const point of gem.points) {
      const radius = radiusOf(point);
      assert.ok(radius > mark.capOuterRadius, `a ${gem.ring} stone at ${gem.angle}° runs under the centre ring`);
      assert.ok(radius < frameEdge, `a ${gem.ring} stone at ${gem.angle}° runs under the frame`);
      const clearance = Math.min(...mark.spokes.map((spoke) => radius * Math.sin((angleGap(angleOf(point), spoke.angle) * Math.PI) / 180)));
      assert.ok(clearance > spokeHalfWidth, `a ${gem.ring} stone at ${gem.angle}° overlaps a spoke`);
    }
  }
});

test("the two rings of stones do not sit on each other", () => {
  // They are a pair per sector, not a smear: the inner one small, the outer one wide, with gold
  // between. Overlapping them reads as one long blob and loses the reference's depth.
  const mark = frostMarkGeometry();
  const sector = mark.gems.filter((gem) => gem.angle === mark.gems[0].angle);
  const [inner, outer] = ["inner", "outer"].map((ring) => sector.find((gem) => gem.ring === ring));
  assert.ok(Math.max(...inner.points.map(radiusOf)) < Math.min(...outer.points.map(radiusOf)),
    "the inner stone reaches into the outer one");

  const widthOf = (gem) => Math.max(...gem.points.map((point) => Math.hypot(point.x - gem.points[0].x, point.y - gem.points[0].y)));
  assert.ok(widthOf(outer) > widthOf(inner), "the outer ring carries the bigger stones, as in the reference");
});

test("each stone's table sits inside its own bevel", () => {
  // The table is what makes a flat green hexagon read as a cut stone. Drawn the same size as the
  // stone it disappears; drawn bigger it becomes the stone and the bevel vanishes.
  for (const gem of frostMarkGeometry().gems) {
    assert.equal(gem.table.length, gem.points.length);
    assert.ok(Math.abs(signedArea(gem.table)) < Math.abs(signedArea(gem.points)), "the table must be the smaller shape");
    assert.ok(Math.abs(signedArea(gem.table)) > 0, "a table shrunk to nothing leaves a stone with no face");
  }
});

test("the spokes weld the ring to the lobes without crossing its face", () => {
  // A spoke that reaches past the ring's inner edge fills the disc the snowflake is cut into,
  // because they share one path and one winding. Nothing errors; the snowflake just loses its
  // ground and the middle turns solid gold.
  const mark = frostMarkGeometry();
  assert.equal(mark.spokes.length, FROST_MARK_LOBES);
  for (const spoke of mark.spokes) {
    const radii = spoke.points.map(radiusOf);
    assert.ok(Math.min(...radii) >= mark.capInnerRadius, `the spoke at ${spoke.angle}° reaches into the ring's face`);
    assert.ok(Math.min(...radii) < mark.capOuterRadius, `the spoke at ${spoke.angle}° stops short of the ring and leaves a seam`);
    assert.ok(Math.max(...radii) >= mark.lobes[0].bezel, `the spoke at ${spoke.angle}° does not reach its lobe`);
  }
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

test("both holes in the gold are wound against it", () => {
  // The property the whole mark rests on. Counted from the path itself rather than from the code
  // that built it, so a later edit that appends a subpath by hand is held to the same rule.
  const mark = frostMarkGeometry();
  const subpaths = mark.gold.split("M ").filter(Boolean).map((part) => `M ${part.trim()}`);

  const arcs = subpaths.filter((part) => part.includes("A "));
  assert.equal(arcs.filter((part) => / 0 1 1 /.test(part)).length, 1, "the centre ring's outside must be solid");
  assert.equal(arcs.filter((part) => / 0 1 0 /.test(part)).length, 1, "its face must be cut out of it");

  const areas = subpaths.filter((part) => !part.includes("A ")).map((part) => {
    const numbers = part.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const points = [];
    for (let index = 0; index < numbers.length; index += 2) points.push({ x: numbers[index], y: numbers[index + 1] });
    return signedArea(points);
  });
  assert.equal(areas.length, FROST_MARK_LOBES + 2, "the two frame octagons and one spoke per lobe");
  assert.equal(areas.filter((area) => area < 0).length, 1, "exactly one of them is a hole: the frame's inside");
  assert.ok(areas[0] > 0 && areas[1] < 0, "the frame must be an outer octagon with an inner one cut from it");
});

test("the snowflake has six arms and stays on the ring's face", () => {
  // Six, not eight: the mark's own symmetry is eightfold and a snowflake's is not, and copying the
  // rosette's count here is the change that would quietly turn it into a star.
  const mark = frostMarkGeometry();
  assert.equal(FLAKE_ARMS.length, 6);
  assert.ok(FLAKE_ARMS.includes(90) && FLAKE_ARMS.includes(270), "an arm must point straight up and down");

  const points = mark.flake.match(/-?\d+(?:\.\d+)?/g).map(Number);
  let furthest = 0;
  for (let index = 0; index < points.length; index += 2) {
    furthest = Math.max(furthest, radiusOf({ x: points[index], y: points[index + 1] }));
  }
  assert.ok(furthest + mark.flakeStroke / 2 < mark.capInnerRadius,
    `the snowflake reaches ${furthest.toFixed(2)} and the face it is drawn on ends at ${mark.capInnerRadius}`);
});

test("the snowflake is drawn as strokes, not as one continuous scribble", () => {
  // Every branch has to start with its own move. Dropping one joins two branches with a line
  // across the middle of the flake, which renders as a smudge rather than as an error.
  const flake = snowflakePath(10);
  const moves = flake.match(/M /g).length;
  const lines = flake.match(/L /g).length;
  assert.equal(moves, lines, "each stroke is exactly one move and one line");
  assert.equal(moves, 3 + FLAKE_ARMS.length * 4, "three diameters, plus two pairs of branches per arm");
});

test("the shape can be retuned without escaping its own field", () => {
  // The knobs exist so the mark can be adjusted; this is the guard rail on adjusting them. A lobe
  // orbit pushed out far enough to clip is caught here rather than on a shopkeeper's screen.
  const wide = frostMarkGeometry({ lobeOrbit: 38, lobeBezelRadius: 11 });
  assert.equal(wide.extent, 49);
  assert.ok(wide.extent < FROST_MARK_SIZE / 2);
  const tooWide = frostMarkGeometry({ lobeOrbit: 44, lobeBezelRadius: 11 });
  assert.ok(tooWide.extent > FROST_MARK_SIZE / 2, "the extent must report an overflow rather than hide it");
});

test("a point on the rim is where trigonometry says it is", () => {
  assert.deepEqual(pointAt(0, 10), { x: 60, y: 50 });
  assert.deepEqual(pointAt(90, 10), { x: 50, y: 60 });
  assert.deepEqual(pointAt(180, 10), { x: 40, y: 50 });
});
