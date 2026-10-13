import { periodLabel, type Score } from '../lib/scoreboard';
import { api } from './api-client';
import { md } from './live';
for (const section of document.querySelectorAll<HTMLElement>('[data-game-updates]')) {
  const gid = encodeURIComponent(section.dataset.gameUpdates!);
  const status = section.querySelector<HTMLElement>('[data-game-status]')!;
  async function load() {
    const [scores, notes, jobs, identity] = await Promise.all([
      api(`/stats/game/${gid}`), api(`/notes/${gid}`), api(`/jobs/${gid}`), api('/auth/me'),
    ]);
    if (![scores, notes, jobs, identity].every(result => result.ok)) {
      status.textContent = 'Game updates could not load. Please reload to try again.'; return;
    }
    const result = scores.body.result;
    const score = section.querySelector<HTMLElement>('[data-game-score]')!;
    score.hidden = !result;
    if (result) score.textContent = `${result.status.replaceAll('_', ' ')} · Lightning ${result.our_score ?? '—'} – Opponent ${result.their_score ?? '—'}`;
    const noteList = section.querySelector<HTMLElement>('[data-game-notes]')!;
    noteList.replaceChildren();
    for (const [kind, note] of Object.entries(notes.body as Record<string,{body:string}>)) {
      const heading = document.createElement('h3'); heading.textContent = kind === 'preview' ? 'Before the game' : 'Game recap';
      const body = document.createElement('div'); body.innerHTML = md(note.body);
      noteList.append(heading, body);
    }
    const jobsSection = section.querySelector<HTMLElement>('[data-game-jobs]')!;
    const list = jobsSection.querySelector('ul')!; list.replaceChildren();
    jobsSection.hidden = jobs.body.length === 0;
    const user = identity.body;
    for (const job of jobs.body) {
      const item = document.createElement('li');
      const title = document.createElement('strong'); title.textContent = job.name;
      const detail = document.createElement('p');
      detail.textContent = `${job.family || 'Unassigned'}${job.claimed_by ? ` · Claimed by ${job.claimed_by}` : ' · Not claimed'}`;
      item.append(title, detail);
      if (job.note) { const note = document.createElement('p'); note.textContent = job.note; item.append(note); }
      const eligible = user && (user.role === 'admin' || (user.role === 'parent' && user.player_id && user.player_id === job.player_id));
      if (eligible && (user.role === 'admin' || !job.claimed_by_id || job.claimed_by_id === user.id)) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost';
        button.textContent = job.claimed_by_id ? 'Release job' : 'Claim job';
        button.addEventListener('click', async () => {
          button.disabled = true;
          const result = await api(`/jobs/${gid}/${job.job_type_id}/claim${job.claimed_by_id ? '?release=true' : ''}`, {method:'POST'});
          if (result.ok) await load();
          else { status.textContent = typeof result.body?.detail === 'string' ? result.body.detail : 'Could not update this job.'; button.disabled = false; }
        });
        item.append(button);
      }
      list.append(item);
    }
    status.textContent = result || noteList.childElementCount || jobs.body.length ? '' : 'No updates yet.';
  }
  document.addEventListener('scoreboard:updated', ((event:CustomEvent<Score[]>) => {
    const result=event.detail.find(g=>g.game_id===section.dataset.gameUpdates);
    if(!result) return;
    const score=section.querySelector<HTMLElement>('[data-game-score]')!;
    score.hidden=!['in_progress','final'].includes(result.status);
    score.textContent=`${result.status==='final'?'Final':periodLabel(result.period)} · Lightning ${result.our_score ?? '—'} – Opponent ${result.their_score ?? '—'}`;
  }) as EventListener);
  void load();
}
