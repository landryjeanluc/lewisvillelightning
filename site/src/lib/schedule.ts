/** Shared practice labels and runtime upcoming selection; no private data imports. */
export function practiceLabel(event: { practiceKind?: string }): string {
  return event.practiceKind === 'off_ice' ? 'Off-ice practice' : 'Ice practice';
}
export type UpcomingEvent = {id:string; startsAt:string; endsAt:string|null; status:string};
export function upcomingEvents<T extends UpcomingEvent>(events:T[], now = Date.now()): T[] {
  return events.filter(event => !['cancelled','postponed','final'].includes(event.status)
    && new Date(event.endsAt ?? new Date(new Date(event.startsAt).getTime() + 90 * 60000).toISOString()).getTime() > now)
    .sort((a,b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/** The team streams its games on YouTube. Tournament games the team enters in
 *  Spordle itself arrive as practices whose note starts with "Game". */
export function isStreamed(event: {type:string; notes?:string|null}): boolean {
  return event.type === 'game' || /^\s*game\b/i.test(event.notes ?? '');
}
export type StreamEvent = {id:string; startsAt:string; status:string; stream:boolean};
/** The streamed event that is on the air around `now`: from 20 minutes before
 *  the start until 2.5 hours after it, or while its saved status is in_progress. */
export function onAirEvent<T extends StreamEvent>(events:T[], now = Date.now()): T | undefined {
  return events.filter(e => e.stream && !['cancelled','postponed'].includes(e.status))
    .sort((a,b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .find(e => {
      if (e.status === 'in_progress') return true;
      if (e.status === 'final') return false;
      const start = Date.parse(e.startsAt);
      return now >= start - 20 * 60000 && now <= start + 150 * 60000;
    });
}
/** The next streamed event later today (local time), for a "live at 6:30" hint. */
export function laterTodayStream<T extends StreamEvent>(events:T[], now = Date.now()): T | undefined {
  const day = new Date(now).toDateString();
  return events.filter(e => e.stream && e.status === 'scheduled' && Date.parse(e.startsAt) > now
      && new Date(e.startsAt).toDateString() === day)
    .sort((a,b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
}
