import { initGoalEditor } from './goal-editor';

type Goal = {
  id: number; title: string; scope: 'team' | 'player'; player_id: string | null;
  unit: 'shots' | 'reps' | 'minutes' | 'seconds'; target: number; starts_on: string;
  ends_on: string; archived: boolean; total: number; family_total: number;
};
type Board = { goals: Goal[]; players: { id: string; name: string; number: number }[];
  admin: boolean; today: string; player_id: string | null };
type Entry = { id: number; player_id: string; amount: number; performed_on: string; recorded_by: string };
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
const logDialog = $<HTMLDialogElement>('#goal-log');
const historyDialog = $<HTMLDialogElement>('#goal-activity');
const logForm = $<HTMLFormElement>('#goal-log-form');
let board: Board;
let scope = 'team';
let logSource: 'manual' | 'shots' | 'timer' = 'manual';
let pending: { signature: string; id: string } | null = null;
let logBusy = false;
let shots = 0;
let shotSteps: number[] = [];
let elapsed = 0;
let started: number | null = null;
let activeHistory: Goal | null = null;
const fmt = (n: number) => n.toLocaleString();
const dateLabel = (s: string) => new Date(s + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function action(text: string, fn: () => void, className = 'ghost') {
  const el = node('button', text, className); el.type = 'button'; el.addEventListener('click', fn); return el;
}
function message(text: string) { $('#goals-message').textContent = text; }
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/goals' + path, { method, signal: AbortSignal.timeout(15000), credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  if (response.status === 401) {
    $('#goals-content').hidden = true; $('#goals-gate').hidden = false;
    throw new Error('Your session has ended. Sign in again to continue.');
  }
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : 'Could not save. Check the fields and try again.');
  return data as T;
}
function errorText(e: unknown) { return e instanceof Error ? e.message : 'Something went wrong. Please try again.'; }
function writable(g: Goal) {
  return !g.archived && g.starts_on <= board.today && board.players.some(p => g.scope === 'team' || g.player_id === p.id);
}
function toolEligible(g: Goal, source: typeof logSource) {
  return writable(g) && (source === 'manual' || (g.ends_on >= board.today &&
    (source === 'shots' ? g.unit === 'shots' : g.unit === 'minutes' || g.unit === 'seconds')));
}
function playerName(id: string | null) { return board.players.find(p => p.id === id)?.name || 'Player'; }
function render() {
  $('#personal-tab').textContent = board.admin ? 'Player goals' : 'My goals';
  const past = $<HTMLInputElement>('#goal-history').checked;
  const goals = board.goals.filter(g => g.scope === scope && (past ? g.archived || g.ends_on < board.today : !g.archived && g.ends_on >= board.today));
  $('#goals-context').textContent = scope === 'team'
    ? 'One shared target. Every player’s contribution helps the team get there.'
    : board.admin ? 'Individual targets. Each player has their own progress.'
    : board.player_id ? `Goals for ${playerName(board.player_id)}. Players and parents share the same progress.`
    : 'Your account is not linked to a player. Ask an admin to link it to see and update personal goals.';
  $('#goals-empty').hidden = goals.length > 0;
  $('#goals-empty-text').textContent = past ? 'Finished and archived goals will appear here.' : board.admin ? 'Set a shared team target or an individual goal in Admin → Goals.' : 'Your coach can set a goal for the next challenge.';
  const grid = $('#goal-grid'); grid.replaceChildren();
  for (const g of goals) {
    const complete = g.total >= g.target;
    const card = node('article', '', 'card goal-card' + (complete ? ' is-complete' : ''));
    card.dataset.goal = String(g.id);
    const top = node('div', '', 'goal-card-top');
    top.append(node('span', g.scope === 'team' ? 'Together as a team' : playerName(g.player_id), 'eyebrow'));
    top.append(node('span', g.archived ? 'Archived' : complete ? 'Goal reached ✓' : g.starts_on > board.today ? 'Upcoming' : g.ends_on < board.today ? 'Finished' : 'In progress', 'goal-status'));
    const total = node('div', '', 'goal-total');
    total.append(node('strong', fmt(g.total)), node('span', `/ ${fmt(g.target)} ${g.unit}`, 'muted'));
    const progress = node('progress'); progress.max = g.target; progress.value = Math.min(g.total, g.target);
    progress.setAttribute('aria-label', `${g.title}: ${g.total} of ${g.target} ${g.unit}`);
    card.append(top, node('h2', g.title), node('p', `${dateLabel(g.starts_on)} – ${dateLabel(g.ends_on)}`, 'dim'), total, progress);
    card.append(node('p', complete ? 'Target reached. Keep building on it!' : `${fmt(g.target - g.total)} ${g.unit} to go`, 'muted'));
    if (g.scope === 'team' && board.player_id) card.append(node('p', `Your contribution: ${fmt(g.family_total)} ${g.unit}`, 'dim'));
    const actions = node('div', '', 'tool-actions');
    if (writable(g)) actions.append(action('Log activity', () => openLog('manual', g), ''));
    if (board.admin || board.player_id) actions.append(action('Activity', () => void showHistory(g)));
    if (board.admin) actions.append(action('Edit goal', () => goalEditor.open(board, g), 'link'));
    card.append(actions); grid.append(card);
  }
  paintTools();
}
async function refresh() { board = await api<Board>(''); render(); }
async function boot() {
  $('#goals-retry').hidden = true;
  try {
    await refresh(); $('#goals-content').hidden = false; $('#goals-gate').hidden = true; message('');
  } catch (e) { message(errorText(e)); $('#goals-retry').hidden = false; }
}
function options(select: HTMLInputElement | HTMLSelectElement, values: { value: string; label: string }[]) {
  select.replaceChildren(...values.map(v => { const o = node('option', v.label); o.value = v.value; return o; }));
}
const goalEditor = initGoalEditor({
  save: (path, method, body) => api(path, method, body),
  onSaved: async () => {
    message('Goal updated.');
    try { await refresh(); } catch { message('Goal saved. Refresh the page to load the updated board.'); }
  },
});

function timerMs() { return elapsed + (started === null ? 0 : Date.now() - started); }
function pauseTimer() { if (started !== null) { elapsed = timerMs(); started = null; paintTools(); } }
function syncLogGoal() {
  const g = board.goals.find(g => g.id === Number(field(logForm, 'goal_id').value));
  if (!g) return;
  options(field(logForm, 'player_id'), board.players.filter(p => g.scope === 'team' || g.player_id === p.id).map(p => ({ value: p.id, label: p.name })));
  const date = field(logForm, 'performed_on') as HTMLInputElement;
  date.min = g.starts_on; date.max = g.ends_on < board.today ? g.ends_on : board.today;
  date.value = date.max;
  const amount = field(logForm, 'amount') as HTMLInputElement;
  amount.readOnly = logSource !== 'manual';
  if (logSource === 'shots') amount.value = String(shots);
  if (logSource === 'timer') amount.value = String(Math.floor(timerMs() / (g.unit === 'minutes' ? 60000 : 1000)));
  $('#goal-amount-label').firstChild!.textContent = `Amount (${g.unit})`;
  $('#goal-log-help').textContent = logSource === 'timer'
    ? `Only whole ${g.unit} are saved. Any remaining time stays on your timer.`
    : 'Add just this session’s activity. This saves to the selected goal only.';
}
function openLog(source: typeof logSource, goal?: Goal) {
  logSource = source; logForm.reset(); logForm.querySelector('.goal-error')!.textContent = '';
  if (source === 'timer') pauseTimer();
  const eligible = board.goals.filter(g => toolEligible(g, source));
  if (!eligible.length) { message(`There are no available ${source === 'shots' ? 'shot' : source === 'timer' ? 'timed' : ''} goals for your player.`); return; }
  options(field(logForm, 'goal_id'), eligible.map(g => ({ value: String(g.id), label: `${g.title} · ${g.scope === 'team' ? 'Team' : playerName(g.player_id)} · ${dateLabel(g.starts_on)}` })));
  if (goal) field(logForm, 'goal_id').value = String(goal.id);
  syncLogGoal(); logDialog.showModal();
}
logForm.addEventListener('submit', async e => {
  e.preventDefault(); if (logBusy) return;
  const gid = field(logForm, 'goal_id').value;
  const body = { player_id: field(logForm, 'player_id').value, amount: Number(field(logForm, 'amount').value), performed_on: field(logForm, 'performed_on').value };
  const signature = JSON.stringify({ gid, ...body });
  // Preserve the UUID across a network failure, so retry cannot double count.
  if (pending?.signature !== signature) pending = { signature, id: crypto.randomUUID() };
  const controls = [...logForm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')];
  logBusy = true; controls.forEach(c => c.disabled = true);
  try {
    const result = await api<{ removed?: boolean }>(`/${gid}/entries`, 'POST', { ...body, client_id: pending.id });
    if (logSource === 'shots') { shots = Math.max(0, shots - body.amount); shotSteps = []; }
    if (logSource === 'timer') {
      const unit = board.goals.find(g => g.id === Number(gid))!.unit;
      elapsed = Math.max(0, elapsed - body.amount * (unit === 'minutes' ? 60000 : 1000));
    }
    pending = null; logDialog.close(); paintTools();
    message(result.removed ? 'This activity was already saved and later removed. It has not been added again.' : `Saved ${fmt(body.amount)} ${board.goals.find(g => g.id === Number(gid))!.unit}. Nice work!`);
    try { await refresh(); } catch { message('Activity saved. Refresh the page to see your updated progress.'); }
  } catch (err) { logForm.querySelector('.goal-error')!.textContent = errorText(err); }
  finally { logBusy = false; controls.forEach(c => c.disabled = false); }
});
async function showHistory(g: Goal) {
  activeHistory = g; $('#goal-activity-title').textContent = g.title;
  $('#goal-activity-list').textContent = 'Loading activity…'; historyDialog.querySelector('.goal-error')!.textContent = '';
  if (!historyDialog.open) historyDialog.showModal();
  try {
    const entries = await api<Entry[]>(`/${g.id}/entries`);
    if (activeHistory?.id !== g.id) return;
    const list = $('#goal-activity-list'); list.replaceChildren();
    if (!entries.length) list.textContent = board.admin ? 'No activity logged yet.' : 'No activity logged for your player yet.';
    for (const entry of entries) {
      const row = node('div', '', 'goal-entry'); const text = node('div');
      text.append(node('strong', `${fmt(entry.amount)} ${g.unit} · ${playerName(entry.player_id)}`), node('p', `${dateLabel(entry.performed_on)} · Logged by ${entry.recorded_by}`, 'dim'));
      const remove = action('Remove', async () => {
        if (!confirm(`Remove this entry of ${entry.amount} ${g.unit}?`)) return;
        remove.disabled = true;
        try { await api(`/${g.id}/entries/${entry.id}`, 'DELETE'); await showHistory(g); await refresh(); }
        catch (err) { historyDialog.querySelector('.goal-error')!.textContent = errorText(err); }
        finally { remove.disabled = false; }
      }, 'link');
      row.append(text, remove); list.append(row);
    }
  } catch (err) { $('#goal-activity-list').textContent = ''; historyDialog.querySelector('.goal-error')!.textContent = errorText(err); }
}
function paintTools() {
  $('#shot-count').textContent = fmt(shots);
  $<HTMLButtonElement>('#shot-undo').disabled = !shotSteps.length;
  $<HTMLButtonElement>('#shot-save').disabled = shots < 1 || !board?.goals.some(g => toolEligible(g, 'shots'));
  const secs = Math.floor(timerMs() / 1000);
  $('#timer-count').textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  $('#timer-toggle').textContent = started === null ? (elapsed ? 'Resume timer' : 'Start timer') : 'Pause timer';
  $('#timer-state').textContent = started !== null ? 'Session in progress' : elapsed ? 'Paused · ready to log' : 'Ready when you are';
  $<HTMLButtonElement>('#timer-save').disabled = !board?.goals.some(g => toolEligible(g, 'timer') && secs >= (g.unit === 'minutes' ? 60 : 1));
}
for (const el of document.querySelectorAll<HTMLButtonElement>('[data-scope]')) el.addEventListener('click', () => {
  scope = el.dataset.scope!;
  document.querySelectorAll('[data-scope]').forEach(b => b.setAttribute('aria-pressed', String(b === el))); render();
});
$('#goal-history').addEventListener('change', render);
$('#goals-retry').addEventListener('click', () => void boot());
field(logForm, 'goal_id').addEventListener('change', syncLogGoal);
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-close]')) b.addEventListener('click', () => b.closest('dialog')!.close());
logDialog.addEventListener('cancel', e => { if (logBusy) e.preventDefault(); });
$('#shot-add').addEventListener('click', () => { shots++; shotSteps.push(1); paintTools(); });
$('#shot-ten').addEventListener('click', () => { shots += 10; shotSteps.push(10); paintTools(); });
$('#shot-undo').addEventListener('click', () => { shots -= shotSteps.pop() || 0; paintTools(); });
$('#shot-reset').addEventListener('click', () => { if (!shots || confirm('Clear the unsaved shot count?')) { shots = 0; shotSteps = []; paintTools(); } });
$('#shot-save').addEventListener('click', () => openLog('shots'));
$('#timer-toggle').addEventListener('click', () => { if (started === null) started = Date.now(); else pauseTimer(); paintTools(); });
$('#timer-reset').addEventListener('click', () => { if (!timerMs() || confirm('Clear the unsaved timer?')) { elapsed = 0; started = null; paintTools(); } });
$('#timer-save').addEventListener('click', () => openLog('timer'));
setInterval(() => { if (started !== null) paintTools(); }, 250);
window.addEventListener('beforeunload', e => { if (shots || timerMs() >= 1000 || logBusy) { e.preventDefault(); e.returnValue = ''; } });
void boot();
