/**
 * The whiteboard.
 *
 * A coach draws a play the way he draws it on the board: put the pieces where
 * they line up, then say "step one, this happens", draw it, "step two", draw
 * that. So the editor is built around the current step rather than around a
 * layer list — every line you draw belongs to the step you are on, the pieces
 * sit where the previous step left them, and the rest of the play is dimmed
 * but still visible so you can see what you are building on.
 *
 * Pointer events throughout, not mouse events: this gets used on a tablet in a
 * dressing room at least as often as on a laptop.
 */
import { PlayStage } from "./playback";
import { clampToRink, type Surface } from "../lib/rink";
import {
  CATEGORIES, PATH_KINDS, TOKEN_R, emptyDiagram, normaliseDiagram, pathD,
  polylineLength, simplify, uid,
  type Diagram, type PathKind, type Play, type PlayPath, type Pt, type TokenKind,
} from "../lib/play";

const TOKEN_TOOLS = ["us", "them", "puck", "goalie", "goalieThem", "cone"] as const;
const PATH_TOOLS = ["skate", "pass", "shot", "backward"] as const;

type Tool = "select" | "erase" | "text" | "pen" | TokenKind | PathKind;
const isTokenTool = (t: Tool): t is TokenKind => (TOKEN_TOOLS as readonly string[]).includes(t);
const isPathTool = (t: Tool): t is PathKind => (PATH_TOOLS as readonly string[]).includes(t);

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const SVG_NS = "http://www.w3.org/2000/svg";

import { api } from "./api-client";

/* ------------------------------------------------------------------ state */

let stage: PlayStage;
let doc: Diagram = emptyDiagram();
let tool: Tool = "us";
let step = 0;
let selected: string | null = null;
let editing: Play | null = null;          // null while drawing a brand-new play
let previewing = false;
let plays: Play[] = [];
let roster: { id: string; number: number; name: string }[] = [];
let dirty = false;

const past: string[] = [];
const future: string[] = [];

/**
 * The working document, mirrored into the browser on every change.
 *
 * A save can fail — a lapsed session, a rejected document, a flaky rink wifi —
 * and when it does, the only copy of a play somebody just spent a quarter of an
 * hour drawing is in a tab he must not close. That is not an acceptable way to
 * treat someone's work. The draft is written on every change, offered back when
 * the editor next opens, and cleared only once the play is safely saved.
 */
const DRAFT_KEY = "lvlnb.play-draft.v1";
// Remove drafts persisted by the previous version on shared devices.
try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
let draftTimer = 0;

function keepDraft(now = false) {
  clearTimeout(draftTimer);
  const write = () => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        at: Date.now(), playId: editing?.id ?? null, ...formToPlay(),
      }));
    } catch { /* private window, or a full quota — never worth breaking over */ }
  };
  now ? write() : (draftTimer = window.setTimeout(write, 400));
}

const dropDraft = () => {
  clearTimeout(draftTimer);
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* as above */ }
  $("#pe-draft").hidden = true;
};

function offerDraft() {
  let draft: any = null;
  try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch { /* ignore */ }
  if (!draft?.diagram?.tokens?.length && !draft?.diagram?.paths?.length) return;

  const d = normaliseDiagram(draft.diagram);
  const when = new Date(draft.at).toLocaleString("en-CA",
    { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  $("#pe-draft-what").textContent =
    `Unsaved work from ${when} — ${draft.title || "untitled"}, ` +
    `${d.tokens.length} piece${d.tokens.length === 1 ? "" : "s"}, ` +
    `${d.paths.length} line${d.paths.length === 1 ? "" : "s"}, ` +
    `${d.steps.length} step${d.steps.length === 1 ? "" : "s"}.`;
  $("#pe-draft").hidden = false;

  $("#pe-draft-restore").addEventListener("click", () => {
    const owner = draft.playId ? plays.find((x) => x.id === draft.playId) ?? null : null;
    loadIntoForm(owner);
    doc = d;
    $<HTMLInputElement>("#pe-title").value = draft.title ?? "";
    $<HTMLInputElement>("#pe-subtitle").value = draft.subtitle ?? "";
    $<HTMLSelectElement>("#pe-category").value = draft.category ?? "other";
    $<HTMLSelectElement>("#pe-status").value = draft.status ?? "draft";
    $<HTMLInputElement>("#pe-week").value = draft.week_of ?? "";
    $<HTMLSelectElement>("#pe-game").value = draft.game_id ?? "";
    stage.load(doc, (draft.surface ?? "full") as Surface);
    dirty = true;
    $("#pe-draft").hidden = true;
    render();
    say("Restored. Nothing has been saved to the server yet.");
  }, { once: true });

  $("#pe-draft-discard").addEventListener("click", () => {
    if (confirm("Throw away the unsaved drawing?")) dropDraft();
  });
}

function snapshot() {
  past.push(JSON.stringify(doc));
  if (past.length > 60) past.shift();
  future.length = 0;
}

/** Every change to the document goes through here, so undo is never forgotten. */
function mutate(fn: () => void) {
  snapshot();
  fn();
  dirty = true;
  render();
}

function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(JSON.stringify(doc));
  doc = JSON.parse(prev);
  clampStep();
  render();
}

function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(JSON.stringify(doc));
  doc = JSON.parse(next);
  clampStep();
  render();
}

const clampStep = () => { step = Math.max(0, Math.min(doc.steps.length - 1, step)); };

/* -------------------------------------------------------------- rendering */

function render() {
  stage.editing = !previewing;
  // Undo, redo and Clear swap the document for a different object; the stage
  // has to be told, or it keeps redrawing the one it was handed at load.
  stage.setDiagram(doc);
  stage.redraw(selected);
  stage.goTo(step, 1);
  renderSteps();
  renderInspector();
  renderTools();
  setHint();
  $("#pe-undo").toggleAttribute("disabled", past.length === 0);
  $("#pe-redo").toggleAttribute("disabled", future.length === 0);
  const s = $("#pe-save") as HTMLButtonElement;
  s.textContent = dirty ? "Save play •" : "Save play";
  if (dirty) keepDraft();
}

function renderTools() {
  document.querySelectorAll<HTMLElement>("#pe-tools [data-tool]").forEach((b) => {
    const active = b.dataset.tool === tool;
    b.classList.toggle("is-on", active);
    b.setAttribute("aria-pressed", String(active));
  });
}

function renderSteps() {
  const box = $("#pe-steps");
  box.innerHTML = "";
  doc.steps.forEach((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pe-chip" + (i === step ? " is-on" : "");
    b.textContent = String(i + 1);
    b.title = s.caption || `Step ${i + 1}`;
    b.addEventListener("click", () => { step = i; selected = null; render(); });
    box.appendChild(b);
  });
  const cap = $<HTMLInputElement>("#pe-caption");
  const dur = $<HTMLInputElement>("#pe-duration");
  cap.value = doc.steps[step]?.caption ?? "";
  dur.value = String(doc.steps[step]?.duration ?? 1400);
  $("#pe-durval").textContent = `${((doc.steps[step]?.duration ?? 1400) / 1000).toFixed(1)}s`;
  ($("#pe-delstep") as HTMLButtonElement).disabled = doc.steps.length <= 1;
}

function renderInspector() {
  const box = $("#pe-inspector");
  const token = doc.tokens.find((t) => t.id === selected);
  const path = doc.paths.find((p) => p.id === selected);
  if (!token && !path) {
    box.innerHTML = `<p class="dim">Tap a piece or a line to rename it, move it between
      steps, or take it off the board.</p>`;
    return;
  }

  if (token) {
    const opts = roster
      .map((p) => `<option value="${p.id}"${token.playerId === p.id ? " selected" : ""}>
                     #${p.number} ${p.name}</option>`)
      .join("");
    box.innerHTML = `
      <h4>Piece</h4>
      <label>Label <input id="pe-i-label" maxlength="4" value="" placeholder="C, D1, LW…" /></label>
      <label>Who is it? <select id="pe-i-player">
        <option value="">Nobody in particular</option>${opts}
      </select></label>
      <button type="button" class="link danger" id="pe-i-del">Remove this piece</button>`;
    const label = $<HTMLInputElement>("#pe-i-label");
    label.value = token.label;
    label.addEventListener("input", () => { token.label = label.value; dirty = true; stage.redraw(selected); stage.goTo(step, 1); });
    $("#pe-i-player").addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      mutate(() => {
        token.playerId = v || null;
        // Binding a real player auto-labels the piece with the sweater number,
        // which is what the kid looks for first.
        const p = roster.find((r) => r.id === v);
        if (p && !token.label) token.label = String(p.number);
      });
    });
    $("#pe-i-del").addEventListener("click", () => mutate(() => {
      doc.tokens = doc.tokens.filter((t) => t.id !== token.id);
      doc.paths = doc.paths.filter((p) => p.tokenId !== token.id);
      selected = null;
    }));
    return;
  }

  const p = path!;
  box.innerHTML = `
    <h4>Line</h4>
    <div class="pe-row" id="pe-i-kinds">
      ${PATH_KINDS.map((k) =>
        `<button type="button" class="pe-mini${k.value === p.kind ? " is-on" : ""}"
                 data-kind="${k.value}">${k.label}</button>`).join("")}
    </div>
    <label>Step <select id="pe-i-step">
      ${doc.steps.map((_, i) =>
        `<option value="${i}"${i === p.step ? " selected" : ""}>Step ${i + 1}</option>`).join("")}
    </select></label>
    <button type="button" class="link danger" id="pe-i-del">Remove this line</button>`;
  box.querySelectorAll<HTMLElement>("[data-kind]").forEach((b) =>
    b.addEventListener("click", () => mutate(() => { p.kind = b.dataset.kind as PathKind; })));
  $("#pe-i-step").addEventListener("change", (e) =>
    mutate(() => { p.step = Number((e.target as HTMLSelectElement).value); }));
  $("#pe-i-del").addEventListener("click", () =>
    mutate(() => { doc.paths = doc.paths.filter((x) => x.id !== p.id); selected = null; }));
}

const HINTS: Record<string, string> = {
  select: "Drag a piece to move it. Tap a line to change it.",
  erase: "Tap anything to take it off the board.",
  text: "Tap the ice to drop a label.",
  pen: "Draw freehand — for circling an area or scribbling a read.",
};

function setHint(override?: string) {
  const base = isTokenTool(tool)
    ? "Tap the ice to place it."
    : isPathTool(tool)
      ? "Drag from a piece to make it move, or anywhere for a plain arrow."
      : HINTS[tool] ?? "";
  $("#pe-hint").textContent = override ?? `Step ${step + 1} — ${base}`;
}

/* --------------------------------------------------------------- pointing */

/**
 * Pointer position in rink feet, or null if the board cannot be mapped.
 *
 * A board with no layout — a hidden tab, a collapsed column — has a degenerate
 * screen matrix, and inverting it gives NaN. Returning a point anyway would put
 * a piece at coordinate not-a-number, which survives every clamp, lands in the
 * document, and is only noticed when the save fails. Better to do nothing.
 */
function toRink(e: PointerEvent): Pt | null {
  const m = stage.svg.getScreenCTM();
  if (!m || !m.a || !m.d) return null;
  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
  return clampToRink(pt.x, pt.y);
}

/** The nearest piece to a point, as the board currently shows them. */
function tokenAt(p: Pt) {
  const at = stage.enteringPositions();
  let best: { id: string; d: number } | null = null;
  for (const t of doc.tokens) {
    const pos = at.get(t.id) ?? t;
    const d = Math.hypot(pos.x - p.x, pos.y - p.y);
    if (d < TOKEN_R + 2 && (!best || d < best.d)) best = { id: t.id, d };
  }
  return best ? doc.tokens.find((t) => t.id === best!.id)! : null;
}

function distToPolyline(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

function pathAt(p: Pt): PlayPath | null {
  let best: { path: PlayPath; d: number } | null = null;
  for (const path of doc.paths) {
    const d = distToPolyline(p, path.points);
    // Lines on the step being worked on win ties: that is what the coach is
    // reaching for, even where an older line crosses it.
    const bias = path.step === step ? 0 : 1.2;
    if (d < 3 && (!best || d + bias < best.d)) best = { path, d: d + bias };
  }
  return best?.path ?? null;
}

/** A piece may only be dragged while it is still standing on its start spot. */
const movable = (id: string) =>
  !doc.paths.some((p) => p.tokenId === id && p.step < step);

/* ------------------------------------------------------------- the canvas */

let drag: null | { kind: "token"; id: string; from: Pt }
        | { kind: "draw"; points: Pt[]; tokenId: string | null; ghost: SVGPathElement } = null;

/**
 * Pointer capture is best-effort. Holding the pointer keeps a drag alive when
 * the finger leaves the board, but the call throws if the browser no longer
 * considers that pointer active — which must not abort the drag itself.
 */
function capture(on: boolean, id: number) {
  try {
    if (on) stage.svg.setPointerCapture(id);
    else stage.svg.releasePointerCapture(id);
  } catch { /* pointer already gone */ }
}

function onDown(e: PointerEvent) {
  if (previewing) return;
  if (e.button !== 0 && e.pointerType === "mouse") return;
  const p = toRink(e);
  if (!p) return;
  capture(true, e.pointerId);

  if (isTokenTool(tool)) {
    mutate(() => {
      const t = { id: uid("t"), kind: tool as TokenKind, x: p.x, y: p.y, label: "", playerId: null };
      doc.tokens.push(t);
      selected = t.id;
    });
    return;
  }

  if (tool === "text") {
    const text = prompt("Label:")?.trim();
    if (!text) return;
    mutate(() => { doc.notes.push({ id: uid("n"), step, x: p.x, y: p.y, text: text.slice(0, 80) }); });
    return;
  }

  if (tool === "erase") {
    const t = tokenAt(p);
    if (t) return mutate(() => {
      doc.tokens = doc.tokens.filter((x) => x.id !== t.id);
      doc.paths = doc.paths.filter((x) => x.tokenId !== t.id);
      if (selected === t.id) selected = null;
    });
    const path = pathAt(p);
    if (path) return mutate(() => { doc.paths = doc.paths.filter((x) => x.id !== path.id); });
    const note = doc.notes.find((n) => Math.hypot(n.x - p.x, n.y - p.y) < 4);
    if (note) return mutate(() => { doc.notes = doc.notes.filter((n) => n.id !== note.id); });
    const pen = doc.pen.find((x) => distToPolyline(p, x.points) < 3);
    if (pen) return mutate(() => { doc.pen = doc.pen.filter((x) => x.id !== pen.id); });
    return;
  }

  if (tool === "select") {
    const t = tokenAt(p);
    if (t) {
      selected = t.id;
      if (movable(t.id)) {
        // Snapshot before the first pixel moves: the drag updates the document
        // live, so by pointerup the original position is already gone.
        snapshot();
        drag = { kind: "token", id: t.id, from: { x: t.x, y: t.y } };
      } else {
        setHint(`That piece is where step ${step} left it — go back to step 1 to move its starting spot.`);
      }
      render();
      return;
    }
    selected = pathAt(p)?.id ?? null;
    render();
    return;
  }

  // A line tool. Starting on a piece binds the line to it, which is what makes
  // the piece actually travel when the play runs.
  const start = tool === "pen" ? null : tokenAt(p);
  if (start && doc.paths.some((x) => x.tokenId === start.id && x.step === step)) {
    setHint("That piece already moves in this step — pick another step, or erase its line.");
    return;
  }
  const from = start ? (stage.enteringPositions().get(start.id) ?? p) : p;
  const ghost = document.createElementNS(SVG_NS, "path");
  ghost.setAttribute("class", tool === "pen" ? "pl-pen" : `pl-path pl-path-${tool}`);
  stage.svg.appendChild(ghost);
  drag = { kind: "draw", points: [{ x: from.x, y: from.y }], tokenId: start?.id ?? null, ghost };
}

function onMove(e: PointerEvent) {
  const d = drag;
  if (!d) return;
  const p = toRink(e);
  if (!p) return;

  if (d.kind === "token") {
    const t = doc.tokens.find((x) => x.id === d.id)!;
    t.x = p.x; t.y = p.y;
    // Moved directly rather than through render(): a full redraw per pointer
    // move would rebuild the SVG under the finger that is dragging.
    stage.svg
      .querySelector(`.pl-token[data-id="${t.id}"]`)
      ?.setAttribute("transform", `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
    return;
  }

  const last = d.points[d.points.length - 1];
  // One sample per foot or so: enough to describe a curve, few enough that the
  // simplifier is not doing all the work afterwards.
  if (Math.hypot(p.x - last.x, p.y - last.y) < 1.1) return;
  d.points.push(p);
  d.ghost.setAttribute("d", pathD({
    id: "ghost", kind: tool === "pen" ? "skate" : (tool as PathKind),
    step, tokenId: null, points: d.points,
  }));
}

function onUp(e: PointerEvent) {
  if (!drag) return;
  capture(false, e.pointerId);
  const d = drag;
  drag = null;

  if (d.kind === "token") {
    const t = doc.tokens.find((x) => x.id === d.id)!;
    // A tap that selected a piece without moving it should not cost an undo.
    if (Math.hypot(t.x - d.from.x, t.y - d.from.y) < 0.05) past.pop();
    else dirty = true;
    render();
    return;
  }

  d.ghost.remove();
  const points = simplify(d.points, 0.9);
  // A tap is not a line. Anything under five feet is a slip of the finger.
  if (points.length < 2 || polylineLength(points) < 5) { setHint("Too short — drag a line out."); return; }

  mutate(() => {
    if (tool === "pen") doc.pen.push({ id: uid("d"), step, points });
    else {
      const path: PlayPath = {
        id: uid("p"), kind: tool as PathKind, step, tokenId: d.tokenId, points,
      };
      doc.paths.push(path);
      selected = path.id;
    }
  });
}

/* ------------------------------------------------------------------ plays */

function formToPlay() {
  return {
    title: $<HTMLInputElement>("#pe-title").value.trim(),
    subtitle: $<HTMLInputElement>("#pe-subtitle").value.trim() || null,
    category: $<HTMLSelectElement>("#pe-category").value,
    surface: $<HTMLSelectElement>("#pe-surface").value as Surface,
    status: $<HTMLSelectElement>("#pe-status").value,
    week_of: $<HTMLInputElement>("#pe-week").value || null,
    game_id: $<HTMLSelectElement>("#pe-game").value || null,
    diagram: doc,
  };
}

function loadIntoForm(p: Play | null) {
  editing = p;
  doc = p ? normaliseDiagram(p.diagram) : emptyDiagram();
  past.length = 0; future.length = 0;
  step = 0; selected = null; dirty = false;
  $<HTMLInputElement>("#pe-title").value = p?.title ?? "";
  $<HTMLInputElement>("#pe-subtitle").value = p?.subtitle ?? "";
  $<HTMLSelectElement>("#pe-category").value = p?.category ?? "other";
  $<HTMLSelectElement>("#pe-surface").value = p?.surface ?? "full";
  $<HTMLSelectElement>("#pe-status").value = p?.status ?? "draft";
  $<HTMLInputElement>("#pe-week").value = p?.week_of ?? mondayOf(new Date());
  $<HTMLSelectElement>("#pe-game").value = p?.game_id ?? "";
  ($("#pe-delete") as HTMLButtonElement).disabled = !p;
  $<HTMLSelectElement>("#pe-select").value = p ? String(p.id) : "";
  stage.load(doc, (p?.surface ?? "full") as Surface);
  render();
}

/** Plays are weekly, so the date field defaults to the Monday just gone. */
function mondayOf(d: Date): string {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
  return copy.toISOString().slice(0, 10);
}

function renderPlayList() {
  const sel = $<HTMLSelectElement>("#pe-select");
  const keep = sel.value;
  sel.innerHTML = `<option value="">— new play —</option>` +
    plays.map((p) =>
      `<option value="${p.id}">${p.status === "draft" ? "◦ " : ""}${escapeHtml(p.title)}</option>`,
    ).join("");
  sel.value = keep;
}

const escapeHtml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

const say = (m: string) => { $("#pe-status-line").textContent = m; };

async function reload() {
  const { ok, body } = await api("/plays");
  if (!ok || !Array.isArray(body)) return say("Could not load the saved plays.");
  plays = body as Play[];
  renderPlayList();
}

async function save() {
  const payload = formToPlay();
  if (!payload.title) return say("Give the play a name first.");
  const btn = $<HTMLButtonElement>("#pe-save");
  btn.disabled = true;
  say("Saving…");
  const { ok, status, body } = editing
    ? await api(`/plays/${editing.id}`, { method: "PUT", body: JSON.stringify(payload) })
    : await api("/plays", { method: "POST", body: JSON.stringify(payload) });
  btn.disabled = false;
  if (!ok) {
    // Say what actually went wrong, name the field if the server named one,
    // and make it clear the drawing is not gone.
    const d = body?.detail;
    const detail = Array.isArray(d)
      ? d.map((e: any) => `${(e.loc ?? []).slice(-2).join(" ")} — ${e.msg}`).join("; ")
      : typeof d === "string" ? d : `HTTP ${status}`;
    keepDraft(true);
    console.error("[plays] save failed", status, body);
    return say(status === 401
      ? "Session expired — sign in again. Your drawing is still here."
      : `Could not save (${status}): ${detail}. Your drawing is still here.`);
  }
  // Deliberately *not* reloading the board from the response. A save is not a
  // reason to throw away what is on screen: the coach may already be drawing
  // the next line, and reloading would also wipe the undo history of a play he
  // is still working on. Only the identity changes — a new play becomes the
  // one being edited, so the next save is a PUT.
  editing = { ...(editing ?? {}), ...body } as Play;
  dirty = false;
  dropDraft();              // it is on the server now; the local copy is noise
  say(payload.status === "published" ? "Saved and published." : "Saved as a draft.");
  await reload();
  $<HTMLSelectElement>("#pe-select").value = String(editing.id);
  render();
}

async function remove() {
  if (!editing) return;
  if (!confirm(`Delete "${editing.title}"? This cannot be undone.`)) return;
  const { ok } = await api(`/plays/${editing.id}`, { method: "DELETE" });
  if (!ok) return say("Could not delete it.");
  say("Deleted.");
  await reload();
  loadIntoForm(null);
}

/* ------------------------------------------------------------------- boot */

let mounted = false;

export function mountPlayEditor() {
  if (mounted) return;
  mounted = true;

  roster = JSON.parse($("#pe-roster-data").textContent || "[]");
  $("#pe-category").innerHTML = CATEGORIES
    .map((c) => `<option value="${c.value}">${c.label}</option>`).join("");

  stage = new PlayStage($("#pe-stage"));
  stage.editing = true;

  // Tools
  document.querySelectorAll<HTMLElement>("#pe-tools [data-tool]").forEach((b) =>
    b.addEventListener("click", () => { tool = b.dataset.tool as Tool; selected = null; render(); }));

  // Canvas
  stage.svg.addEventListener("pointerdown", onDown);
  stage.svg.addEventListener("pointermove", onMove);
  stage.svg.addEventListener("pointerup", onUp);
  stage.svg.addEventListener("pointercancel", onUp);

  // Steps
  $("#pe-addstep").addEventListener("click", () => mutate(() => {
    doc.steps.push({ id: uid("s"), caption: "", duration: 1400 });
    step = doc.steps.length - 1;
  }));
  $("#pe-delstep").addEventListener("click", () => mutate(() => {
    if (doc.steps.length <= 1) return;
    const gone = step;
    doc.steps.splice(gone, 1);
    // Everything that belonged to the deleted step goes with it; everything
    // after it slides down one so the numbering stays contiguous.
    const shift = <T extends { step: number }>(xs: T[]) =>
      xs.filter((x) => x.step !== gone).map((x) => (x.step > gone ? { ...x, step: x.step - 1 } : x));
    doc.paths = shift(doc.paths);
    doc.notes = shift(doc.notes);
    doc.pen = shift(doc.pen);
    clampStep();
  }));
  $("#pe-caption").addEventListener("input", (e) => {
    doc.steps[step].caption = (e.target as HTMLInputElement).value;
    dirty = true;
  });
  $("#pe-duration").addEventListener("input", (e) => {
    doc.steps[step].duration = Number((e.target as HTMLInputElement).value);
    $("#pe-durval").textContent = `${(doc.steps[step].duration / 1000).toFixed(1)}s`;
    dirty = true;
  });

  // History and preview
  $("#pe-undo").addEventListener("click", undo);
  $("#pe-redo").addEventListener("click", redo);
  $("#pe-clear").addEventListener("click", () => {
    if (!confirm("Clear the whole diagram? The play's name and settings stay.")) return;
    mutate(() => { doc = emptyDiagram(); step = 0; selected = null; });
  });
  $("#pe-preview").addEventListener("click", () => {
    previewing = !previewing;
    $("#pe-preview").textContent = previewing ? "✎ Back to editing" : "▶ Preview";
    $("#pe-stage").classList.toggle("is-preview", previewing);
    if (!previewing) { stage.pause(); render(); return; }
    selected = null;
    stage.editing = false;
    stage.redraw(null);
    stage.goTo(0, 0);
    stage.play();
  });

  // Metadata
  $("#pe-surface").addEventListener("change", () => {
    stage.load(doc, $<HTMLSelectElement>("#pe-surface").value as Surface);
    dirty = true;
    render();
  });
  for (const id of ["#pe-title", "#pe-subtitle", "#pe-week", "#pe-game", "#pe-category", "#pe-status"])
    $(id).addEventListener("input", () => { dirty = true; render(); });

  $("#pe-select").addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (dirty && !confirm("You have unsaved changes to this play. Discard them?")) {
      $<HTMLSelectElement>("#pe-select").value = editing ? String(editing.id) : "";
      return;
    }
    loadIntoForm(v ? plays.find((p) => p.id === Number(v)) ?? null : null);
  });
  $("#pe-new").addEventListener("click", () => {
    if (dirty && !confirm("You have unsaved changes. Discard them?")) return;
    loadIntoForm(null);
  });
  $("#pe-save").addEventListener("click", save);
  $("#pe-delete").addEventListener("click", remove);

  document.addEventListener("keydown", (e) => {
    if ($("#plays-tab").hidden) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      mutate(() => {
        doc.tokens = doc.tokens.filter((t) => t.id !== selected);
        doc.paths = doc.paths.filter((p) => p.id !== selected && p.tokenId !== selected);
        selected = null;
      });
    }
  });

  window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

  loadIntoForm(null);
  reload().then(offerDraft);
}
