/** Admin → Game scoring → Goal clips: upload the replay tool's clips and tag each goal. */
import { api } from './api-client';

type Player = { id: string; number: number; name: string };
type Clip = { id: string; seq: number; team: 'us' | 'them'; scorer: string | null; assist1: string | null;
  assist2: string | null; on_ice: string[]; power_play: boolean };
type Totals = Record<string, { g: number; a: number; plus_minus: number }>;

// <game id>.goal-03.us.2-1.mp4, exactly as tools/replay/goal_clips.py names them.
export const CLIP_NAME = /^(g-[a-z0-9-]+)\.goal-(\d{2})\.(us|them)\.\d+-\d+\.mp4$/;

const root = document.querySelector<HTMLElement>('[data-goal-clips]');
if (root) {
  const players: Player[] = JSON.parse(root.querySelector('[data-clip-players]')!.textContent!);
  const files = root.querySelector<HTMLInputElement>('[data-clip-files]')!;
  const progress = root.querySelector<HTMLProgressElement>('[data-clip-progress]')!;
  const status = root.querySelector<HTMLElement>('[data-clip-status]')!;
  const list = root.querySelector<HTMLElement>('[data-clip-list]')!;
  const apply = root.querySelector<HTMLElement>('[data-clip-apply]')!;
  const summary = root.querySelector<HTMLElement>('[data-clip-summary]')!;
  const copy = root.querySelector<HTMLButtonElement>('[data-clip-copy]')!;
  let game = '';
  let totals: Totals = {};
  let score = { us: 0, them: 0 };
  let loads = 0;
  let uploading = false;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const detail = (result: { status: number; body: any }, fallback: string) =>
    [401, 403].includes(result.status) ? 'Sign in with your admin account and try again.'
      : typeof result.body?.detail === 'string' ? result.body.detail : fallback;

  function picker(label: string, value: string | null, none: string) {
    const wrap = el('label', '', label);
    const select = el('select');
    select.append(new Option(none, ''));
    for (const p of players) select.append(new Option(`#${p.number} ${p.name}`, p.id));
    select.value = value ?? '';
    select.setAttribute('aria-label', label);   // the wrapping label's text would include every option
    wrap.append(select);
    return { wrap, select };
  }

  function card(clip: Clip, running: string) {
    const article = el('article', 'card clip');
    article.dataset.clip = String(clip.seq);
    const video = el('video');
    video.controls = true; video.playsInline = true; video.preload = 'none';
    video.src = '/api/goal-clips/' + encodeURIComponent(clip.id) + '/video';
    video.poster = '/api/goal-clips/' + encodeURIComponent(clip.id) + '/poster';
    video.setAttribute('aria-label', `Goal ${clip.seq}`);
    const body = el('div', 'clip-body');
    const head = el('div', 'clip-head');
    const remove = el('button', 'clip-remove', 'Remove clip'); remove.type = 'button';
    head.append(el('h3', '', `Goal ${clip.seq} · ${running}`), remove);

    const fields = el('div', 'clip-fields');
    const team = el('label', '', 'Scored by');
    const teamSelect = el('select');
    teamSelect.append(new Option('Lightning', 'us'), new Option('Opponent', 'them'));
    teamSelect.value = clip.team;
    teamSelect.setAttribute('aria-label', 'Scored by');
    team.append(teamSelect);
    const scorer = picker('Scorer', clip.scorer, 'Not tagged');
    const assist1 = picker('Assist', clip.assist1, 'None');
    const assist2 = picker('Second assist', clip.assist2, 'None');
    fields.append(team, scorer.wrap, assist1.wrap, assist2.wrap);

    const iceLabel = el('p', 'dim', 'Lightning players on the ice');
    const ice = el('div', 'clip-ice');
    ice.setAttribute('role', 'group'); ice.setAttribute('aria-label', `Players on the ice for goal ${clip.seq}`);
    const chosen = new Set(clip.on_ice);
    for (const p of players) {
      const chip = el('button', '', String(p.number)); chip.type = 'button';
      chip.title = p.name; chip.dataset.player = p.id;
      chip.setAttribute('aria-label', `#${p.number} ${p.name}`);
      chip.setAttribute('aria-pressed', String(chosen.has(p.id)));
      ice.append(chip);
    }
    const pp = el('label', 'clip-pp');
    const ppBox = el('input'); ppBox.type = 'checkbox'; ppBox.checked = clip.power_play;
    pp.append(ppBox, 'Power-play goal (does not count for +/−)');
    const note = el('p', 'dim clip-note'); note.setAttribute('role', 'status');
    body.append(head, fields, iceLabel, ice, pp, note);
    article.append(video, body);

    const credits = () => { for (const part of [scorer, assist1, assist2]) part.wrap.hidden = teamSelect.value === 'them'; };
    credits();

    async function save() {
      if (teamSelect.value === 'them') for (const part of [scorer, assist1, assist2]) part.select.value = '';
      credits();
      note.textContent = 'Saving…';
      const result = await api('/goal-clips/' + clip.id, { method: 'PUT', body: JSON.stringify({
        team: teamSelect.value, scorer: scorer.select.value || null, assist1: assist1.select.value || null,
        assist2: assist2.select.value || null, on_ice: [...chosen], power_play: ppBox.checked,
      }) });
      if (!result.ok) {
        const issue = Array.isArray(result.body?.detail) ? String(result.body.detail[0]?.msg ?? '').replace(/^Value error, /, '') : '';
        note.textContent = (issue || detail(result, 'Could not save this goal.')) + ' Not saved.';
        return;
      }
      // The server adds the scorer and assists to the players on the ice.
      chosen.clear();
      for (const id of result.body.on_ice) chosen.add(id);
      for (const chip of ice.querySelectorAll<HTMLButtonElement>('button')) chip.setAttribute('aria-pressed', String(chosen.has(chip.dataset.player!)));
      note.textContent = 'Saved.';
      await refreshTotals();
    }
    for (const control of [teamSelect, scorer.select, assist1.select, assist2.select, ppBox]) control.addEventListener('change', () => void save());
    ice.addEventListener('click', event => {
      const chip = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!chip) return;
      const id = chip.dataset.player!;
      if (chosen.has(id)) chosen.delete(id);
      else if (chosen.size >= 6) { note.textContent = 'At most six players can be on the ice.'; return; }
      else chosen.add(id);
      chip.setAttribute('aria-pressed', String(chosen.has(id)));
      void save();
    });
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove the clip for goal ${clip.seq}? Its tags go with it.`)) return;
      const result = await api('/goal-clips/' + clip.id, { method: 'DELETE' });
      if (result.ok) { video.pause(); await load(); } else note.textContent = detail(result, 'Could not remove this clip.');
    });
    return article;
  }

  function describe(body: any) {
    totals = body.totals;
    score = { us: body.our_goals, them: body.their_goals };
    const clips: Clip[] = body.clips;
    apply.hidden = clips.length === 0;
    const untagged = clips.filter(c => c.team === 'us' && !c.scorer).length;
    summary.textContent = `${clips.length} goal${clips.length === 1 ? '' : 's'} on video: Lightning ${score.us}, opponent ${score.them}.`
      + (untagged ? ` ${untagged} Lightning goal${untagged === 1 ? ' has' : 's have'} no scorer yet.` : '');
  }

  async function refreshTotals() {
    const current = game;
    const result = await api('/goal-clips?game_id=' + encodeURIComponent(current));
    if (result.ok && current === game) describe(result.body);
  }

  async function load() {
    const current = ++loads;
    const result = await api('/goal-clips?game_id=' + encodeURIComponent(game));
    if (current !== loads) return;
    if (!result.ok) { list.replaceChildren(); apply.hidden = true; status.textContent = detail(result, 'Could not load goal clips.'); return; }
    let us = 0, them = 0;
    list.replaceChildren(...(result.body.clips as Clip[]).map(clip => {
      clip.team === 'us' ? us++ : them++;
      return card(clip, `Lightning ${us}, opponent ${them}`);
    }));
    describe(result.body);
    if (!uploading) status.textContent = result.body.clips.length ? '' : 'No clips for this game yet.';
  }

  async function upload(file: File, seq: number, team: string) {
    const id = crypto.randomUUID();
    const started = await api('/goal-clips/uploads', { method: 'POST', body: JSON.stringify({ id, game_id: game, seq, team, bytes: file.size }) });
    if (!started.ok) throw new Error(detail(started, 'Could not start the upload.'));
    let offset: number = started.body.received;
    while (offset < file.size) {
      const end = Math.min(file.size, offset + started.body.chunk_bytes);
      let response: Response | null = null;
      // A dropped connection gets one more try at the same position.
      for (let attempt = 0; attempt < 2 && !response?.ok; attempt++) {
        response = await fetch('/api/goal-clips/uploads/' + id + '?offset=' + offset, {
          method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' },
          body: file.slice(offset, end), signal: AbortSignal.timeout(120000),
        }).catch(() => null);
      }
      const body = await response?.json().catch(() => null);
      if (!response?.ok || !(body?.received > offset)) {
        await api('/goal-clips/' + id, { method: 'DELETE' });
        throw new Error(detail({ status: response?.status ?? 0, body }, 'The upload was interrupted.'));
      }
      offset = body.received;
      progress.value = offset / file.size * 100;
    }
    const saved = await api('/goal-clips/uploads/' + id + '/publish', { method: 'POST', signal: AbortSignal.timeout(120000) });
    if (!saved.ok) {
      await api('/goal-clips/' + id, { method: 'DELETE' });
      throw new Error(detail(saved, 'Could not save the clip.'));
    }
  }

  files.addEventListener('change', async () => {
    const chosen = Array.from(files.files ?? []).sort((a, b) => a.name.localeCompare(b.name));
    files.value = '';
    if (!chosen.length || uploading) return;
    const parsed = chosen.map(file => ({ file, match: CLIP_NAME.exec(file.name) }));
    const stray = parsed.find(p => !p.match);
    if (stray) { status.textContent = `“${stray.file.name}” is not a clip from the replay tool. Choose the .mp4 files it wrote.`; return; }
    const other = parsed.find(p => p.match![1] !== game);
    if (other) { status.textContent = `“${other.file.name}” belongs to another game. Select that game at the top first.`; return; }
    if (parsed.some(p => p.file.size === 0 || p.file.size > 100 * 1024 * 1024)) { status.textContent = 'Each clip must be an MP4 up to 100 MB.'; return; }
    uploading = true; files.disabled = true; progress.hidden = false;
    const problems: string[] = [];
    let done = 0;
    for (const { file, match } of parsed) {
      progress.value = 0;
      status.textContent = `Uploading goal ${Number(match![2])} (${done + 1} of ${parsed.length})…`;
      try { await upload(file, Number(match![2]), match![3]); done++; }
      catch (error) { problems.push(`Goal ${Number(match![2])}: ${error instanceof Error ? error.message : 'upload failed.'}`); }
    }
    uploading = false; files.disabled = false; progress.hidden = true;
    await load();
    status.textContent = [`${done} of ${parsed.length} clip${parsed.length === 1 ? '' : 's'} added.`, ...problems].join(' ');
  });

  copy.addEventListener('click', () => {
    const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>('#sheet tbody tr'));
    const field = (row: HTMLElement, name: string) => row.querySelector<HTMLInputElement>(`[data-f="${name}"]`)!;
    const filled = rows.some(row => ['g', 'a', 'plus_minus'].some(name => Number(field(row, name).value || 0) !== 0));
    if (filled && !confirm('Replace the goals, assists and +/− on this scoresheet with the totals from the clips? Penalty minutes are kept.')) return;
    const set = (input: HTMLInputElement, value: number | string) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));   // marks the sheet unsaved
    };
    for (const row of rows) {
      const line = totals[row.dataset.player!] ?? { g: 0, a: 0, plus_minus: 0 };
      set(field(row, 'g'), line.g); set(field(row, 'a'), line.a); set(field(row, 'plus_minus'), line.plus_minus);
    }
    const ours = document.querySelector<HTMLInputElement>('#ourScore')!, theirs = document.querySelector<HTMLInputElement>('#theirScore')!;
    let scoreNote = '';
    if (ours.value === '' && theirs.value === '') { set(ours, score.us); set(theirs, score.them); }
    else if (Number(ours.value) !== score.us || Number(theirs.value) !== score.them)
      scoreNote = ` The score on the sheet (${ours.value || '–'}–${theirs.value || '–'}) differs from the clips (${score.us}–${score.them}); it was left alone.`;
    status.textContent = 'Copied to the scoresheet. Add penalty minutes, check it, then press Save changes.' + scoreNote;
    document.querySelector<HTMLElement>('#save')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // admin.astro announces each scoresheet it loads; the clips follow that game.
  document.addEventListener('sheet:loaded', event => {
    game = (event as CustomEvent<string>).detail;
    if (!uploading) status.textContent = '';
    void load();
  });
}
