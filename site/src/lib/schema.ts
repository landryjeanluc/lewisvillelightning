import { z } from "zod";

/**
 * Schemas for the five files in /data. These are the contract described in
 * docs/DATA-CONTRACT.md — the Spordle sync writes those files, the site reads
 * them, and nothing else is allowed between the two.
 *
 * Validation is deliberately strict. A silent coercion here becomes a game time
 * that is an hour wrong on a page parents plan their evening around.
 */

/** ISO-8601 with a REQUIRED offset. `2026-10-13T17:30:00-03:00`, never naive. */
const isoOffset = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    "must be ISO-8601 with an explicit UTC offset (e.g. 2026-10-13T17:30:00-03:00)",
  )
  .refine((s) => !Number.isNaN(Date.parse(s)), "not a real date");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const source = z.object({
  provider: z.string(),
  teamId: z.string().nullable().optional(),
  fetchedAt: isoOffset.nullable(),
  note: z.string().optional(),
});

const venue = z.object({
  name: z.string().min(1),
  surface: z.string().nullable(),
  address: z.string().nullable(),
  mapUrl: z.string().url().nullable(),
});

/* ---------------------------------------------------------------- opponents */

export const opponentsSchema = z.object({
  version: z.literal(1),
  source,
  teams: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        short: z.string().min(1),
        town: z.string().nullable(),
        crest: z.string().nullable(),
        colours: z.object({
          primary: z.string(),
          secondary: z.string(),
          accent: z.string().optional(),
        }),
      }),
    )
    .min(1),
});

/* ----------------------------------------------------------------- schedule */

const gameEvent = z.object({
  id: z.string().min(1),
  type: z.literal("game"),
  startsAt: isoOffset,
  endsAt: isoOffset.nullable(),
  venue,
  home: z.object({ teamId: z.string(), score: z.number().int().min(0).nullable() }),
  away: z.object({ teamId: z.string(), score: z.number().int().min(0).nullable() }),
  status: z.enum(["scheduled", "in_progress", "final", "postponed", "cancelled"]),
  gameType: z.enum(["regular", "exhibition", "playoff", "tournament"]),
  league: z.string().nullable(),
  notes: z.string().nullable(),
  spordleId: z.string().nullable(),
});

const practiceEvent = z.object({
  id: z.string().min(1),
  type: z.literal("practice"),
  startsAt: isoOffset,
  endsAt: isoOffset.nullable(),
  venue,
  status: z.enum(["scheduled", "cancelled", "postponed"]),
  notes: z.string().nullable(),
  spordleId: z.string().nullable().optional(),
});

export const scheduleSchema = z.object({
  version: z.literal(1),
  source,
  events: z.array(z.discriminatedUnion("type", [gameEvent, practiceEvent])),
});

/* ------------------------------------------------------------------- roster */

export const rosterSchema = z.object({
  version: z.literal(1),
  source,
  privacy: z.object({
    publicNameFormat: z.enum(["full", "first-initial-last", "first-only", "number-only"]),
    publishBirthYear: z.boolean(),
    publishPhotos: z.boolean(),
    note: z.string().optional(),
  }),
  players: z.array(
    z.object({
      id: z.string().min(1),
      number: z.number().int().min(0).max(99),
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      position: z.enum(["C", "LW", "RW", "F", "D", "G"]),
      shoots: z.enum(["L", "R"]).nullable(),
      birthYear: z.number().int().min(1990).max(2030).nullable(),
      photo: z.string().nullable(),
      cardArt: z.string().nullable(),
      captain: z.enum(["C", "A"]).nullable(),
      affiliate: z.boolean(),
    }),
  ),
  staff: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })),
});

/* -------------------------------------------------------------------- stats */

export const statsSchema = z.object({
  version: z.literal(1),
  source,
  asOf: isoDate.nullable(),
  team: z.object({
    gp: z.number().int().min(0),
    w: z.number().int().min(0),
    l: z.number().int().min(0),
    otl: z.number().int().min(0),
    t: z.number().int().min(0),
    gf: z.number().int().min(0),
    ga: z.number().int().min(0),
    pts: z.number().int().min(0),
    streak: z.string().nullable(),
  }),
  skaters: z.array(
    z.object({
      playerId: z.string(),
      gp: z.number().int().min(0),
      g: z.number().int().min(0),
      a: z.number().int().min(0),
      pts: z.number().int().min(0).nullable(),
      pim: z.number().int().min(0),
      ppg: z.number().int().min(0).nullable(),
      shg: z.number().int().min(0).nullable(),
      gwg: z.number().int().min(0).nullable(),
    }),
  ),
  goalies: z.array(
    z.object({
      playerId: z.string(),
      gp: z.number().int().min(0),
      w: z.number().int().min(0),
      l: z.number().int().min(0),
      otl: z.number().int().min(0),
      ga: z.number().int().min(0),
      sa: z.number().int().min(0),
      sv: z.number().int().min(0),
      svPct: z.number().min(0).max(1).nullable(),
      gaa: z.number().min(0).nullable(),
      so: z.number().int().min(0),
      min: z.number().min(0),
    }),
  ),
});

/* --------------------------------------------------------------------- news */

export const newsSchema = z.object({
  version: z.literal(1),
  source,
  articles: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be url-safe kebab-case"),
      publishedAt: isoOffset,
      author: z.string().nullable(),
      summary: z.string().nullable(),
      body: z.string(),
      image: z.string().nullable(),
      tags: z.array(z.string()),
      spordleId: z.string().nullable(),
      lang: z.enum(["en", "fr"]),
    }),
  ),
});

export type Opponents = z.infer<typeof opponentsSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type Roster = z.infer<typeof rosterSchema>;
export type Stats = z.infer<typeof statsSchema>;
export type News = z.infer<typeof newsSchema>;
export type GameEvent = z.infer<typeof gameEvent>;
export type PracticeEvent = z.infer<typeof practiceEvent>;
export type Player = Roster["players"][number];
export type Team = Opponents["teams"][number];
