/**
 * The team-facing plays board: an index of cards, and a player for one play.
 *
 * Both live at /plays. A play opens in place and pushes `?p=<slug>`, so a link
 * to a play is a real link — the coach can paste one into the team chat and it
 * opens on that diagram — while the browser's back button still behaves.
 */
import { PlayStage, staticPlaySvg } from "./playback";
import { mountPlayFullscreen } from "./play-fullscreen";
import {
  categoryLabel, normaliseDiagram, totalDuration, type Diagram, type Play,
} from "../lib/play";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

import { api } from "./api-client";

let plays: Play[] = [];
/** Fixture ids to human labels, baked in at build time. */
let gameLabels: Record<string, string> = {};
let filter = "all";
let stage: PlayStage | null = null;
let current: Play | null = null;
/** The open play's diagram, normalised once. `paintControls` runs on every
 *  animation frame, and re-normalising there allocated a fresh document sixty
 *  times a second for the whole length of a play. */
let currentDiagram: Diagram | null = null;
let paintedStep = -1;
let fullscreen: ReturnType<typeof mountPlayFullscreen>;

const weekLabel = (iso: string | null) => {
  if (!iso) return "All season";
  // week_of is a plain date; parsing it as UTC and formatting as UTC keeps it
  // off the day before in our timezone.
  const d = new Date(iso + "T12:00:00Z");
  return "Week of " + d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
};

/* ----------------------------------------------------------------- index -- */

function renderIndex() {
  const shown = plays.filter((p) => filter === "all" || p.category === filter);
  const grid = $("#pl-grid");
  grid.innerHTML = "";

  for (const p of shown) {
    const d = normaliseDiagram(p.diagram);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "pl-card";
    card.dataset.slug = p.slug;
    card.innerHTML =
      `<div class="pl-card-art">${staticPlaySvg(d, p.surface, "c" + p.id)}</div>` +
      `<div class="pl-card-body">` +
      `<div class="pl-card-tags">` +
      `<span class="pl-pill">${categoryLabel(p.category)}</span>` +
      (p.status === "draft" ? `<span class="pl-pill pl-pill--draft">Draft</span>` : "") +
      `<span class="pl-pill pl-pill--plain">${d.steps.length} step${d.steps.length === 1 ? "" : "s"}</span>` +
      `</div>` +
      `<h3></h3>` +
      `<p class="sub"></p>` +
      `<p class="week"></p>` +
      `</div>`;
    // Titles are the coach's free text — set them as text, never as markup.
    card.querySelector("h3")!.textContent = p.title;
    card.querySelector(".sub")!.textContent = p.subtitle ?? "";
    card.querySelector(".week")!.textContent =
      p.game_id && gameLabels[p.game_id]
        ? `${weekLabel(p.week_of)} · for ${gameLabels[p.game_id]}`
        : weekLabel(p.week_of);
    card.addEventListener("click", () => open(p.slug, true));
    grid.appendChild(card);
  }

  $("#pl-empty").hidden = shown.length > 0;
  renderFilters();
}

function renderFilters() {
  const cats = [...new Set(plays.map((p) => p.category))];
  if (cats.length < 2) { $("#pl-filters").innerHTML = ""; return; }
  const box = $("#pl-filters");
  box.innerHTML = "";
  for (const value of ["all", ...cats]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pl-filter" + (filter === value ? " is-on" : "");
    b.textContent = value === "all" ? "Everything" : categoryLabel(value);
    b.addEventListener("click", () => { filter = value; renderIndex(); });
    box.appendChild(b);
  }
}

/* ---------------------------------------------------------------- detail -- */

function open(slug: string, push: boolean) {
  const play = plays.find((p) => p.slug === slug);
  if (!play) return showIndex(push);
  current = play;
  const d = currentDiagram = normaliseDiagram(play.diagram);
  paintedStep = -1;

  $("#pl-index").hidden = true;
  $("#pl-detail").hidden = false;

  const bits = [categoryLabel(play.category), weekLabel(play.week_of)];
  if (play.game_id && gameLabels[play.game_id]) bits.push(`For ${gameLabels[play.game_id]}`);
  if (play.status === "draft") bits.push("Draft");
  $("#pl-d-meta").textContent = bits.join(" · ");
  $("#pl-d-title").textContent = play.title;
  $("#pl-d-sub").textContent = play.subtitle ?? "";
  $("#pl-d-byline").textContent = play.author
    ? `Drawn up by ${play.author}` : "";

  stage?.destroy();
  stage = new PlayStage($("#pl-stage"));
  stage.onchange = paintControls;
  stage.load(d, play.surface);
  renderSteps(d.steps.length);
  paintControls({ step: 0, progress: 0, playing: false, steps: d.steps.length });

  if (push) history.pushState({ slug }, "", `/plays?p=${encodeURIComponent(slug)}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showIndex(push: boolean) {
  fullscreen?.exit();
  stage?.destroy();
  stage = null;
  current = null;
  currentDiagram = null;
  $("#pl-detail").hidden = true;
  $("#pl-index").hidden = false;
  if (push) history.pushState({}, "", "/plays");
}

function renderSteps(count: number) {
  const d = currentDiagram;
  const ol = $("#pl-steps");
  ol.innerHTML = "";
  // A one-step play with nothing written about it has no list worth showing.
  if (!d || (count <= 1 && !d.steps[0]?.caption)) return;
  d.steps.forEach((s, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pl-step";
    b.dataset.step = String(i);
    b.innerHTML = `<b>${i + 1}</b><span></span>`;
    const span = b.querySelector("span")!;
    if (s.caption) span.textContent = s.caption;
    else { const em = document.createElement("em"); em.textContent = "—"; span.appendChild(em); }
    b.addEventListener("click", () => stage?.goTo(i, 1));
    li.appendChild(b);
    ol.appendChild(li);
  });
}

function paintControls(s: { step: number; progress: number; playing: boolean; steps: number }) {
  $("#pl-play").textContent = s.playing ? "❚❚ Pause" : "▶ Play";
  // The step list only changes when the step does; the bar changes every frame.
  if (s.step !== paintedStep) {
    paintedStep = s.step;
    $("#pl-count").textContent = s.steps ? `Step ${s.step + 1} of ${s.steps}` : "";
    (document.querySelectorAll(".pl-step") as NodeListOf<HTMLElement>).forEach((el) =>
      el.classList.toggle("is-on", Number(el.dataset.step) === s.step));
  }

  const d = currentDiagram;
  if (!d) return;
  const total = totalDuration(d) || 1;
  const before = d.steps.slice(0, s.step).reduce((sum, x) => sum + x.duration, 0);
  const pct = ((before + s.progress * (d.steps[s.step]?.duration ?? 0)) / total) * 100;
  $("#pl-scrub-fill").style.width = `${pct}%`;
  $("#pl-scrub").setAttribute("aria-valuenow", String(Math.round(pct)));
}

/** Clicking the bar seeks across the whole play, not just the current step. */
function scrubTo(fraction: number) {
  const d = currentDiagram;
  if (!d || !stage) return;
  let target = Math.max(0, Math.min(1, fraction)) * (totalDuration(d) || 1);
  for (let i = 0; i < d.steps.length; i++) {
    if (target <= d.steps[i].duration || i === d.steps.length - 1) {
      stage.pause();
      stage.goTo(i, Math.max(0, Math.min(1, target / d.steps[i].duration)));
      return;
    }
    target -= d.steps[i].duration;
  }
}

/* ------------------------------------------------------------------ boot -- */

function wire() {
  fullscreen = mountPlayFullscreen($("#pl-workspace"), $<HTMLButtonElement>("#pl-fullscreen"), true);
  $("#pl-play").addEventListener("click", () => stage?.toggle());
  $("#pl-next").addEventListener("click", () => stage?.next());
  $("#pl-prev").addEventListener("click", () => stage?.prev());
  $("#pl-back").addEventListener("click", (e) => { e.preventDefault(); showIndex(true); });
  $("#pl-scrub").addEventListener("pointerdown", (e: Event) => {
    const el = $("#pl-scrub");
    const r = el.getBoundingClientRect();
    scrubTo(((e as PointerEvent).clientX - r.left) / r.width);
  });

  $("#pl-scrub").addEventListener("keydown", (e) => {
    const fraction = Number($("#pl-scrub").getAttribute("aria-valuenow")) / 100;
    const keys: Record<string, number> = {
      ArrowRight: fraction + .05, ArrowUp: fraction + .05,
      ArrowLeft: fraction - .05, ArrowDown: fraction - .05, Home: 0, End: 1,
    };
    if (e.key in keys) {
      e.preventDefault(); e.stopPropagation(); scrubTo(keys[e.key]);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!stage || $("#pl-detail").hidden) return;
    if (e.target instanceof Element && e.target.closest('button, input, textarea, select, a, [role="slider"]')) return;
    if (e.key === " ") { e.preventDefault(); stage.toggle(); }
    if (e.key === "ArrowRight") stage.next();
    if (e.key === "ArrowLeft") stage.prev();
  });

  window.addEventListener("popstate", () => {
    const slug = new URLSearchParams(location.search).get("p");
    slug ? open(slug, false) : showIndex(false);
  });
}

async function boot() {
  gameLabels = JSON.parse(document.querySelector("#pl-games")?.textContent || "{}");
  const { ok, status, body } = await api("/plays");
  $("#pl-loading").hidden = true;
  if (status === 401) { $("#pl-gate").hidden = false; return; }
  if (!ok || !Array.isArray(body)) {
    $("#pl-loading").hidden = false;
    $("#pl-loading").textContent = "Could not load the plays. Try again in a moment.";
    return;
  }
  plays = body as Play[];
  wire();
  renderIndex();

  const slug = new URLSearchParams(location.search).get("p");
  if (slug) open(slug, false);
  else $("#pl-index").hidden = false;
}

boot();
