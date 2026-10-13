/**
 * The sheet of ice, drawn once and shared by the editor, the viewer and the
 * index thumbnails.
 *
 * Everything is in **feet on a standard 200 × 85 rink**, origin at the top-left
 * corner of the left-end boards. Using real units rather than a 0–100 box means
 * the markings sit where they sit in an actual arena — blue lines 64 ft off each
 * goal line, end-zone dots 20 ft off it — and a play drawn on the full sheet
 * still reads correctly when the view is cropped to one zone, because cropping
 * is only a change of viewBox and never a change of coordinates.
 */
export const RINK = { length: 200, width: 85, corner: 28 } as const;

export type Surface = "full" | "ozone" | "nzone" | "dzone";

/** The four framings a play can be drawn in. Same ice, different window. */
export const SURFACES: Record<Surface, { label: string; short: string; viewBox: string }> = {
  full:  { label: "Full sheet",      short: "Full",      viewBox: "-3 -3 206 91" },
  dzone: { label: "Defensive zone",  short: "D-zone",    viewBox: "-3 -3 81 91" },
  nzone: { label: "Neutral zone",    short: "N-zone",    viewBox: "70 -3 60 91" },
  ozone: { label: "Offensive zone",  short: "O-zone",    viewBox: "122 -3 81 91" },
};

/* Markings, in feet. These are the numbers, not approximations of them. */
const GOAL_LINE = [11, 189];                 // 11 ft off each end board
const BLUE_LINE = [75, 125];                 // 64 ft off each goal line
const CENTRE = 100;
const DOT_Y = [20.5, 64.5];                  // 22 ft either side of centre
const END_DOT_X = [31, 169];                 // 20 ft off the goal line
const NEUTRAL_DOT_X = [80, 120];             // 5 ft off each blue line
const CIRCLE_R = 15;
const MID_Y = RINK.width / 2;

/** Half-chord of the boards at a given x, so the goal line stops at the boards. */
function boardInset(x: number): number {
  const r = RINK.corner;
  const dx = Math.min(x, RINK.length - x);
  if (dx >= r) return 0;
  return r - Math.sqrt(r * r - (r - dx) * (r - dx));
}

function faceoffCircle(cx: number, cy: number): string {
  // Hash marks: 2 ft long, 5 ft 9 in apart, at the top and bottom of the circle.
  const hash = [-1, 1]
    .flatMap((vy) =>
      [-2.875, 2.875].map(
        (ox) =>
          `<line x1="${cx + ox}" y1="${cy + vy * CIRCLE_R}" x2="${cx + ox}" y2="${
            cy + vy * (CIRCLE_R + 2)
          }" />`,
      ),
    )
    .join("");
  return (
    `<circle class="rk-red-line" cx="${cx}" cy="${cy}" r="${CIRCLE_R}" fill="none" />` +
    `<g class="rk-red-line">${hash}</g>` +
    `<circle class="rk-red-fill" cx="${cx}" cy="${cy}" r="1" />`
  );
}

function net(x: number, dir: 1 | -1): string {
  // Crease: a 6 ft radius arc bulging toward centre ice. Goal: 6 ft across,
  // 4 ft deep, sitting behind the line.
  const crease =
    `M ${x} ${MID_Y - 6} A 6 6 0 0 ${dir > 0 ? 1 : 0} ${x} ${MID_Y + 6} Z`;
  // Trapezoid: 22 ft along the goal line, 28 ft at the end boards.
  const bx = dir > 0 ? 0 : RINK.length;
  const trap =
    `M ${x} ${MID_Y - 11} L ${bx} ${MID_Y - 14} M ${x} ${MID_Y + 11} L ${bx} ${MID_Y + 14}`;
  return (
    `<path class="rk-crease" d="${crease}" />` +
    `<rect class="rk-goal" x="${dir > 0 ? x - 4 : x}" y="${MID_Y - 3}" width="4" height="6" />` +
    `<path class="rk-trapezoid" d="${trap}" />`
  );
}

/**
 * The ice layer: boards, lines, circles, creases. Static markup with no state,
 * so callers can drop it into any `<svg>` and draw their own play on top.
 *
 * `iceFill` is passed in rather than set in CSS because the sheet is painted
 * with an SVG gradient, and a gradient is referenced by id — which only the
 * caller, who owns the `<defs>`, knows.
 */
export function rinkMarkup(iceFill = "#EFF5FC"): string {
  const goalLines = GOAL_LINE.map((x) => {
    const inset = boardInset(x);
    return `<line class="rk-red-line" x1="${x}" y1="${inset}" x2="${x}" y2="${RINK.width - inset}" />`;
  }).join("");

  const blueLines = BLUE_LINE.map(
    (x) => `<line class="rk-blue-line" x1="${x}" y1="0" x2="${x}" y2="${RINK.width}" />`,
  ).join("");

  const endCircles = END_DOT_X.flatMap((x) => DOT_Y.map((y) => faceoffCircle(x, y))).join("");
  const neutralDots = NEUTRAL_DOT_X.flatMap((x) =>
    DOT_Y.map((y) => `<circle class="rk-red-fill" cx="${x}" cy="${y}" r="1" />`),
  ).join("");

  return `
    <rect class="rk-ice" fill="${iceFill}" x="0" y="0" width="${RINK.length}" height="${RINK.width}"
          rx="${RINK.corner}" ry="${RINK.corner}" />
    ${net(GOAL_LINE[0], 1)}
    ${net(GOAL_LINE[1], -1)}
    ${goalLines}
    ${blueLines}
    <line class="rk-centre-line" x1="${CENTRE}" y1="0" x2="${CENTRE}" y2="${RINK.width}" />
    <circle class="rk-blue-line" cx="${CENTRE}" cy="${MID_Y}" r="${CIRCLE_R}" fill="none" />
    <circle class="rk-blue-fill" cx="${CENTRE}" cy="${MID_Y}" r="1" />
    ${endCircles}
    ${neutralDots}
    <path class="rk-ref-crease" d="M ${CENTRE - 10} ${RINK.width} A 10 10 0 0 0 ${CENTRE + 10} ${RINK.width}" />
    <rect class="rk-boards" x="0" y="0" width="${RINK.length}" height="${RINK.width}"
          rx="${RINK.corner}" ry="${RINK.corner}" />
  `;
}

/** Clamp a point to the ice, so a dragged piece can never end up in the stands. */
export function clampToRink(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(RINK.length, Math.max(0, x)),
    y: Math.min(RINK.width, Math.max(0, y)),
  };
}
