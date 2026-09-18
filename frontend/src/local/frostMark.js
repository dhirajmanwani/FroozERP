// The FROST mark: an eight-lobed rosette, drawn from geometry rather than by hand.
//
// The mark used to be a plain CSS circle with a conic gradient and an "F" in it. The
// shape asked for is the one in the reference photo Dhiraj sent: a central cap, eight
// ringed lobes around it each holding a ball, and a pierced lattice of diamonds in the
// web between them. None of that is expressible as a border-radius, so it is an SVG.
//
// Why the geometry lives here and not in App.jsx: this is the only layer in the frontend
// that is practically testable, and a mark built from eight rotations has invariants worth
// pinning - the lobes have to be evenly spaced, the whole thing has to stay inside its own
// viewBox at every radius, and every hole has to be wound against its body or it fills in
// solid instead of piercing. Each of those has a quiet failure mode: the mark still renders,
// it just renders wrong, and at 62 pixels nobody would spot a lobe two degrees out of place.
//
// Nothing here knows a colour. The palette is applied in App.css from the same tokens the
// old launcher used, so the mark's shape can change without its colours moving with it.

/** A square drawing field. Every radius below is in these units, measured from the middle. */
export const FROST_MARK_SIZE = 100;
export const FROST_MARK_CENTRE = FROST_MARK_SIZE / 2;
export const FROST_MARK_VIEWBOX = `0 0 ${FROST_MARK_SIZE} ${FROST_MARK_SIZE}`;

/** Eight lobes, as in the reference. */
export const FROST_MARK_LOBES = 8;

/**
 * The lobes sit half a step off the vertical, so the mark reads as a rosette rather than a
 * compass: two lobes straddle the top instead of one sitting on it. This is the offset that
 * does it, and it is what makes the four diamonds land on the axes where the reference has
 * its arrow-like spurs.
 */
const LOBE_OFFSET_DEGREES = 360 / FROST_MARK_LOBES / 2;

const DEFAULTS = Object.freeze({
  // Centre of each lobe, from the middle of the mark.
  lobeOrbit: 33,
  // The ring around each ball, and the socket cut out of it.
  lobeOuterRadius: 13,
  lobeSocketRadius: 8.6,
  ballRadius: 7.4,
  // The body is an octagon whose corners are the lobe centres, so the lobes bulge out of it
  // exactly as the metal ones do.
  bodyRadius: 33,
  // The raised cap in the middle, which carries the letter.
  capRadius: 14,
  // The lattice: one diamond in each web between two lobes. The four on the axes are drawn
  // longer, which is what gives the reference its up/down/left/right spurs.
  diamondOrbit: 22.6,
  diamondRadial: 6.6,
  diamondTangential: 6,
  axisDiamondRadial: 7.4,
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
 * SVG's default `nonzero` fill is what pierces the lattice: a shape wound against the body it
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

/** A diamond: half-height along the spoke, half-width across it. */
const diamondAt = (degrees, orbit, radial, tangential) => {
  const outward = pointAt(degrees, orbit + radial);
  const inward = pointAt(degrees, orbit - radial);
  const middle = pointAt(degrees, orbit);
  // Measured from zero on purpose: this one is a direction to step sideways from `middle`, not
  // a place on the mark. Treating it as a place puts the diamond's waist in the very middle.
  const side = pointAt(degrees + 90, tangential, 0);
  return [
    outward,
    { x: round(middle.x + side.x), y: round(middle.y + side.y) },
    inward,
    { x: round(middle.x - side.x), y: round(middle.y - side.y) },
  ];
};

/** True for the four spokes that point straight up, down, left and right. */
export const isAxisAngle = (degrees) => ((degrees % 90) + 90) % 90 === 0;

/**
 * Every measurement the mark is drawn from.
 *
 * `body` is one path: the octagon and the eight rings fill it, the sockets and the diamonds
 * pierce it. They have to share a path for the piercing to work at all — a hole is only a
 * hole relative to the shape it is cut from.
 */
export const frostMarkGeometry = (overrides = {}) => {
  const spec = { ...DEFAULTS, ...overrides };
  const step = 360 / FROST_MARK_LOBES;

  const lobes = Array.from({ length: FROST_MARK_LOBES }, (_, index) => {
    const angle = LOBE_OFFSET_DEGREES + index * step;
    const { x, y } = pointAt(angle, spec.lobeOrbit);
    return { angle, cx: x, cy: y, radius: spec.lobeOuterRadius, socket: spec.lobeSocketRadius, ball: spec.ballRadius };
  });

  // The webs sit between the lobes, which is where the reference has its lattice.
  const diamonds = Array.from({ length: FROST_MARK_LOBES }, (_, index) => {
    const angle = index * step;
    const radial = isAxisAngle(angle) ? spec.axisDiamondRadial : spec.diamondRadial;
    return { angle, points: diamondAt(angle, spec.diamondOrbit, radial, spec.diamondTangential) };
  });

  const octagon = Array.from({ length: FROST_MARK_LOBES }, (_, index) => (
    pointAt(LOBE_OFFSET_DEGREES + index * step, spec.bodyRadius)
  ));

  const body = [
    polygonPath(octagon, { clockwise: true }),
    ...lobes.map((lobe) => circlePath(lobe.cx, lobe.cy, lobe.radius, { clockwise: true })),
    ...lobes.map((lobe) => circlePath(lobe.cx, lobe.cy, lobe.socket, { clockwise: false })),
    ...diamonds.map((diamond) => polygonPath(diamond.points, { clockwise: false })),
  ].join(" ");

  return {
    viewBox: FROST_MARK_VIEWBOX,
    centre: FROST_MARK_CENTRE,
    capRadius: spec.capRadius,
    lobes,
    diamonds,
    octagon,
    body,
    // The furthest any ink reaches. Read by the tests, so a radius raised past the edge of the
    // drawing field fails here instead of being quietly clipped on screen.
    extent: round(spec.lobeOrbit + spec.lobeOuterRadius),
  };
};
