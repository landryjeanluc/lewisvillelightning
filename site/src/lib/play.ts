/**
 * The play document: the shape the coach draws, the API stores and the viewer
 * replays. One definition, used by all three, so a diagram can never mean two
 * different things at two ends of the wire.
 *
 * The geometry helpers below are deliberately DOM-free. The index page draws
 * forty thumbnails and the editor redraws on every pointer move; neither can
 * afford to go through the layout engine to work out where a line goes.
 */
import type { Surface } from "./rink";

export type TokenKind = "us" | "them" | "puck" | "cone" | "goalie" | "goalieThem";
export type PathKind = "skate" | "pass" | "shot" | "backward";

export interface Pt { x: number; y: number }

export interface Step { id: string; caption: string; duration: number }
export interface Token extends Pt {
  id: string; kind: TokenKind; label: string; playerId?: string | null;
}
export interface PlayPath {
  id: string; kind: PathKind; step: number; tokenId: string | null; points: Pt[];
}
export interface Note extends Pt { id: string; step: number; text: string }
export interface Pen { id: string; step: number; points: Pt[] }

export interface Diagram {
  v: 1;
  steps: Step[];
  tokens: Token[];
  paths: PlayPath[];
  notes: Note[];
  pen: Pen[];
}

export interface Play {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  category: string;
  surface: Surface;
  diagram: Diagram;
  status: "draft" | "published";
  week_of: string | null;
  game_id: string | null;
  published_at: string | null;
  updated_at: string;
  author: string | null;
}

export const CATEGORIES: { value: string; label: string }[] = [
  { value: "breakout",    label: "Breakout" },
  { value: "forecheck",   label: "Forecheck" },
  { value: "powerplay",   label: "Power play" },
  { value: "penaltykill", label: "Penalty kill" },
  { value: "faceoff",     label: "Faceoff" },
  { value: "neutralzone", label: "Neutral zone" },
  { value: "dzone",       label: "D-zone coverage" },
  { value: "drill",       label: "Practice drill" },
  { value: "other",       label: "Other" },
];
export const categoryLabel = (v: string) =>
  CATEGORIES.find((c) => c.value === v)?.label ?? "Play";

export const TOKEN_KINDS: { value: TokenKind; label: string; hint: string }[] = [
  { value: "us",         label: "Us",          hint: "One of ours (✕)" },
  { value: "them",       label: "Them",        hint: "An opponent (◯)" },
  { value: "puck",       label: "Puck",        hint: "The puck" },
  { value: "goalie",     label: "Our goalie",  hint: "Our netminder" },
  { value: "goalieThem", label: "Their goalie", hint: "Their netminder" },
  { value: "cone",       label: "Cone",        hint: "A cone, for drills" },
];

export const PATH_KINDS: { value: PathKind; label: string; hint: string }[] = [
  { value: "skate",    label: "Skate",    hint: "Solid line — a player carrying or moving" },
  { value: "pass",     label: "Pass",     hint: "Dashed line — the puck leaves the stick" },
  { value: "shot",     label: "Shot",     hint: "Barred line — a shot on net" },
  { value: "backward", label: "Backward", hint: "Wavy line — skating backwards" },
];

let seq = 0;
/** Short, collision-proof-enough ids. The server caps them at 40 characters. */
export const uid = (prefix: string) =>
  `${prefix}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function emptyDiagram(): Diagram {
  return {
    v: 1,
    steps: [{ id: uid("s"), caption: "", duration: 1400 }],
    tokens: [], paths: [], notes: [], pen: [],
  };
}

/** Tolerate anything the server might hand back, including `{}` from an old row. */
export function normaliseDiagram(d: any): Diagram {
  const base = emptyDiagram();
  if (!d || typeof d !== "object") return base;
  const steps: Step[] = Array.isArray(d.steps) && d.steps.length ? d.steps : base.steps;
  return {
    v: 1,
    steps,
    tokens: Array.isArray(d.tokens) ? d.tokens : [],
    paths: Array.isArray(d.paths) ? d.paths : [],
    notes: Array.isArray(d.notes) ? d.notes : [],
    pen: Array.isArray(d.pen) ? d.pen : [],
  };
}

/* ------------------------------------------------------------- geometry -- */

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Ramer–Douglas–Peucker. A finger dragged across a tablet produces hundreds of
 * points a foot apart; this throws away the ones that say nothing, which keeps
 * the document small and, more usefully, keeps the smoothing from wobbling.
 */
export function simplify(points: Pt[], eps = 0.9): Pt[] {
  if (points.length < 3) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    const a = points[lo], b = points[hi];
    const len = dist(a, b);
    let worst = -1, worstAt = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i];
      const d = len === 0
        ? dist(p, a)
        : Math.abs((b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x) / len;
      if (d > worst) { worst = d; worstAt = i; }
    }
    if (worst > eps) {
      keep[worstAt] = true;
      stack.push([lo, worstAt], [worstAt, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Catmull-Rom through every point, emitted as cubic béziers.
 *
 * Why not just join the dots: a breakout drawn as straight segments reads as a
 * robot's route. Players skate arcs, and the curve is what makes the diagram
 * look like hockey rather than like a flowchart.
 */
export function smoothD(points: Pt[]): string {
  if (points.length < 2) return "";
  if (points.length === 2)
    return `M ${f(points[0].x)} ${f(points[0].y)} L ${f(points[1].x)} ${f(points[1].y)}`;

  const pts = points;
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${f(c1.x)} ${f(c1.y)}, ${f(c2.x)} ${f(c2.y)}, ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

const f = (n: number) => Math.round(n * 100) / 100;

/** Walk a polyline and emit points at a fixed spacing, with their normals. */
function resample(points: Pt[], spacing: number): { p: Pt; nx: number; ny: number }[] {
  const out: { p: Pt; nx: number; ny: number }[] = [];
  let carry = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const seg = dist(a, b);
    if (seg === 0) continue;
    const ux = (b.x - a.x) / seg, uy = (b.y - a.y) / seg;
    for (let t = carry; t < seg; t += spacing) {
      out.push({ p: { x: a.x + ux * t, y: a.y + uy * t }, nx: -uy, ny: ux });
    }
    carry = (carry - seg) % spacing;
    if (carry < 0) carry += spacing;
  }
  const last = points[points.length - 1];
  out.push({ p: last, nx: 0, ny: 0 });
  return out;
}

/**
 * The backward-skating squiggle. Hockey notation draws it as a wave along the
 * route, so the wave is generated from the route's own normals rather than
 * faked with a dash pattern — it follows the curve round the corners.
 */
export function squiggleD(points: Pt[], amplitude = 1.5, wavelength = 4): string {
  const dense = densify(points);
  const samples = resample(dense, wavelength / 4);
  if (samples.length < 2) return smoothD(points);
  const total = samples.length;
  const wave = samples.map((s, i) => {
    // Flatten the wave at both ends so it starts on the piece and finishes on
    // the arrowhead instead of beside them.
    const edge = Math.min(i, total - 1 - i) / 3;
    const a = amplitude * Math.min(1, edge);
    const phase = (i * (wavelength / 4)) / wavelength * Math.PI * 2;
    const k = Math.sin(phase) * a;
    return { x: s.p.x + s.nx * k, y: s.p.y + s.ny * k };
  });
  return smoothD(wave);
}

/** Subdivide a polyline so the squiggle follows curves, not just corners. */
function densify(points: Pt[], step = 1.5): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 0; k < n; k++)
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  out.push(points[points.length - 1]);
  return out;
}

/** What gets drawn for a path — the squiggle for backward, the curve otherwise. */
export const pathD = (p: PlayPath) =>
  p.kind === "backward" ? squiggleD(p.points) : smoothD(p.points);

/** Total length of the polyline, in feet. Used to reject accidental taps. */
export const polylineLength = (points: Pt[]) =>
  points.reduce((sum, p, i) => (i ? sum + dist(points[i - 1], p) : 0), 0);

/* --------------------------------------------------------------- pieces -- */

export const TOKEN_R = 3.4;

/** One piece, as SVG. `state` lets the editor tint a selection without forking. */
export function tokenMarkup(t: Token, opts: { selected?: boolean } = {}): string {
  const cls = `pl-token pl-${t.kind}${opts.selected ? " is-selected" : ""}`;
  const r = TOKEN_R;
  let glyph = "";
  switch (t.kind) {
    case "us":
      glyph =
        `<line x1="${-r * 0.62}" y1="${-r * 0.62}" x2="${r * 0.62}" y2="${r * 0.62}" />` +
        `<line x1="${r * 0.62}" y1="${-r * 0.62}" x2="${-r * 0.62}" y2="${r * 0.62}" />`;
      break;
    case "them":
      glyph = `<circle cx="0" cy="0" r="${r * 0.72}" fill="none" />`;
      break;
    case "puck":
      glyph = `<circle cx="0" cy="0" r="1.45" />`;
      break;
    case "cone":
      glyph = `<path d="M 0 ${-r * 0.8} L ${r * 0.72} ${r * 0.6} L ${-r * 0.72} ${r * 0.6} Z" />`;
      break;
    case "goalie":
    case "goalieThem":
      glyph =
        `<rect x="${-r * 0.78}" y="${-r * 0.78}" width="${r * 1.56}" height="${r * 1.56}" rx="1.1" fill="none" />` +
        `<text class="pl-glyph-text" x="0" y="${r * 0.42}">G</text>`;
      break;
  }
  const label = t.label
    ? `<text class="pl-token-label" x="0" y="${r + 4.4}">${escapeXml(t.label)}</text>`
    : "";
  // A generous invisible disc under every piece: these get grabbed with a
  // thumb on a tablet, where the glyph itself is a few millimetres across.
  return (
    `<g class="${cls}" data-id="${t.id}" transform="translate(${f(t.x)} ${f(t.y)})">` +
    `<circle class="pl-hit" cx="0" cy="0" r="${r + 1.6}" />` +
    `<g class="pl-glyph">${glyph}</g>${label}</g>`
  );
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/* -------------------------------------------------------------- timeline -- */

/** Where every piece sits once `step` has finished playing. */
export function positionsAfter(d: Diagram, step: number): Map<string, Pt> {
  const at = new Map<string, Pt>(d.tokens.map((t) => [t.id, { x: t.x, y: t.y }]));
  for (let s = 0; s <= step; s++) {
    for (const p of d.paths) {
      if (p.step !== s || !p.tokenId) continue;
      const end = p.points[p.points.length - 1];
      at.set(p.tokenId, { x: end.x, y: end.y });
    }
  }
  return at;
}

export const totalDuration = (d: Diagram) =>
  d.steps.reduce((sum, s) => sum + s.duration, 0);
