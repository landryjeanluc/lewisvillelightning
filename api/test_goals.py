"""Training goals against real Postgres: isolation, ownership and retries."""
import asyncio
from datetime import timedelta
from uuid import uuid4

import httpx
from app import signer
from goals import today


async def run_goals_tests(app, pool, ok):
    results = []
    clients = []

    def check(name, condition):
        results.append(ok('goals: ' + name, condition))

    async def client(role=None, player=None):
        cookies = {}
        if role:
            uid = await pool.fetchval("""INSERT INTO users (email,display_name,password_hash,role,player_id)
                VALUES ($1,$1,'unused',$2,$3) RETURNING id""", f'goals-{uuid4()}', role, player)
            cookies = {'lvlnb_session': signer.dumps([uid, 1])}
        c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://t/api', cookies=cookies)
        clients.append(c)
        return c

    coach = await client('admin')
    kid = await client('player', 'pl-02')
    parent = await client('parent', 'pl-02')
    other = await client('player', 'pl-22')
    viewer = await client('viewer', 'pl-02')
    unlinked = await client('parent')
    anon = await client()
    start = (today() - timedelta(days=6)).isoformat()
    end = today().isoformat()
    goal = {'title': '1000 off-ice shots', 'scope': 'team', 'unit': 'shots',
            'target': 1000, 'starts_on': start, 'ends_on': end}

    def entry(amount=25, pid='pl-02', **extra):
        return {'player_id': pid, 'amount': amount, 'performed_on': end, 'client_id': str(uuid4()), **extra}

    try:
        check('anonymous board is gated', (await anon.get('/goals')).status_code == 401)
        check('anonymous create is gated', (await anon.post('/goals', json=goal)).status_code == 401)
        for c in (kid, parent, viewer):
            check('only admin can set targets', (await c.post('/goals', json=goal)).status_code == 403)
        for change in ({'target': 0}, {'target': 1.5}, {'target': True}, {'title': '  '},
                       {'ends_on': '2020-01-01'}, {'scope': 'player'}, {'player_id': 'pl-02'}, {'unit': 'bogus'}):
            check('invalid goal rejected', (await coach.post('/goals', json={**goal, **change})).status_code == 422)
        check('unknown player rejected', (await coach.post('/goals', json={**goal, 'scope': 'player', 'player_id': 'missing'})).status_code == 400)
        r = await coach.post('/goals', json=goal)
        check('coach creates team target', r.status_code == 201)
        tid = r.json()['id']
        personal = {**goal, 'title': '50 squats', 'scope': 'player', 'player_id': 'pl-02', 'unit': 'reps', 'target': 50}
        r = await coach.post('/goals', json=personal)
        pid = r.json()['id']
        for c in (kid, parent):
            r = await c.get('/goals')
            check('family sees team and own goal with no-store',
                  {g['id'] for g in r.json()['goals']} == {tid, pid} and r.headers.get('cache-control') == 'no-store')
            check('family gets only their player', [p['id'] for p in r.json()['players']] == ['pl-02'])
        for c in (other, viewer, unlinked):
            data = (await c.get('/goals')).json()
            check('other accounts cannot see personal goal', pid not in [g['id'] for g in data['goals']])
            check('cannot read personal history by guessed id', (await c.get(f'/goals/{pid}/entries')).status_code == 404)
        for c in (viewer, unlinked):
            check('unlinked or viewer cannot log', (await c.post(f'/goals/{tid}/entries', json=entry())).status_code == 403)
        check('player cannot spoof family', (await kid.post(f'/goals/{tid}/entries', json=entry(pid='pl-22'))).status_code == 403)
        check('parent cannot edit targets', (await parent.put(f'/goals/{pid}', json=personal)).status_code == 403)
        for amount in (0, -1, 1.1, True, 1000001):
            check('invalid progress rejected', (await kid.post(f'/goals/{tid}/entries', json=entry(amount))).status_code == 422)
        for day in ((today() + timedelta(days=1)).isoformat(), (today() - timedelta(days=7)).isoformat()):
            check('out-of-period or future progress rejected', (await kid.post(f'/goals/{tid}/entries', json=entry(performed_on=day))).status_code == 400)
        payload = entry(40)
        responses = await asyncio.gather(*(kid.post(f'/goals/{tid}/entries', json=payload) for _ in range(4)))
        check('concurrent retries insert once', all(r.status_code == 201 for r in responses) and len({r.json()['id'] for r in responses}) == 1)
        eid = responses[0].json()['id']
        check('retry key cannot change amount', (await kid.post(f'/goals/{tid}/entries', json={**payload, 'amount': 41})).status_code == 409)
        await asyncio.gather(parent.post(f'/goals/{tid}/entries', json=entry(10)), other.post(f'/goals/{tid}/entries', json=entry(20, 'pl-22')))
        data = (await kid.get('/goals')).json()
        team = next(g for g in data['goals'] if g['id'] == tid)
        individual = next(g for g in data['goals'] if g['id'] == pid)
        check('team contributions sum across families', team['total'] == 70 and team['family_total'] == 50)
        check('team activity does not affect individual goals', individual['total'] == 0)
        await parent.post(f'/goals/{pid}/entries', json=entry(60))
        data = (await kid.get('/goals')).json()
        check('parent updates player progress and overachievement allowed', next(g for g in data['goals'] if g['id'] == pid)['total'] == 60)
        check('family history excludes other players', len((await parent.get(f'/goals/{tid}/entries')).json()) == 2)
        check('admin sees all contributions', len((await coach.get(f'/goals/{tid}/entries')).json()) == 3)
        check('cannot delete another family contribution', (await other.delete(f'/goals/{tid}/entries/{eid}')).status_code == 403)
        check('parent can correct child entry', (await parent.delete(f'/goals/{tid}/entries/{eid}')).status_code == 200)
        check('repeated removal safe', (await kid.delete(f'/goals/{tid}/entries/{eid}')).status_code == 200)
        r = await kid.post(f'/goals/{tid}/entries', json=payload)
        check('retry cannot resurrect removed progress', r.json()['removed'] is True)
        team = next(g for g in (await kid.get('/goals')).json()['goals'] if g['id'] == tid)
        check('corrected total recomputed', team['total'] == 30 and team['family_total'] == 10)
        for change in ({'unit': 'reps'}, {'starts_on': end}, {'scope': 'player', 'player_id': 'pl-02'}):
            check('existing activity cannot be reinterpreted', (await coach.put(f'/goals/{tid}', json={**goal, **change})).status_code == 409)
        check('target can be adjusted', (await coach.put(f'/goals/{tid}', json={**goal, 'target': 2000})).status_code == 200)
        check('admin can archive', (await coach.put(f'/goals/{tid}', json={**goal, 'archived': True})).status_code == 200)
        check('archived goals reject new activity', (await kid.post(f'/goals/{tid}/entries', json=entry())).status_code == 409)
        check('successful retry still works after archiving', (await kid.post(f'/goals/{tid}/entries', json=payload)).status_code == 201)
        r = await coach.post('/goals', json={**goal, 'starts_on': start, 'ends_on': start})
        past_id = r.json()['id']
        check('can backfill past goal within its period', (await parent.post(f'/goals/{past_id}/entries', json=entry(performed_on=start))).status_code == 201)
        check('writes audited', await pool.fetchval("SELECT count(*) FROM audit_log WHERE action LIKE 'goal_%'") >= 10)
        # Linking a family is live state, not a permission cached in the cookie.
        uid = signer.loads(kid.cookies.get('lvlnb_session'))[0]
        await pool.execute('UPDATE users SET player_id=$2 WHERE id=$1', uid, 'pl-22')
        check('family relink immediately revokes previous access', (await kid.get(f'/goals/{pid}/entries')).status_code == 404)
    finally:
        for c in clients:
            await c.aclose()
    return results
