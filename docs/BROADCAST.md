# Running the broadcast

The team's games stream on YouTube and are watched on **lvlnb.ca/watch**, where
the site draws its own scorebug, penalty clocks and goal graphics over the
video. You run all of it from a phone in the stands at **lvlnb.ca/control**.

Everything here is admin-only to operate and signed-in-only to watch. Nothing
about a broadcast is public.

---

## Before the game

1. Start the live stream on the phone that is filming, in the YouTube app.
2. Open **/control** and pick the game.
3. Open **Stream and scoresheet**, paste the YouTube link — any form works, the
   share sheet's `youtu.be/…`, the browser's `watch?v=…`, or a `live/…` URL —
   set the state to **Live now**, and press **Save the stream**.

The game now appears on **/watch** with a live badge, and a "Watch live now"
button shows up on the homepage scoreboard and the game's own page. Families
tap once to join; the page never autoplays at anyone.

Set the period length while you are in there — 12, 15 or 20 minutes.

> Marking the stream live is what anchors highlight marks to a position in the
> recording. Marks made before that have no timestamp to point at.

## During the game

| Control | What it does |
|---|---|
| **Start / Stop clock** | The big one. Follow the arena clock; everything else is measured against it. |
| **−10s −1s +1s +10s** | Nudge the clock back into agreement with the board. |
| Period chips | Move to the next period. The clock resets to a full one, stopped. |
| **Set the clock exactly** | Type what the board reads — `12:48`, or just the seconds. |
| **Goal** | Opens the scorer and assist chips. An opponent goal is one more tap and asks for nobody. |
| **Shot** | One tap. A goal already counts as a shot on goal; do not tap both. |
| **Penalty** | Player, infraction, and 2 / 4 / 5 / 10 minutes. |
| **Mark Highlight** | One tap, any time. See below. |
| **Timeout** | One tap. |
| **Undo**, in the Recorded list | Takes an entry back off the board. |

The score and the period publish to the rest of the site as you go — the
homepage hero, `/api/scoreboard` and the existing live scoreboards all update
within five seconds with no extra work.

### Penalties and the power play

A penalty is measured in **game time**, so its clock stops when you stop the
game clock and carries across periods correctly. The overlay shows each box
counting down, the strength (`5v4`, `5v3`, `4v4`), and a power-play clock. A
third simultaneous penalty does not take a team below three skaters, same as the
real rule.

### Highlight marks

Tap **Mark Highlight** the moment something happens. Each mark records the
period, the clock, and where you were in the broadcast, and turns into a
**Jump ↗** link in the Recorded list that opens the recording twelve seconds
before the moment. After the game, that list is the clip queue: open each mark,
trim the clip, and upload it to the player in **Roster → Highlights**.

### If the signal drops

The console keeps working. A tap made with no connection is queued, says so, and
sends itself when the signal comes back. Every tap carries its own key, so a
retry can never double-count a goal — leave the page open and it sorts itself
out.

## After the final whistle

1. Set the stream state to **Ended — replay available** so /watch offers the
   replay instead of a live badge.
2. Open **Stream and scoresheet → Show the derived scoresheet**. It turns what
   you tapped into goals, assists and penalty minutes per player.
3. Enter those in **Admin → Game scoring** and press **Finish game**.

Step 3 is deliberately a human step. The broadcast log publishes the *team*
score automatically, but a mis-tap must not be able to edit a child's season
statistics without someone looking at it first. Plus/minus is never derived —
it cannot be, without tracking who was on the ice — so the editor keeps whatever
you enter.

Once a game is marked **Final**, the scoresheet editor owns the result and the
broadcast log stops publishing to it. A late correction to a finished game goes
in the editor, not the console.

---

## How it works

- **The clock is stored as intent, not ticks.** One row holds the reading that
  was true at an anchor instant plus whether it is running; every device derives
  the countdown from the server's own clock, which each response carries. That
  is why a three-second poll still gives a smooth countdown, why every phone in
  the building agrees, and why a device with a wrong clock cannot run the game
  fast. Nothing on the server wakes up on a timer.

- **`elapsed_ms` is total game time played**, and only advances while the clock
  runs. Penalties are measured against it, which is the whole reason penalty
  clocks need no second timer and handle overtime of any length. Nudging the
  clock inside a period moves it by the same amount, so a timekeeper's
  correction does not silently shift every box on the ice.

- **The log is append-only.** Score, shots, penalties on ice, strength and the
  scoring summary are all derived from `game_events` server-side, so there is
  one reducer rather than one per screen. Undo *voids* a row; it never deletes
  it. The log is what happened.

- **Only a video id is ever stored.** Whatever you paste is reduced to the
  11-character id, and the embed address is rebuilt from it — a stored value can
  never become an arbitrary third-party frame on our page.

- **No YouTube JavaScript runs on our pages.** The overlay is our own DOM over a
  plain iframe, which is why the Content-Security-Policy only has to allow a
  frame (`frame-src`) and `script-src` stays `'self'`.

### Timing

The overlay shows the **true current state**, and YouTube live runs roughly
15–30 seconds behind. Viewers on the site therefore see the scorebug change
before the video reaches the goal. This was a deliberate call (JL, 2026-10-20)
in favour of simplicity. Every event in the log is timestamped, so if it starts
spoiling goals, rendering the overlay as of `now − delay` is a configuration
change rather than a redesign.

### Where it lives

| Piece | File |
|---|---|
| API — stream, clock, log, derivation | `api/broadcast.py` |
| Tables | `game_streams`, `game_clock`, `game_events` in `api/schema.sql` |
| Ticking maths, shared by overlay and console | `site/src/lib/broadcast.ts` |
| Overlay | `site/src/components/BroadcastStage.astro`, `site/src/scripts/broadcast.ts` |
| Console | `site/src/pages/control/index.astro`, `site/src/scripts/control.ts` |
| Viewer pages | `site/src/pages/watch/` |
| Tests | `api/test_broadcast.py`, `site/src/lib/broadcast.test.ts`, `tools/test_broadcast_ui.mjs` |

### Deploying

`ops/nginx.conf` gained `frame-src https://www.youtube-nocookie.com
https://www.youtube.com` in its Content-Security-Policy. **The host's nginx
configuration must be updated to match**, or the stream frame is blocked and
/watch shows an empty player with a CSP error in the console. See
`docs/DEPLOY.md`.
