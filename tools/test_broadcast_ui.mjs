#!/usr/bin/env node
/**
 * Broadcast overlay and console browser checks. Build site/ first; the API
 * contract itself is covered by api/test_broadcast.py.
 *
 * The mock API mirrors the real derivation — score and shots counted from the
 * event log, the clock stored as a reading plus an anchor — because the whole
 * point of the client code under test is that it derives the ticking parts from
 * exactly that shape.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(ROOT, "site", "dist");
const OUT = await mkdtemp(path.join(tmpdir(), "lvlnb-broadcast-"));
const CHROME = process.env.CHROME_PATH || "chromium";
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".ttf": "font/ttf" };

const GAME = "g-2026-10-23-shediac";
const VIDEO = "abcdefghijk";

let role = "admin";
let signedOut = false;
let offline = false;        // network failures, as in a rink
const posted = [];
let stream = null;
let result = { status: "scheduled", our_score: 0, their_score: 0, period: null, revision: 0 };
let events = [];
let nextId = 1;
let clock = {
  period: "1", period_length_ms: 900000, remaining_ms: 900000,
  elapsed_ms: 0, running: false, anchor: Date.now(), revision: 0,
};

/** The same settle the server does: a running clock is a reading plus an anchor. */
function settle(now = Date.now()) {
  if (!clock.running) return { remaining: clock.remaining_ms, elapsed: clock.elapsed_ms };
  const spent = Math.min(Math.max(0, now - clock.anchor), clock.remaining_ms);
  return { remaining: clock.remaining_ms - spent, elapsed: clock.elapsed_ms + spent };
}

function snapshot() {
  const now = Date.now();
  const { remaining, elapsed } = settle(now);
  const live = events.filter((e) => !e.voided);
  const count = (kind, team) => live.filter((e) => e.kind === kind && e.team === team).length;
  const shots = (team) => ({
    total: live.filter((e) => ["shot", "goal"].includes(e.kind) && e.team === team).length,
    by_period: {},
  });
  return {
    game_id: GAME,
    server_now: new Date(now).toISOString(),
    stream: stream && { ...stream, game_id: GAME, provider: "youtube",
      embed_url: `https://www.youtube-nocookie.com/embed/${stream.video_id}`,
      watch_url: `https://www.youtube.com/watch?v=${stream.video_id}` },
    clock: {
      period: clock.period, period_length_ms: clock.period_length_ms,
      remaining_ms: remaining, elapsed_ms: elapsed, running: clock.running,
      anchor_at: new Date(now).toISOString(), revision: clock.revision,
    },
    score: { us: count("goal", "us"), them: count("goal", "them") },
    shots: { us: shots("us"), them: shots("them") },
    penalties: live.filter((e) => e.kind === "penalty").map((e) => ({ ...e, seconds: e.minutes * 60 })),
    goals: live.filter((e) => e.kind === "goal"),
    timeouts: { us: count("timeout", "us"), them: count("timeout", "them") },
    highlights: live.filter((e) => e.kind === "highlight"),
    events: [...live].reverse().slice(0, 60),
    result: result.revision ? result : null,
  };
}

function append(body) {
  const { remaining, elapsed } = settle();
  if (events.some((e) => e.client_id === body.client_id)) return;  // the dedupe the API does
  events.push({
    id: nextId++, kind: body.kind, team: body.team ?? null,
    period: clock.period, clock_ms: remaining, elapsed_ms: elapsed,
    player_id: body.player_id ?? null, assist1: body.assist1 ?? null, assist2: body.assist2 ?? null,
    minutes: body.minutes ?? null, infraction: body.infraction ?? null, strength: null,
    note: body.note ?? null,
    stream_offset_ms: stream?.started_at ? 125000 : null,
    client_id: body.client_id, created_at: new Date().toISOString(), voided: false,
  });
  if (body.kind === "goal") {
    const live = events.filter((e) => !e.voided && e.kind === "goal");
    result = { status: "in_progress", period: clock.period, revision: result.revision + 1,
      our_score: live.filter((e) => e.team === "us").length,
      their_score: live.filter((e) => e.team === "them").length };
  }
}

function api(req, res, raw) {
  const json = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const url = req.url.split("?")[0];
  if (url === "/api/auth/me") {
    return json(200, signedOut ? null : { id: 1, display_name: "Test admin", role });
  }
  if (offline) { res.destroy(); return; }
  if (url === "/api/broadcast") {
    return json(200, { streams: stream ? [{ game_id: GAME, state: stream.state, video_id: stream.video_id,
      label: stream.label, started_at: stream.started_at, provider: "youtube",
      embed_url: "", watch_url: "" }] : [] });
  }
  if (url === `/api/broadcast/${GAME}/scoresheet`) {
    return json(200, { our_score: 1, their_score: 0, warnings: [],
      lines: [{ player_id: "pl-09", g: 1, a: 0, pim: 0, plus_minus: 0 }],
      plus_minus_note: "Plus/minus is not derived from the broadcast log." });
  }
  if (url === `/api/broadcast/${GAME}/stream`) {
    if (req.method === "DELETE") { stream = null; return json(204, null); }
    const body = JSON.parse(raw);
    posted.push({ path: "stream", body });
    if (!/^[\w-]{11}$/.test(body.url) && !body.url.includes("you")) return json(422, { detail: "that is not a YouTube link" });
    stream = { video_id: VIDEO, label: body.label ?? null, state: body.state,
      started_at: body.state === "live" ? new Date().toISOString() : null };
    return json(200, { ...snapshot().stream });
  }
  if (url === `/api/broadcast/${GAME}/clock`) {
    const body = JSON.parse(raw);
    posted.push({ path: "clock", body });
    if (body.expected_revision !== clock.revision) return json(409, { detail: "The clock changed on another device." });
    const { remaining, elapsed } = settle();
    clock = {
      period: body.period, period_length_ms: body.period_length_ms,
      remaining_ms: body.remaining_ms,
      elapsed_ms: body.reset_elapsed ? 0
        : body.period === clock.period ? Math.max(0, elapsed - (body.remaining_ms - remaining)) : elapsed,
      running: body.running, anchor: Date.now(), revision: clock.revision + 1,
    };
    if (!result.revision) result = { ...result, status: "in_progress", period: body.period, revision: 1 };
    return json(200, snapshot());
  }
  const void_ = url.match(new RegExp(`^/api/broadcast/${GAME}/events/(\\d+)/void$`));
  if (void_) {
    const target = events.find((e) => e.id === Number(void_[1]));
    if (!target || target.voided) return json(404, { detail: "that entry is already gone" });
    target.voided = true;
    posted.push({ path: "void", body: { id: target.id } });
    return json(200, snapshot());
  }
  if (url === `/api/broadcast/${GAME}/events`) {
    const body = JSON.parse(raw);
    posted.push({ path: "events", body });
    if (role !== "admin") return json(403, { detail: "admin role required" });
    append(body);
    return json(201, snapshot());
  }
  if (url.startsWith(`/api/broadcast/${GAME}`)) return json(200, snapshot());
  if (url.startsWith("/api/broadcast/")) return json(404, { detail: "unknown game" });
  // Everything else the shared page chrome asks for.
  return json(200, /stats|notes|jobs|scoreboard/.test(url) ? { games: [], result: null, lines: [] } : {});
}

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url.startsWith("/api/")) return api(req, res, body);
      try {
        let f = decodeURIComponent(req.url.split("?")[0]);
        if (f.endsWith("/")) f += "index.html";
        if (!path.extname(f)) f += "/index.html";
        const file = path.join(DIST, f);
        if (!file.startsWith(DIST + path.sep)) { res.writeHead(403).end(); return; }
        const buf = await readFile(file);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        res.end(buf);
      } catch { res.writeHead(404).end("not found"); }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ CDP -- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map();
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.method === "Page.javascriptDialogOpening") {
        this.send("Page.handleJavaScriptDialog", { accept: true });
        return;
      }
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}, useSession = true) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (useSession && this.session) payload.sessionId = this.session;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
      return new CDP(ws);
    } catch { await sleep(150); }
  }
  throw new Error("chromium never came up");
}

const results = [];
const ok = (name, cond, extra = "") => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name} ${extra}`); };
const { server, port } = await serve();
const probe = createServer();
const dbg = await new Promise((resolve) =>
  probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); }));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  `--remote-debugging-port=${dbg}`, `--user-data-dir=${OUT}/profile`, "about:blank"], { stdio: "ignore" });
let cdp;
try {
  cdp = await connect(dbg);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }, false);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, false);
  cdp.session = sessionId;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const go = async (p) => { await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}${p}` }); await sleep(600); };
  const click = async (sel) => { await cdp.eval(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(220); };
  const test = (expr) => cdp.eval(expr);
  const text = (sel) => cdp.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() ?? null`);
  // The pages poll on visibilitychange, so the suite can pull a fresh snapshot
  // through the real code path instead of waiting out the interval.
  const repoll = async () => { await cdp.eval(`document.dispatchEvent(new Event('visibilitychange'))`); await sleep(350); };
  const value = (sel, val) => cdp.eval(`document.querySelector(${JSON.stringify(sel)}).value = ${JSON.stringify(val)}`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  /* ------------------------------------------------- the viewer, no stream -- */
  await go(`/watch/${GAME}`);
  ok("with no stream the page says so and offers nothing to play",
    (await text("[data-facade-note]"))?.includes("No stream") && await test(`document.querySelector('[data-play]').hidden`));
  ok("no stream means no frame is loaded", await test(`!document.querySelector('[data-holder] iframe')`));
  ok("the scorebug stays down before the game starts", await test(`document.querySelector('[data-bug]').hidden`));

  /* ----------------------------------------------------- a live broadcast -- */
  stream = { video_id: VIDEO, label: "Lightning vs Predators", state: "live", started_at: new Date().toISOString() };
  clock = { period: "2", period_length_ms: 900000, remaining_ms: 748000, elapsed_ms: 1052000,
            running: true, anchor: Date.now(), revision: 4 };
  result = { status: "in_progress", our_score: 0, their_score: 0, period: "2", revision: 4 };
  events = [];
  nextId = 1;
  for (let i = 0; i < 9; i++) append({ kind: "shot", team: i < 6 ? "us" : "them", client_id: `s${i}` });
  append({ kind: "goal", team: "us", player_id: "pl-09", assist1: "pl-22", client_id: "g1" });
  append({ kind: "penalty", team: "them", minutes: 2, infraction: "Tripping", client_id: "p1" });

  await go(`/watch/${GAME}`);
  ok("a live stream offers one tap to watch",
    !(await test(`document.querySelector('[data-play]').hidden`))
    && (await text("[data-play-label]")) === "Watch live");
  ok("the live badge is up", !(await test(`document.querySelector('[data-live-badge]').hidden`)));
  await click("[data-play]");
  ok("tapping mounts the privacy-preserving embed built from the stored id only",
    (await test(`document.querySelector('[data-holder] iframe')?.src ?? ''`))
      .startsWith(`https://www.youtube-nocookie.com/embed/${VIDEO}?`));
  ok("the facade gets out of the way", await test(`document.querySelector('[data-facade]').hidden`));

  ok("the scorebug is up with the derived score and shots",
    !(await test(`document.querySelector('[data-bug]').hidden`))
    && (await text('[data-bug-side="us"] [data-score]')) === "1"
    && (await text('[data-sog="us"]')) === "7"
    && (await text('[data-sog="them"]')) === "3");
  ok("the period reads as a scorebug reads it", (await text("[data-period]")) === "2ND");
  ok("goals count as shots on goal", (await text('[data-sog="us"]')) === "7");

  const first = await text("[data-clock]");
  await sleep(1300);
  const second = await text("[data-clock]");
  ok("the clock ticks between polls, not on them", first !== second
    && /^\d+:\d\d$/.test(first) && /^\d+:\d\d$/.test(second));

  ok("a penalty on them shows our power play with its own clock",
    !(await test(`document.querySelector('[data-pp]').hidden`))
    && (await text("[data-pp-label]")) === "POWER PLAY"
    && /^[01]:\d\d$/.test(await text("[data-pp-clock]")));
  ok("the strength is named", (await text("[data-strength]")) === "5v4");
  ok("the penalty box lists the offending side and counts down",
    await test(`document.querySelectorAll('[data-boxes] li').length === 1`)
    && (await text("[data-boxes] li .bx-clock")).match(/^\d:\d\d$/) !== null);

  /* --------------------------------------------------------- goal graphic -- */
  append({ kind: "goal", team: "us", player_id: "pl-22", assist1: "pl-09", assist2: "pl-03", client_id: "g2" });
  await repoll();
  ok("a goal that happens while watching raises the graphic",
    !(await test(`document.querySelector('[data-lower]').hidden`)));
  ok("the graphic names the scorer and the assists",
    (await text("[data-lower-name]"))?.length > 2
    && (await text("[data-lower-detail]"))?.startsWith("Assists:"));
  ok("and the score follows it", (await text('[data-bug-side="us"] [data-score]')) === "2");

  /* ------------------------------------------------------------- overlay -- */
  await click("[data-toggle-overlay]");
  ok("the overlay can be taken off for a clean picture",
    await test(`getComputedStyle(document.querySelector('.ovl')).display === 'none'`)
    && (await text("[data-toggle-overlay]")) === "Show overlay");
  await click("[data-toggle-overlay]");
  ok("and put back", await test(`getComputedStyle(document.querySelector('.ovl')).display !== 'none'`));

  /* ------------------------------------------------------------ the horn -- */
  clock = { ...clock, running: false, remaining_ms: 0 };
  result = { ...result, status: "final", revision: result.revision + 1 };
  await repoll();
  ok("the final card goes up with the scoring summary",
    !(await test(`document.querySelector('[data-card]').hidden`))
    && (await text("[data-card-title]")) === "Final"
    && await test(`document.querySelectorAll('[data-card-summary] li').length === 2`));
  await click("[data-card]");
  ok("a tap dismisses it so a replay is watchable", await test(`document.querySelector('[data-card]').hidden`));

  /* ----------------------------------------------------- a dropped signal -- */
  offline = true;
  await repoll();
  ok("losing the connection keeps the last state and says so",
    (await text("[data-status]"))?.includes("interrupted")
    && (await text('[data-bug-side="us"] [data-score]')) === "2");
  offline = false;

  /* ------------------------------------------------------- phone viewport -- */
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await go(`/watch/${GAME}`);
  await click("[data-play]");
  await sleep(300);
  ok("the watch page fits a phone", await test(`document.documentElement.scrollWidth <= innerWidth`));
  ok("the scorebug stays inside the frame on a phone", await test(`(() => {
    const frame = document.querySelector('.frame').getBoundingClientRect();
    const bug = document.querySelector('[data-bug]').getBoundingClientRect();
    return bug.left >= frame.left - 1 && bug.right <= frame.right + 1 && bug.bottom <= frame.bottom + 1;
  })()`));
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(OUT, "watch-mobile.png"), Buffer.from(shot.data, "base64"));

  /* ------------------------------------------------------------- console -- */
  role = "parent";
  await go("/control");
  ok("a parent cannot open the console",
    !(await test(`document.querySelector('#gate').hidden`)) && await test(`document.querySelector('#console').hidden`));
  role = "admin";

  events = [];
  nextId = 1;
  posted.length = 0;
  result = { status: "scheduled", our_score: 0, their_score: 0, period: null, revision: 0 };
  clock = { period: "1", period_length_ms: 900000, remaining_ms: 900000, elapsed_ms: 0,
            running: false, anchor: Date.now(), revision: 0 };
  await go(`/control?game=${GAME}`);
  ok("an admin gets the console on the requested game",
    !(await test(`document.querySelector('#console').hidden`))
    && (await cdp.eval(`document.querySelector('[data-game-select]').value`)) === GAME);
  ok("the console fits a phone with no sideways scroll",
    await test(`document.documentElement.scrollWidth <= innerWidth`));
  const small = await test(`
    [...document.querySelectorAll('#console .pad, .run, .nudges button, .periods button')]
      .filter(el => el.getBoundingClientRect().height < 44)
      .map(el => el.className + '|' + Math.round(el.getBoundingClientRect().height))`);
  ok("every control used during play is a real thumb target", small.length === 0, JSON.stringify(small));

  await click('[data-act="shot"][data-team="us"]');
  ok("one tap records a shot with a de-duplication key",
    posted.at(-1).path === "events" && posted.at(-1).body.kind === "shot"
    && posted.at(-1).body.team === "us" && typeof posted.at(-1).body.client_id === "string");
  ok("the console never sends a clock reading with a tap",
    !("clock_ms" in posted.at(-1).body) && !("period" in posted.at(-1).body));
  ok("and the scoreline shows it", (await text('[data-sog="us"]'))?.includes("1"));

  /* ---- a goal, through the sheet ---- */
  await click('[data-act="goal"][data-team="us"]');
  ok("the goal sheet opens asking who scored", !(await test(`document.querySelector('[data-sheet="goal"]').hidden`)));
  await click('[data-scorer] [data-player="pl-09"]');
  await click('[data-assists] [data-player="pl-22"]');
  await click('[data-sheet="goal"] [data-confirm]');
  ok("the goal carries the scorer and the assist",
    posted.at(-1).body.kind === "goal" && posted.at(-1).body.player_id === "pl-09"
    && posted.at(-1).body.assist1 === "pl-22" && posted.at(-1).body.assist2 === null);
  ok("the sheet closes once it is recorded", await test(`document.querySelector('[data-sheet="goal"]').hidden`));
  ok("the score updates from the server's own count", (await text('[data-score="us"]')) === "1");

  /* ---- an opponent goal needs no roster ---- */
  await click('[data-act="goal"][data-team="them"]');
  ok("an opponent goal does not ask for one of our players",
    await test(`document.querySelector('[data-scorer]').hidden`));
  await click('[data-sheet="goal"] [data-confirm]');
  ok("and records with no player named",
    posted.at(-1).body.team === "them" && posted.at(-1).body.player_id === null);

  /* ---- the clock ---- */
  await click("[data-run]");
  ok("starting the clock carries the revision it was read at",
    posted.at(-1).path === "clock" && posted.at(-1).body.running === true
    && posted.at(-1).body.expected_revision === 0);
  ok("the button turns into a stop", (await text("[data-run]")) === "Stop clock");
  await sleep(1200);
  const onConsole = await text("[data-clock]");
  ok("the console clock runs down too", onConsole !== "15:00" && /^\d+:\d\d$/.test(onConsole));
  await click('[data-nudge="-10000"]');
  ok("a nudge sends the live reading, not the stale one",
    posted.at(-1).path === "clock" && posted.at(-1).body.remaining_ms < 890000);
  await click("[data-run]");
  await click('[data-period-set="2"]');
  ok("picking a period resets the clock to a full one and stops it",
    posted.at(-1).body.period === "2" && posted.at(-1).body.remaining_ms === 900000
    && posted.at(-1).body.running === false);
  await cdp.eval(`document.querySelector('.tweak').open = true`);
  await value("[data-clock-input]", "12:48");
  await click("[data-clock-apply]");
  ok("a timekeeper can type the board's exact reading", posted.at(-1).body.remaining_ms === 768000);

  /* ---- a penalty ---- */
  await click('[data-act="penalty"][data-team="us"]');
  await click('[data-pen-player] [data-player="pl-22"]');
  await click('[data-pen-infraction] [data-infraction="Hooking"]');
  await click('[data-pen-minutes] [data-minutes="4"]');
  await click('[data-sheet="penalty"] [data-confirm]');
  ok("the penalty carries player, infraction and minutes",
    posted.at(-1).body.kind === "penalty" && posted.at(-1).body.player_id === "pl-22"
    && posted.at(-1).body.infraction === "Hooking" && posted.at(-1).body.minutes === 4);
  ok("the console shows us short handed",
    (await text("[data-pp]"))?.startsWith("Short handed"));

  /* ---- the highlight button ---- */
  await click('[data-act="highlight"]');
  ok("marking a highlight is a single tap", posted.at(-1).body.kind === "highlight");
  ok("the mark links into the recording at the moment it happened", await test(`(() => {
    const link = [...document.querySelectorAll('[data-feed] li')]
      .find(li => li.textContent.includes('Highlight'))?.querySelector('a');
    return !!link && /[?&]v=/.test(link.href) && /&t=\\d+s$/.test(link.href);
  })()`));

  /* ---- undo ---- */
  const before = await text('[data-score="us"]');
  await cdp.eval(`[...document.querySelectorAll('[data-feed] li')]
    .find(li => li.textContent.includes('Goal') && li.textContent.includes('#9'))
    ?.querySelector('button')?.click()`);
  await sleep(300);
  ok("undo takes a goal back off the board",
    before === "1" && (await text('[data-score="us"]')) === "0"
    && posted.at(-1).path === "void");

  /* ---- a tap made with no signal ---- */
  offline = true;
  await click('[data-act="shot"][data-team="them"]');
  await sleep(300);
  ok("a tap with no signal is queued, and says so",
    (await text("[data-say]"))?.includes("waiting for a connection"));
  const queuedBefore = posted.filter((p) => p.path === "events").length;
  offline = false;
  await sleep(3200);          // the outbox retry interval
  const sent = posted.filter((p) => p.path === "events");
  ok("and it sends itself when the signal comes back",
    sent.length === queuedBefore + 1 && sent.at(-1).body.kind === "shot" && sent.at(-1).body.team === "them");
  ok("the queue clears once it is through", !(await text("[data-say]"))?.includes("waiting"));

  /* ---- the stream, and the handover to the official scoresheet ---- */
  await cdp.eval(`document.querySelector('.settings').open = true`);
  await value("[data-stream-url]", "https://youtu.be/abcdefghijk");
  await value("[data-stream-state]", "live");
  await click("[data-stream-save]");
  ok("the console sets the stream from a shared link",
    posted.at(-1).path === "stream" && posted.at(-1).body.url === "https://youtu.be/abcdefghijk"
    && posted.at(-1).body.state === "live");
  await click("[data-sheet-preview]");
  ok("the derived scoresheet can be reviewed before it is entered",
    !(await test(`document.querySelector('[data-derived]').hidden`))
    && (await text("[data-derived]"))?.includes("Admin → Game scoring"));

  /* ---- discovery ---- */
  await go("/watch");
  ok("the watch index lists the game that has a stream", await test(`(() => {
    const rows = [...document.querySelectorAll('[data-game]')].filter(r => !r.hidden);
    return rows.length === 1 && rows[0].dataset.streamState === 'live';
  })()`));
  await go(`/schedule/${GAME}`);
  ok("the game page offers the broadcast once there is one", await test(`(() => {
    const cta = document.querySelector('[data-watch-cta]');
    return cta && !cta.hidden && cta.dataset.state === 'live' && cta.textContent.includes('Watch live now');
  })()`));

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed\nScreenshots: ${OUT}`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
} finally {
  cdp?.ws.close();
  chrome.kill("SIGKILL");
  server.close();
}
