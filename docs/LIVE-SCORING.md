# Live scoring

Open **Admin → Live score**, choose the game, and press **Start game**. This saves
0–0 and the first period unless you have entered different values. The homepage
hero switches to a scoreboard within five seconds. A game is live only when an
admin marks it live; reaching its scheduled start time does not invent a result.

Update either score, choose the period, and press **Save scoreboard**. The +1
buttons change the form; press Save to publish. You can correct a score downward
in the number field. Intermissions, overtime and shootouts are available. There
is no game clock. Set the status to **Final** and save after the game; the final
score remains featured for that game day in Atlantic time. A live game takes
priority over final results and the build-time upcoming fixture.

Families' visible pages poll every five seconds and refresh when returning to a
background tab. A connection failure retains the last received score with an
interruption notice. The game detail page also carries the scoreboard.

Live scores update `game_results` only. Player goals, assists and penalties remain
in the Scoresheet tab. Full scoresheet saves retain the loaded game status rather
than silently marking a live game final. Both editors share a revision number and
per-game transaction lock; a stale save returns 409. Use **Load latest score** or
**Reload scoresheet** to resolve a conflict before making your corrections.

The authenticated `/api/scoreboard` feed falls back to schedule data when no result
exists. Admin-only `PUT /api/scoreboard/{game_id}` requires scores, status and an
`expected_revision`; live status also requires a valid period. Writes are audited.
