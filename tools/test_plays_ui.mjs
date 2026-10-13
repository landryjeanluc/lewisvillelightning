#!/usr/bin/env node
/**
 * The plays board, driven in a real browser.
 *
 * The editor is a drawing tool: almost nothing it does can be checked without
 * a layout engine and a pointer. So this serves `site/dist` with a stub API,
 * drives headless chromium over the DevTools protocol, and plays the coach —
 * drops pieces, drags lines, adds a step, saves, undoes, previews — then
 * asserts on what the page did and on the document it sent to the server.
 *
 * It has already earned its keep twice: undo silently replaced the editor's
 * document without telling the stage, and a zone diagram painted the next zone
 * along into the leftover space beside it. Neither is visible from a unit test.
 *
 *   npm run build            # in site/, the dist it drives
 *   node tools/test_plays_ui.mjs [--shots <dir>]
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(ROOT, "site", "dist");
const shotArg = process.argv.indexOf("--shots");
const OUT = shotArg === -1
  ? await mkdtemp(path.join(tmpdir(), "lvlnb-plays-"))
  : process.argv[shotArg + 1];
const CHROME = process.env.CHROME_PATH || "chromium";

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ttf": "font/ttf", ".json": "application/json", ".ico": "image/x-icon",
  ".webp": "image/webp",
};

/* ------------------------------------------------------------- stub API -- */
// Just enough of /api to boot the admin page and the plays board. Everything
// the API itself promises is covered by api/test_plays.py against real
// Postgres; what is being tested here is the browser half.
let nextId = 10;
let signedOut = false;
let failWrites = false;
const saved = [];
const store = [{
  id: 1, slug: "wheel-breakout", title: "Wheel breakout",
  subtitle: "Out clean under forecheck pressure", category: "breakout",
  surface: "dzone", status: "published", week_of: "2026-10-12",
  game_id: "g-2026-10-15-dieppe", published_at: "2026-10-12T12:00:00Z",
  updated_at: "2026-10-12T12:00:00Z", author: "Coach",
  diagram: {
    v: 1,
    steps: [
      { id: "s1", caption: "D1 retrieves behind the net", duration: 1200 },
      { id: "s2", caption: "Rim it to the wall", duration: 1000 },
      { id: "s3", caption: "LW chips it out to centre", duration: 1200 },
    ],
    tokens: [
      { id: "t1", kind: "us", x: 18, y: 52, label: "D1" },
      { id: "t2", kind: "us", x: 24, y: 12, label: "LW" },
      { id: "t3", kind: "us", x: 48, y: 42, label: "C" },
      { id: "t4", kind: "them", x: 26, y: 40, label: "F1" },
      { id: "t5", kind: "goalie", x: 13, y: 42.5, label: "" },
      { id: "t6", kind: "puck", x: 18, y: 54 },
    ],
    paths: [
      { id: "p1", kind: "skate", step: 0, tokenId: "t1",
        points: [{ x: 18, y: 52 }, { x: 14, y: 42 }, { x: 18, y: 30 }] },
      { id: "p2", kind: "skate", step: 0, tokenId: "t6",
        points: [{ x: 18, y: 54 }, { x: 14, y: 43 }, { x: 18, y: 31 }] },
      { id: "p3", kind: "pass", step: 1, tokenId: "t6",
        points: [{ x: 18, y: 31 }, { x: 22, y: 16 }, { x: 24, y: 13 }] },
      { id: "p4", kind: "backward", step: 1, tokenId: "t4",
        points: [{ x: 26, y: 40 }, { x: 34, y: 34 }] },
      { id: "p5", kind: "pass", step: 2, tokenId: "t6",
        points: [{ x: 24, y: 13 }, { x: 40, y: 30 }, { x: 48, y: 41 }] },
    ],
    notes: [{ id: "n1", step: 0, x: 40, y: 70, text: "weak side stays high" }],
    pen: [],
  },
}];

function api(req, res, body) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/^\/api/, "");
  const json = (code, v) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(v));
  };
  // Control routes first: once the gate is on it would answer 401 to the very
  // request that turns it off.
  if (p === "/__signout") { signedOut = url.searchParams.get("v") === "1"; return json(200, { signedOut }); }
  if (p === "/__fail") { failWrites = url.searchParams.get("v") === "1"; return json(200, { failWrites }); }
  if (failWrites && req.method !== "GET") return json(400, { detail: "nope" });
  if (p === "/__saved") return json(200, saved);
  // With the gate on, the stub behaves like the real API does for a stranger.
  if (signedOut) return json(401, { detail: "sign in to see the plays" });
  if (p === "/auth/me") return json(200, { id: 1, email: "coach@lvlnb.ca", display_name: "Coach", role: "admin" });
  if (p === "/plays" && req.method === "GET") return json(200, store);
  if (p === "/plays" && req.method === "POST") {
    const v = JSON.parse(body);
    saved.push(v);
    const row = { ...v, id: nextId++, slug: "new-play", author: "Coach", published_at: null, updated_at: new Date().toISOString() };
    store.push(row);
    return json(201, row);
  }
  if (p.startsWith("/plays/") && req.method === "PUT") {
    const v = JSON.parse(body); saved.push(v);
    return json(200, { id: Number(p.split("/")[2]), slug: "new-play", title: v.title, status: v.status });
  }
  if (p.startsWith("/plays/") && req.method === "GET") {
    const row = store.find((x) => x.slug === p.split("/")[2]);
    return row ? json(200, row) : json(404, { detail: "no" });
  }
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

/* ----------------------------------------------------------------- main -- */
const results = [];
const ok = (name, cond, extra = "") => {
  results.push(!!cond);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

await mkdir(OUT, { recursive: true });
if (!(await readFile(path.join(DIST, "plays", "index.html")).catch(() => null))) {
  console.error("site/dist has no /plays — run `npm run build` in site/ first.");
  process.exit(1);
}

const { server, port } = await serve();
const base = `http://127.0.0.1:${port}`;
// Ask the OS for a free debug port rather than hard-coding one: a run that is
// interrupted leaves its browser behind, and a fixed port means the next run
// silently attaches to that stale browser instead of its own.
const dbg = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${dbg}`, "--window-size=1600,1200", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

try {
  const cdp = await connect(dbg);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }, false);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, false);
  cdp.session = sessionId;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false,
  });

  const shot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(OUT, name), Buffer.from(data, "base64"));
  };
  const goto = async (url) => {
    await cdp.send("Page.navigate", { url });
    await sleep(900);
  };

  /* ----------------------------------------------------- the plays page -- */
  await goto(`${base}/plays`);
  ok("the index lists the published play",
     await cdp.eval(`document.querySelectorAll(".pl-card").length`) === 1);
  ok("each card draws a real rink",
     await cdp.eval(`document.querySelectorAll(".pl-card .rk-boards").length`) === 1);
  await shot("01-plays-index.png");

  await cdp.eval(`document.querySelector(".pl-card").click()`);
  await sleep(400);
  ok("opening a play pushes its slug into the url",
     (await cdp.eval(`location.search`)) === "?p=wheel-breakout");
  ok("a play tied to a fixture names it",
     (await cdp.eval(`document.querySelector("#pl-d-meta").textContent`)).includes("Aigles")
     || (await cdp.eval(`document.querySelector("#pl-d-meta").textContent`)).includes("For "),
     await cdp.eval(`document.querySelector("#pl-d-meta").textContent`));
  ok("the step captions are listed",
     await cdp.eval(`document.querySelectorAll(".pl-step").length`) === 3);
  ok("the board drew every line",
     await cdp.eval(`document.querySelectorAll("#pl-stage .pl-path").length`) === 5);
  ok("the pass line keeps its dashes",
     await cdp.eval(
       `getComputedStyle(document.querySelector("#pl-stage .pl-path-pass")).strokeDasharray`
     ).then?.((v) => v) ?? true);

  const dash = await cdp.eval(
    `getComputedStyle(document.querySelector("#pl-stage .pl-path-pass")).strokeDasharray`);
  ok("the pass line is still dashed, not borrowed for the reveal",
     /\d/.test(dash) && dash !== "none", dash);

  const before = await cdp.eval(
    `document.querySelector('#pl-stage .pl-token[data-id="t1"]').getAttribute("transform")`);
  await cdp.eval(`document.querySelector("#pl-play").click()`);
  await sleep(600);
  const mid = await cdp.eval(
    `document.querySelector('#pl-stage .pl-token[data-id="t1"]').getAttribute("transform")`);
  ok("a piece actually skates its route", before !== mid, `${before} -> ${mid}`);
  const revealed = await cdp.eval(
    `document.querySelector('#pl-stage .pl-reveal[data-reveal="p1"]').style.strokeDashoffset`);
  ok("its line is drawing itself on", Number(revealed) > 0, `offset ${revealed}`);
  await shot("02-plays-midplay.png");

  await sleep(3200);
  ok("the play reaches its last step",
     (await cdp.eval(`document.querySelector("#pl-count").textContent`)) === "Step 3 of 3",
     await cdp.eval(`document.querySelector("#pl-count").textContent`));
  await shot("03-plays-finished.png");

  // signed out: the page must ask for a login rather than look broken
  await fetch(`${base}/api/__signout?v=1`);
  await goto(`${base}/plays`);
  ok("a stranger is asked to sign in",
     await cdp.eval(`!document.querySelector("#pl-gate").hidden`));
  ok("and is not told the board is broken",
     await cdp.eval(`document.querySelector("#pl-loading").hidden`));
  await fetch(`${base}/api/__signout?v=0`);

  /* --------------------------------------------------------- the editor -- */
  await goto(`${base}/admin`);
  await cdp.eval(`localStorage.clear(); true`);   // no draft left from a prior run
  await cdp.eval(`[...document.querySelectorAll(".tab")].find(b => b.dataset.tab === "plays-tab").click()`);
  await sleep(500);
  ok("the editor mounts when its tab opens",
     await cdp.eval(`!!document.querySelector("#pe-stage svg")`));
  ok("the editor's rink has its markings",
     await cdp.eval(`document.querySelectorAll("#pe-stage .rk-red-line").length`) > 4);

  // rink feet -> viewport pixels, the inverse of the editor's own mapping
  await cdp.eval(`window.__at = (x, y) => {
    const svg = document.querySelector("#pe-stage svg");
    const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM());
    return { x: p.x, y: p.y };
  }; true`);
  const at = async (x, y) => cdp.eval(`JSON.stringify(window.__at(${x}, ${y}))`).then(JSON.parse);
  const pick = async (toolName) =>
    cdp.eval(`document.querySelector('#pe-tools [data-tool="${toolName}"]').click()`);
  const tap = async (x, y) => {
    const p = await at(x, y);
    await cdp.mouse("mousePressed", p.x, p.y);
    await cdp.mouse("mouseReleased", p.x, p.y);
    await sleep(90);
  };
  const dragTo = async (from, pts) => {
    const a = await at(from[0], from[1]);
    await cdp.mouse("mousePressed", a.x, a.y);
    for (const [x, y] of pts) {
      const p = await at(x, y);
      await cdp.mouse("mouseMoved", p.x, p.y);
      await sleep(16);
    }
    const last = await at(pts.at(-1)[0], pts.at(-1)[1]);
    await cdp.mouse("mouseReleased", last.x, last.y);
    await sleep(120);
  };

  await pick("us");    await tap(60, 60);
  await pick("us");    await tap(95, 25);
  await pick("them");  await tap(80, 45);
  await pick("puck");  await tap(61, 62);
  ok("tapping the ice puts pieces down",
     await cdp.eval(`document.querySelectorAll("#pe-stage .pl-token").length`) === 4);

  await pick("skate");
  await dragTo([60, 60], [[70, 52], [80, 44], [92, 32]]);
  ok("dragging from a piece draws a line",
     await cdp.eval(`document.querySelectorAll("#pe-stage .pl-path").length`) === 1);

  await cdp.eval(`document.querySelector("#pe-addstep").click()`);
  await sleep(120);
  ok("a second step appears",
     await cdp.eval(`document.querySelectorAll(".pe-chip").length`) === 2);

  await pick("pass");
  await dragTo([92, 32], [[94, 29], [95, 26]]);
  await pick("pen");
  await dragTo([120, 20], [[128, 24], [134, 32], [128, 40], [120, 34], [120, 22]]);

  await cdp.eval(`
    document.querySelector("#pe-title").value = "Stretch out of the zone";
    document.querySelector("#pe-title").dispatchEvent(new Event("input", {bubbles:true}));
    document.querySelector("#pe-caption").value = "Winger pulls the D wide";
    document.querySelector("#pe-caption").dispatchEvent(new Event("input", {bubbles:true}));
    true`);
  await shot("04-editor.png");

  await cdp.eval(`document.querySelector("#pe-save").click()`);
  await sleep(500);
  const payloads = await (await fetch(`${base}/api/__saved`)).json();
  const sent = payloads.at(-1);
  ok("saving posts the whole document", !!sent, JSON.stringify(sent).slice(0, 60));
  ok("every piece made it into the payload", sent?.diagram?.tokens?.length === 4,
     String(sent?.diagram?.tokens?.length));
  ok("both lines made it", sent?.diagram?.paths?.length === 2,
     String(sent?.diagram?.paths?.length));
  ok("the first line is bound to the piece it started on",
     sent?.diagram?.paths?.[0]?.tokenId === sent?.diagram?.tokens?.[0]?.id);
  ok("the second line landed on the second step", sent?.diagram?.paths?.[1]?.step === 1,
     String(sent?.diagram?.paths?.[1]?.step));
  ok("the scribble was kept", sent?.diagram?.pen?.length === 1);
  ok("the caption was kept", sent?.diagram?.steps?.[1]?.caption === "Winger pulls the D wide",
     JSON.stringify(sent?.diagram?.steps));
  ok("the drawn line was simplified, not dumped raw",
     sent?.diagram?.paths?.[0]?.points?.length < 12,
     `${sent?.diagram?.paths?.[0]?.points?.length} points`);
  ok("every point is on the ice",
     sent?.diagram?.paths?.every((p) => p.points.every((q) =>
       q.x >= 0 && q.x <= 200 && q.y >= 0 && q.y <= 85)));

  // undo should peel the scribble back off — and must survive the save
  ok("saving does not throw away the undo history",
     await cdp.eval(`!document.querySelector("#pe-undo").disabled`));
  ok("saving leaves the board alone",
     await cdp.eval(`document.querySelectorAll("#pe-stage .pl-token").length`) === 4);
  ok("undo is available after drawing",
     await cdp.eval(`!document.querySelector("#pe-undo").disabled`));
  await cdp.eval(`document.querySelector("#pe-undo").click()`);
  await sleep(180);
  ok("undo takes the last thing back off the board",
     await cdp.eval(`document.querySelectorAll("#pe-stage .pl-pen").length`) === 0);
  await cdp.eval(`document.querySelector("#pe-undo").click()`);
  await sleep(180);
  ok("undo again removes the line before it",
     await cdp.eval(`document.querySelectorAll("#pe-stage .pl-path").length`) === 1);
  await cdp.eval(`document.querySelector("#pe-redo").click()`);
  await cdp.eval(`document.querySelector("#pe-redo").click()`);
  await sleep(220);
  ok("redo puts both back",
     await cdp.eval(`document.querySelectorAll("#pe-stage .pl-pen").length`) === 1
     && await cdp.eval(`document.querySelectorAll("#pe-stage .pl-path").length`) === 2);

  // A piece that already moved in an earlier step is pinned where that step
  // left it; one that has not moved can still be dragged.
  await pick("select");
  const pinned = await cdp.eval(`document.querySelector("#pe-stage .pl-us").getAttribute("transform")`);
  await dragTo([92, 32], [[88, 40], [84, 46]]);
  ok("a piece that already skated this play cannot be dragged off its route",
     (await cdp.eval(`document.querySelector("#pe-stage .pl-us").getAttribute("transform")`)) === pinned,
     pinned);

  const theirs = await cdp.eval(`document.querySelector("#pe-stage .pl-them").getAttribute("transform")`);
  await dragTo([80, 45], [[76, 56], [74, 62]]);
  const moved = await cdp.eval(`document.querySelector("#pe-stage .pl-them").getAttribute("transform")`);
  ok("a piece with no route yet can be dragged to a new spot", theirs !== moved, `${theirs} -> ${moved}`);

  await cdp.eval(`document.querySelector("#pe-preview").click()`);
  await sleep(700);
  await shot("05-editor-preview.png");
  ok("preview runs the play in the editor",
     await cdp.eval(`document.querySelector("#pe-stage").classList.contains("is-preview")`));
  await cdp.eval(`document.querySelector("#pe-preview").click()`);
  await sleep(200);

  /* ------------------------------------------------- a save that fails -- */
  // The thing that actually costs a coach his evening: fifteen minutes of
  // drawing, then the save is rejected. The work must survive it.
  await fetch(`${base}/api/__fail?v=1`);
  await pick("them");
  await tap(140, 30);
  const drawn = await cdp.eval(`document.querySelectorAll("#pe-stage .pl-token").length`);
  await cdp.eval(`document.querySelector("#pe-save").click()`);
  await sleep(500);

  const said = await cdp.eval(`document.querySelector("#pe-status-line").textContent`);
  ok("a rejected save says what the server said", said.includes("400"), said);
  ok("and says the drawing is not gone", /still here/i.test(said), said);
  const draft = await cdp.eval(`sessionStorage.getItem("lvlnb.play-draft.v1")`);
  ok("the work is written to the browser", !!draft && JSON.parse(draft).diagram.tokens.length === drawn,
     `${drawn} pieces`);

  await fetch(`${base}/api/__fail?v=0`);
  const dialogsBefore = cdp.dialogs;
  await goto(`${base}/admin`);
  ok("leaving with unsaved work warns first", cdp.dialogs > dialogsBefore,
     `${cdp.dialogs - dialogsBefore} prompt(s)`);
  await cdp.eval(`[...document.querySelectorAll(".tab")].find(b => b.dataset.tab === "plays-tab").click()`);
  await sleep(700);
  ok("after a reload the editor offers the work back",
     await cdp.eval(`!document.querySelector("#pe-draft").hidden`));
  ok("and says what it is holding",
     (await cdp.eval(`document.querySelector("#pe-draft-what").textContent`)).includes("Stretch out of the zone"),
     await cdp.eval(`document.querySelector("#pe-draft-what").textContent`));

  await cdp.eval(`document.querySelector("#pe-draft-restore").click()`);
  await sleep(400);
  ok("restoring puts every piece back on the board",
     await cdp.eval(`document.querySelectorAll("#pe-stage .pl-token").length`) === drawn,
     `${drawn} expected`);
  ok("and the lines with them",
     await cdp.eval(`document.querySelectorAll("#pe-stage .pl-path").length`) === 2);
  ok("and the name it was saved under",
     (await cdp.eval(`document.querySelector("#pe-title").value`)) === "Stretch out of the zone",
     await cdp.eval(`document.querySelector("#pe-title").value`));
  await shot("06-draft-restored.png");

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  console.log(`screenshots: ${OUT}`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
} finally {
  chrome.kill("SIGKILL");
  server.close();
}
