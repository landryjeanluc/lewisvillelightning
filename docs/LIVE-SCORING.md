# Game scoring

Open **Admin → Game scoring** and choose the game. The score, period, and player
scoresheet are all in this one editor. Old links to the Live score tab open it
as well; **Manage game** on a live scoreboard opens the matching game.

Press **Start game** when play begins. Blank team scores start at 0–0; any scores
or player entries already typed are retained. Update the score, period, goals,
assists, penalties, and plus/minus, then press **Save changes**. The +1 buttons
change the form; Save publishes the changes. The homepage updates within five
seconds. Reaching puck-drop time alone does not mark a game live.

Press **Finish game** after the final whistle. It saves the final team score and
all player entries together, marks the game Final, and publishes season totals
to `/stats` and player pages. Both team scores are required. This also works for
a completed game entered afterwards without first starting it live. For later
corrections, load the final game, edit the entries, and press Save changes.

The status selector also supports Not started, Postponed, and Cancelled. Those
states preserve saved player entries but exclude the game from season totals.
The editor explains whether the selected status contributes to the stats pages.

Families' visible scoreboards poll every five seconds and refresh when returning
to a background tab. A connection failure retains the last received score with
an interruption notice. Only a live or final game from the current Atlantic
calendar day can replace the homepage's upcoming matchup. A live game takes
priority over a final result from that day.

Game saves share a revision number and per-game transaction lock with the
scoreboard API. A stale save returns 409 and retains the entered values; use
**Reload scoresheet** to load the latest saved version before correcting it.

The authenticated `/api/scoreboard` feed falls back to schedule data when no result
exists. The combined editor writes `/api/stats/game/{game_id}`, including period
and player lines. The admin-only scoreboard write endpoint remains compatible
with older clients and does not change player entries. Both paths are audited.

## A scoresheet filed under the wrong game

There is no admin control for this: picking the wrong game in the dropdown writes
real rows under that `game_id`, and re-entering the sheet is the only in-app fix.
Both tables key on the contract `game_id`, no foreign keys point at it, and
`updated_at` has no trigger, so the rows can be moved host-side instead. Dump the
database first, then move `game_results` and `game_stats` together in one
transaction, holding the writers' per-game advisory lock
(`pg_advisory_xact_lock(hashtextextended(<game_id>, 71004))`) for **both** ids so
no admin save interleaves. Guard on the source and destination row counts and
abort if the destination already holds a sheet — the move must never merge two
games. Leave `revision` and `updated_at` as they are: the carried revision makes
any device still holding the old sheet fail with 409 and reload, which is what
should happen, and the original timestamp is when the game was actually scored.

Leave the earlier `put_scoresheet` audit rows under the old `game_id` and append
one row describing the move; the log records what was done, not what was meant.
`game_notes` and `game_jobs` are keyed the same way but are *not* part of the
scoresheet — volunteer assignments and notes for the other game are usually
correct, so move them only when they are genuinely misfiled too.

Check `status` afterwards: moving a sheet preserves its status. Set a completed
game to **Final** so its player entries count toward season statistics. The
homepage hero only features live or final scores from the current Atlantic
calendar day; an older game left `in_progress` no longer takes over the hero.
