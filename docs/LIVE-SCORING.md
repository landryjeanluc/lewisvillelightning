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
