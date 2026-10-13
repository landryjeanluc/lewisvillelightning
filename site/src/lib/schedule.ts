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
