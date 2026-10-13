/**
 * iCalendar (RFC 5545) generation for game and practice events.
 *
 * Hand-rolled because the rules that actually matter here are few: escape the
 * text values, fold long lines at 75 octets, and emit UTC stamps. Getting any
 * of those wrong produces a file that imports silently wrong, or not at all.
 */
import { sides, team, type GameEvent, type PracticeEvent } from "./data";

const PRODID = "-//Lewisville Lightning//lvlnb.ca//EN";
/** Minor-hockey ice slots run about 90 minutes when no end time is given. */
const DEFAULT_MINUTES = 90;

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newline are special. */
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** §3.1: lines are folded at 75 octets, continuations begin with one space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (out.length === 0 ? 75 : 74), bytes.length);
    // never split a multi-byte character
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((out.length ? " " : "") + bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return out.join("\r\n");
}

/** 2026-10-13T17:30:00-03:00 -> 20261013T203000Z */
const utc = (iso: string) =>
  new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const plus = (iso: string, minutes: number) =>
  utc(new Date(new Date(iso).getTime() + minutes * 60_000).toISOString());

export function eventLines(e: GameEvent | PracticeEvent, stamp: string): string[] {
  const isGame = e.type === "game";
  const s = isGame ? sides(e as GameEvent) : null;

  const summary = isGame
    ? `${team.name} ${s!.weAreHome ? "vs" : "@"} ${s!.them.short}`
    : `${team.name} practice`;

  const detail: string[] = [];
  if (isGame) {
    detail.push(s!.weAreHome ? "Home game" : "Away game");
    const g = e as GameEvent;
    if (g.gameType && g.gameType !== "regular") detail.push(`${g.gameType} game`);
    if (g.league) detail.push(g.league);
  }
  if (e.notes) detail.push(e.notes);
  detail.push(`https://lvlnb.ca/schedule/${e.id}`);

  const lines = [
    "BEGIN:VEVENT",
    `UID:${e.id}@lvlnb.ca`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${utc(e.startsAt)}`,
    `DTEND:${e.endsAt ? utc(e.endsAt) : plus(e.startsAt, DEFAULT_MINUTES)}`,
    `SUMMARY:${esc(summary)}`,
    `LOCATION:${esc(e.venue.name)}`,
    `DESCRIPTION:${esc(detail.join("\n"))}`,
    `URL:https://lvlnb.ca/schedule/${e.id}`,
    // cancelled events still export, so a calendar that already has them updates
    `STATUS:${e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    // Hockey means arriving early to dress; an hour's warning is the useful one.
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(summary)}`,
    "TRIGGER:-PT60M",
    "END:VALARM",
    "END:VEVENT",
  ];
  return lines;
}

export function calendar(events: (GameEvent | PracticeEvent)[], name: string): string {
  // A fixed stamp would be wrong, but it must not change per request either;
  // build time is the honest answer for a static file.
  const stamp = utc(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    "X-WR-TIMEZONE:America/Moncton",
    ...events.flatMap((e) => eventLines(e, stamp)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export const icsHeaders = (filename: string) => ({
  "content-type": "text/calendar; charset=utf-8",
  "content-disposition": `attachment; filename="${filename}"`,
});
