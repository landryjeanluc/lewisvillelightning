import {
  opponentsSchema, scheduleSchema, rosterSchema, statsSchema, newsSchema,
  type GameEvent, type PracticeEvent, type Player, type Team,
} from "./schema";

import opponentsRaw from "../../../data/opponents.json";
import scheduleRaw from "../../../data/schedule.json";
import rosterRaw from "../../../data/roster.json";
import statsRaw from "../../../data/stats.json";
import newsRaw from "../../../data/news.json";
import teamRaw from "../../../team.json";

/** Parse with a message that names the file and the exact JSON path that failed. */
function parse<T>(schema: { safeParse: (v: unknown) => any }, raw: unknown, file: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues
      .map((i: any) => `  data/${file} → ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `\n\nInvalid ${file} — it does not match docs/DATA-CONTRACT.md:\n${lines}\n`,
    );
  }
  return r.data as T;
}

export const opponents = parse<any>(opponentsSchema, opponentsRaw, "opponents.json");
export const schedule  = parse<any>(scheduleSchema,  scheduleRaw,  "schedule.json");
export const roster    = parse<any>(rosterSchema,    rosterRaw,    "roster.json");
export const stats     = parse<any>(statsSchema,     statsRaw,     "stats.json");
export const news      = parse<any>(newsSchema,      newsRaw,      "news.json");
export const team = teamRaw as {
  name: string; division: string; level: string; home_arena: string;
  association_website: string;
};

/** Our own team id, the anchor every home/away decision hangs off. */
export const US = "lewisville-lightning";

/* ------------------------------------------------- referential integrity */

const teamsById = new Map<string, Team>(opponents.teams.map((t: Team) => [t.id, t]));
const playersById = new Map<string, Player>(roster.players.map((p: Player) => [p.id, p]));

{
  const bad: string[] = [];
  for (const e of schedule.events) {
    if (e.type !== "game") continue;
    for (const side of ["home", "away"] as const) {
      const id = (e as GameEvent)[side].teamId;
      if (!teamsById.has(id)) bad.push(`schedule.json → event ${e.id}: ${side}.teamId "${id}" is not in opponents.json`);
    }
  }
  for (const s of [...stats.skaters, ...stats.goalies]) {
    if (!playersById.has(s.playerId)) bad.push(`stats.json → playerId "${s.playerId}" is not in roster.json`);
  }
  if (!teamsById.has(US)) bad.push(`opponents.json is missing our own team entry "${US}"`);
  if (bad.length) throw new Error(`\n\nData cross-reference failed:\n  ${bad.join("\n  ")}\n`);
}

export const getTeam = (id: string): Team => teamsById.get(id)!;
export const getPlayer = (id: string): Player | undefined => playersById.get(id);

/* ------------------------------------------------------------- schedule */

export const games: GameEvent[] = schedule.events
  .filter((e: any): e is GameEvent => e.type === "game")
  .sort((a: GameEvent, b: GameEvent) => a.startsAt.localeCompare(b.startsAt));

export const practices: PracticeEvent[] = schedule.events
  .filter((e: any): e is PracticeEvent => e.type === "practice")
  .sort((a: PracticeEvent, b: PracticeEvent) => a.startsAt.localeCompare(b.startsAt));

export const allEvents = [...schedule.events].sort((a: any, b: any) =>
  a.startsAt.localeCompare(b.startsAt),
);

const isUpcoming = (e: { startsAt: string; status: string }, now: Date) =>
  new Date(e.startsAt) >= now && e.status !== "cancelled";

export function nextGame(now = new Date()): GameEvent | undefined {
  return games.find((g) => isUpcoming(g, now));
}
export function nextPractice(now = new Date()): PracticeEvent | undefined {
  return practices.find((p) => isUpcoming(p, now));
}
export function upcoming(now = new Date(), limit = 8) {
  return allEvents.filter((e: any) => isUpcoming(e, now)).slice(0, limit);
}
export function results(now = new Date(), limit = 8): GameEvent[] {
  return games
    .filter((g) => g.status === "final" || new Date(g.startsAt) < now)
    .reverse()
    .slice(0, limit);
}

/** Lewisville's side of a game, and the team we're facing. */
export function sides(g: GameEvent) {
  const weAreHome = g.home.teamId === US;
  return {
    weAreHome,
    us: getTeam(weAreHome ? g.home.teamId : g.away.teamId),
    them: getTeam(weAreHome ? g.away.teamId : g.home.teamId),
    ourScore: weAreHome ? g.home.score : g.away.score,
    theirScore: weAreHome ? g.away.score : g.home.score,
    /** Poster + scoreboard convention: away on the left, home on the right. */
    left: getTeam(g.away.teamId),
    right: getTeam(g.home.teamId),
  };
}

/** "W 2-1" / "L 0-3" / "T 2-2", or null when the game has no final score. */
export function outcome(g: GameEvent): { result: "W" | "L" | "T"; label: string } | null {
  const { ourScore, theirScore } = sides(g);
  if (g.status !== "final" || ourScore === null || theirScore === null) return null;
  const result = ourScore > theirScore ? "W" : ourScore < theirScore ? "L" : "T";
  return { result, label: `${result} ${ourScore}-${theirScore}` };
}

/* --------------------------------------------------------------- players */

/** Respects roster.privacy — the public build never decides this ad hoc. */
export function displayName(p: Player): string {
  switch (roster.privacy.publicNameFormat) {
    case "full":               return `${p.firstName} ${p.lastName}`;
    case "first-initial-last": return `${p.firstName} ${p.lastName[0]}.`;
    case "first-only":         return p.firstName;
    case "number-only":        return `#${p.number}`;
  }
}
export const showPhotos = () => roster.privacy.publishPhotos;
export const showBirthYear = () => roster.privacy.publishBirthYear;

export const skatersByPoints = () =>
  stats.skaters
    .map((s: any) => ({ ...s, pts: s.pts ?? s.g + s.a, player: getPlayer(s.playerId)! }))
    .sort((a: any, b: any) => b.pts - a.pts || b.g - a.g);

export const goaliesSorted = () =>
  stats.goalies
    .map((s: any) => ({
      ...s,
      svPct: s.svPct ?? (s.sa > 0 ? s.sv / s.sa : null),
      gaa: s.gaa ?? (s.min > 0 ? (s.ga * 60) / s.min : null),
      player: getPlayer(s.playerId)!,
    }))
    .sort((a: any, b: any) => b.gp - a.gp);

export const articles = [...news.articles].sort((a: any, b: any) =>
  b.publishedAt.localeCompare(a.publishedAt),
);

/** Has the Spordle sync ever run? Drives the "fixture data" banner. */
export const isFixtureData = schedule.source.fetchedAt === null;

/**
 * Crests live in the repo at assets/brand/… and are copied into the site at
 * /brand/…. One mapping, so templates never hardcode either path.
 */
export function crestUrl(t: Team): string {
  if (!t.crest) return "";
  return "/brand/" + t.crest.replace(/^.*\//, "").replace("lightning-crest-hi", "lightning-crest");
}
