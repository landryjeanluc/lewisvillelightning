"""Broadcast clock, log and stream against real Postgres.

The clock is the part worth being paranoid about: it is stored as a reading plus
an anchor, so the tests move the anchor in the database rather than sleeping,
and assert the derived reading. Everything else is about a phone in a cold rink
— retried taps, competing devices, and a fat thumb that needs an undo.
"""
import asyncio
from uuid import uuid4

import httpx
from app import signer
from broadcast import parse_youtube_id

GAME = 'g-2026-10-23-shediac'
OTHER = 'g-2026-10-15-dieppe'
VIDEO = 'dQw4w9WgXcQ'


async def run_broadcast_tests(app, pool, ok):
    results = []
    clients = []

    def check(name, condition, extra=''):
        results.append(ok('broadcast: ' + name, condition, extra))

    async def client(role=None):
        cookies = {}
        if role:
            uid = await pool.fetchval("""INSERT INTO users (email,display_name,password_hash,role)
                VALUES ($1,$1,'unused',$2) RETURNING id""", f'bcast-{uuid4()}', role)
            cookies = {'lvlnb_session': signer.dumps([uid, 1])}
        c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                              base_url='http://t/api', cookies=cookies)
        clients.append(c)
        return c

    # ------------------------------------------------- pure link parsing --
    for link, expected in [
        (VIDEO, VIDEO),
        (f'https://www.youtube.com/watch?v={VIDEO}', VIDEO),
        (f'https://www.youtube.com/watch?v={VIDEO}&feature=share&t=42', VIDEO),
        (f'https://youtu.be/{VIDEO}?si=xyz', VIDEO),
        (f'https://www.youtube.com/live/{VIDEO}', VIDEO),
        (f'https://m.youtube.com/watch?v={VIDEO}', VIDEO),
        (f'https://www.youtube-nocookie.com/embed/{VIDEO}', VIDEO),
        (f'youtube.com/watch?v={VIDEO}', VIDEO),
        (f'  https://youtu.be/{VIDEO}  ', VIDEO),
    ]:
        try:
            got = parse_youtube_id(link)
        except ValueError as exc:
            got = f'rejected: {exc}'
        check(f'parses {link[:48]}', got == expected, got)
    for bad in ['', 'nonsense', 'https://vimeo.com/123456',
                'https://www.youtube.com/watch?v=short',
                'https://evil.example/watch?v=' + VIDEO,
                'javascript:alert(1)', 'https://www.youtube.com/']:
        rejected = False
        try:
            parse_youtube_id(bad)
        except ValueError:
            rejected = True
        check(f'rejects {bad[:40] or "(empty)"}', rejected)

    admin = await client('admin')
    second = await client('admin')
    parent = await client('parent')
    viewer = await client('viewer')
    anon = await client()

    def event(kind='shot', **extra):
        return {'kind': kind, 'client_id': str(uuid4()), **extra}

    async def clock_state():
        return (await admin.get(f'/broadcast/{GAME}')).json()['clock']

    async def put_clock(**extra):
        state = await clock_state()
        body = {'period': state['period'], 'period_length_ms': state['period_length_ms'],
                'remaining_ms': state['remaining_ms'], 'running': state['running'],
                'expected_revision': state['revision'], **extra}
        return await admin.put(f'/broadcast/{GAME}/clock', json=body)

    try:
        await pool.execute('DELETE FROM game_events WHERE game_id = ANY($1)', [GAME, OTHER])
        await pool.execute('DELETE FROM game_clock WHERE game_id = ANY($1)', [GAME, OTHER])
        await pool.execute('DELETE FROM game_streams WHERE game_id = ANY($1)', [GAME, OTHER])
        await pool.execute('DELETE FROM game_results WHERE game_id = ANY($1)', [GAME, OTHER])

        # ------------------------------------------------------- gating --
        check('anonymous cannot read a broadcast',
              (await anon.get(f'/broadcast/{GAME}')).status_code == 401)
        check('anonymous cannot append',
              (await anon.post(f'/broadcast/{GAME}/events', json=event())).status_code == 401)
        check('signed-in viewer can read the overlay feed',
              (await viewer.get(f'/broadcast/{GAME}')).status_code == 200)
        for c, who in ((viewer, 'viewer'), (parent, 'parent')):
            check(f'{who} cannot append to the log',
                  (await c.post(f'/broadcast/{GAME}/events', json=event())).status_code == 403)
            check(f'{who} cannot set the clock',
                  (await c.put(f'/broadcast/{GAME}/clock', json={
                      'period': '1', 'period_length_ms': 900000, 'remaining_ms': 900000,
                      'running': False, 'expected_revision': 0})).status_code == 403)
            check(f'{who} cannot set the stream',
                  (await c.put(f'/broadcast/{GAME}/stream',
                               json={'url': VIDEO})).status_code == 403)
            check(f'{who} cannot read the derived scoresheet',
                  (await c.get(f'/broadcast/{GAME}/scoresheet')).status_code == 403)
        check('unknown game is a 404',
              (await admin.get('/broadcast/not-a-real-game')).status_code == 404)
        check('unknown game cannot be appended to',
              (await admin.post('/broadcast/not-a-real-game/events',
                                json=event('shot', team='us'))).status_code == 404)

        # ------------------------------------------------------- stream --
        r = await admin.put(f'/broadcast/{GAME}/stream',
                            json={'url': f'https://youtu.be/{VIDEO}', 'label': 'Lightning vs Predators'})
        check('admin sets the stream from a shared link',
              r.status_code == 200 and r.json()['video_id'] == VIDEO, r.text[:80])
        check('only the video id is stored, and the frame address is rebuilt',
              r.json()['embed_url'] == f'https://www.youtube-nocookie.com/embed/{VIDEO}')
        check('a scheduled stream has no start time yet', r.json()['started_at'] is None)
        check('a bad link is rejected with a reason',
              (await admin.put(f'/broadcast/{GAME}/stream',
                               json={'url': 'https://vimeo.com/1'})).status_code == 422)
        check('an unknown field is rejected',
              (await admin.put(f'/broadcast/{GAME}/stream',
                               json={'url': VIDEO, 'embed_url': 'x'})).status_code == 422)
        r = await admin.put(f'/broadcast/{GAME}/stream', json={'url': VIDEO, 'state': 'live'})
        first_live = r.json()['started_at']
        check('going live records when it started', first_live is not None)
        r = await admin.put(f'/broadcast/{GAME}/stream', json={'url': VIDEO, 'state': 'live'})
        check('saving again does not move the start time', r.json()['started_at'] == first_live)
        r = await viewer.get('/broadcast')
        check('the watch index lists streams for signed-in families',
              r.status_code == 200 and [s['game_id'] for s in r.json()['streams']] == [GAME],
              r.text[:80])

        # -------------------------------------------------------- clock --
        check('the clock starts stopped at a full period',
              (await clock_state())['remaining_ms'] == 900000
              and (await clock_state())['running'] is False)
        check('the clock cannot read longer than its period',
              (await put_clock(remaining_ms=1_000_000)).status_code == 422)
        check('the clock cannot run from zero',
              (await put_clock(remaining_ms=0, running=True)).status_code == 422)
        check('a float reading is rejected',
              (await put_clock(remaining_ms=1.5)).status_code == 422)
        r = await put_clock(remaining_ms=900000, running=True)
        check('admin starts the clock', r.status_code == 200 and r.json()['clock']['running'])
        check('starting the game publishes it as live',
              r.json()['result']['status'] == 'in_progress', r.text[:120])

        # Move the anchor back instead of sleeping: the stored reading plus the
        # anchor is the whole clock, so this is exactly a 45-second run.
        await pool.execute("UPDATE game_clock SET anchor_at = now() - interval '45 seconds'"
                           ' WHERE game_id=$1', GAME)
        state = await clock_state()
        check('a running clock has counted down', 854_000 <= state['remaining_ms'] <= 855_500,
              str(state['remaining_ms']))
        check('and counted the same time as played',
              44_500 <= state['elapsed_ms'] <= 45_500, str(state['elapsed_ms']))

        r = await second.put(f'/broadcast/{GAME}/clock', json={
            'period': '1', 'period_length_ms': 900000, 'remaining_ms': 500000,
            'running': False, 'expected_revision': 0})
        check('a stale device cannot set the clock', r.status_code == 409, r.text[:80])

        # ------------------------------------------------------- events --
        shot = event('shot', team='us')
        r = await admin.post(f'/broadcast/{GAME}/events', json=shot)
        check('admin records a shot', r.status_code == 201 and r.json()['shots']['us']['total'] == 1)
        r = await admin.post(f'/broadcast/{GAME}/events', json=shot)
        check('the same tap twice counts once',
              r.status_code == 201 and r.json()['shots']['us']['total'] == 1, r.text[:90])
        check('a shot carries the clock reading the server had',
              r.json()['events'][0]['clock_ms'] < 900000)

        r = await admin.post(f'/broadcast/{GAME}/events',
                             json=event('goal', team='us', player_id='pl-09',
                                        assist1='pl-22', assist2='pl-03'))
        snap = r.json()
        check('a goal scores', r.status_code == 201 and snap['score'] == {'us': 1, 'them': 0})
        check('a goal also counts as a shot on goal', snap['shots']['us']['total'] == 2)
        check('a goal publishes to the scoreboard the whole site reads',
              snap['result']['our_score'] == 1 and snap['result']['status'] == 'in_progress')
        goal_id = snap['goals'][0]['id']

        r = await admin.get('/scoreboard')
        live = next(g for g in r.json()['games'] if g['game_id'] == GAME)
        check('the existing scoreboard feed shows it with no changes of its own',
              live['our_score'] == 1 and live['status'] == 'in_progress', str(live)[:110])

        for bad, why in [
            (event('goal'), 'a goal needs a team'),
            (event('goal', team='us', assist1='pl-22'), 'assists need a scorer'),
            (event('goal', team='us', player_id='pl-09', assist2='pl-22'), 'the second assist needs the first'),
            (event('goal', team='us', player_id='pl-09', assist1='pl-09'), 'nobody assists their own goal'),
            (event('goal', team='them', player_id='pl-09'), 'opponent scorers are not on our roster'),
            (event('penalty', team='us'), 'a penalty needs minutes'),
            (event('penalty', team='us', minutes=3), '3 minutes is not a penalty'),
            (event('shot', team='us', minutes=2), 'only penalties carry minutes'),
            (event('shot', team='sideways'), 'there are two teams'),
            (event('bananas', team='us'), 'unknown kinds are rejected'),
        ]:
            r = await admin.post(f'/broadcast/{GAME}/events', json=bad)
            check(why, r.status_code == 422, f'got {r.status_code}')
        r = await admin.post(f'/broadcast/{GAME}/events',
                             json=event('goal', team='us', player_id='pl-not-real'))
        check('an unknown player is a clear 400', r.status_code == 400, r.text[:70])

        r = await admin.post(f'/broadcast/{GAME}/events',
                             json=event('penalty', team='them', minutes=2, infraction='Tripping'))
        penalties = r.json()['penalties']
        check('a penalty lands with the game time it was called at',
              len(penalties) == 1 and penalties[0]['seconds'] == 120
              and penalties[0]['elapsed_ms'] > 0, str(penalties)[:110])

        r = await admin.post(f'/broadcast/{GAME}/events', json=event('highlight', note='Big save'))
        marks = r.json()['highlights']
        check('a highlight mark knows where it is in the recording',
              len(marks) == 1 and marks[0]['stream_offset_ms'] is not None, str(marks)[:110])
        check('and carries the note and the game time',
              marks[0]['note'] == 'Big save' and marks[0]['period'] == '1')

        # --------------------------------------- clock corrections move boxes --
        before = await clock_state()
        penalty_elapsed = (await admin.get(f'/broadcast/{GAME}')).json()['penalties'][0]['elapsed_ms']
        r = await put_clock(remaining_ms=before['remaining_ms'] + 20_000, running=False)
        after = r.json()
        check('winding the clock back winds the time played back with it',
              after['clock']['elapsed_ms'] <= before['elapsed_ms'] - 19_000,
              f"{before['elapsed_ms']} -> {after['clock']['elapsed_ms']}")
        check('so a penalty called earlier still has its full time left',
              after['penalties'][0]['elapsed_ms'] == penalty_elapsed
              and after['clock']['elapsed_ms'] < penalty_elapsed + 120_000)

        r = await put_clock(period='INT1', remaining_ms=900000, running=False)
        check('moving to the intermission keeps the time played',
              r.json()['clock']['elapsed_ms'] == after['clock']['elapsed_ms'],
              str(r.json()['clock'])[:120])
        check('and republishes the period', r.json()['result']['period'] == 'INT1')
        r = await put_clock(period='2', remaining_ms=900000, running=False, reset_elapsed=True)
        check('a full reset clears the time played', r.json()['clock']['elapsed_ms'] == 0)

        # --------------------------------------------------------- undo --
        r = await admin.post(f'/broadcast/{GAME}/events/{goal_id}/void')
        check('voiding a goal takes it off the board',
              r.status_code == 200 and r.json()['score'] == {'us': 0, 'them': 0}, r.text[:90])
        check('and off the published scoreboard', r.json()['result']['our_score'] == 0)
        check('and out of the shot count', r.json()['shots']['us']['total'] == 1)
        check('voiding twice is a 404',
              (await admin.post(f'/broadcast/{GAME}/events/{goal_id}/void')).status_code == 404)
        check('a goal from another game cannot be voided from here',
              (await admin.post(f'/broadcast/{OTHER}/events/{goal_id}/void')).status_code == 404)
        check('the voided row is kept, not deleted',
              await pool.fetchval('SELECT voided_at IS NOT NULL FROM game_events WHERE id=$1',
                                  goal_id))
        check('only an admin can undo',
              (await parent.post(f'/broadcast/{GAME}/events/{goal_id}/void')).status_code == 403)

        # -------------------------------------------- derived scoresheet --
        for line in [event('goal', team='us', player_id='pl-09', assist1='pl-22'),
                     event('goal', team='us', player_id='pl-09'),
                     event('goal', team='them'),
                     event('penalty', team='us', minutes=4, player_id='pl-22',
                           infraction='Double minor')]:
            await admin.post(f'/broadcast/{GAME}/events', json=line)
        sheet = (await admin.get(f'/broadcast/{GAME}/scoresheet')).json()
        lines = {line['player_id']: line for line in sheet['lines']}
        check('the log derives a scoresheet',
              sheet['our_score'] == 2 and sheet['their_score'] == 1, str(sheet)[:110])
        check('goals, assists and minutes land on the right players',
              lines['pl-09']['g'] == 2 and lines['pl-22']['a'] == 1
              and lines['pl-22']['pim'] == 4, str(lines)[:140])
        check('plus/minus is left alone because it cannot be derived',
              all(line['plus_minus'] == 0 for line in sheet['lines']))
        check('it does not write the scoresheet itself',
              await pool.fetchval('SELECT count(*) FROM game_stats WHERE game_id=$1', GAME) == 0)

        # ------------------------------- a reviewed final is not clobbered --
        r = await admin.put(f'/stats/game/{OTHER}', json={
            'our_score': 5, 'their_score': 4, 'status': 'final',
            'lines': [{'player_id': 'pl-09', 'g': 5}]})
        check('a game is finished through the existing editor', r.status_code == 200, r.text[:80])
        await admin.post(f'/broadcast/{OTHER}/events', json=event('goal', team='them'))
        row = await pool.fetchrow('SELECT our_score,their_score,status FROM game_results'
                                  ' WHERE game_id=$1', OTHER)
        check('a late tap cannot reach back and change a reviewed final result',
              dict(row) == {'our_score': 5, 'their_score': 4, 'status': 'final'}, str(dict(row)))

        check('the stream can be taken down',
              (await admin.delete(f'/broadcast/{GAME}/stream')).status_code == 204)
        check('and the page then knows there is nothing to play',
              (await admin.get(f'/broadcast/{GAME}')).json()['stream'] is None)
    finally:
        await asyncio.gather(*(c.aclose() for c in clients))
    return results
