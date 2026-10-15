import { upcomingEvents, type UpcomingEvent } from '../lib/schedule';
import { isToday, relativeDay } from '../lib/format';
import type { Score } from '../lib/scoreboard';

const source = document.querySelector('#home-events');
if (source) {
  const events: (UpcomingEvent & {type:string})[] = JSON.parse(source.textContent ?? '[]');
  let statuses = new Map<string, string>();
  function refresh() {
    const now = new Date();
    const upcoming = upcomingEvents(events.map(e => ({...e, status:statuses.get(e.id) ?? e.status})), now.getTime());
    const game = upcoming.find(e => e.type === 'game');
    const practice = upcoming.find(e => e.type === 'practice');
    for (const hero of document.querySelectorAll<HTMLElement>('[data-home-game]')) {
      hero.hidden = hero.dataset.homeGame !== game?.id;
      if (!hero.hidden && game) hero.querySelector('[data-home-game-title]')!.textContent = isToday(game.startsAt, now) ? 'Game Day' : 'Next Game';
    }
    document.querySelector<HTMLElement>('[data-home-empty]')!.hidden = Boolean(game);
    for (const el of document.querySelectorAll<HTMLElement>('[data-home-spotlight]')) el.hidden = el.dataset.homeSpotlight !== game?.id;
    for (const el of document.querySelectorAll<HTMLElement>('[data-home-practice]')) el.hidden = el.dataset.homePractice !== practice?.id;
    const rest = upcoming.filter(e => e.id !== game?.id).slice(0, 8);
    for (const el of document.querySelectorAll<HTMLElement>('[data-home-event]')) {
      const event = rest.find(e => e.id === el.dataset.homeEvent);
      el.hidden = !event;
      const relative = el.querySelector('.when');
      if (relative && event) relative.textContent = relativeDay(event.startsAt, now);
    }
    document.querySelector<HTMLElement>('[data-home-upcoming-empty]')!.hidden = rest.length > 0;
  }
  document.addEventListener('scoreboard:updated', ((event: CustomEvent<Score[]>) => {
    statuses = new Map(event.detail.map(g => [g.game_id, g.status]));
    refresh();
  }) as EventListener);
  refresh();
  setInterval(refresh, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('pageshow', refresh);
}
