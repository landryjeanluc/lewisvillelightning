#!/usr/bin/env node
/**
 * Game-day graphics renderer.
 *
 * Serves the built Astro site and screenshots its /render/<format>/<id> routes
 * with headless chromium at 2x device scale. The poster therefore shares the
 * site's tokens, fonts, crests and Matchup component — there is no second
 * design system to keep in sync, and no model inventing the lettering.
 *
 *   node render/render.mjs --all
 *   node render/render.mjs --game g-2026-10-13-shediac
 *   node render/render.mjs --game <id> --formats poster,story
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = path.join(ROOT, "site", "dist");
const CHROME = process.env.CHROME_PATH || "chromium";

/** Canvas sizes must match FORMATS in src/pages/render/[format]/[id].astro. */
const FORMATS = {
  poster: { w: 1920, h: 1080, scale: 2 },  // -> 3840x2160
  story:  { w: 1080, h: 1920, scale: 2 },  // -> 2160x3840
  square: { w: 1080, h: 1080, scale: 2 },  // -> 2160x2160
};

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ttf": "font/ttf", ".woff2": "font/woff2", ".json": "application/json",
  ".ico": "image/x-icon",
};

function serve(dir) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(req.url.split("?")[0]);
        if (p.endsWith("/")) p += "index.html";
        if (!path.extname(p)) p += "/index.html";
        const file = path.join(dir, p);
        if (!file.startsWith(dir + path.sep)) { res.writeHead(403).end(); return; }
        const buf = await readFile(file);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        res.end(buf);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function shoot(url, out, { w, h, scale }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--force-color-profile=srgb", "--disable-lcd-text",
      `--force-device-scale-factor=${scale}`,
      `--window-size=${w},${h}`,
      `--screenshot=${out}`,
      url,
    ];
    const ch = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ch.stderr.on("data", (d) => (err += d));
    ch.on("close", (code) =>
      existsSync(out) ? resolve() : reject(new Error(`chromium exited ${code}\n${err.slice(-600)}`)),
    );
  });
}

/** Game ids available in the build, read straight off the generated routes. */
async function builtGames() {
  const dir = path.join(DIST, "render", "poster");
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
}

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};

if (!existsSync(DIST)) {
  console.error("site/dist not found — run `npm run build` in site/ first.");
  process.exit(1);
}

const formats = (flag("--formats", "poster,story,square")).split(",").map((s) => s.trim());
for (const f of formats) {
  if (!FORMATS[f]) { console.error(`unknown format "${f}" (want: ${Object.keys(FORMATS).join(", ")})`); process.exit(1); }
}

const all = await builtGames();
const one = flag("--game");
const targets = argv.includes("--all") ? all : one ? [one] : all.slice(0, 1);
if (!targets.length) { console.error("no games found in the build"); process.exit(1); }
for (const t of targets) {
  if (!all.includes(t)) { console.error(`game "${t}" is not in the build. Available:\n  ${all.join("\n  ")}`); process.exit(1); }
}

const { server, port } = await serve(DIST);
const base = `http://127.0.0.1:${port}`;
let n = 0;

for (const id of targets) {
  // date prefix from the id (g-YYYY-MM-DD-slug), else today
  const m = id.match(/(\d{4}-\d{2}-\d{2})/);
  const outDir = path.join(ROOT, "output", m ? m[1] : "undated");
  await mkdir(outDir, { recursive: true });

  for (const f of formats) {
    const spec = FORMATS[f];
    const out = path.join(outDir, `${id}-${f}.png`);
    const t0 = Date.now();
    await shoot(`${base}/render/${f}/${id}`, out, spec);
    const px = `${spec.w * spec.scale}x${spec.h * spec.scale}`;
    console.log(`  ✓ ${path.relative(ROOT, out)}  ${px}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    n++;
  }
}

server.close();
console.log(`\n${n} image${n === 1 ? "" : "s"} rendered for ${targets.length} game${targets.length === 1 ? "" : "s"}.`);
