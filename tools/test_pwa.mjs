#!/usr/bin/env node
/**
 * The install button, in a real browser.
 *
 * "Add to Home Screen" is a contract between four files that never import each
 * other — the manifest, the icons, the service worker and the head of two
 * layouts — and the failure mode is silent: the button is simply never offered,
 * on a phone, to a parent who will not report it. So this serves `site/dist`,
 * drives headless chromium, and checks the contract end to end: the manifest
 * parses and every icon it promises exists at the size it claims, the worker
 * registers and takes control, the card appears for a browser that can install
 * and hides inside the installed app, the iPhone path falls back to the Share
 * sheet instructions, and the cache keeps its hands off team data.
 *
 *   cd site && npm run build
 *   node tools/test_pwa.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(ROOT, "site", "dist");
const CHROME = process.env.CHROME_PATH || "chromium";

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ttf": "font/ttf", ".json": "application/json", ".ico": "image/x-icon",
  ".webp": "image/webp", ".webmanifest": "application/manifest+json",
};

const results = [];
const ok = (name, cond, extra = "") => {
  results.push(!!cond);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- static -- */
// The same shape of server render/ and the plays harness use: dist on disk,
// directory URLs resolved to index.html.
function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
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
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  }
  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.eval("new Promise(r => document.readyState === 'complete' ? r(1) : addEventListener('load', () => r(1)))");
  }
}

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

/* ------------------------------------------------- the files, off disk -- */
const read = (p) => readFile(path.join(DIST, p));

const manifestRaw = await read("manifest.webmanifest").catch(() => null);
if (!manifestRaw) {
  console.error("site/dist has no manifest.webmanifest — run `npm run build` in site/ first.");
  process.exit(1);
}

console.log("manifest and icons");
let manifest = null;
try { manifest = JSON.parse(manifestRaw.toString()); } catch { /* reported below */ }
ok("the manifest is valid JSON", manifest !== null);
ok("start_url and scope cover the whole site", manifest?.start_url === "/" && manifest?.scope === "/");
ok("display is standalone", manifest?.display === "standalone");
ok("it declares a maskable icon", manifest?.icons?.some((i) => i.purpose === "maskable"),
   "— without one Android crops the crest into a white square");

// A manifest that names an icon the build does not ship is the single most
// common way an install prompt disappears, and nothing warns about it.
for (const icon of manifest?.icons ?? []) {
  const buf = await read(icon.src.replace(/^\//, "")).catch(() => null);
  // IHDR: width and height are big-endian 32-bit at byte 16 and 20.
  const size = buf && `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
  ok(`${icon.src} exists at ${icon.sizes}`, size === icon.sizes, size ? `(${size})` : "(missing)");
}
const apple = await read("icons/apple-touch-icon.png").catch(() => null);
ok("the apple-touch-icon exists", apple !== null, "— iOS uses this one, not the manifest");

const home = (await read("index.html")).toString();
const login = (await read("login/index.html")).toString();
for (const [name, html] of [["the home page", home], ["the sign-in page", login]]) {
  ok(`${name} links the manifest`, /rel="manifest"/.test(html));
  ok(`${name} links the apple-touch-icon`, /rel="apple-touch-icon"/.test(html));
  ok(`${name} carries the install card`, /data-install\b/.test(html));
}

/* ----------------------------------------------------------- in chromium -- */
const { server, port } = await serve();
const base = `http://127.0.0.1:${port}`;   // a loopback origin is a secure one,
                                           // so service workers are allowed
const dbg = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${dbg}`, "--window-size=420,900", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

try {
  const cdp = await connect(dbg);
  const { targetInfos } = await cdp.send("Target.getTargets", {}, false);
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, false);
  cdp.session = sessionId;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  console.log("\nthe worker");
  await cdp.goto(base + "/");
  // Registration, activation and clients.claim() all land after load. Polling
  // for the end state is the difference between testing the worker and testing
  // how fast this machine is.
  const sw = await cdp.eval(`(async () => {
    const reg = await navigator.serviceWorker.ready;
    for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++)
      await new Promise(r => setTimeout(r, 50));
    return { scope: reg.scope, state: reg.active?.state, controlled: !!navigator.serviceWorker.controller };
  })()`);
  ok("the service worker activates", sw?.state === "activated", sw?.state ?? "never ready");
  ok("its scope is the whole site", sw?.scope?.endsWith("/"), sw?.scope);

  // clients.claim() means the page that registered it is controlled without a
  // reload — which is what lets the first visit install.
  ok("it controls the page that registered it", sw?.controlled);

  console.log("\nwhat it caches");
  await cdp.eval(`(async () => {
    await fetch('/fonts/BarlowCondensed-Black.ttf');
    await fetch('/photos/Hugo Landry.webp');
    await fetch('/roster/');
  })()`);
  await sleep(300);   // stale-while-revalidate fills the cache behind the answer
  const cached = await cdp.eval(`caches.open('lvlnb-static-v1')
    .then(c => c.keys()).then(ks => ks.map(r => new URL(r.url).pathname))`);
  ok("a font is cached", cached.some((p) => p.startsWith("/fonts/")), cached.join(" "));
  ok("a player photo is NOT cached", !cached.some((p) => p.startsWith("/photos/")),
     "— the roster is nineteen minors behind a login");
  ok("a page is NOT cached", !cached.some((p) => p.endsWith("/") || p.endsWith(".html")));

  console.log("\nthe card");
  const card = await cdp.eval(`(() => {
    const el = document.querySelector('[data-install]');
    return { hidden: el.hidden, label: el.querySelector('[data-install-button]').textContent.trim() };
  })()`);
  ok("it is visible in a browser", card.hidden === false);
  ok("the button offers an install", /install/i.test(card.label), card.label);

  // Inside the installed app the same card would be an invitation to install
  // something you are already looking at. Chromium cannot emulate
  // `display-mode: standalone` — not through setEmulatedMedia and not through
  // --app in headless — so the browser's answer to the one question the card
  // asks is stubbed instead, before the page script runs.
  const stub = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => q.includes('display-mode: standalone')
        ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
        : real(q);
    })()`,
  });
  await cdp.goto(base + "/");
  ok("it stays hidden inside the installed app",
     await cdp.eval(`document.querySelector('[data-install]').hidden`));
  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: stub.identifier });

  console.log("\nthe iPhone path");
  // iOS has no beforeinstallprompt and never will; the button has to teach the
  // Share-sheet gesture instead of pretending it can install anything.
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 "
             + "(KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  });
  await cdp.goto(base + "/");
  const ios = await cdp.eval(`(() => {
    const el = document.querySelector('[data-install]');
    const btn = el.querySelector('[data-install-button]');
    btn.click();
    const dialog = document.querySelector('[data-install-how]');
    const steps = [...dialog.querySelectorAll('.ins-steps')]
      .filter(s => getComputedStyle(s).display !== 'none')
      .map(s => s.dataset.steps);
    return { hidden: el.hidden, label: btn.textContent.trim(), open: dialog.open, steps };
  })()`);
  ok("the card still shows on an iPhone", ios.hidden === false);
  ok("the button says how, not install", /how/i.test(ios.label), ios.label);
  ok("tapping it opens the instructions", ios.open === true);
  ok("and they are the Safari Share-sheet steps", ios.steps.join() === "ios", ios.steps.join() || "none shown");

  await cdp.goto(base + "/login");
  ok("the sign-in page shows the compact card",
     await cdp.eval(`(() => { const el = document.querySelector('[data-install]');
       return !el.hidden && el.classList.contains('ins--compact'); })()`),
     "— the only page a parent sees before they have a password");
} finally {
  chrome.kill();
  server.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
