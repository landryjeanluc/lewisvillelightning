/**
 * The arithmetic the broadcast overlay has to do between polls.
 *
 * The API derives everything that can be counted — score, shots, the scoring
 * summary — so none of that is recomputed here. What cannot wait for the next
 * poll is anything that *moves*: the game clock, each penalty box, and the
 * strength that changes the instant a box empties. Those are pure functions of
 * (snapshot, now), unit tested, and shared by the overlay and the console so
 * the operator's phone and the viewer's scorebug never disagree.
 *
 * `now` is always *server* time. The page measures its skew once per poll from
 * the `server_now` each response carries, because a tablet with a wrong clock
 * must not be able to run the game clock fast.
 */

export type Side = "us" | "them";

export type BroadcastClock = {
  period: string;
  period_length_ms: number;
  remaining_ms: number;
  elapsed_ms: number;
  running: boolean;
  anchor_at: string;
  revision: number;
};

export type Penalty = {
  id: number;
  team: Side;
  player_id: string | null;
  minutes: number;
  infraction: string | null;
  period: string;
  clock_ms: number;
  elapsed_ms: number;
  seconds: number;
};

export type Goal = {
  id: number;
  team: Side;
  player_id: string | null;
  assist1: string | null;
  assist2: string | null;
  period: string;
  clock_ms: number;
  elapsed_ms: number;
  strength: string | null;
};

export type HighlightMark = {
  id: number;
  period: string;
  clock_ms: number;
  note: string | null;
  stream_offset_ms: number | null;
  created_at: string;
};

export type BroadcastEvent = {
  id: number;
  kind: "goal" | "shot" | "penalty" | "highlight" | "timeout" | "goalie" | "note";
  team: Side | null;
  period: string;
  clock_ms: number;
  elapsed_ms: number;
  player_id: string | null;
  assist1: string | null;
  assist2: string | null;
  minutes: number | null;
  infraction: string | null;
  strength: string | null;
  note: string | null;
  stream_offset_ms: number | null;
  created_at: string;
};

export type Stream = {
  game_id: string;
  provider: string;
  video_id: string;
  label: string | null;
  state: "scheduled" | "live" | "ended";
  started_at: string | null;
  embed_url: string;
  watch_url: string;
};

export type Snapshot = {
  game_id: string;
  server_now: string;
  stream: Stream | null;
  clock: BroadcastClock;
  score: Record<Side, number>;
  shots: Record<Side, { total: number; by_period: Record<string, number> }>;
  penalties: Penalty[];
  goals: Goal[];
  timeouts: Record<Side, number>;
  highlights: HighlightMark[];
  events: BroadcastEvent[];
  result: { status: string; period: string | null; revision: number } | null;
};

/* ------------------------------------------------------------------ clock */

/** The clock as it reads at `now`, from the reading that was true at the anchor. */
export function clockAt(clock: BroadcastClock, now: number): { remaining: number; elapsed: number } {
  if (!clock.running) return { remaining: clock.remaining_ms, elapsed: clock.elapsed_ms };
  const ran = Math.max(0, now - Date.parse(clock.anchor_at));
  // Elapsed only counts time the period actually had left to give: a clock left
  // running past zero must not keep draining every penalty on the ice.
  const spent = Math.min(ran, clock.remaining_ms);
  return { remaining: clock.remaining_ms - spent, elapsed: clock.elapsed_ms + spent };
}

/**
 * Broadcast convention: minutes and seconds down to the last minute, then
 * tenths. Under a minute is when everyone in the rink is watching the clock.
 */
export function formatClock(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe >= 60_000) {
    const total = Math.ceil(safe / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }
  const tenths = Math.ceil(safe / 100);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** Always minutes and seconds — for penalty boxes, where tenths are noise. */
export function formatPenaltyClock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const PERIOD_SHORT: Record<string, string> = {
  "1": "1ST", "2": "2ND", "3": "3RD", OT: "OT", SO: "SO", INT1: "INT", INT2: "INT",
};
const PERIOD_LONG: Record<string, string> = {
  "1": "1st period", "2": "2nd period", "3": "3rd period",
  OT: "Overtime", SO: "Shootout", INT1: "1st intermission", INT2: "2nd intermission",
};

export const periodShort = (period: string): string => PERIOD_SHORT[period] ?? period;
export const periodLong = (period: string): string => PERIOD_LONG[period] ?? period;
export const isIntermission = (period: string): boolean => period === "INT1" || period === "INT2";

/* --------------------------------------------------------------- penalties */

/** Time left in a penalty. Measured in game time, so it stops when play stops. */
export const penaltyRemaining = (penalty: Penalty, elapsed: number): number =>
  Math.max(0, penalty.seconds * 1000 - (elapsed - penalty.elapsed_ms));

/** The boxes with time still on them, soonest to expire first. */
export function activePenalties(penalties: Penalty[], elapsed: number): Penalty[] {
  return penalties
    .filter((p) => penaltyRemaining(p, elapsed) > 0)
    .sort((a, b) => penaltyRemaining(a, elapsed) - penaltyRemaining(b, elapsed));
}

export type Strength = {
  us: number;
  them: number;
  label: string;
  /** Who is up a skater, if anyone. */
  powerPlay: Side | null;
  /** Time until the power play ends, or 0 when nobody is on one. */
  powerPlayRemaining: number;
};

/**
 * Skaters a side, and what to call it.
 *
 * A team never drops below three skaters: a third simultaneous penalty is
 * served after one of the first two ends, so only two boxes can be short-handing
 * a side at once. That rule is why this is a `min(2, …)` and not a count.
 */
export function strength(penalties: Penalty[], elapsed: number): Strength {
  const active = activePenalties(penalties, elapsed);
  const serving = (side: Side) => Math.min(2, active.filter((p) => p.team === side).length);
  const us = 5 - serving("us");
  const them = 5 - serving("them");
  const powerPlay: Side | null = us > them ? "us" : them > us ? "them" : null;
  const shorthanded: Side | null = powerPlay === "us" ? "them" : powerPlay === "them" ? "us" : null;
  // The power play lasts until the first of the short-handed side's boxes empties.
  const next = shorthanded ? active.find((p) => p.team === shorthanded) : undefined;
  return {
    us,
    them,
    label: us === them ? (us === 5 ? "EVEN" : `${us}v${them}`) : `${us}v${them}`,
    powerPlay,
    powerPlayRemaining: next ? penaltyRemaining(next, elapsed) : 0,
  };
}

/* ------------------------------------------------------------------ stream */

/**
 * Where in the recording a highlight mark points.
 *
 * YouTube only honours whole seconds, and landing a second early is always
 * better than landing a second late, so this floors. The lead-in exists because
 * nobody wants the clip to start on the puck already in the net.
 */
export function markLink(watchUrl: string, offsetMs: number | null, leadInSeconds = 12): string | null {
  if (offsetMs === null || !Number.isFinite(offsetMs)) return null;
  const at = Math.max(0, Math.floor(offsetMs / 1000) - leadInSeconds);
  return `${watchUrl}&t=${at}s`;
}

/** "12:48 · 2ND" — how a scoring summary line names its moment. */
export const stamp = (period: string, clockMs: number): string =>
  `${formatPenaltyClock(clockMs)} · ${periodShort(period)}`;
