import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clockAt, formatClock, formatPenaltyClock, penaltyRemaining, activePenalties,
  strength, markLink, periodShort, isIntermission, stamp,
  type BroadcastClock, type Penalty,
} from "./broadcast";

const anchor = "2026-10-20T23:00:00.000Z";
const at = (seconds: number) => Date.parse(anchor) + seconds * 1000;

const clock = (over: Partial<BroadcastClock> = {}): BroadcastClock => ({
  period: "1", period_length_ms: 900_000, remaining_ms: 900_000, elapsed_ms: 0,
  running: false, anchor_at: anchor, revision: 1, ...over,
});

const penalty = (over: Partial<Penalty> = {}): Penalty => ({
  id: 1, team: "us", player_id: "pl-09", minutes: 2, infraction: "Tripping",
  period: "1", clock_ms: 600_000, elapsed_ms: 300_000, seconds: 120, ...over,
});

test("a stopped clock reads the same whenever you look at it", () => {
  const stopped = clock({ remaining_ms: 743_000, elapsed_ms: 157_000 });
  for (const seconds of [0, 30, 3600]) {
    assert.deepEqual(clockAt(stopped, at(seconds)), { remaining: 743_000, elapsed: 157_000 });
  }
});

test("a running clock counts down and counts elapsed up by the same amount", () => {
  const running = clock({ running: true, remaining_ms: 600_000, elapsed_ms: 300_000 });
  assert.deepEqual(clockAt(running, at(45)), { remaining: 555_000, elapsed: 345_000 });
});

test("a clock left running past zero stops at zero and stops draining penalties", () => {
  // The buzzer went and nobody pressed stop. Elapsed must not keep advancing,
  // or every penalty on the ice would expire during the intermission.
  const running = clock({ running: true, remaining_ms: 10_000, elapsed_ms: 890_000 });
  assert.deepEqual(clockAt(running, at(60)), { remaining: 0, elapsed: 900_000 });
});

test("a clock read before its own anchor does not run backwards", () => {
  const running = clock({ running: true, remaining_ms: 600_000, elapsed_ms: 0 });
  assert.deepEqual(clockAt(running, at(-30)), { remaining: 600_000, elapsed: 0 });
});

test("the clock shows minutes and seconds, then tenths under a minute", () => {
  assert.equal(formatClock(900_000), "15:00");
  assert.equal(formatClock(748_200), "12:29");   // rounds up: 12:28.2 still reads 12:29
  assert.equal(formatClock(60_000), "1:00");
  assert.equal(formatClock(59_900), "59.9");
  assert.equal(formatClock(9_400), "9.4");
  assert.equal(formatClock(0), "0.0");
  assert.equal(formatClock(-500), "0.0");
});

test("penalty boxes never show tenths", () => {
  assert.equal(formatPenaltyClock(120_000), "2:00");
  assert.equal(formatPenaltyClock(59_900), "1:00");
  assert.equal(formatPenaltyClock(0), "0:00");
});

test("a penalty burns game time, not wall time", () => {
  const trip = penalty({ elapsed_ms: 300_000 });
  assert.equal(penaltyRemaining(trip, 300_000), 120_000);
  assert.equal(penaltyRemaining(trip, 360_000), 60_000);
  assert.equal(penaltyRemaining(trip, 420_000), 0);
  // Play stopped for five minutes between: elapsed did not move, so neither did this.
  assert.equal(penaltyRemaining(trip, 330_000), 90_000);
});

test("a penalty never shows negative time left", () => {
  assert.equal(penaltyRemaining(penalty({ elapsed_ms: 0 }), 900_000), 0);
});

test("expired boxes drop off and the rest sort by who gets out first", () => {
  const boxes = [
    penalty({ id: 1, elapsed_ms: 0 }),                              // long gone
    penalty({ id: 2, elapsed_ms: 290_000, minutes: 5, seconds: 300 }),
    penalty({ id: 3, elapsed_ms: 299_000 }),
  ];
  assert.deepEqual(activePenalties(boxes, 300_000).map((p) => p.id), [3, 2]);
});

test("even strength is even strength", () => {
  const s = strength([penalty({ elapsed_ms: 0 })], 900_000);
  assert.equal(s.label, "EVEN");
  assert.equal(s.powerPlay, null);
  assert.equal(s.powerPlayRemaining, 0);
  assert.deepEqual([s.us, s.them], [5, 5]);
});

test("one of theirs in the box is our power play, timed to their box", () => {
  const s = strength([penalty({ team: "them", elapsed_ms: 300_000 })], 330_000);
  assert.deepEqual([s.us, s.them, s.label, s.powerPlay], [5, 4, "5v4", "us"]);
  assert.equal(s.powerPlayRemaining, 90_000);
});

test("two of ours in the box is five on three against", () => {
  const s = strength([
    penalty({ id: 1, elapsed_ms: 300_000 }),
    penalty({ id: 2, elapsed_ms: 310_000 }),
  ], 320_000);
  assert.deepEqual([s.us, s.them, s.label, s.powerPlay], [3, 5, "3v5", "them"]);
  // Their power play ends when the first of our boxes empties.
  assert.equal(s.powerPlayRemaining, 100_000);
});

test("a third penalty does not take a team below three skaters", () => {
  // Hockey's rule: the third is served after one of the first two ends.
  const s = strength([
    penalty({ id: 1, elapsed_ms: 300_000 }),
    penalty({ id: 2, elapsed_ms: 300_000 }),
    penalty({ id: 3, elapsed_ms: 300_000 }),
  ], 300_000);
  assert.equal(s.us, 3);
  assert.equal(s.label, "3v5");
});

test("coincidental penalties are four on four, not a power play", () => {
  const s = strength([
    penalty({ id: 1, team: "us", elapsed_ms: 300_000 }),
    penalty({ id: 2, team: "them", elapsed_ms: 300_000 }),
  ], 310_000);
  assert.deepEqual([s.label, s.powerPlay, s.powerPlayRemaining], ["4v4", null, 0]);
});

test("a highlight mark links into the recording with a lead-in", () => {
  const watch = "https://www.youtube.com/watch?v=abcdefghijk";
  assert.equal(markLink(watch, 125_000), `${watch}&t=113s`);
  // Marks in the opening seconds clamp to the start rather than going negative.
  assert.equal(markLink(watch, 4_000), `${watch}&t=0s`);
  // Marked before the stream was declared live: there is nowhere to point.
  assert.equal(markLink(watch, null), null);
});

test("periods read the way a scorebug reads them", () => {
  assert.equal(periodShort("1"), "1ST");
  assert.equal(periodShort("OT"), "OT");
  assert.equal(periodShort("INT2"), "INT");
  assert.ok(isIntermission("INT1") && isIntermission("INT2"));
  assert.ok(!isIntermission("3"));
  assert.equal(stamp("2", 748_000), "12:28 · 2ND");
});
