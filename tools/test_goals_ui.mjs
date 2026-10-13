#!/usr/bin/env node
/** Goals browser regression checks. Build site/ first; API contracts live in test_goals.py. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(ROOT, "site", "dist");
const OUT = await mkdtemp(path.join(tmpdir(), "lvlnb-goals-"));
const CHROME = process.env.CHROME_PATH || "chromium";
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".ttf": "font/ttf" };
let admin = true, signedOut = false, failSave = false, failLoad = false;
const saved = [];
const goals = [
  { id: 1, title: "1,000 off-ice shots", scope: "team", player_id: null, unit: "shots", target: 1000, total: 450, family_total: 50 },
  { id: 2, title: "50 squats this week", scope: "player", player_id: "pl-02", unit: "reps", target: 50, total: 10, family_total: 10 },
  { id: 3, title: "Stickhandling time", scope: "player", player_id: "pl-02", unit: "seconds", target: 60, total: 0, family_total: 0 },
].map(g => ({ ...g, starts_on: "2026-10-12", ends_on: "2026-10-18", archived: false }));
function api(req, res, raw) {
  const p = req.url.replace(/^\/api\/goals/, "");
  const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (req.url === "/api/auth/me") return json(200, signedOut ? null : { id: 1, display_name: "Test user", role: admin ? "admin" : "parent" });
  if (req.url === "/api/auth/login") { signedOut = false; return json(200, { id: 1, display_name: "Test user", role: "admin" }); }
  if (req.url === "/api/auth/logout") { signedOut = true; return json(200, { ok: true }); }
  if (!req.url.startsWith("/api/goals")) return json(200, /users|news|uploads|queue|types|suggestions|plays|jobs/.test(req.url) ? [] : {});
  if (signedOut) return json(401, {detail: "Sign in"});
  if (failLoad && req.method === "GET") return json(503, {detail: "Try again"});
  if (!p && req.method === "GET") return json(200, { goals, admin, today: "2026-10-13", player_id: admin ? null : "pl-02",
    players: [{id: "pl-02", name: "Test Player", number: 2}] });
  if (req.method === "POST" && !p) {
    const b = JSON.parse(raw); saved.push(b); goals.push({...b, id: goals.length + 1, total: 0, family_total: 0}); return json(201, goals.at(-1));
  }
  if (req.method === "POST" && /entries$/.test(p)) {
    const b = JSON.parse(raw); saved.push(b);
    // Simulate a server commit whose response fails. Retry must reuse its key.
    if (!saved.slice(0, -1).some(x => x.client_id === b.client_id)) {
      const g = goals.find(g => g.id === Number(p.split("/")[1])); g.total += b.amount; g.family_total += b.amount;
    }
    if (failSave) return json(503, {detail: "Connection interrupted. Try again."});
    return json(201, {id: 10});
  }
  if (req.method === "GET" && /entries$/.test(p)) return json(200, [{id: 10, player_id: "pl-02", amount: 10, performed_on: "2026-10-13", recorded_by: "Parent"}]);
  if (req.method === "DELETE") return json(200, {ok: true});
  if (req.method === "PUT") { Object.assign(goals.find(g => g.id === Number(p.slice(1))), JSON.parse(raw)); return json(200, {}); }
  return json(404, {detail: "Missing"});
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
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.session = null;
    this.dialogs = 0;
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      // An editor with unsaved work puts up a beforeunload dialog on navigate.
      // That is the point of it — but headless chromium blocks on a dialog
      // nobody answers, so the run has to answer it.
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
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  }
  async mouse(type, x, y) {
    await this.send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1, pointerType: "mouse",
    });
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
const ok = (name, cond) => { results.push(!!cond); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); };
const {server, port} = await serve();
const probe = createServer();
const dbg = await new Promise(resolve => probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${dbg}`, `--user-data-dir=${OUT}/profile`, 'about:blank'], {stdio: 'ignore'});
let cdp;
try {
  cdp = await connect(dbg);
  const {targetId} = await cdp.send('Target.createTarget', {url: 'about:blank'}, false);
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true}, false);
  cdp.session = sessionId;
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const go = async (path = '/goals') => { await cdp.send('Page.navigate', {url: `http://127.0.0.1:${port}${path}`}); await sleep(500); };
  const click = async sel => { await cdp.eval(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(100); };
  const value = async (sel, val) => cdp.eval(`document.querySelector(${JSON.stringify(sel)}).value = ${JSON.stringify(val)}`);
  const test = async expr => cdp.eval(expr);
  const submit = async form => { await cdp.eval(`document.querySelector(${JSON.stringify(form)}).requestSubmit()`); await sleep(200); };
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false});
  await go();
  ok('team tab shows only shared goals', await test(`document.querySelectorAll('.goal-card').length === 1 && document.querySelector('.goal-card').textContent.includes('450')`));
  ok('goal creation has moved off the progress page', await test(`!document.querySelector('#goal-new')`));
  ok('admin has a link in the main header', await test(`!document.querySelector('#admin-nav-item').hidden && document.querySelector('#admin-nav-item a').getAttribute('href') === '/admin'`));
  await go('/admin');
  await click('[data-tab="goals-tab"]');
  ok('Goals opens its own admin tab', await test(`!document.querySelector('#editor').hidden && !document.querySelector('#goals-tab').hidden && document.querySelector('#sheet-tab').hidden`));
  ok('Admin is marked as the current header page', await test(`document.querySelector('#admin-nav-item a').getAttribute('aria-current') === 'page'`));
  await click('#goal-new');
  await value('#goal-form [name=title]', 'Squats challenge');
  await value('#goal-form [name=target]', '50');
  await value('#goal-form [name=scope]', 'player');
  await cdp.eval(`document.querySelector('#goal-form [name=scope]').dispatchEvent(new Event('change'))`);
  await value('#goal-form [name=unit]', 'reps');
  await click('#goal-next-week');
  await submit('#goal-form');
  ok('weekly individual goal sends correct player, dates and target', saved[0].player_id === 'pl-02' && saved[0].starts_on === '2026-10-19' && saved[0].ends_on === '2026-10-25' && saved[0].target === 50);
  ok('admin sees confirmation after saving', await test(`!document.querySelector('#goal-editor').open && document.querySelector('#admin-goals-status').textContent.includes('Goal saved')`));
  await go();
  await click('.goal-card button.link');
  await value('#goal-form [name=target]', '1200');
  await submit('#goal-form');
  ok('existing goals can still be edited', goals[0].target === 1200 && await test(`document.querySelector('.goal-card').textContent.includes('1,200')`));
  await click('[data-scope=player]');
  ok('individual goals stay separate from team', await test(`document.querySelectorAll('.goal-card').length === 3 && !document.querySelector('#goal-grid').textContent.includes('off-ice')`));
  await click('[data-scope=team]');
  await click('#shot-ten'); await click('#shot-add'); await click('#shot-undo');
  ok('counter supports increments and undo', await test(`document.querySelector('#shot-count').textContent === '10'`));
  await click('#shot-save');
  ok('shot tool selects only shot goals', await test(`document.querySelector('#goal-log [name=goal_id]').options.length === 1 && document.querySelector('#goal-log [name=amount]').value === '10'`));
  failSave = true; await submit('#goal-log-form');
  const key = saved.at(-1).client_id;
  ok('failed save keeps tool and form intact', await test(`document.querySelector('#goal-log').open && document.querySelector('#shot-count').textContent === '10' && document.querySelector('#goal-log .goal-error').textContent.includes('interrupted')`));
  failSave = false; await submit('#goal-log-form');
  ok('retry uses same activity key and counts only once', saved.at(-1).client_id === key && goals[0].total === 460);
  ok('successful save clears logged shots', await test(`!document.querySelector('#goal-log').open && document.querySelector('#shot-count').textContent === '0'`));
  await click('#timer-toggle'); await sleep(1200); await click('#timer-toggle');
  ok('timer measures elapsed time', await test(`document.querySelector('#timer-count').textContent !== '00:00'`));
  await click('#timer-save'); await submit('#goal-log-form');
  ok('timer saves whole seconds to timed goal', saved.at(-1).amount >= 1 && goals[2].total >= 1 && goals[0].total === 460);
  // Literal title text must not create markup.
  goals[0].title = '<img src=x onerror=alert(1)>';
  admin = false; await go();
  ok('family cannot see admin controls or header link', await test(`!document.querySelector('#goal-new') && !document.querySelector('#goal-grid').textContent.includes('Edit goal') && document.querySelector('#admin-nav-item').hidden`));
  ok('titles rendered as text', await test(`!document.querySelector('.goal-card img') && document.querySelector('.goal-card h2').textContent.includes('<img')`));
  goals[0].title = '1,000 off-ice shots'; await go();
  ok('family sees their contribution', await test(`document.querySelector('#goal-grid').textContent.includes('Your contribution: 60 shots')`));
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await sleep(150);
  ok('mobile page fits viewport', await test(`document.documentElement.scrollWidth <= innerWidth`));
  const {data} = await cdp.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
  await writeFile(path.join(OUT, 'goals-mobile.png'), Buffer.from(data, 'base64'));
  await click('.goal-card button');
  ok('mobile logging dialog fits viewport', await test(`document.querySelector('#goal-log').getBoundingClientRect().right <= innerWidth`));
  await click('#goal-log [data-close]');
  failLoad = true; await go();
  ok('load errors offer retry', await test(`!document.querySelector('#goals-retry').hidden`));
  failLoad = false; await click('#goals-retry');
  ok('retry restores board', await test(`!document.querySelector('#goals-content').hidden`));
  signedOut = true; await go();
  ok('signed-out goals are gated', await test(`!document.querySelector('#goals-gate').hidden && document.querySelector('#goals-content').hidden`));
  ok('signed-out header hides Admin', await test(`document.querySelector('#admin-nav-item').hidden`));
  admin = true; await go('/admin');
  await value('#login [name=email]', 'admin@example.com');
  await value('#login [name=password]', 'test-password');
  await submit('#login');
  ok('signing in updates the header without a page reload', await test(`!document.querySelector('#admin-nav-item').hidden`));
  await click('[data-tab="goals-tab"]');
  await click('.menu-toggle');
  ok('mobile menu includes Admin and fits the viewport', await test(`document.querySelector('#admin-nav-item a').getBoundingClientRect().height > 0 && document.documentElement.scrollWidth <= innerWidth`));
  await click('.menu-toggle');
  await click('#goal-new');
  ok('admin goal form fits the mobile viewport', await test(`document.querySelector('#goal-editor').open && document.querySelector('#goal-editor').getBoundingClientRect().right <= innerWidth`));
  await click('#goal-editor [data-close]');
  await click('[data-tab="sheet-tab"]');
  await click('#editor [data-logout]');
  ok('signing out hides the header link immediately', await test(`document.querySelector('#admin-nav-item').hidden && document.querySelector('#editor').hidden`));

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed\nScreenshots: ${OUT}`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
} finally {
  cdp?.ws.close(); chrome.kill('SIGKILL'); server.close();
}
