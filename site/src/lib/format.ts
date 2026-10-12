/**
 * Every date on this site renders in the team's own timezone, never the
 * build machine's or the visitor's. A parent reading "5:30 PM" must get the
 * time the puck actually drops in Moncton.
 */
export const TZ = "America/Moncton";

const fmt = (opts: Intl.DateTimeFormatOptions, locale = "en-CA") =>
  new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts });

const d = (iso: string) => new Date(iso);

/** "Tuesday, October 13, 2026" */
export const longDate = (iso: string) =>
  fmt({ weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(d(iso));

/** "Tue, Oct 13" */
export const shortDate = (iso: string) =>
  fmt({ weekday: "short", month: "short", day: "numeric" }).format(d(iso));

/** "5:30 PM" — en-CA yields a narrow-space "5:30 p.m."; the scoreboard spells it PM. */
export const time = (iso: string) =>
  fmt({ hour: "numeric", minute: "2-digit", hour12: true })
    .format(d(iso))
    .replace(/[\s\u202f\u00a0]+/g, " ")
    .replace(/\./g, "")
    .trim()
    .toUpperCase();

/** "OCT" / "13" for calendar-chip layouts */
export const monthAbbr = (iso: string) =>
  fmt({ month: "short" }).format(d(iso)).toUpperCase();
export const dayNum = (iso: string) => fmt({ day: "numeric" }).format(d(iso));
export const weekdayAbbr = (iso: string) =>
  fmt({ weekday: "short" }).format(d(iso)).toUpperCase();

/** Whole-day difference in the team's timezone, so "today" means today there. */
function dayIndex(iso: string): number {
  const parts = fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Math.floor(Date.UTC(get("year"), get("month") - 1, get("day")) / 86400000);
}

/** "Today" · "Tomorrow" · "In 4 days" · "Sat, Nov 7" */
export function relativeDay(iso: string, now = new Date()): string {
  const delta = dayIndex(iso) - dayIndex(now.toISOString());
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  if (delta > 1 && delta < 7) return `In ${delta} days`;
  if (delta < -1 && delta > -7) return `${-delta} days ago`;
  return shortDate(iso);
}

export const isToday = (iso: string, now = new Date()) =>
  dayIndex(iso) === dayIndex(now.toISOString());

/** ISO-8601 for <time datetime> and calendar exports. */
export const machine = (iso: string) => new Date(iso).toISOString();

/** Percentage like .918 → ".918"; GAA like 2.4 → "2.40" */
export const svPct = (v: number | null) => (v === null ? "—" : v.toFixed(3).replace(/^0/, ""));
export const gaa = (v: number | null) => (v === null ? "—" : v.toFixed(2));
