import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from './markdown';
import { safeNext, scriptJson, escapeHtml } from './security';
import { eventLines, calendar } from './ics';
import { scheduleSchema } from './schema';
import { games } from './data';

test('Markdown rejects script URLs, HTML handlers, remote trackers and encoded schemes', () => {
  for (const source of ['[click](javascript:alert%281%29)', '[click](jav&#x61;script:alert%281%29)',
    '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<script>alert(1)</script>',
    '![tracking](https://evil.invalid/track)', '<a href="data:text/html,hello">link</a>']) {
    const html = renderMarkdown(source);
    assert.doesNotMatch(html, /javascript:|onerror=|onload=|<script|<img|data:text/i);
  }
  assert.match(renderMarkdown('**Goal** [team](https://example.invalid)'), /<strong>Goal<\/strong>/);
  assert.match(renderMarkdown('[team](https://example.invalid)'), /rel="noopener noreferrer"/);
});

test('login redirects remain on origin, including browser backslash normalization', () => {
  for (const next of ['//evil.invalid', '/\\evil.invalid', 'https://evil.invalid', '/\n/evil.invalid', 'javascript:alert(1)'])
    assert.equal(safeNext(next, 'https://lvlnb.ca'), '/');
  assert.equal(safeNext('/goals?week=next#shots', 'https://lvlnb.ca'), '/goals?week=next#shots');
});

test('JSON cannot break out of a script element and HTML strings escape both quotes', () => {
  const value = { name: '</script><script>alert(1)</script>' };
  const encoded = scriptJson(value);
  assert.ok(!encoded.includes('<'));
  assert.deepEqual(JSON.parse(encoded), value);
  assert.equal(escapeHtml('"\'><&'), '&quot;&#39;&gt;&lt;&amp;');
});

test('calendar text escapes separators and line injection, preserves UTF-8 folding', () => {
  const game = structuredClone(games[0]);
  game.venue.name = 'Arena; rink, A\rBEGIN:VEVENT';
  game.notes = 'é'.repeat(100);
  const lines = eventLines(game, '20261013T120000Z');
  assert.ok(lines.includes('LOCATION:Arena\\; rink\\, A\\nBEGIN:VEVENT'));
  const ics = calendar([game], 'Team');
  assert.ok(ics.endsWith('\r\n'));
  assert.equal(ics.split('\r\nBEGIN:VEVENT\r\n').length - 1, 1);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  assert.ok(ics.replace(/\r\n /g, '').includes('é'.repeat(100)));
});

test('schedule rejects route injection, duplicate IDs, impossible dates and reversed times', () => {
  const base = {version:1, source:{provider:'test',fetchedAt:null},events:[structuredClone(games[0])]};
  assert.ok(scheduleSchema.safeParse(base).success);
  for (const change of [ {id:'../../login'}, {startsAt:'2026-02-30T12:00:00-04:00'}, {endsAt:'2020-01-01T12:00:00-04:00'}, {venue:{...games[0].venue,mapUrl:'javascript:alert(1)'}} ]) {
    assert.equal(scheduleSchema.safeParse({...base,events:[{...base.events[0],...change}]}).success,false);
  }
  assert.equal(scheduleSchema.safeParse({...base, events:[base.events[0],base.events[0]]}).success,false);
});
