#!/usr/bin/env node
/**
 * Training progress on a player's page, driven in a real browser.
 *
 * The page is public and static and the section on it is filled from
 * /api/goals, so the thing worth testing is who the browser shows it to: a
 * signed-out visitor must see nothing, a parent must see their own child and
 * not somebody else's, and a team goal's shared total must not be passed off
 * as one player's work. None of that is visible without a browser and a
 * session. The goals board itself is covered by test_goals_ui.mjs, the API by
 * api/test_goals.py.
 *
 *   npm run build            # in site/, the dist it drives
 *   node tools/test_player_goals_ui.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(ROOT, "site", "dist");
const shotArg = process.argv.indexOf("--shots");
const OUT = shotArg === -1 ? await mkdtemp(path.join(tmpdir(), "lvlnb-pgoals-")) : process.argv[shotArg + 1];
const CHROME = process.env.CHROME_PATH || "chromium";
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ttf": "font/ttf" };

const TODAY = "2026-10-13";
let role = "parent";        // parent of pl-02 | admin | signed-out
const goals = [
  { id: 11, title: "Team off-ice shots",  scope: "team",   player_id: null,    unit: "shots",   target: 1000, total: 450, family_total: 50,  starts_on: "2026-10-12", ends_on: "2026-10-18", archived: false },
  { id: 12, title: "50 squats this week", scope: "player", player_id: "pl-02", unit: "reps",    target: 50,   total: 10,  family_total: 10,  starts_on: "2026-10-12", ends_on: "2026-10-18", archived: false },
  { id: 13, title: "Edgework drills",     scope: "player", player_id: "pl-02", unit: "minutes", target: 60,   total: 60,  family_total: 60,  starts_on: "2026-10-12", ends_on: "2026-10-18", archived: false },
  { id: 14, title: "September shots",     scope: "player", player_id: "pl-02", unit: "shots",   target: 100,  total: 80,  family_total: 80,  starts_on: "2026-09-01", ends_on: "2026-09-30", archived: false },
  { id: 15, title: "Retired drill",       scope: "player", player_id: "pl-02", unit: "reps",    target: 10,   total: 0,   family_total: 0,   starts_on: "2026-10-12", ends_on: "2026-10-18", archived: true },
  { id: 16, title: "Stickhandling",       scope: "player", player_id: "pl-07", unit: "minutes", target: 30,   total: 12,  family_total: 0,   starts_on: "2026-10-12", ends_on: "2026-10-18", archived: false },
];
const NAMES = { "pl-02": "Test Player", "pl-07": "Hugo Landry" };

// The board the API would build for this viewer: a family gets team goals plus
// their own player's, an admin gets everything, and family_total is only ever
// the signed-in family's own player. Contract in api/goals.py.
function board() {
  const admin = role === "admin";
  const family = admin ? null : "pl-02";
  return {
    goals: goals
      .filter((g) => g.scope === "team" || admin || g.player_id === family)
      .map((g) => ({ ...g, family_total: family ? g.family_total : 0 })),
    players: Object.entries(NAMES)
      .filter(([id]) => admin || id === family)
      .map(([id, name]) => ({ id, name, number: Number(id.slice(3)) })),
    admin, today: TODAY, player_id: family,
  };
}

function api(req, res) {
  const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (role === "signed-out") return json(401, { detail: "Sign in to see goals" });
  if (req.url.replace(/^\/api/, "") === "/goals") return json(200, board());
  return json(404, { detail: "Missing" });
}

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.url.startsWith("/api/")) return api(req, res);
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
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.session = null;
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
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
const ok = (name, cond, extra = "") => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : "  " + extra}`); };

if (!(await readFile(path.join(DIST, "players", "pl-02", "index.html")).catch(() => null))) {
  console.error("site/dist has no /players/pl-02 — run `npm run build` in site/ first.");
  process.exit(1);
}

const { server, port } = await serve();
const probe = createServer();
const dbg = await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); }));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
  `--remote-debugging-port=${dbg}`, `--user-data-dir=${OUT}/profile`, "about:blank"], { stdio: "ignore" });
let cdp;
try {
  cdp = await connect(dbg);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }, false);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, false);
  cdp.session = sessionId;
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  // Wait on the section settling, not on a timer: the signed-out case has
  // nothing to appear, so a sleep could never tell "shut" from "not yet".
  async function visit(id) {
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/players/${id}` });
    for (let i = 0; i < 60; i++) {
      const done = await cdp.eval(`!!document.querySelector('[data-player-goals][data-pgoals-done]')`).catch(() => false);
      if (done) break;
      await sleep(100);
    }
    return cdp.eval(`(() => {
      const s = document.querySelector('[data-player-goals]');
      if (!s) return { missing: true, where: location.pathname };
      const e = s.querySelector('[data-pgoals-empty]');
      return { hidden: s.hidden, text: s.textContent, empty: e.hidden ? null : e.textContent,
        cards: [...s.querySelectorAll('.goal-card')].map(c => ({
          title: c.querySelector('h3').textContent,
          eyebrow: c.querySelector('.eyebrow').textContent,
          status: c.querySelector('.goal-status').textContent,
          total: c.querySelector('.goal-total strong').textContent,
          of: c.querySelector('.goal-total .muted').textContent,
          note: [...c.querySelectorAll('p')].pop().textContent,
          max: Number(c.querySelector('progress').max),
          value: Number(c.querySelector('progress').value),
          complete: c.classList.contains('is-complete'),
        })) };
    })()`);
  }

  /* --- a public page keeps a child's training to itself --------------- */
  role = "signed-out";
  let p = await visit("pl-02");
  ok("a signed-out visitor sees no training progress", !p.missing && p.hidden && p.cards.length === 0, JSON.stringify(p));

  // Not in the markup either: the build is public, and roster.json's privacy
  // block may be hiding even the player's name from it. The component's own
  // code and class names are in the page, of course — what must not be is a
  // goal, a total, or a name.
  const raw = await (await fetch(`http://127.0.0.1:${port}/players/pl-02`)).text();
  ok("the static page ships the section empty",
     /<div class="pgoals-list"[^>]*><\/div>/.test(raw) && !/data-pgoals-done/.test(raw));
  ok("no goal of this player's is built into the public page",
     !/50 squats this week|Edgework drills|September shots|Retired drill|Test Player/.test(raw));

  /* --- the player's own family ---------------------------------------- */
  role = "parent";
  p = await visit("pl-02");
  ok("a family sees their own player's current goals", !p.hidden && p.cards.length === 3,
     JSON.stringify(p.cards?.map((c) => c.title)));
  ok("finished and archived goals stay off the page",
     !p.text.includes("September shots") && !p.text.includes("Retired drill"));
  const squats = p.cards[0] ?? {};
  ok("a goal in progress shows its total, target and what is left",
     squats.title === "50 squats this week" && squats.total === "10" && squats.of === "/ 50 reps"
     && squats.note === "40 reps to go" && squats.status === "In progress" && !squats.complete,
     JSON.stringify(squats));
  ok("the bar measures the goal, not the screen", squats.max === 50 && squats.value === 10);
  const edge = p.cards[1] ?? {};
  ok("a reached goal is marked reached", edge.complete && edge.status === "Goal reached ✓"
     && edge.note === "Target reached. Keep building on it!", JSON.stringify(edge));
  const shared = p.cards[2] ?? {};
  ok("a team goal shows the team total with this player's share named",
     shared.eyebrow === "Together as a team" && shared.total === "450" && shared.of === "/ 1,000 shots"
     && shared.note === "Test Player’s share: 50 shots" && shared.max === 1000, JSON.stringify(shared));

  /* --- somebody else's child ------------------------------------------ */
  // family_total is the signed-in family's own player. On another child's page
  // it would be their work shown under the wrong name.
  p = await visit("pl-07");
  ok("a family sees nothing on another player's page", p.hidden && p.cards.length === 0, JSON.stringify(p.cards));

  /* --- the coach ------------------------------------------------------- */
  role = "admin";
  p = await visit("pl-07");
  ok("an admin sees that player's own goals", !p.hidden && p.cards.length === 1
     && p.cards[0]?.title === "Stickhandling" && p.cards[0]?.note === "18 minutes to go", JSON.stringify(p.cards));
  ok("no share is claimed for a viewer the board cannot attribute one to", !p.text.includes("share"));

  p = await visit("pl-04");
  ok("a player with no goals running says so rather than looking broken",
     !p.hidden && p.cards.length === 0 && /No goal is running for them/.test(p.empty ?? ""), JSON.stringify(p));

  const shoot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await mkdir(OUT, { recursive: true });
    await writeFile(path.join(OUT, name), Buffer.from(data, "base64"));
  };

  /* --- small screens --------------------------------------------------- */
  role = "parent";
  await visit("pl-02");
  await shoot("player-goals-desktop.png");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await visit("pl-02");
  ok("the section fits a phone", await cdp.eval(`document.documentElement.scrollWidth <= innerWidth`));
  await shoot("player-goals-mobile.png");

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed\nScreenshots: ${OUT}`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
} finally {
  cdp?.ws.close(); chrome.kill("SIGKILL"); server.close();
}
