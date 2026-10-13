/**
 * Replaying a play.
 *
 * The stage draws the diagram on a rink and walks it one numbered step at a
 * time: during a step the lines of that step draw themselves on, and the pieces
 * bound to them skate along. Lines from earlier steps stay on the board, which
 * is exactly how a whiteboard fills up as a coach talks.
 *
 * Two paths exist per movement — the one you see and the one the piece follows.
 * They are usually the same element, but backward skating is drawn as a wave
 * and nobody skates in a wave, so that one keeps a hidden smooth path to travel
 * along while the wave is what gets revealed.
 */
import { SURFACES, rinkMarkup, type Surface } from "../lib/rink";
import {
  escapeXml, pathD, positionsAfter, smoothD, tokenMarkup,
  type Diagram, type PlayPath,
} from "../lib/play";

const SVG_NS = "http://www.w3.org/2000/svg";
const reduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Arrowheads, the ice gradient, and the frame everything is clipped to. */
function defs(uidPrefix: string, surface: Surface): string {
  const [vx, vy, vw, vh] = SURFACES[surface].viewBox.split(/\s+/).map(Number);
  const head = (id: string, cls: string) =>
    `<marker id="${uidPrefix}-${id}" viewBox="0 0 10 10" refX="8.5" refY="5"
             markerWidth="5" markerHeight="5" orient="auto-start-reverse"
             markerUnits="strokeWidth">
       <path class="${cls}" d="M 0 1 L 10 5 L 0 9 z" />
     </marker>`;
  return `<defs>
    <!-- A viewBox frames the drawing but does not clip it: ice beyond the
         frame still paints into whatever box is left over, so a zone view in a
         wider box quietly showed the next zone along. Clip to the frame. -->
    <clipPath id="${uidPrefix}-frame">
      <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" />
    </clipPath>
    <linearGradient id="${uidPrefix}-ice" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#FDFEFF" />
      <stop offset="55%"  stop-color="#EEF4FB" />
      <stop offset="100%" stop-color="#DCE7F4" />
    </linearGradient>
    ${head("a-skate", "pl-head-skate")}
    ${head("a-pass", "pl-head-pass")}
    ${head("a-shot", "pl-head-shot")}
    ${head("a-backward", "pl-head-skate")}
  </defs>`;
}

export interface MarkupOptions {
  /** Which framing of the ice to draw; decides the clip. */
  surface?: Surface;
  /** Draw only what has happened by the end of this step. -1 shows the setup. */
  through?: number;
  /** Include hidden motion paths and stable data-ids, for an interactive stage. */
  forStage?: boolean;
  selectedId?: string | null;
}

/** Every layer of a diagram as SVG markup, with no DOM involved. */
export function diagramMarkup(d: Diagram, uidPrefix: string, opts: MarkupOptions = {}): string {
  const surface = opts.surface ?? "full";
  const through = opts.through ?? d.steps.length - 1;
  const visible = (step: number) => step <= through;

  const pen = d.pen
    .filter((p) => visible(p.step))
    .map((p) => `<path class="pl-pen" data-id="${p.id}" d="${smoothD(p.points)}" />`)
    .join("");

  const paths = d.paths
    .filter((p) => visible(p.step))
    .map((p) => pathElement(p, uidPrefix, !!opts.forStage))
    .join("");

  // The piece positions a viewer should see: wherever the completed steps left
  // them. Mid-step motion is applied by the stage on top of this.
  const at = positionsAfter(d, through);
  const tokens = d.tokens
    .map((t) => {
      const p = at.get(t.id) ?? t;
      return tokenMarkup({ ...t, x: p.x, y: p.y }, { selected: opts.selectedId === t.id });
    })
    .join("");

  const notes = d.notes
    .filter((n) => visible(n.step))
    .map(
      (n) =>
        `<text class="pl-note" data-id="${n.id}" x="${n.x}" y="${n.y}">${escapeXml(n.text)}</text>`,
    )
    .join("");

  // Hidden twins for the pieces to travel along. Only backward paths need one,
  // because every other kind is drawn on its own true route.
  const motion = opts.forStage
    ? d.paths
        .filter((p) => p.kind === "backward")
        .map((p) => `<path class="pl-motion" data-motion="${p.id}" d="${smoothD(p.points)}" />`)
        .join("")
    : "";

  return `${defs(uidPrefix, surface)}${opts.forStage ? revealMasks(d, uidPrefix) : ""}
    <g clip-path="url(#${uidPrefix}-frame)">
      <g class="pl-ice">${rinkMarkup(`url(#${uidPrefix}-ice)`)}</g>
      <g class="pl-layer pl-layer-pen">${pen}</g>
      <g class="pl-layer pl-layer-paths">${paths}</g>
      <g class="pl-layer pl-layer-notes">${notes}</g>
      <g class="pl-layer pl-layer-tokens">${tokens}</g>
    </g>
    <g class="pl-motion-layer" aria-hidden="true">${motion}</g>`;
}

function pathElement(p: PlayPath, uidPrefix: string, masked: boolean): string {
  const marker = `url(#${uidPrefix}-a-${p.kind})`;
  const bar =
    // A shot carries a bar across the line, the way it is drawn on a board.
    p.kind === "shot" ? shotBar(p) : "";
  const mask = masked ? ` mask="url(#${uidPrefix}-m-${p.id})"` : "";
  return (
    `<path class="pl-path pl-path-${p.kind}" data-id="${p.id}" data-step="${p.step}"` +
    ` d="${pathD(p)}" marker-end="${marker}"${mask} />${bar}`
  );
}

/**
 * One mask per line, so a line can draw itself on without losing its own look.
 *
 * The obvious way to reveal a stroke is to animate its dash offset — but the
 * pass line *is* a dash pattern, and the backward line is a wave, and both get
 * destroyed by borrowing their dasharray for the reveal. Masking with a fat
 * stroked copy keeps the reveal and the notation independent: the mask wipes,
 * the line underneath stays whatever a coach expects it to look like.
 */
function revealMasks(d: Diagram, uidPrefix: string): string {
  const masks = d.paths
    .map(
      (p) =>
        `<mask id="${uidPrefix}-m-${p.id}" maskUnits="userSpaceOnUse"` +
        ` x="-20" y="-20" width="240" height="125">` +
        `<path class="pl-reveal" data-reveal="${p.id}" d="${pathD(p)}" /></mask>`,
    )
    .join("");
  return `<defs>${masks}</defs>`;
}

function shotBar(p: PlayPath): string {
  const pts = p.points;
  const b = pts[pts.length - 1];
  const a = pts[pts.length - 2] ?? b;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  // Sit the bar back from the arrowhead so the two do not collide.
  const cx = b.x - ux * 5, cy = b.y - uy * 5;
  const h = 2.2;
  return (
    `<line class="pl-shot-bar" data-bar="${p.id}" data-step="${p.step}"` +
    ` x1="${(cx - uy * h).toFixed(2)}" y1="${(cy + ux * h).toFixed(2)}"` +
    ` x2="${(cx + uy * h).toFixed(2)}" y2="${(cy - ux * h).toFixed(2)}" />`
  );
}

/** A complete, self-contained SVG of the finished play — for cards and previews. */
export function staticPlaySvg(d: Diagram, surface: Surface, prefix = "thumb"): string {
  return (
    `<svg class="pl-svg" viewBox="${SURFACES[surface].viewBox}" ` +
    `preserveAspectRatio="xMidYMid meet" role="img" aria-label="Play diagram">` +
    diagramMarkup(d, prefix, { surface }) +
    `</svg>`
  );
}

/* ----------------------------------------------------------------- stage -- */

export interface StageState {
  step: number;
  progress: number;      // 0–1 within the current step
  playing: boolean;
  steps: number;
}

let stageSeq = 0;

export class PlayStage {
  readonly svg: SVGSVGElement;
  private diagram: Diagram;
  private surface: Surface = "full";
  private prefix = `pl${++stageSeq}`;
  private step = 0;
  private progress = 1;
  private raf = 0;
  private startedAt = 0;
  private playing = false;
  /** Cached per path: the element that is revealed, and the one pieces follow. */
  private geometry = new Map<string, {
    show: SVGPathElement; reveal: SVGPathElement; motion: SVGPathElement; len: number;
  }>();
  /** Which step each scribble and label belongs to. Built on redraw rather than
   *  searched per element per frame. */
  private annotationStep = new Map<string, number>();

  onchange: ((s: StageState) => void) | null = null;

  /**
   * Edit mode paints the whole play at once with the step being worked on lit
   * and the rest knocked back, and parks every piece where the *previous* step
   * left it — because that is where the coach is drawing the next move from.
   */
  editing = false;

  constructor(private host: HTMLElement) {
    this.diagram = { v: 1, steps: [], tokens: [], paths: [], notes: [], pen: [] };
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("class", "pl-svg");
    this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.host.appendChild(this.svg);
  }

  load(diagram: Diagram, surface: Surface) {
    this.pause();
    this.diagram = diagram;
    this.surface = surface;
    const viewBox = SURFACES[surface].viewBox;
    this.svg.setAttribute("viewBox", viewBox);
    // A zone view is nearly square, so a board sized purely by its column would
    // be twice the height of a laptop screen. The frame sizes itself from this
    // ratio and the --pl-board-h the page asks for, and the drawing fills it.
    const [, , w, h] = viewBox.split(/\s+/).map(Number);
    this.host.style.setProperty("--pl-ratio", (w / h).toFixed(4));
    this.redraw();
    this.goTo(0, 0);
  }

  /**
   * Point the stage at a different document object without disturbing where we
   * are in the play. Undo and redo replace the document wholesale rather than
   * mutating it, and without this the stage would keep drawing the old one.
   */
  setDiagram(diagram: Diagram) { this.diagram = diagram; }

  /** Rebuild the SVG from the document. Cheap enough to do on every edit. */
  redraw(selectedId: string | null = null) {
    this.svg.innerHTML = diagramMarkup(this.diagram, this.prefix, {
      surface: this.surface,
      through: this.diagram.steps.length - 1,
      forStage: true,
      selectedId,
    });
    this.annotationStep.clear();
    for (const a of [...this.diagram.pen, ...this.diagram.notes])
      this.annotationStep.set(a.id, a.step);

    this.geometry.clear();
    for (const p of this.diagram.paths) {
      const show = this.svg.querySelector<SVGPathElement>(`.pl-path[data-id="${p.id}"]`);
      const reveal = this.svg.querySelector<SVGPathElement>(`.pl-reveal[data-reveal="${p.id}"]`);
      if (!show || !reveal) continue;
      const motion =
        this.svg.querySelector<SVGPathElement>(`.pl-motion[data-motion="${p.id}"]`) ?? show;
      const len = reveal.getTotalLength();
      reveal.style.strokeDasharray = `${len}`;
      this.geometry.set(p.id, { show, reveal, motion, len });
    }
    this.apply();
  }

  get state(): StageState {
    return {
      step: this.step,
      progress: this.progress,
      playing: this.playing,
      steps: this.diagram.steps.length,
    };
  }

  /** Put the board at a moment in time and paint it. */
  goTo(step: number, progress = 1) {
    this.step = Math.max(0, Math.min(this.diagram.steps.length - 1, step));
    this.progress = Math.max(0, Math.min(1, progress));
    this.apply();
    this.onchange?.(this.state);
  }

  next() { this.pause(); this.goTo(this.step + 1, 1); }
  prev() { this.pause(); this.goTo(this.step - 1, 1); }
  restart() { this.pause(); this.goTo(0, 0); }

  toggle() { this.playing ? this.pause() : this.play(); }

  play() {
    if (!this.diagram.steps.length) return;
    // Hitting play at the end of the play starts it over, which is what the
    // button looks like it should do.
    if (this.step >= this.diagram.steps.length - 1 && this.progress >= 1) this.goTo(0, 0);
    this.playing = true;
    this.startedAt = performance.now() - this.progress * this.stepMs(this.step);
    this.onchange?.(this.state);
    this.tick();
  }

  pause() {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.onchange?.(this.state);
  }

  destroy() {
    this.pause();
    this.svg.remove();
  }

  private stepMs(i: number) { return this.diagram.steps[i]?.duration ?? 1400; }

  private tick = () => {
    if (!this.playing) return;
    const span = this.stepMs(this.step);
    const elapsed = performance.now() - this.startedAt;
    // Under reduced motion a step snaps to its finished state and simply holds
    // for its duration: the sequence survives, the sliding does not.
    const p = reduceMotion() ? (elapsed >= span ? 1 : 1) : Math.min(1, elapsed / span);
    this.progress = p;
    this.apply();
    this.onchange?.(this.state);

    if (elapsed >= span) {
      if (this.step >= this.diagram.steps.length - 1) {
        this.playing = false;
        this.raf = 0;
        this.onchange?.(this.state);
        return;
      }
      this.step += 1;
      this.startedAt = performance.now();
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Paint the current moment: reveal lines, move pieces, show the right notes. */
  private apply() {
    const d = this.diagram;
    // Stepping with the buttons glides; a running animation sets the transform
    // every frame and must not have a transition fighting it.
    this.svg.classList.toggle("is-running", this.playing);
    this.svg.classList.toggle("is-editing", this.editing);
    if (this.editing) return this.paintForEditor();
    const t = easeInOut(this.progress);

    for (const p of d.paths) {
      const g = this.geometry.get(p.id);
      if (!g) continue;
      const frac = p.step < this.step ? 1 : p.step > this.step ? 0 : t;
      g.reveal.style.strokeDashoffset = `${g.len * (1 - frac)}`;
      g.show.style.opacity = frac > 0 ? "1" : "0";
      const bar = this.svg.querySelector<SVGLineElement>(`.pl-shot-bar[data-bar="${p.id}"]`);
      // The bar belongs to the arrowhead, so it arrives with it rather than
      // hanging in mid-air while the line is still drawing.
      if (bar) bar.style.opacity = frac >= 0.999 ? "1" : "0";
    }

    for (const el of this.svg.querySelectorAll<SVGElement>(".pl-pen, .pl-note")) {
      const step = this.annotationStep.get(el.dataset.id!);
      el.style.opacity = step !== undefined && step <= this.step ? "1" : "0";
    }

    const settled = positionsAfter(d, this.step - 1);
    for (const token of d.tokens) {
      const el = this.svg.querySelector<SVGGElement>(`.pl-token[data-id="${token.id}"]`);
      if (!el) continue;
      let pos = settled.get(token.id) ?? { x: token.x, y: token.y };
      const running = d.paths.find((p) => p.step === this.step && p.tokenId === token.id);
      if (running) {
        const g = this.geometry.get(running.id);
        if (g) {
          const pt = g.motion.getPointAtLength(g.motion.getTotalLength() * t);
          pos = { x: pt.x, y: pt.y };
        }
      }
      el.setAttribute("transform", `translate(${pos.x.toFixed(2)} ${pos.y.toFixed(2)})`);
    }
  }

  private paintForEditor() {
    const d = this.diagram;
    const dim = (step: number) => (step === this.step ? "1" : step < this.step ? "0.38" : "0.2");

    for (const p of d.paths) {
      const g = this.geometry.get(p.id);
      if (!g) continue;
      g.reveal.style.strokeDashoffset = "0";          // nothing is mid-draw here
      g.show.style.opacity = dim(p.step);
      const bar = this.svg.querySelector<SVGLineElement>(`.pl-shot-bar[data-bar="${p.id}"]`);
      if (bar) bar.style.opacity = dim(p.step);
    }
    for (const el of this.svg.querySelectorAll<SVGElement>(".pl-pen, .pl-note")) {
      const step = this.annotationStep.get(el.dataset.id!);
      el.style.opacity = step === undefined ? "1" : dim(step);
    }

    const entering = positionsAfter(d, this.step - 1);
    for (const token of d.tokens) {
      const el = this.svg.querySelector<SVGGElement>(`.pl-token[data-id="${token.id}"]`);
      const pos = entering.get(token.id) ?? token;
      el?.setAttribute("transform", `translate(${pos.x.toFixed(2)} ${pos.y.toFixed(2)})`);
    }
  }

  /** Where the editor should consider each piece to be right now. */
  enteringPositions() {
    return positionsAfter(this.diagram, this.step - 1);
  }
}
