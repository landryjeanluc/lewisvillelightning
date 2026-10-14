#!/usr/bin/env node
/** Fullscreen viewing/editing against local fixtures, including iPhone fallback. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = createRequire(path.join(root, 'site/package.json'))('playwright-core');
const dist = path.join(root, 'site/dist');
const play = { id: 1, slug: 'test-play', title: 'Test breakout', category: 'breakout', surface: 'full', status: 'published',
  diagram: { v: 1, steps: [{ id: 's1', caption: 'Retrieve the puck', duration: 5000 }, { id: 's2', caption: 'Pass up the wall', duration: 5000 }],
    tokens: [{ id: 't1', kind: 'us', x: 40, y: 40 }], paths: [{ id: 'p1', kind: 'skate', tokenId: 't1', step: 0, points: [{ x: 40, y: 40 }, { x: 70, y: 50 }] }], notes: [], pen: [] } };
const saved = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/auth/me') return json({ id: 1, role: 'admin', display_name: 'Test Coach' });
    if (url.pathname === '/api/plays' && req.method === 'GET') return json([play]);
    if (url.pathname === '/api/plays' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); saved.push(body); return json({ ...body, id: 2, slug: 'new-play' });
    }
    return json([]);
  }
  try {
    let relative = decodeURIComponent(url.pathname);
    if (!path.extname(relative)) relative = relative.replace(/\/$/, '') + '/index.html';
    const filename = path.join(dist, relative);
    if (!filename.startsWith(dist + path.sep)) return res.writeHead(403).end();
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ttf': 'font/ttf' };
    const body = await readFile(filename); res.writeHead(200, { 'content-type': types[path.extname(filename)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
// No native HTML fullscreen, as on phones that need the viewport fallback.
await context.addInitScript(() => Object.defineProperty(document, 'fullscreenEnabled', { value: false }));
const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
let count = 0;
async function check(name, fn) { await fn(); count++; console.log('  PASS  ' + name); }
const reveal = () => page.locator('#pl-stage').tap();
const hidden = () => page.locator('#pl-workspace.play-controls-hidden').waitFor();
const entered = id => page.locator(`#${id}.is-play-fullscreen`).waitFor();
try {
  await check('phone full-screen button opens a viewport-sized rink and isolates the page', async () => {
    await page.goto(base + '/plays?p=test-play'); await page.locator('#pl-stage svg').waitFor();
    await page.evaluate(() => { window.originalSvg = document.querySelector('#pl-stage svg'); });
    await page.locator('#pl-fullscreen').tap(); await entered('pl-workspace');
    const box = await page.locator('#pl-workspace').boundingBox();
    assert.deepEqual(box, { x: 0, y: 0, width: 390, height: 844 });
    assert.equal(await page.locator('.site-head').evaluate(el => el.inert), true);
    assert.equal(await page.locator('#pl-fullscreen').getAttribute('aria-label'), 'Exit full screen');
    await page.screenshot({ path: '/tmp/lvlnb-viewer-fullscreen.png' });
  });
  await check('viewer controls hide after inactivity and tapping the ice brings them back', async () => {
    await hidden(); assert.equal(await page.locator('#pl-play').isVisible(), false);
    assert.equal(await page.locator('.play-viewer-controls').evaluate(el => el.inert), true);
    await reveal(); assert.equal(await page.locator('#pl-play').isVisible(), true);
    assert.equal(await page.locator('.play-viewer-controls').evaluate(el => el.inert), false);
    await hidden();
    // Assistive technology can activate this even while the visual controls hide.
    await page.locator('.play-show-controls').evaluate(el => el.click());
    assert.equal(await page.locator('#pl-play').isVisible(), true);
    assert.equal(await page.locator('#pl-fullscreen').evaluate(el => el === document.activeElement), true);
  });
  await check('playback continues with controls hidden and keyboard users keep controls visible', async () => {
    await page.locator('#pl-play').tap();
    await hidden(); const first = await page.locator('#pl-scrub').getAttribute('aria-valuenow');
    await page.waitForTimeout(350); assert.ok(Number(await page.locator('#pl-scrub').getAttribute('aria-valuenow')) > Number(first));
    await page.keyboard.press('Tab'); await page.waitForTimeout(3200);
    assert.equal(await page.locator('#pl-play').isVisible(), true);
    await page.locator('#pl-play').tap();
    await page.locator('#pl-scrub').focus(); await page.keyboard.press('End');
    assert.equal(await page.locator('#pl-scrub').getAttribute('aria-valuenow'), '100');
  });
  await check('landscape and narrow phones fill the viewport without horizontal overflow', async () => {
    for (const viewport of [{ width: 844, height: 390 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(h => document.querySelector('#pl-workspace').getBoundingClientRect().height === h, viewport.height);
      const box = await page.locator('#pl-stage').boundingBox();
      assert.equal(box.width, viewport.width); assert.equal(box.height, viewport.height);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await reveal(); const exit = await page.locator('#pl-fullscreen').boundingBox(); assert.ok(exit.x >= 0 && exit.x + exit.width <= viewport.width);
    }
    await page.setViewportSize({ width: 844, height: 390 }); await reveal(); await hidden();
    await page.screenshot({ path: '/tmp/lvlnb-viewer-landscape.png' });
  });
  await check('Escape restores scrolling, focus and the original SVG without resetting the play', async () => {
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pl-workspace').evaluate(el => el.classList.contains('is-play-fullscreen')), false);
    assert.deepEqual(await page.evaluate(() => ({sameSvg: document.querySelector('#pl-stage svg') === window.originalSvg, bodyStyle: document.body.style.cssText})), {sameSvg: true, bodyStyle: ''});
    assert.equal(await page.locator('.site-head').evaluate(el => el.inert), false);
    assert.equal(await page.locator('#pl-fullscreen').evaluate(el => document.activeElement === el), true);
    assert.equal(await page.locator('#pl-scrub').getAttribute('aria-valuenow'), '100');
  });
  await check('browser back leaves fullscreen cleanly and returns to the play list', async () => {
    await page.goto(base + '/plays'); await page.locator('.pl-card').click(); await page.locator('#pl-fullscreen').tap();
    await page.goBack(); await page.locator('#pl-index').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.body.style.position), '');
    assert.equal(await page.locator('.site-head').evaluate(el => el.inert), false);
  });
  await check('editor keeps tools visible after inactivity and draws at the right coordinates', async () => {
    await page.setViewportSize({ width: 844, height: 390 }); await page.goto(base + '/admin');
    await page.locator('[data-tab="plays-tab"]').click(); await page.locator('#pe-stage svg').waitFor();
    await page.locator('#pe-fullscreen').tap(); await entered('pe-workspace');
    await page.waitForTimeout(3300);
    assert.equal(await page.locator('#pe-tools').isVisible(), true); assert.equal(await page.locator('#pe-fullscreen').isVisible(), true);
    const toolBox = await page.locator('#pe-tools').boundingBox(), rinkBox = await page.locator('#pe-stage').boundingBox();
    assert.ok(rinkBox.y >= toolBox.y + toolBox.height && rinkBox.y + rinkBox.height <= 390, 'rink fits below toolbar');
    await page.locator('[data-tool="us"]').tap();
    const point = await page.locator('#pe-stage svg').evaluate(svg => { const p = new DOMPoint(60, 40).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y }; });
    await page.touchscreen.tap(point.x, point.y);
    assert.equal(await page.locator('#pe-stage .pl-token').count(), 1);
    assert.match(await page.locator('#pe-stage .pl-token').getAttribute('transform'), /translate\(60[\d.]*[ ,]+40[\d.]*\)/);
    await page.screenshot({ path: '/tmp/lvlnb-editor-landscape.png' });
  });
  await check('editor tools stay pinned while settings scroll and every tool remains reachable', async () => {
    await page.locator('#pe-title').fill('Fullscreen draft');
    const tools = await page.locator('#pe-tools').boundingBox(); assert.ok(tools.y >= 0 && tools.y + tools.height <= 390);
    await page.locator('[data-tool="erase"]').tap(); assert.equal(await page.locator('[data-tool="erase"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#pe-caption').fill('A caption made in fullscreen');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.pe-grid').evaluate(el => el.scrollTop = 0);
    await page.waitForTimeout(150);
    await page.screenshot({ path: '/tmp/lvlnb-editor-fullscreen.png' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
  await check('editor preview never auto-hides menus and exiting preserves unsaved work', async () => {
    await page.locator('#pe-preview').tap(); await page.waitForTimeout(3300);
    assert.equal(await page.locator('#pe-tools').isVisible(), true); assert.equal(await page.locator('#pe-fullscreen').isVisible(), true);
    await page.locator('#pe-preview').tap(); await page.locator('#pe-fullscreen').tap();
    assert.equal(await page.locator('#pe-title').inputValue(), 'Fullscreen draft');
    assert.equal(await page.locator('#pe-caption').inputValue(), 'A caption made in fullscreen');
    assert.equal(await page.locator('#pe-stage .pl-token').count(), 1);
    await page.locator('#pe-save').click(); await page.waitForFunction(() => document.querySelector('#pe-status-line').textContent.includes('Saved'));
    assert.equal(saved.at(-1).diagram.tokens.length, 1); assert.equal(saved.at(-1).diagram.steps[0].caption, 'A caption made in fullscreen');
  });
  await check('desktop native fullscreen exits through the browser and keeps controls visible', async () => {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    desktop.on('pageerror', e => errors.push(e.message));
    await desktop.goto(base + '/plays?p=test-play'); await desktop.locator('#pl-fullscreen').click();
    await desktop.waitForFunction(() => document.fullscreenElement?.id === 'pl-workspace');
    await desktop.waitForTimeout(3300); assert.equal(await desktop.locator('#pl-play').isVisible(), true);
    await desktop.evaluate(() => document.exitFullscreen());
    await desktop.waitForFunction(() => !document.querySelector('#pl-workspace').classList.contains('is-play-fullscreen'));
    assert.equal(await desktop.locator('.site-head').evaluate(el => el.inert), false); await desktop.close();
  });
  await check('a rejected native request still opens the usable fallback', async () => {
    const denied = await browser.newPage({ serviceWorkers: 'block' });
    await denied.addInitScript(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('Denied')); });
    await denied.goto(base + '/plays?p=test-play'); await denied.locator('#pl-fullscreen').click();
    await denied.locator('#pl-workspace.is-play-fullscreen').waitFor();
    assert.equal(await denied.evaluate(() => document.fullscreenElement), null);
    await denied.locator('#pl-fullscreen').click(); assert.equal(await denied.evaluate(() => document.body.style.position), '');
    await denied.close();
  });
  await check('fullscreen produces no browser exceptions', async () => assert.deepEqual(errors, []));
  console.log(`\n${count}/${count} fullscreen browser checks passed`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
