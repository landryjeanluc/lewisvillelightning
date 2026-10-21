/**
 * The broadcast console, driven from the stands.
 *
 * Design rules that come from the setting rather than from taste:
 *
 * - **A tap must never be lost and never be doubled.** Every action carries a
 *   uuid the server dedupes on, and failed sends sit in an outbox and retry.
 *   Arena wifi drops constantly; the operator should not have to wonder whether
 *   the goal went in.
 * - **The server owns the clock reading.** The console sends "goal", not "goal
 *   at 12:48" — the time it happened is a fact about the game clock, which
 *   lives in the API. The only thing sent here that is a clock reading is the
 *   clock itself.
 * - **Nothing destructive next to anything frequent.** Undo is in the feed, a
 *   deliberate scroll away from the pad that gets hit forty times a game.
 */
import { api } from './api-client';
import {
  clockAt, formatClock, formatPenaltyClock, activePenalties, strength, markLink,
  periodShort, stamp, type Snapshot, type Side, type BroadcastEvent,
} from '../lib/broadcast';

const POLL_MS = 3000;
const RETRY_MS = 2500;

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel)!;
const all = <T extends HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

const gate = $('#gate');
const panel = $('#console');
const select = $<HTMLSelectElement>('[data-game-select]');
const say = $('[data-say]');

type Named = { n: number; first: string; last: string };
let players: Record<string, Named> = {};
try {
  players = JSON.parse(document.querySelector('[data-control-roster]')?.textContent || '{}');
} catch { /* The feed falls back to ids, which is ugly but never wrong. */ }

const tag = (id: string | null): string | null => {
  const p = id ? players[id] : undefined;
  return p ? `#${p.n} ${p.last}` : null;
};

let snap: Snapshot | null = null;
let skew = 0;
let gameId = '';
let busy = false;
let sending = false;
const serverNow = () => Date.now() + skew;

const abbr = { us: 'LWV', them: 'OPP' };

function tell(message: string, bad = false) {
  say.textContent = message;
  say.toggleAttribute('data-bad', bad);
}

/* ------------------------------------------------------------------ outbox */

type Pending = { path: string; body: unknown; label: string };
const outbox: Pending[] = [];

/** Send what is queued, oldest first, and stop at the first network failure. */
async function flush() {
  if (sending || !outbox.length) return;
  sending = true;
  while (outbox.length) {
    const next = outbox[0];
    const { ok, status, body } = await api(next.path, { method: 'POST', body: JSON.stringify(next.body) });
    if (ok) {
      outbox.shift();
      apply(body as Snapshot);
      tell(outbox.length ? `${next.label} saved · ${outbox.length} still sending…` : `${next.label} saved.`);
      continue;
    }
    if (status === 0) {
      // Offline. Keep the tap and try again; the dedupe id makes that safe.
      tell(`${next.label} is waiting for a connection — ${outbox.length} queued.`, true);
      break;
    }
    // The server refused it on its merits, so retrying would refuse it again.
    outbox.shift();
    tell(typeof body?.detail === 'string' ? body.detail : `${next.label} was refused (${status}).`, true);
  }
  sending = false;
}

function send(label: string, body: Record<string, unknown>) {
  if (!gameId) return;
  outbox.push({
    path: `/broadcast/${encodeURIComponent(gameId)}/events`,
    body: { ...body, client_id: crypto.randomUUID() },
    label,
  });
  tell(`${label}…`);
  void flush();
}

/* ------------------------------------------------------------------- clock */

async function putClock(change: Record<string, unknown>) {
  if (!snap) return;
  const now = serverNow();
  const live = clockAt(snap.clock, now);
  const body = {
    period: snap.clock.period,
    period_length_ms: snap.clock.period_length_ms,
    remaining_ms: live.remaining,
    running: snap.clock.running,
    expected_revision: snap.clock.revision,
    ...change,
  };
  const { ok, status, body: result } = await api(
    `/broadcast/${encodeURIComponent(gameId)}/clock`, { method: 'PUT', body: JSON.stringify(body) });
  if (ok) { apply(result as Snapshot); tell('Clock set.'); return; }
  if (status === 409) { tell('The clock was changed on another device. Reloading it.', true); await load(); return; }
  tell(typeof result?.detail === 'string' ? result.detail : `Could not set the clock (${status}).`, true);
}

const clampToPeriod = (ms: number) =>
  Math.max(0, Math.min(ms, snap?.clock.period_length_ms ?? 900_000));

/* ------------------------------------------------------------------ render */

function apply(next: Snapshot) {
  skew = Date.parse(next.server_now) - Date.now();
  snap = next;

  const badge = $('[data-stream-badge]');
  badge.textContent = next.stream
    ? { live: 'Live', ended: 'Replay', scheduled: 'Stream ready' }[next.stream.state] ?? next.stream.state
    : 'No stream';
  badge.dataset.state = next.stream?.state ?? '';
  $<HTMLAnchorElement>('[data-watch]').href = `/watch/${next.game_id}`;
  if (next.stream) {
    const url = $<HTMLInputElement>('[data-stream-url]');
    if (!url.value) url.value = next.stream.video_id;
    const label = $<HTMLInputElement>('[data-stream-label]');
    if (!label.value && next.stream.label) label.value = next.stream.label;
    $<HTMLSelectElement>('[data-stream-state]').value = next.stream.state;
  }

  for (const side of ['us', 'them'] as Side[]) {
    $(`[data-score="${side}"]`).textContent = String(next.score[side] ?? 0);
    $(`[data-sog="${side}"]`).textContent = String(next.shots[side]?.total ?? 0);
  }
  $<HTMLSelectElement>('[data-period-length]').value = String(next.clock.period_length_ms);
  for (const chip of all('[data-period-set]')) {
    chip.classList.toggle('is-on', chip.dataset.periodSet === next.clock.period);
  }
  const run = $<HTMLButtonElement>('[data-run]');
  run.textContent = next.clock.running ? 'Stop clock' : 'Start clock';
  run.toggleAttribute('data-running', next.clock.running);

  paintFeed(next);
  tick();
}

function describe(event: BroadcastEvent): string {
  const side = (event.team ?? 'us') as Side;
  const who = (side === 'us' ? tag(event.player_id) : null) ?? abbr[side];
  switch (event.kind) {
    case 'goal': {
      const assists = [event.assist1, event.assist2].map(tag).filter(Boolean);
      return `Goal — ${who}${assists.length ? ` (${assists.join(', ')})` : ''}`;
    }
    case 'shot': return `Shot — ${abbr[side]}`;
    case 'penalty':
      return `Penalty — ${who} · ${[event.infraction, `${event.minutes} min`].filter(Boolean).join(' · ')}`;
    case 'timeout': return `Timeout — ${abbr[side]}`;
    case 'goalie': return `Goalie change — ${abbr[side]}`;
    case 'highlight': return `Highlight mark${event.note ? ` — ${event.note}` : ''}`;
    default: return event.note ?? event.kind;
  }
}

function paintFeed(next: Snapshot) {
  const list = $<HTMLUListElement>('[data-feed]');
  if (!next.events.length) {
    const li = document.createElement('li');
    li.className = 'dim';
    li.textContent = 'Nothing yet.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...next.events.map((event) => {
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.className = 'fd-stamp';
    when.textContent = stamp(event.period, event.clock_ms);
    const what = document.createElement('span');
    what.className = event.kind === 'highlight' ? 'fd-what fd-mark' : 'fd-what';
    what.textContent = describe(event);
    li.append(when, what);

    // A highlight mark is only useful if it takes you to the moment.
    const jump = next.stream ? markLink(next.stream.watch_url, event.stream_offset_ms) : null;
    if (event.kind === 'highlight' && jump) {
      const link = document.createElement('a');
      link.href = jump;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Jump ↗';
      li.append(link);
    }

    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = 'Undo';
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      const { ok, body } = await api(
        `/broadcast/${encodeURIComponent(gameId)}/events/${event.id}/void`, { method: 'POST' });
      if (ok) { apply(body as Snapshot); tell('Taken back.'); }
      else { undo.disabled = false; tell(typeof body?.detail === 'string' ? body.detail : 'Could not undo that.', true); }
    });
    li.append(undo);
    return li;
  }));
}

/** Everything that moves between polls. */
function tick() {
  if (!snap) return;
  const { remaining, elapsed } = clockAt(snap.clock, serverNow());
  $('[data-clock]').textContent = formatClock(remaining);
  $('[data-period]').textContent = periodShort(snap.clock.period);

  const s = strength(snap.penalties, elapsed);
  $('[data-strength]').textContent = s.label === 'EVEN' ? '' : s.label;
  const pp = $('[data-pp]');
  pp.hidden = s.powerPlay === null;
  if (s.powerPlay) {
    pp.textContent = `${s.powerPlay === 'us' ? 'Power play' : 'Short handed'} ${formatPenaltyClock(s.powerPlayRemaining)}`;
  }

  const boxes = $<HTMLUListElement>('[data-boxes]');
  const active = activePenalties(snap.penalties, elapsed);
  const signature = active.map((p) => p.id).join(',');
  if (boxes.dataset.signature !== signature) {
    boxes.dataset.signature = signature;
    boxes.replaceChildren(...active.map((p) => {
      const li = document.createElement('li');
      li.dataset.box = String(p.id);
      const who = document.createElement('span');
      who.textContent = (p.team === 'us' ? tag(p.player_id) : null) ?? abbr[p.team];
      const left = document.createElement('b');
      li.append(who, left);
      return li;
    }));
  }
  for (const p of active) {
    const left = boxes.querySelector<HTMLElement>(`[data-box="${p.id}"] b`);
    if (left) left.textContent = formatPenaltyClock(
      Math.max(0, p.seconds * 1000 - (elapsed - p.elapsed_ms)));
  }
}

/* ------------------------------------------------------------------ sheets */

type SheetState = { team: Side; scorer: string | null; assists: string[]; infraction: string | null; minutes: number };
let sheet: SheetState = { team: 'us', scorer: null, assists: [], infraction: null, minutes: 2 };

function closeSheets() {
  for (const el of all('[data-sheet]')) el.hidden = true;
}

function openGoal(team: Side) {
  closeSheets();
  sheet = { ...sheet, team, scorer: null, assists: [] };
  const panelEl = $('[data-sheet="goal"]');
  $('[data-goal-title]', panelEl).textContent = team === 'us' ? 'Lightning goal' : `${abbr.them} goal`;
  // Only our own roster is ours to record, so an opponent goal is one tap.
  const needsPlayer = team === 'us';
  for (const group of ['[data-scorer]', '[data-assists]']) {
    $(group, panelEl).hidden = !needsPlayer;
    for (const chip of all('.chip', $(group, panelEl))) chip.classList.remove('is-on');
  }
  for (const p of all('p.dim', panelEl)) p.hidden = !needsPlayer;
  panelEl.hidden = false;
  panelEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function openPenalty(team: Side) {
  closeSheets();
  sheet = { ...sheet, team, scorer: null, infraction: null, minutes: 2 };
  const panelEl = $('[data-sheet="penalty"]');
  $('[data-pen-title]', panelEl).textContent = team === 'us' ? 'Lightning penalty' : `${abbr.them} penalty`;
  $('[data-pen-player]', panelEl).hidden = team !== 'us';
  for (const chip of all('.chip', panelEl)) chip.classList.remove('is-on');
  const two = panelEl.querySelector<HTMLElement>('[data-minutes="2"]');
  two?.classList.add('is-on');
  panelEl.hidden = false;
  panelEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  // --- action pads
  for (const pad of all<HTMLButtonElement>('[data-act]')) {
    pad.addEventListener('click', () => {
      const team = (pad.dataset.team ?? 'us') as Side;
      switch (pad.dataset.act) {
        case 'goal': return openGoal(team);
        case 'penalty': return openPenalty(team);
        case 'shot': return send(`Shot (${abbr[team]})`, { kind: 'shot', team });
        case 'timeout': return send(`Timeout (${abbr[team]})`, { kind: 'timeout', team });
        case 'highlight': return send('Highlight mark', { kind: 'highlight' });
      }
    });
  }

  // --- goal sheet
  const goalPanel = $('[data-sheet="goal"]');
  for (const chip of all<HTMLButtonElement>('[data-player]', $('[data-scorer]', goalPanel))) {
    chip.addEventListener('click', () => {
      sheet.scorer = chip.dataset.player || null;
      for (const other of all('.chip', $('[data-scorer]', goalPanel))) other.classList.remove('is-on');
      chip.classList.add('is-on');
    });
  }
  for (const chip of all<HTMLButtonElement>('[data-player]', $('[data-assists]', goalPanel))) {
    chip.addEventListener('click', () => {
      const id = chip.dataset.player!;
      const at = sheet.assists.indexOf(id);
      if (at >= 0) sheet.assists.splice(at, 1);
      else if (sheet.assists.length < 2) sheet.assists.push(id);
      else { tell('A goal carries at most two assists.', true); return; }
      chip.classList.toggle('is-on', sheet.assists.includes(id));
    });
  }
  $('[data-confirm]', goalPanel).addEventListener('click', () => {
    if (sheet.team === 'us' && sheet.assists.includes(sheet.scorer ?? '')) {
      tell('The scorer cannot also have an assist.', true); return;
    }
    if (sheet.team === 'us' && !sheet.scorer && sheet.assists.length) {
      tell('Choose the scorer, or "Not sure", before the assists.', true); return;
    }
    const assists = sheet.team === 'us' ? sheet.assists : [];
    send(`Goal (${abbr[sheet.team]})`, {
      kind: 'goal', team: sheet.team,
      player_id: sheet.team === 'us' ? sheet.scorer : null,
      assist1: assists[0] ?? null, assist2: assists[1] ?? null,
    });
    closeSheets();
  });

  // --- penalty sheet
  const penPanel = $('[data-sheet="penalty"]');
  for (const [group, apply_] of [
    ['[data-pen-player]', (chip: HTMLElement) => { sheet.scorer = chip.dataset.player || null; }],
    ['[data-pen-infraction]', (chip: HTMLElement) => { sheet.infraction = chip.dataset.infraction ?? null; }],
    ['[data-pen-minutes]', (chip: HTMLElement) => { sheet.minutes = Number(chip.dataset.minutes); }],
  ] as const) {
    for (const chip of all<HTMLButtonElement>('.chip', $(group, penPanel))) {
      chip.addEventListener('click', () => {
        apply_(chip);
        for (const other of all('.chip', $(group, penPanel))) other.classList.remove('is-on');
        chip.classList.add('is-on');
      });
    }
  }
  $('[data-confirm]', penPanel).addEventListener('click', () => {
    send(`Penalty (${abbr[sheet.team]})`, {
      kind: 'penalty', team: sheet.team,
      player_id: sheet.team === 'us' ? sheet.scorer : null,
      minutes: sheet.minutes, infraction: sheet.infraction,
    });
    closeSheets();
  });

  for (const cancel of all('[data-cancel]')) cancel.addEventListener('click', closeSheets);

  // --- clock
  $('[data-run]').addEventListener('click', () => {
    if (!snap) return;
    const live = clockAt(snap.clock, serverNow());
    if (!snap.clock.running && live.remaining === 0) {
      tell('The period is at zero — set the clock or pick the next period first.', true);
      return;
    }
    void putClock({ running: !snap.clock.running });
  });
  for (const nudge of all<HTMLButtonElement>('[data-nudge]')) {
    nudge.addEventListener('click', () => {
      if (!snap) return;
      const live = clockAt(snap.clock, serverNow());
      const next = clampToPeriod(live.remaining + Number(nudge.dataset.nudge));
      void putClock({ remaining_ms: next, running: snap.clock.running && next > 0 });
    });
  }
  for (const chip of all<HTMLButtonElement>('[data-period-set]')) {
    chip.addEventListener('click', () => {
      if (!snap) return;
      void putClock({
        period: chip.dataset.periodSet, remaining_ms: snap.clock.period_length_ms, running: false,
      });
    });
  }
  $('[data-clock-apply]').addEventListener('click', () => {
    const raw = $<HTMLInputElement>('[data-clock-input]').value.trim();
    // "12:48", "12.48" and a bare "768" seconds all mean the same thing to a
    // timekeeper reading the board, so all three are accepted.
    const parts = raw.split(/[:.]/).map((n) => Number(n));
    if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) {
      tell('Enter the clock as minutes:seconds, for example 12:48.', true); return;
    }
    const ms = parts.length >= 2 ? (parts[0] * 60 + parts[1]) * 1000 : parts[0] * 1000;
    void putClock({ remaining_ms: clampToPeriod(ms), running: false });
  });
  $<HTMLSelectElement>('[data-period-length]').addEventListener('change', (event) => {
    const length = Number((event.target as HTMLSelectElement).value);
    void putClock({ period_length_ms: length, remaining_ms: length, running: false });
  });
  $('[data-period-reset]').addEventListener('click', () => {
    if (!snap) return;
    void putClock({ remaining_ms: snap.clock.period_length_ms, running: false });
  });

  // --- stream
  $('[data-stream-save]').addEventListener('click', async () => {
    const url = $<HTMLInputElement>('[data-stream-url]').value.trim();
    if (!url) { tell('Paste the YouTube link first.', true); return; }
    const { ok, body } = await api(`/broadcast/${encodeURIComponent(gameId)}/stream`, {
      method: 'PUT',
      body: JSON.stringify({
        url,
        label: $<HTMLInputElement>('[data-stream-label]').value.trim() || null,
        state: $<HTMLSelectElement>('[data-stream-state]').value,
      }),
    });
    if (!ok) {
      const detail = Array.isArray(body?.detail) ? body.detail[0]?.msg : body?.detail;
      tell(detail ?? 'Could not save the stream.', true);
      return;
    }
    tell('Stream saved. Families can watch it on the Watch page.');
    await load();
  });
  $('[data-stream-clear]').addEventListener('click', async () => {
    if (!confirm('Remove the stream from this game? The overlay stays; only the video goes.')) return;
    const { ok } = await api(`/broadcast/${encodeURIComponent(gameId)}/stream`, { method: 'DELETE' });
    tell(ok ? 'Stream removed.' : 'Could not remove the stream.', !ok);
    $<HTMLInputElement>('[data-stream-url]').value = '';
    await load();
  });

  // --- derived scoresheet
  $('[data-sheet-preview]').addEventListener('click', async () => {
    const out = $('[data-derived]');
    const { ok, body } = await api(`/broadcast/${encodeURIComponent(gameId)}/scoresheet`);
    if (!ok) { tell('Could not work out the scoresheet.', true); return; }
    const lines = (body.lines as { player_id: string; g: number; a: number; pim: number }[])
      .map((line) => `${(tag(line.player_id) ?? line.player_id).padEnd(18)} G ${line.g}  A ${line.a}  PIM ${line.pim}`);
    out.textContent = [
      `Score  ${abbr.us} ${body.our_score} — ${abbr.them} ${body.their_score}`,
      ...lines,
      '',
      ...(body.warnings as string[]),
      body.plus_minus_note as string,
      '',
      'Open Admin → Game scoring to enter and publish these.',
    ].join('\n');
    out.hidden = false;
  });

  // --- game choice
  select.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('game', select.value);
    history.replaceState(null, '', url);
    void load();
  });
}

/* -------------------------------------------------------------------- boot */

async function load() {
  if (busy) return;
  busy = true;
  gameId = select.value;
  const option = select.selectedOptions[0];
  abbr.us = option?.dataset.us ?? 'LWV';
  abbr.them = option?.dataset.them ?? 'OPP';
  for (const el of all('[data-abbr]')) el.textContent = abbr[el.dataset.abbr as Side];
  const { ok, body, status } = await api(`/broadcast/${encodeURIComponent(gameId)}`);
  busy = false;
  if (!ok) {
    tell(status === 0
      ? 'No connection. The console keeps working; taps will send when it comes back.'
      : `Could not load this game (${status}).`, true);
    return;
  }
  apply(body as Snapshot);
  tell('');
}

async function boot() {
  const { ok, body: user } = await api('/auth/me');
  if (!ok || user?.role !== 'admin') { gate.hidden = false; return; }
  panel.hidden = false;
  wire();

  // Default to the game being played today, else the nearest one either way.
  const requested = new URLSearchParams(location.search).get('game');
  const options = Array.from(select.options);
  if (requested && options.some((o) => o.value === requested)) select.value = requested;
  else {
    const today = new Date().toISOString().slice(0, 10);
    const todays = options.find((o) => o.value.includes(today));
    if (todays) select.value = todays.value;
  }

  await load();
  window.setInterval(() => void load(), POLL_MS);
  window.setInterval(() => void flush(), RETRY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
  const loop = () => { tick(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

  // A half-sent tap must not vanish because somebody backed out of the page.
  window.addEventListener('beforeunload', (event) => { if (outbox.length) event.preventDefault(); });
}

void boot();
