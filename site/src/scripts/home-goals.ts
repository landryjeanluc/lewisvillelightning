type TeamGoal = {
  id: number; title: string; scope: string; target: number; total: number;
  unit: string; starts_on: string; ends_on: string; archived: boolean;
};
type GoalBoard = { today: string; goals: TeamGoal[]; admin: boolean };
const root = document.querySelector<HTMLElement>('[data-home-goals]')!;
const bars = [...root.querySelectorAll<HTMLElement>('[data-goal-bar]')];
const select = root.querySelector<HTMLSelectElement>('[data-goals-select]')!;
const picker = root.querySelector<HTMLElement>('[data-goals-picker]')!;
const notice = root.querySelector<HTMLElement>('[data-goals-notice]')!;
const retry = root.querySelector<HTMLButtonElement>('[data-goals-retry]')!;
const preview = root.querySelector<HTMLButtonElement>('[data-goals-preview]')!;
const link = root.querySelector<HTMLAnchorElement>('[data-goals-link]')!;
const format = new Intl.NumberFormat('en-CA');
const date = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'America/Moncton' });
let goals: TeamGoal[] = [];
let loading = false;
let failed = false;
const text = (bar: HTMLElement, name: string, value: string) => { bar.querySelector<HTMLElement>(`[data-goal-${name}]`)!.textContent = value; };

function paint(goal: TeamGoal | null, message = 'No active team goal', demo = false) {
  for (const bar of bars) {
    const progress = bar.querySelector<HTMLElement>('[data-goal-progress]')!;
    const pct = goal ? Math.min(100, Math.max(0, goal.total / goal.target * 100)) : 0;
    const complete = !!goal && goal.total >= goal.target;
    bar.style.setProperty('--progress', `${pct}%`);
    bar.classList.toggle('is-complete', complete);
    text(bar, 'title', goal?.title || message);
    text(bar, 'percent', goal ? String(complete ? 100 : Math.floor(pct)) : '—');
    text(bar, 'total', goal ? format.format(goal.total) : '—');
    text(bar, 'target', goal ? ` / ${format.format(goal.target)} ${goal.unit}` : ' / No target set');
    text(bar, 'status', demo ? 'Sample progress' : !goal ? 'Ready for a challenge' : complete ? 'Goal reached!' : 'In progress');
    text(bar, 'remaining', goal ? complete ? 'Target reached. Keep it going!' : `${format.format(goal.target - goal.total)} ${goal.unit} to go. Every player counts.` : 'Set a team goal and start building together.');
    text(bar, 'deadline', goal && !demo ? `Through ${date.format(new Date(goal.ends_on + 'T12:00:00Z'))}` : '');
    progress.setAttribute('aria-valuenow', String(pct));
    progress.setAttribute('aria-valuetext', goal ? `${demo ? 'Design preview: ' : ''}${format.format(goal.total)} of ${format.format(goal.target)} ${goal.unit}` : message);
  }
}

function showSelected() {
  paint(goals.find(g => String(g.id) === select.value) || goals[0]);
}

async function load() {
  if (loading) return;
  loading = true;
  failed = false;
  retry.hidden = true;
  try {
    const response = await fetch('/api/goals', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (response.status === 401) {
      goals = []; picker.hidden = true; preview.hidden = true; preview.setAttribute('aria-pressed', 'false');
      paint(null, 'Your team’s next challenge');
      for (const bar of bars) {
        text(bar, 'target', ' / Sign in to view');
        text(bar, 'status', 'Team access');
        text(bar, 'remaining', 'See the team’s challenge and add your activity.');
      }
      notice.textContent = 'Sign in to see the team’s progress.';
      link.href = '/login?next=/goals'; link.textContent = 'Sign in ↗';
      return;
    }
    if (!response.ok) throw new Error('Goals unavailable');
    const board: GoalBoard = await response.json();
    if (!Array.isArray(board.goals) || !/^\d{4}-\d{2}-\d{2}$/.test(board.today)) throw new Error('Invalid goals');
    // Only current, shared targets belong on the homepage. Never combine unlike
    // units or show a player's private goal in a team progress banner.
    goals = board.goals.filter(g => g.scope === 'team' && !g.archived && g.starts_on <= board.today && g.ends_on >= board.today && Number.isFinite(g.target) && g.target > 0 && Number.isFinite(g.total) && g.total >= 0)
      .sort((a, b) => a.ends_on.localeCompare(b.ends_on) || a.id - b.id);
    const previous = select.value;
    select.replaceChildren(...goals.map(g => new Option(g.title, String(g.id))));
    if (goals.some(g => String(g.id) === previous)) select.value = previous;
    picker.hidden = goals.length < 2;
    preview.hidden = goals.length > 0;
    preview.setAttribute('aria-pressed', 'false'); preview.textContent = 'Preview both styles';
    link.href = '/goals'; link.textContent = 'Team goals ↗';
    if (goals.length) {
      showSelected(); notice.textContent = 'Two looks. The same team effort. Log your activity in Goals.';
    } else {
      paint(null);
      notice.textContent = board.admin ? 'Set your next team challenge in Goals, or preview the two styles below.' : 'Your coach can set the next team challenge. Preview the two styles below.';
    }
  } catch {
    // The preview is sample data drawn in the page, so it is the one part of
    // this that still works with no API answering — which is every local dev
    // run, and precisely when comparing the two designs is all there is to do.
    // Hiding it here left the bars dead and the comparison impossible.
    goals = []; failed = true; picker.hidden = true;
    preview.hidden = false; preview.setAttribute('aria-pressed', 'false');
    preview.textContent = 'Preview both styles';
    paint(null, 'Team progress unavailable');
    for (const bar of bars) {
      text(bar, 'target', ' / Progress unavailable');
      text(bar, 'status', 'Check back shortly');
      text(bar, 'remaining', 'Open Goals to check your latest progress.');
    }
    notice.textContent = 'Couldn’t load goals. Please try again.'; retry.hidden = false;
  } finally { loading = false; }
}

select.addEventListener('change', showSelected);
retry.addEventListener('click', () => void load());
preview.addEventListener('click', () => {
  const show = preview.getAttribute('aria-pressed') !== 'true';
  preview.setAttribute('aria-pressed', String(show));
  preview.textContent = show ? 'Close design preview' : 'Preview both styles';
  // Closing it after a failed load must not claim there is simply no goal —
  // go back and find out what the real state is.
  if (!show && failed) { void load(); return; }
  paint(show ? { id: 0, title: '1,000 shots. One team.', scope: 'team', target: 1000, total: 650, unit: 'shots', starts_on: '', ends_on: '', archived: false } : null, undefined, show);
  notice.textContent = show ? 'Design preview only · 650 of 1,000 shots is sample progress.' : 'No active team goal yet. Your next challenge starts in Goals.';
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
void load();
