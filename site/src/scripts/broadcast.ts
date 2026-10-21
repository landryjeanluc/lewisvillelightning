/**
 * Drives the broadcast overlay.
 *
 * Two loops, deliberately separate. A poll every few seconds asks the API for
 * the snapshot — score, shots, penalties, the scoring summary, all already
 * derived server-side. A requestAnimationFrame loop redraws only the things
 * that move between polls: the game clock, each penalty box, and the strength
 * that flips the instant a box empties. Nothing is recomputed that the server
 * already counted, and nothing that ticks waits on the network.
 *
 * Time is always the server's. Each response carries `server_now`, the page
 * measures its own skew from it, and every clock reading goes through that — so
 * a tablet with a wrong clock cannot run the game clock fast.
 */
import { api } from './api-client';
import {
  clockAt, formatClock, formatPenaltyClock, activePenalties, strength,
  periodShort, periodLong, isIntermission, stamp,
  type Snapshot, type Side, type Penalty, type BroadcastEvent,
} from '../lib/broadcast';

const POLL_MS = 3000;
const GOAL_SECONDS = 11;
const PENALTY_SECONDS = 8;
const FINAL_CARD_SECONDS = 20;

type Named = { n: number; first: string; last: string };

for (const stage of document.querySelectorAll<HTMLElement>('[data-broadcast]')) {
  mount(stage);
}

function mount(stage: HTMLElement) {
  const gameId = stage.dataset.broadcast!;
  const path = `/broadcast/${encodeURIComponent(gameId)}`;
  const pick = <T extends HTMLElement>(sel: string) => stage.querySelector<T>(sel)!;

  const frame = pick('[data-frame]');
  const facade = pick('[data-facade]');
  const facadeNote = pick('[data-facade-note]');
  const holder = pick('[data-holder]');
  const play = pick<HTMLButtonElement>('[data-play]');
  const playLabel = pick('[data-play-label]');
  const bug = pick('[data-bug]');
  const clockOut = pick('[data-clock]');
  const periodOut = pick('[data-period]');
  const strengthOut = pick('[data-strength]');
  const boxes = pick<HTMLUListElement>('[data-boxes]');
  const pp = pick('[data-pp]');
  const ppLabel = pick('[data-pp-label]');
  const ppClock = pick('[data-pp-clock]');
  const liveBadge = pick('[data-live-badge]');
  const liveText = pick('[data-live-text]');
  const statusOut = pick('[data-status]');
  const watchLink = pick<HTMLAnchorElement>('[data-watch-link]');
  const card = pick('[data-card]');
  const lower = pick('[data-lower]');

  const scores = new Map<Side, HTMLElement>();
  for (const block of stage.querySelectorAll<HTMLElement>('[data-bug-side]')) {
    scores.set(block.dataset.bugSide as Side, block.querySelector<HTMLElement>('[data-score]')!);
  }
  // The attribute sits on the number itself, not a wrapper around it.
  const sogs = new Map<Side, HTMLElement>();
  for (const el of stage.querySelectorAll<HTMLElement>('[data-sog]')) {
    sogs.set(el.dataset.sog as Side, el);
  }

  const shortName: Record<Side, string> = {
    us: stage.dataset.usShort ?? 'Lightning',
    them: stage.dataset.themShort ?? 'Opponent',
  };

  // Names live in this page's HTML, never in a public bundle — see the comment
  // in BroadcastStage.astro.
  let players: Record<string, Named> = {};
  try {
    players = JSON.parse(stage.querySelector('[data-broadcast-roster]')?.textContent || '{}');
  } catch { /* A goal graphic falls back to the jersey-less form. */ }

  const named = (id: string | null): string | null => {
    const p = id ? players[id] : undefined;
    return p ? `${p.first} ${p.last}` : null;
  };
  const tag = (id: string | null): string | null => {
    const p = id ? players[id] : undefined;
    return p ? `#${p.n} ${p.last.toUpperCase()}` : null;
  };

  let snap: Snapshot | null = null;
  let skew = 0;
  let seenEventId = -1;
  let busy = false;
  let mounted = false;
  let finalShownFor: string | null = null;
  let cardDismissed = '';

  const serverNow = () => Date.now() + skew;

  /* ------------------------------------------------------------ the frame */

  function mountPlayer() {
    if (mounted || !snap?.stream) return;
    mounted = true;
    const iframe = document.createElement('iframe');
    // Only an id ever reaches here; the address is built by the API from it.
    iframe.src = `${snap.stream.embed_url}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
    iframe.title = `${shortName.us} broadcast`;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'no-referrer';
    holder.replaceChildren(iframe);
    facade.hidden = true;
  }

  play.addEventListener('click', mountPlayer);

  /* ------------------------------------------------------------- polling */

  async function poll() {
    if (busy || document.hidden) return;
    busy = true;
    const response = await api(path);
    busy = false;
    if (!response.ok || !response.body?.clock) {
      // Keep whatever is on screen: a dropped poll in a rink is normal, and a
      // scorebug that blanks itself is worse than one a few seconds stale.
      if (snap) statusOut.textContent = 'Updates interrupted. Showing the last received state; reconnecting…';
      return;
    }
    apply(response.body as Snapshot);
  }

  function apply(next: Snapshot) {
    const first = snap === null;
    skew = Date.parse(next.server_now) - Date.now();
    snap = next;

    // Stream availability.
    const stream = next.stream;
    watchLink.hidden = !stream;
    if (stream) watchLink.href = stream.watch_url;
    play.hidden = !stream;
    if (!stream) {
      facadeNote.textContent = 'No stream has been added for this game yet.';
    } else if (stream.state === 'live') {
      playLabel.textContent = 'Watch live';
      facadeNote.textContent = stream.label || 'The broadcast is live.';
    } else if (stream.state === 'ended') {
      playLabel.textContent = 'Watch the replay';
      facadeNote.textContent = stream.label || 'The broadcast has ended — the replay is available.';
    } else {
      playLabel.textContent = 'Open the broadcast';
      facadeNote.textContent = stream.label || 'The stream is set up and will start shortly.';
    }

    const status = next.result?.status ?? 'scheduled';
    const underway = status === 'in_progress' || status === 'final' || next.clock.revision > 0;
    bug.hidden = !underway;

    liveBadge.hidden = !(stream?.state === 'live' || status === 'in_progress');
    liveText.textContent = stream?.state === 'live' ? 'LIVE' : 'IN PROGRESS';

    for (const side of ['us', 'them'] as Side[]) {
      scores.get(side)!.textContent = String(next.score[side] ?? 0);
      sogs.get(side)!.textContent = String(next.shots[side]?.total ?? 0);
    }

    statusOut.textContent = status === 'final'
      ? 'Final result.'
      : next.clock.running ? 'Live — the clock and the score update automatically.'
      : underway ? 'Play is stopped. Scores update automatically.'
      : 'The game has not started.';

    // A brand-new page must not replay every goal of the game at once; it
    // only announces what happens from now on.
    const newest = next.events.length ? Math.max(...next.events.map((e) => e.id)) : -1;
    if (first) seenEventId = newest;
    else {
      const fresh = next.events.filter((e) => e.id > seenEventId).sort((a, b) => a.id - b.id);
      seenEventId = Math.max(seenEventId, newest);
      for (const event of fresh) queueGraphic(event);
    }

    drawCard(next, status);
    tick();
  }

  /* --------------------------------------------------------------- cards */

  function drawCard(next: Snapshot, status: string) {
    const key = status === 'final' ? 'final' : isIntermission(next.clock.period) ? next.clock.period : '';
    if (!key || cardDismissed === key) { card.hidden = true; return; }
    if (key === 'final' && finalShownFor === null) {
      finalShownFor = key;
      // The horn graphic should not sit over a replay forever.
      window.setTimeout(() => { cardDismissed = 'final'; card.hidden = true; }, FINAL_CARD_SECONDS * 1000);
    }
    const kicker = pick('[data-card-kicker]');
    const title = pick('[data-card-title]');
    const sub = pick('[data-card-sub]');
    const summary = pick<HTMLOListElement>('[data-card-summary]');
    const line = `${shortName.us} ${next.score.us} — ${shortName.them} ${next.score.them}`;

    if (key === 'final') {
      kicker.textContent = `${shortName.us} vs ${shortName.them}`;
      title.textContent = 'Final';
      sub.textContent = line;
      summary.replaceChildren(...next.goals.map((goal) => {
        const li = document.createElement('li');
        const when = document.createElement('span');
        when.className = 'cs-stamp';
        when.textContent = stamp(goal.period, goal.clock_ms);
        const who = document.createElement('span');
        const assists = [goal.assist1, goal.assist2].map(named).filter(Boolean);
        who.textContent = goal.team === 'them'
          ? shortName.them
          : [tag(goal.player_id) ?? shortName.us, assists.length ? `(${assists.join(', ')})` : '']
              .filter(Boolean).join(' ');
        li.append(when, who);
        return li;
      }));
      summary.hidden = next.goals.length === 0;
    } else {
      kicker.textContent = line;
      title.textContent = 'Intermission';
      sub.textContent = next.clock.period === 'INT1' ? 'Second period coming up.' : 'Third period coming up.';
      summary.hidden = true;
    }
    card.hidden = false;
  }

  // Both cards get out of the way on a tap — someone watching a replay should
  // never have to wait out a graphic.
  card.style.pointerEvents = 'auto';
  card.addEventListener('click', () => {
    if (!snap) return;
    cardDismissed = snap.result?.status === 'final' ? 'final' : snap.clock.period;
    card.hidden = true;
  });

  /* -------------------------------------------------------- lower thirds */

  const queue: BroadcastEvent[] = [];
  let showing = false;

  function queueGraphic(event: BroadcastEvent) {
    if (event.kind !== 'goal' && event.kind !== 'penalty') return;
    queue.push(event);
    if (!showing) void runQueue();
  }

  async function runQueue() {
    showing = true;
    while (queue.length) {
      const event = queue.shift()!;
      const seconds = event.kind === 'goal' ? GOAL_SECONDS : PENALTY_SECONDS;
      paintLower(event);
      lower.hidden = false;
      lower.removeAttribute('data-leaving');
      await wait(seconds * 1000);
      lower.setAttribute('data-leaving', '');
      await wait(400);
      lower.hidden = true;
    }
    showing = false;
  }

  function paintLower(event: BroadcastEvent) {
    const kicker = pick('[data-lower-kicker]');
    const name = pick('[data-lower-name]');
    const detail = pick('[data-lower-detail]');
    const flag = pick('[data-lower-flag]');
    const side = (event.team ?? 'us') as Side;

    if (event.kind === 'goal') {
      kicker.textContent = side === 'us' ? 'Lightning goal' : `${shortName.them} goal`;
      name.textContent = (side === 'us' ? named(event.player_id) : null) ?? shortName[side];
      const assists = [event.assist1, event.assist2].map(named).filter(Boolean);
      detail.textContent = side === 'us' && assists.length
        ? `Assists: ${assists.join(', ')}`
        : side === 'us' && event.player_id ? 'Unassisted' : '';
    } else {
      kicker.textContent = side === 'us' ? 'Lightning penalty' : `${shortName.them} penalty`;
      name.textContent = (side === 'us' ? named(event.player_id) : null) ?? shortName[side];
      detail.textContent = [event.infraction, event.minutes ? `${event.minutes} minutes` : '']
        .filter(Boolean).join(' · ');
    }
    // Our graphics lean volt; theirs stay neutral, so a glance tells you whose.
    flag.style.background = side === 'us' ? 'var(--volt-500)' : 'var(--steel-500)';
    pick('[data-lower-stamp]').textContent = stamp(event.period, event.clock_ms);
  }

  const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

  /* ---------------------------------------------------------- the ticking */

  function tick() {
    if (!snap) return;
    const now = serverNow();
    const { remaining, elapsed } = clockAt(snap.clock, now);
    clockOut.textContent = formatClock(remaining);
    periodOut.textContent = periodShort(snap.clock.period);
    periodOut.title = periodLong(snap.clock.period);
    bug.toggleAttribute('data-ticking', snap.clock.running);

    const active = activePenalties(snap.penalties, elapsed);
    paintBoxes(active, elapsed);

    const s = strength(snap.penalties, elapsed);
    strengthOut.hidden = s.powerPlay === null && s.label === 'EVEN';
    strengthOut.textContent = s.label;
    pp.hidden = s.powerPlay === null;
    if (s.powerPlay) {
      ppLabel.textContent = s.powerPlay === 'us' ? 'POWER PLAY' : 'SHORT HANDED';
      ppClock.textContent = formatPenaltyClock(s.powerPlayRemaining);
    }
  }

  let painted = '';
  function paintBoxes(active: Penalty[], elapsed: number) {
    // Rebuild only when the set changes; the clock inside each row is updated
    // in place so a redraw never restarts an animation mid-tick.
    const signature = active.map((p) => p.id).join(',');
    if (signature !== painted) {
      painted = signature;
      boxes.replaceChildren(...active.map((p) => {
        const li = document.createElement('li');
        li.dataset.side = p.team;
        li.dataset.penalty = String(p.id);
        const who = document.createElement('span');
        who.className = 'bx-tag';
        who.textContent = (p.team === 'us' ? tag(p.player_id) : null) ?? shortName[p.team];
        const what = document.createElement('span');
        what.textContent = [p.infraction, `${p.minutes}:00`].filter(Boolean).join(' · ');
        const left = document.createElement('span');
        left.className = 'bx-clock num';
        li.append(who, what, left);
        return li;
      }));
    }
    for (const p of active) {
      const li = boxes.querySelector<HTMLElement>(`[data-penalty="${p.id}"] .bx-clock`);
      if (li) li.textContent = formatPenaltyClock(
        Math.max(0, p.seconds * 1000 - (elapsed - p.elapsed_ms)));
    }
  }

  /* ---------------------------------------------------------- stage chrome */

  const toggle = pick<HTMLButtonElement>('[data-toggle-overlay]');
  toggle.addEventListener('click', () => {
    const off = stage.toggleAttribute('data-overlay-off');
    toggle.textContent = off ? 'Show overlay' : 'Hide overlay';
    toggle.setAttribute('aria-pressed', String(!off));
  });

  const full = pick<HTMLButtonElement>('[data-fullscreen]');
  full.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frame.requestFullscreen?.().catch(() => {
      statusOut.textContent = 'This browser would not go fullscreen.';
    });
  });
  document.addEventListener('fullscreenchange', () => {
    full.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  });

  /* --------------------------------------------------------------- start */

  void poll();
  window.setInterval(() => void poll(), POLL_MS);
  document.addEventListener('visibilitychange', () => void poll());

  // The clock has to be smooth; the network does not have to be fast.
  const frameLoop = () => { tick(); requestAnimationFrame(frameLoop); };
  requestAnimationFrame(frameLoop);
}
