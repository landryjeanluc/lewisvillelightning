import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { teamId, teamUrl, sanitize, extractPageData, belongsToTeamPage,
  isTeamResponse, digest, describeChanges, pageProblem } from './core.mjs';

process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const privateRoot = path.join(root, 'private/spordle');
const dataRoot = path.join(privateRoot, teamId);
const profileRoot = path.join(privateRoot, 'browser-profile');
const mode = process.argv[2] || 'status';
const headed = mode === 'setup' || process.argv.includes('--headed');

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  await fs.rename(temp, file);
}
async function setStatus(status, extra = {}) {
  await writeJson(path.join(dataRoot, 'status.json'), {
    teamId, sourceUrl: teamUrl, checkedAt: new Date().toISOString(), status,
    visibility: 'local_only', ...extra,
  });
}

async function collect() {
  await fs.mkdir(dataRoot, {recursive: true, mode: 0o700});
  const lock = path.join(privateRoot, 'collector.lock');
  let lockHandle;
  try { lockHandle = await fs.open(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another collector run holds the lock. Close it before starting another.');
    throw error;
  }
  await lockHandle.writeFile(String(process.pid));
  let context;
  let statusWritten = false;
  try {
    if (mode === 'sync' && !await readJson(path.join(privateRoot, 'setup.json'))) {
      throw new Error('Run setup first to establish and verify the dedicated browser session.');
    }
    await fs.mkdir(profileRoot, {recursive: true, mode: 0o700});
    context = await chromium.launchPersistentContext(profileRoot, {
      executablePath: process.env.SPORDLE_CHROMIUM || '/etc/profiles/per-user/jl/bin/chromium',
      headless: !headed, chromiumSandbox: true,
      acceptDownloads: false, viewport: {width: 1440, height: 1000},
    });
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15000);
    // Keep response bodies only. Never persist request headers, cookies, or HARs.
    const responses = new Map();
    const pending = new Set();
    const errors = new Set();
    const responseHandler = response => {
      if (!isTeamResponse(response.url(), response.request().method())) return;
      if (response.status() >= 400) { errors.add(`http_${response.status()}`); return; }
      if (!/json/i.test(response.headers()['content-type'] || '')) return;
      const task = (async () => {
        try {
          const body = await response.body();
          if (body.byteLength > 5_000_000) { errors.add('response_too_large'); return; }
          const url = new URL(response.url());
          const payload = sanitize(JSON.parse(body.toString('utf8')));
          // Filters distinguish pages of results; unrelated query parameters are not retained.
          let filter = null;
          if (url.searchParams.has('filter')) {
            try { filter = sanitize(JSON.parse(url.searchParams.get('filter'))); } catch { /* omit */ }
          }
          const resource = url.origin + url.pathname;
          responses.set(resource + ':' + digest(filter), {resource, filter, payload});
        } catch { errors.add('unreadable_response'); }
      })();
      pending.add(task);
      task.finally(() => pending.delete(task));
    };
    page.on('response', responseHandler);
    await page.goto(teamUrl, {waitUntil: 'domcontentloaded', timeout: 45000});

    if (mode === 'setup') {
      console.log('Dedicated Spordle browser opened. Sign in there yourself if requested.');
      console.log('Open team 223790 and its roster/schedule tabs. No passwords or codes go in this terminal.');
      const rl = createInterface({input: stdin, output: stdout});
      try { await rl.question('When the team page is loaded, press Enter here to capture and finish setup: '); }
      finally { rl.close(); }
    }

    const problem = pageProblem(await page.title(), page.url());
    if (problem) {
      await setStatus(problem, {lastSuccessfulSnapshotPreserved: true});
      statusWritten = true;
      throw new Error(`Spordle requires attention (${problem}). No new data was accepted.`);
    }
    await page.waitForSelector('#__NEXT_DATA__', {state: 'attached', timeout: 15000});
    // Let the normal site load its own data; do not replay credentials or bypass browser checks.
    await page.waitForLoadState('networkidle', {timeout: 10000}).catch(() => {});
    const next = JSON.parse(await page.locator('#__NEXT_DATA__').textContent());
    await writeJson(path.join(dataRoot, 'schema.json'), {
      query: sanitize(next.query),
      sections: Object.fromEntries(Object.entries(next.props?.pageProps || {}).map(([key, value]) => [key, {
        type: Array.isArray(value) ? 'array' : typeof value,
        keys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : undefined,
        count: Array.isArray(value) ? value.length : undefined,
      }])),
    });
    const pageData = extractPageData(next);

    // Only navigate links within this exact team's page; no organization-wide crawling.
    const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(n => n.href));
    const teamLinks = [...new Set(links)].filter(link => belongsToTeamPage(link) && link !== page.url()).slice(0, 6);
    for (const link of teamLinks) {
      await page.goto(link, {waitUntil: 'domcontentloaded', timeout: 30000});
      if (pageProblem(await page.title(), page.url())) { errors.add('team_view_unavailable'); break; }
      await page.waitForLoadState('networkidle', {timeout: 5000}).catch(() => {});
    }
    page.off('response', responseHandler);
    await Promise.allSettled([...pending]);
    if (errors.size) {
      await setStatus('incomplete', {errors: [...errors], lastSuccessfulSnapshotPreserved: true});
      statusWritten = true;
      throw new Error('Some team data could not be read. The previous snapshot was preserved.');
    }

    const captured = {pageData, responses: Object.fromEntries([...responses].sort(([a], [b]) => a.localeCompare(b)))};
    const latestFile = path.join(dataRoot, 'latest.json');
    const previous = await readJson(latestFile);
    if (previous) {
      const oldKeys = Object.keys(previous.data.responses);
      if (oldKeys.some(key => !(key in captured.responses))) {
        await setStatus('incomplete', {reason: 'Previously captured resources were missing', lastSuccessfulSnapshotPreserved: true});
        statusWritten = true;
        throw new Error('Not all previous team resources loaded; refusing to replace the last good snapshot.');
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const hash = digest(captured);
    const changed = previous?.contentHash !== hash;
    const snapshot = {
      teamId, sourceUrl: teamUrl, capturedAt: new Date().toISOString(), contentHash: hash,
      // Discovery captures are explicitly distinguished from a verified normalized roster.
      coverage: {embeddedSections: Object.keys(pageData), responseCount: responses.size, normalizedRosterVerified: false},
      data: captured,
    };
    if (changed) {
      await writeJson(path.join(dataRoot, 'snapshots', stamp + '.json'), snapshot);
      await writeJson(latestFile, snapshot);
      await writeJson(path.join(dataRoot, 'changes', stamp + '.json'), {
        capturedAt: snapshot.capturedAt, firstCapture: !previous,
        changedSections: describeChanges(previous?.data, captured),
        previousHash: previous?.contentHash || null, currentHash: hash,
      });
    }
    await setStatus('captured_needs_schema_validation', {changed, responseCount: responses.size, normalizedRosterVerified: false});
    statusWritten = true;
    if (mode === 'setup') await writeJson(path.join(privateRoot, 'setup.json'), {teamId, completedAt: snapshot.capturedAt});
    console.log(`Private capture ${changed ? 'saved' : 'unchanged'}; ${responses.size} team-scoped JSON responses. Roster normalization still needs validation.`);
  } catch (error) {
    if (!statusWritten) await setStatus('failed', {lastSuccessfulSnapshotPreserved: true});
    throw error;
  } finally {
    await context?.close().catch(() => {});
    await lockHandle.close();
    await fs.unlink(lock);
  }
}

try {
  if (mode === 'status') {
    const status = await readJson(path.join(dataRoot, 'status.json'));
    console.log(JSON.stringify(status || {status: 'not_configured', teamId}, null, 2));
  } else if (['setup', 'sync'].includes(mode)) {
    await collect();
  } else {
    throw new Error('Usage: node collector.mjs setup | sync [--headed] | status');
  }
} catch (error) {
  // Browser errors may contain page content and URLs. Never print a browser error dump.
  console.error(error.name === 'Error' && !error.message.includes('browserType.') && !error.message.includes('page.')
    ? error.message : 'Browser collection failed. Check the private status file and complete setup in your browser.');
  process.exitCode = 1;
}
