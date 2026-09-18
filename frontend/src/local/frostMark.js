// The FROST mark: an eight-lobed gold rosette holding green stones, drawn from geometry
// rather than by hand.
//
// The shape is the one in the reference Dhiraj sent: a gold centre ring carrying a
// snowflake, eight gold bezels around it each holding a domed green cabochon, eight gold
// spokes welding the ring to the bezels, an octagonal gold frame closing the rim, and two
// rings of faceted green stones inset in the pockets the gold leaves between them. None of
// that is expressible as a border-radius, so it is an SVG.
//
// Why the geometry lives here and not in App.jsx: this is the only layer in the frontend
// that is practically testable, and a mark built from eight rotations has invariants worth
// pinning - the lobes have to be evenly spaced, the whole thing has to stay inside its own
// viewBox at every radius, the stones have to land in the pockets rather than under the
// gold, and the two holes in the gold have to be wound against it or they fill in solid.
// Each of those has a quiet failure mode: the mark still renders, it just renders wrong,
// and at 66 pixels nobody would spot a lobe two degrees out of place.
//
// Nothing here knows a colour. The palette is applied in App.css from the same brand values
// the launcher already used, so the mark's shape can change without its colours moving
// with it.

/** A square drawing field. Every radius below is in these units, measured from the middle. */
export const FROST_MARK_SIZE = 100;
export const FROST_MARK_CENTRE = FROST_MARK_SIZE / 2;
export const FROST_MARK_VIEWBOX = `0 0 ${FROST_MARK_SIZE} ${FROST_MARK_SIZE}`;

/** Eight lobes, as in the reference. */
export const FROST_MARK_LOBES = 8;

/**
 * A lobe points straight up. The reference is squared to its own frame - one stone at the
 * top, one at the bottom, one at each side - and that is what makes the octagonal rim read
 * as a frame rather than as a tilted blob. Starting the ring at -90° is what does it, and
 * it is the first thing that would be lost by someone "tidying" this to 0.
 */
const LOBE_OFFSET_DEGREES = -90;

/** The angle a sector points along: halfway between two lobes, which is where the stones sit. */
const SECTOR_OFFSET_DEGREES = LOBE_OFFSET_DEGREES + 360 / FROST_MARK_LOBES / 2;

const DEFAULTS = Object.freeze({
  // Centre of each lobe, from the middle of the mark.
  lobeOrbit: 37.4,
  // The gold bezel, and the cabochon seated in it.
  lobeBezelRadius: 10.4,
  lobeGemRadius: 8.1,
  // The centre ring: gold from `capOuterRadius` in to `capInnerRadius`, green inside that.
  capOuterRadius: 17.6,
  capInnerRadius: 14.8,
  // The bars from the centre ring out to each bezel.
  spokeHalfWidth: 4.2,
  // The octagonal rim, as two octagons with their corners on the lobes: the band between
  // them is the frame, and the hole inside it is where the stones show through.
  frameOuterRadius: 38,
  frameInnerRadius: 34.6,
  // Two rings of inset stones per sector, small one inboard and wide one outboard, as in
  // the reference. Each is an elongated hexagon: `Radial` is half its length along the
  // spoke, `Tangential` half its width across it.
  innerGemOrbit: 21.7,
  innerGemRadial: 3.1,
  innerGemTangential: 2.9,
  outerGemOrbit: 28.5,
  outerGemRadial: 3.1,
  outerGemTangential: 6.6,
  // The raised table each stone is cut with, as a fraction of the stone. The rest of it
  // reads as the bevel around the table.
  gemTableScale: 0.66,
  // The snowflake in the middle: arm length, and the stroke it is drawn with.
  flakeArm: 11,
  flakeStroke: 1.7,
});

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const round = (value) => Number(value.toFixed(3));

/** Where a point at `degrees` around the middle lands, `radius` out. */
export const pointAt = (degrees, radius, centre = FROST_MARK_CENTRE) => {
  const angle = toRadians(degrees);
  return { x: round(centre + radius * Math.cos(angle)), y: round(centre + radius * Math.sin(angle)) };
};

/** Twice the signed area. Positive means the points run clockwise in SVG's y-down space. */
export const signedArea = (points) => points.reduce((total, point, index) => {
  const next = points[(index + 1) % points.length];
  return total + (point.x * next.y - next.x * point.y);
}, 0);

/**
 * A closed polygon, wound the way the caller asked for.
 *
 * SVG's default `nonzero` fill is what opens the gold up: a shape wound against the body it
 * sits on cancels it and leaves a hole, and the same shape wound with it merely fills in. The
 * difference is invisible in the path data and total on screen, so the winding is computed
 * here rather than trusted to the order somebody happened to write the corners in.
 */
export const polygonPath = (points, { clockwise = true } = {}) => {
  const ordered = (signedArea(points) >= 0) === clockwise ? points : [...points].reverse();
  const [first, ...rest] = ordered;
  return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")} Z`;
};

/** A closed circle as two arcs, wound the way the caller asked for. */
export const circlePath = (cx, cy, radius, { clockwise = true } = {}) => {
  const sweep = clockwise ? 1 : 0;
  const left = round(cx - radius);
  const right = round(cx + radius);
  const r = round(radius);
  return `M ${right} ${round(cy)} A ${r} ${r} 0 1 ${sweep} ${left} ${round(cy)} A ${r} ${r} 0 1 ${sweep} ${right} ${round(cy)} Z`;
};

/**
 * A point `radius` out along `degrees`, then `sideways` across it.
 *
 * The sideways step is measured from zero on purpose: it is a direction to step in, not a
 * place on the mark. Treating it as a place puts every shape's waist in the very middle.
 */
const offsetPoint = (degrees, radius, sideways) => {
  const along = pointAt(degrees, radius);
  const across = pointAt(degrees + 90, sideways, 0);
  return { x: round(along.x + across.x), y: round(along.y + across.y) };
};

/** Where a stone's shoulders sit along its own length. Lower means a pointier stone. */
const GEM_SHOULDER = 0.42;

/** An inset stone: an elongated hexagon lying along its spoke. */
const gemAt = (degrees, orbit, radial, tangential) => [
  offsetPoint(degrees, orbit + radial, 0),
  offsetPoint(degrees, orbit + radial * GEM_SHOULDER, tangential),
  offsetPoint(degrees, orbit - radial * GEM_SHOULDER, tangential),
  offsetPoint(degrees, orbit - radial, 0),
  offsetPoint(degrees, orbit - radial * GEM_SHOULDER, -tangential),
  offsetPoint(degrees, orbit + radial * GEM_SHOULDER, -tangential),
];

/** The same shape shrunk about its own middle, which is the stone's table inside its bevel. */
const shrink = (points, factor) => {
  const cx = points.reduce((total, point) => total + point.x, 0) / points.length;
  const cy = points.reduce((total, point) => total + point.y, 0) / points.length;
  return points.map((point) => ({
    x: round(cx + (point.x - cx) * factor),
    y: round(cy + (point.y - cy) * factor),
  }));
};

/** A bar running out along `degrees`, from `inner` to `outer`. */
const spokeAt = (degrees, inner, outer, halfWidth) => [
  offsetPoint(degrees, inner, halfWidth),
  offsetPoint(degrees, outer, halfWidth),
  offsetPoint(degrees, outer, -halfWidth),
  offsetPoint(degrees, inner, -halfWidth),
];

/** An octagon with a corner on each lobe. */
const octagonAt = (radius) => Array.from({ length: FROST_MARK_LOBES }, (_, index) => (
  pointAt(LOBE_OFFSET_DEGREES + index * (360 / FROST_MARK_LOBES), radius)
));

/** True for the four spokes that point straight up, down, left and right. */
export const isAxisAngle = (degrees) => ((degrees % 90) + 90) % 90 === 0;

/** The six arms the snowflake in the cap is drawn from, including the vertical one. */
export const FLAKE_ARMS = [90, 150, 210, 270, 330, 30];

/**
 * The snowflake, as open strokes rather than a filled outline.
 *
 * Stroked because it is drawn at about fourteen pixels across: an outline that thin renders
 * as a smear, where a stroke with a round cap stays a snowflake. The three diameters draw
 * the six arms between them, so the middle is crossed once rather than six times.
 */
export const snowflakePath = (armLength, {
  centre = FROST_MARK_CENTRE,
  branchAt = [0.42, 0.72],
  branchLength = [0.28, 0.19],
  branchAngle = 45,
} = {}) => {
  const segments = [];
  for (const angle of FLAKE_ARMS.slice(0, 3)) {
    const tip = pointAt(angle, armLength, centre);
    const tail = pointAt(angle + 180, armLength, centre);
    segments.push(`M ${tail.x} ${tail.y} L ${tip.x} ${tip.y}`);
  }
  for (const angle of FLAKE_ARMS) {
    branchAt.forEach((along, index) => {
      const root = pointAt(angle, armLength * along, centre);
      const length = armLength * branchLength[index];
      for (const side of [-1, 1]) {
        const step = pointAt(angle + side * branchAngle, length, 0);
        segments.push(`M ${root.x} ${root.y} L ${round(root.x + step.x)} ${round(root.y + step.y)}`);
      }
    });
  }
  return segments.join(" ");
};

/**
 * Every measurement the mark is drawn from.
 *
 * `gold` is one path, and has to be: the frame band and the centre ring are each an outer
 * shape with an inner one cut out of it, and a hole is only a hole relative to the shape it
 * is cut from. The spokes join the same path so they weld to the ring instead of sitting on
 * it as separate slabs with seams between.
 */
export const frostMarkGeometry = (overrides = {}) => {
  const spec = { ...DEFAULTS, ...overrides };
  const step = 360 / FROST_MARK_LOBES;

  const lobes = Array.from({ length: FROST_MARK_LOBES }, (_, index) => {
    const angle = LOBE_OFFSET_DEGREES + index * step;
    const { x, y } = pointAt(angle, spec.lobeOrbit);
    return { angle, cx: x, cy: y, bezel: spec.lobeBezelRadius, gem: spec.lobeGemRadius };
  });

  // The spokes start inside the gold of the ring rather than at its edge, so the two weld
  // into one piece. Starting any further in would push a spoke across the ring's hole and
  // fill the face the snowflake is cut into.
  const spokeInner = Math.max(spec.capInnerRadius, spec.capOuterRadius - 0.8);
  const spokes = lobes.map((lobe) => ({
    angle: lobe.angle,
    points: spokeAt(lobe.angle, spokeInner, spec.lobeOrbit, spec.spokeHalfWidth),
  }));

  // Two stones per sector, in the pocket between two spokes: a small one inboard, a wide
  // one out at the rim. The reference has the outer pair carrying the mark's weight.
  const gems = Array.from({ length: FROST_MARK_LOBES }, (_, index) => {
    const angle = SECTOR_OFFSET_DEGREES + index * step;
    return [
      { angle, ring: "inner", points: gemAt(angle, spec.innerGemOrbit, spec.innerGemRadial, spec.innerGemTangential) },
      { angle, ring: "outer", points: gemAt(angle, spec.outerGemOrbit, spec.outerGemRadial, spec.outerGemTangential) },
    ];
  }).flat().map((gem) => ({ ...gem, table: shrink(gem.points, spec.gemTableScale) }));

  const frameOuter = octagonAt(spec.frameOuterRadius);
  const frameInner = octagonAt(spec.frameInnerRadius);

  const gold = [
    polygonPath(frameOuter, { clockwise: true }),
    polygonPath(frameInner, { clockwise: false }),
    ...spokes.map((spoke) => polygonPath(spoke.points, { clockwise: true })),
    circlePath(FROST_MARK_CENTRE, FROST_MARK_CENTRE, spec.capOuterRadius, { clockwise: true }),
    circlePath(FROST_MARK_CENTRE, FROST_MARK_CENTRE, spec.capInnerRadius, { clockwise: false }),
  ].join(" ");

  return {
    viewBox: FROST_MARK_VIEWBOX,
    centre: FROST_MARK_CENTRE,
    capOuterRadius: spec.capOuterRadius,
    capInnerRadius: spec.capInnerRadius,
    lobes,
    spokes,
    gems,
    frameOuter,
    frameInner,
    // The plate the gold sits on. Its edge is the frame's own outer edge, so the only thing
    // that reaches past it is the bezels - exactly as they bulge past the rim in the
    // reference.
    plate: polygonPath(frameOuter, { clockwise: true }),
    gold,
    flake: snowflakePath(spec.flakeArm),
    flakeStroke: spec.flakeStroke,
    flakeArm: spec.flakeArm,
    // The furthest any ink reaches. Read by the tests, so a radius raised past the edge of
    // the drawing field fails here instead of being quietly clipped on screen.
    extent: round(spec.lobeOrbit + spec.lobeBezelRadius),
  };
};
