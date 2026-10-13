#!/usr/bin/env node
/**
 * The admin roster panel's card-art state, driven in a real browser.
 *
 * Written for one bug: the panel decided "no card art" from the profiles table
 * alone, so all nineteen players — every one of whom has art in the repo —
 * were reported as having none, inviting JL to redraw work already done. The
 * art state has two sources now, and only a browser shows the merge of the
 * server-rendered baseline with what /profiles returns.
 *
 *   npm run build            # in site/, the dist it drives
 *   node tools/test_roster_ui.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(ROOT, "site", "dist");
const OUT = await mkdtemp(path.join(tmpdir(), "lvlnb-roster-"));
const CHROME = process.env.CHROME_PATH || "chromium";
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".ttf": "font/ttf" };

const UPLOADED = "/uploads/card_art-20261013120000-a1b2c3d4.jpg";
// pl-02 has repo art and an empty card_art column — the bug's exact shape.
// pl-03 carries an upload. pl-04 has no row at all.
const profiles = {
  "pl-02": { player_id: "pl-02", position: "D", shoots: "L", captain: null, nickname: null, bio: null, card_art: null, photo: null },
  "pl-03": { player_id: "pl-03", position: "C", shoots: "R", captain: "C", nickname: "Hank", bio: null, card_art: UPLOADED, photo: null },
};
const puts = [];

function api(req, res, raw) {
  const p = req.url.replace(/^\/api/, "");
  const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (p === "/auth/me") return json(200, { id: 1, email: "jl@hexpi.ca", display_name: "JL", role: "admin" });
  if (p === "/profiles" && req.method === "GET") return json(200, profiles);
  if (p.startsWith("/profiles/") && req.method === "PUT") {
    const id = p.split("/")[2];
    const body = JSON.parse(raw);
    puts.push({ id, body });
    profiles[id] = { ...(profiles[id] ?? { player_id: id }), ...body };
    return json(200, profiles[id]);
  }
  // Everything else the admin page boots: benign empties.
  return json(200, /users|news|uploads|queue|types|plays|jobs|moderation/.test(p) ? [] : {});
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
const ok = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); };

if (!(await readFile(path.join(DIST, "admin", "index.html")).catch(() => null))) {
  console.error("site/dist has no /admin — run `npm run build` in site/ first.");
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
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/admin` });
  await sleep(700);

  const state = (id) => cdp.eval(
    `(() => { const s = document.querySelector('.rp-item[data-player="${id}"] [data-artstate]');
        return { text: s.textContent.trim(), has: s.classList.contains('has'),
                 title: s.title, repo: s.dataset.repoart,
                 override: document.querySelector('.rp-item[data-player="${id}"]').dataset.art ?? null }; })()`);

  // The regression. Before the fix this read "no card art" for all nineteen.
  const none = await cdp.eval(
    `[...document.querySelectorAll('[data-artstate]')].filter(s => s.textContent.includes('no card art')).length`);
  const total = await cdp.eval(`document.querySelectorAll('[data-artstate]').length`);
  ok(`no player with repo art is reported as having none (${total} players)`, total === 19 && none === 0);
  ok("every art state is marked as having art", await cdp.eval(
    `[...document.querySelectorAll('[data-artstate]')].every(s => s.classList.contains('has'))`));

  const a = await state("pl-02");
  ok("an empty card_art column keeps the repo art", a.text === "card art — Olivier Landry.jpg" && a.has);
  ok("repo art names the file it found", a.title === "assets/photos/Olivier Landry.jpg" && a.repo === "assets/photos/Olivier Landry.jpg");
  ok("repo art is not held as an upload override", a.override === "");

  const b = await state("pl-03");
  ok("an uploaded card art overrides the repo art", b.text === "uploaded card art attached" && b.has);
  ok("the upload keeps its path for saving", b.title === UPLOADED && b.override === UPLOADED);

  const c = await state("pl-04");
  ok("a player with no profiles row keeps the rendered baseline", c.text === "card art — Vincent Lacasse.jpg" && c.has);

  // Saving an unrelated field must not copy repo art into the profiles row.
  await cdp.eval(`document.querySelector('.rp-item[data-player="pl-02"] [data-f="nickname"]').value = 'Ollie'`);
  await cdp.eval(`document.querySelector('.rp-item[data-player="pl-02"] [data-save]').click()`);
  await sleep(400);
  const put = puts.find((p) => p.id === "pl-02");
  ok("saving a profile sends card_art: null, not the repo path", !!put && put.body.card_art === null && put.body.nickname === "Ollie");
  ok("the repo art survives a save", (await state("pl-02")).text === "card art — Olivier Landry.jpg");

  // The empty state still exists for a player the import found no art for.
  await cdp.eval(`document.querySelector('.rp-item[data-player="pl-02"] [data-artstate]').dataset.repoart = ''`);
  await cdp.eval(`document.querySelector('.rp-item[data-player="pl-02"] [data-save]').click()`);
  await sleep(400);
  const empty = await state("pl-02");
  ok("a player with neither source reads 'no card art'", empty.text === "no card art" && !empty.has);

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
} finally {
  cdp?.ws.close(); chrome.kill("SIGKILL"); server.close();
}
