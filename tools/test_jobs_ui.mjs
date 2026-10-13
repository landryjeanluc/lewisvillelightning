#!/usr/bin/env node
/**
 * The game-jobs admin panel, driven in a real browser.
 *
 * The API half is covered by api/test_api.py against real Postgres. What is
 * checked here is the panel: that the standard three arrive on their own, that
 * the jobs we stopped seeding can be added back one at a time, that a job
 * invented for a tournament weekend reaches the server, that dropping one asks
 * first — and that adding or dropping a job refreshes the assignment table in
 * the same breath, since that is the part a unit test cannot see.
 *
 *   cd site && npm run build
 *   node tools/test_jobs_ui.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(ROOT, "site", "dist");
const OUT = await mkdtemp(path.join(tmpdir(), "lvlnb-jobs-"));
const CHROME = process.env.CHROME_PATH || "chromium";
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".ttf": "font/ttf" };

/* ------------------------------------------------------------- stub API -- */
// Mirrors app.py: DEFAULT_JOBS seeded, OPTIONAL_JOBS offered.
let nextId = 4;
let types = [
  { id: 1, name: "50/50 tickets", description: "Sell 50/50 tickets in the stands", sort: 10, active: true },
  { id: 2, name: "Scoresheet", description: "Keep the official scoresheet", sort: 20, active: true },
  { id: 3, name: "Timekeeper", description: "Run the clock", sort: 30, active: true },
];
const OPTIONAL = [
  { name: "Penalty box", description: "Penalty box door", sort: 40 },
  { name: "Jerseys", description: "Collect and wash the jerseys", sort: 50 },
  { name: "Snacks", description: "Post-game snacks", sort: 60 },
];
// one family already on the hook, so a delete has something to cascade into
let assigned = { 1: { player_id: "pl-02", family: "Olivier Landry", family_number: 2,
                      claimed_by: "Mom to Olivier", claimed_by_id: 7 } };
const posted = [];

function api(req, res, raw) {
  const p = new URL(req.url, "http://x").pathname.replace(/^\/api/, "");
  const json = (status, value) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };
  const sorted = () => [...types].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

  // The jobs routes come before the catch-all: /jobs/types must not be read
  // as a game id, and the catch-all answers anything with "types" in it.
  if (p === "/auth/me") return json(200, { id: 1, email: "coach@lvlnb.ca", display_name: "Coach", role: "admin" });
  if (p === "/jobs/types" && req.method === "GET") return json(200, sorted());
  if (p === "/jobs/suggestions") {
    const have = new Set(types.map((t) => t.name.toLowerCase()));
    return json(200, OPTIONAL.filter((o) => !have.has(o.name.toLowerCase())));
  }
  if (p === "/jobs/types" && req.method === "POST") {
    const b = JSON.parse(raw);
    posted.push(b);
    if (types.some((t) => t.name.toLowerCase() === b.name.toLowerCase()))
      return json(409, { detail: `there is already a job called ${b.name}` });
    const row = { id: nextId++, name: b.name, description: b.description ?? null, active: true,
                  sort: b.sort ?? Math.max(0, ...types.map((t) => t.sort)) + 10 };
    types.push(row);
    return json(201, row);
  }
  if (p.startsWith("/jobs/types/") && req.method === "DELETE") {
    const id = Number(p.split("/")[3]);
    if (!types.some((t) => t.id === id)) return json(404, { detail: "no such job" });
    const removed = assigned[id] ? 1 : 0;
    types = types.filter((t) => t.id !== id);
    delete assigned[id];
    return json(200, { ok: true, assignments_removed: removed });
  }
  if (p === "/jobs/seed-defaults") return json(200, { added: 0 });
  if (p.startsWith("/jobs/") && req.method === "GET")
    return json(200, sorted().map((t) => ({
      job_type_id: t.id, name: t.name, description: t.description, sort: t.sort,
      player_id: null, note: null, updated_at: null, claimed_by: null, claimed_by_id: null,
      family: null, family_number: null, ...(assigned[t.id] ?? {}),
    })));
  if (p.startsWith("/jobs/") && req.method === "PUT") return json(200, { saved: JSON.parse(raw).length });

  // Everything else the admin page boots: benign empties.
  return json(200, /users|news|uploads|queue|types|profiles/.test(p) ? [] : {});
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
        if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
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
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.session = null; this.dialogs = 0;
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      // Removing a job puts up a confirm(). Headless chromium blocks on a
      // dialog nobody answers, so the run answers it — and counts it, because
      // "it asked first" is one of the things being tested.
      if (msg.method === "Page.javascriptDialogOpening") {
        this.dialogs++;
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
const ok = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };
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
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",
                 { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  const test = (expr) => cdp.eval(expr);
  const click = async (sel) => {
    await cdp.eval(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(250);
  };
  const value = (sel, val) =>
    cdp.eval(`document.querySelector(${JSON.stringify(sel)}).value = ${JSON.stringify(val)}`);
  // The panel sits in a hidden tab, inside a folded <details>.
  const go = async () => {
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/admin` });
    await sleep(600);
    await cdp.eval(`document.querySelector('[data-tab=jobs-tab]').click();
                    document.querySelector('.jp-list').open = true`);
    await sleep(250);
  };

  await go();
  ok("the standard three arrive on their own",
     await test(`[...document.querySelectorAll('#jp-types li strong')].map(e => e.textContent).join('|')
                 === '50/50 tickets|Scoresheet|Timekeeper'`));
  ok("the jobs we stopped seeding are offered as one-tap adds",
     await test(`!document.querySelector('#jp-sugg').hidden &&
                 [...document.querySelectorAll('.jp-add')].map(b => b.textContent).join('|')
                 === '+ Penalty box|+ Jerseys|+ Snacks'`));

  await click("[data-i='1']");
  ok("an offered job is added with its own blurb and place in the order",
     posted.at(-1)?.name === "Jerseys" && posted.at(-1)?.sort === 50 &&
     posted.at(-1)?.description === "Collect and wash the jerseys");
  ok("a job on the list stops being offered",
     await test(`[...document.querySelectorAll('.jp-add')].map(b => b.textContent).join('|')
                 === '+ Penalty box|+ Snacks'`));
  ok("the new job appears in the list, in its place",
     await test(`[...document.querySelectorAll('#jp-types li strong')].map(e => e.textContent).join('|')
                 === '50/50 tickets|Scoresheet|Timekeeper|Jerseys'`));
  ok("adding a job also refreshes the game's assignment table",
     await test(`document.querySelector('#jp-rows').textContent.includes('Jerseys')`));

  // something nobody planned for: a tournament needs a person on the gate
  await value("#jp-new-name", "Tournament gate");
  await value("#jp-new-desc", "Take admission at the door, Saturday only");
  await cdp.eval(`document.querySelector('#jp-new').requestSubmit()`);
  await sleep(300);
  ok("a job invented on the spot is sent with no sort, to land at the end",
     posted.at(-1)?.name === "Tournament gate" && posted.at(-1)?.sort === undefined &&
     posted.at(-1)?.description === "Take admission at the door, Saturday only");
  ok("the invented job lands at the end of the list",
     await test(`document.querySelector('#jp-types li:last-child strong').textContent === 'Tournament gate'`));
  ok("the form is cleared for the next one",
     await test(`!document.querySelector('#jp-new-name').value && !document.querySelector('#jp-new-desc').value`));
  ok("a blank job name is not sent",
     (await cdp.eval(`document.querySelector('#jp-new').requestSubmit(); 1`),
      await sleep(200), posted.at(-1)?.name === "Tournament gate"));

  // dropping the 50/50, which a family is on the hook for
  const before = cdp.dialogs;
  await click(".jp-del[data-id='1']");
  await sleep(300);
  ok("dropping a job asks first", cdp.dialogs === before + 1);
  ok("dropping a job says what went with it",
     await test(`document.querySelector('#jp-list-status').textContent
                 === '50/50 tickets removed — 1 game assignment with it.'`));
  ok("the dropped job leaves the list and the game's table",
     await test(`!document.querySelector('#jp-types').textContent.includes('50/50') &&
                 !document.querySelector('#jp-rows').textContent.includes('50/50')`));

  // a name typed by an admin is text, never markup — in both views
  types.push({ id: 99, name: "<img src=x onerror=alert(1)>", description: "<b>bold</b>", sort: 5, active: true });
  await go();
  ok("job names render as text, not markup",
     await test(`!document.querySelector('#jp-types img') && !document.querySelector('#jp-rows img') &&
                 document.querySelector('#jp-types li strong').textContent.includes('<img')`));

  await cdp.send("Emulation.setDeviceMetricsOverride",
                 { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(200);
  ok("the panel fits a phone", await test(`document.documentElement.scrollWidth <= innerWidth`));

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
} finally {
  cdp?.ws.close(); chrome.kill("SIGKILL"); server.close();
}
