"""Goal clips: admin-only upload and tagging, and the scoresheet totals they imply."""
from uuid import uuid4

import httpx

from app import signer
from goal_clips import MEDIA_DIR
from test_highlights import sample_clip

GAME = 'g-2026-10-23-shediac'


async def run_goal_clip_tests(app, pool, ok):
    results = []
    def check(name, condition):
        results.append(ok('goal clips: ' + name, condition))
    transport = httpx.ASGITransport(app=app)
    clients = []
    for role in ('admin', 'parent'):
        uid = await pool.fetchval("INSERT INTO users(email,display_name,password_hash,role) VALUES($1,'Clip test','unused',$2) RETURNING id", 'goal-clips-' + role, role)
        clients.append(httpx.AsyncClient(transport=transport, base_url='http://t/api', cookies={'lvlnb_session': signer.dumps([uid, 1])}))
    admin, parent = clients
    raw = sample_clip()

    async def upload(seq, team):
        id = str(uuid4())
        await admin.post('/goal-clips/uploads', json={'id': id, 'game_id': GAME, 'seq': seq, 'team': team, 'bytes': len(raw)})
        await admin.put(f'/goal-clips/uploads/{id}?offset=0', content=raw)
        return id, await admin.post(f'/goal-clips/uploads/{id}/publish')

    try:
        body = {'id': str(uuid4()), 'game_id': GAME, 'seq': 1, 'team': 'us', 'bytes': len(raw)}
        check('families cannot list', (await parent.get(f'/goal-clips?game_id={GAME}')).status_code == 403)
        check('families cannot upload', (await parent.post('/goal-clips/uploads', json=body)).status_code == 403)
        check('unknown game rejected', (await admin.post('/goal-clips/uploads', json=dict(body, game_id='nope'))).status_code == 404)
        r = await admin.post('/goal-clips/uploads', json=body)
        check('admin starts upload', r.status_code == 201 and r.json()['received'] == 0)
        split = len(raw) // 2
        await admin.put(f"/goal-clips/uploads/{body['id']}?offset=0", content=raw[:split])
        check('retry resumes at saved position', (await admin.post('/goal-clips/uploads', json=body)).json()['received'] == split)
        check('unfinished clip is not listed', (await admin.get(f'/goal-clips?game_id={GAME}')).json()['clips'] == [])
        await admin.put(f"/goal-clips/uploads/{body['id']}?offset={split}", content=raw[split:])
        r = await admin.post(f"/goal-clips/uploads/{body['id']}/publish")
        first = body['id']
        check('clip saved', r.status_code == 200 and r.json()['duration'] == 2 and r.json()['scorer'] is None)
        check('source removed after saving', not (MEDIA_DIR / first / 'source.mp4').exists())
        r = await admin.post('/goal-clips/uploads', json=dict(body, id=str(uuid4())))
        check('a goal holds one clip', r.status_code == 409 and 'Goal 1' in r.json()['detail'])
        second, r = await upload(2, 'them')
        check('second goal saved', r.status_code == 200)
        third, _ = await upload(3, 'us')

        tags = {'team': 'us', 'scorer': 'pl-02', 'assist1': 'pl-07', 'assist2': None,
                'on_ice': ['pl-14', 'pl-15', 'pl-09', 'pl-29'], 'power_play': False}
        check('families cannot tag', (await parent.put(f'/goal-clips/{first}', json=tags)).status_code == 403)
        check('unknown player rejected', (await admin.put(f'/goal-clips/{first}', json=dict(tags, scorer='pl-99'))).status_code == 400)
        check('one credit per player', (await admin.put(f'/goal-clips/{first}', json=dict(tags, assist1='pl-02'))).status_code == 422)
        check('assists need a scorer', (await admin.put(f'/goal-clips/{first}', json=dict(tags, scorer=None))).status_code == 422)
        check('opponent goals have no scorer', (await admin.put(f'/goal-clips/{second}', json=dict(tags, team='them'))).status_code == 422)
        check('seven on the ice rejected', (await admin.put(f'/goal-clips/{first}', json=dict(tags, on_ice=['pl-03', 'pl-04', 'pl-05', 'pl-14', 'pl-15', 'pl-29']))).status_code == 422)
        r = await admin.put(f'/goal-clips/{first}', json=tags)
        check('scorer and assist join the players on the ice', r.status_code == 200
              and r.json()['on_ice'] == ['pl-14', 'pl-15', 'pl-09', 'pl-29', 'pl-02', 'pl-07'])
        await admin.put(f'/goal-clips/{second}', json={'team': 'them', 'on_ice': ['pl-02', 'pl-14', 'pl-31']})
        await admin.put(f'/goal-clips/{third}', json={'team': 'us', 'scorer': 'pl-07', 'on_ice': ['pl-02'], 'power_play': True})

        r = (await admin.get(f'/goal-clips?game_id={GAME}')).json()
        check('listed in game order with the score', [c['seq'] for c in r['clips']] == [1, 2, 3]
              and (r['our_goals'], r['their_goals']) == (2, 1))
        totals = r['totals']
        check('goals and assists add up', totals['pl-02'] == {'g': 1, 'a': 0, 'plus_minus': 0}
              and totals['pl-07'] == {'g': 1, 'a': 1, 'plus_minus': 1})
        check('plus and minus come from who was on the ice', totals['pl-14']['plus_minus'] == 0 and totals['pl-15']['plus_minus'] == 1)
        check('goalies carry no plus/minus', 'pl-29' not in totals and 'pl-31' not in totals)
        check('tagging is audited', await pool.fetchval("SELECT count(*) FROM audit_log WHERE action='goal_clip_tag' AND game_id=$1", GAME) == 3)

        check('families cannot watch', (await parent.get(f'/goal-clips/{first}/video')).status_code == 403)
        r = await admin.get(f'/goal-clips/{first}/video', headers={'Range': 'bytes=0-15'})
        check('video supports seeking', r.status_code == 206 and len(r.content) == 16)
        check('poster served', (await admin.get(f'/goal-clips/{first}/poster')).headers['content-type'] == 'image/jpeg')
        check('families cannot remove', (await parent.delete(f'/goal-clips/{first}')).status_code == 403)
        for id in (first, second, third):
            await admin.delete(f'/goal-clips/{id}')
        check('removed clips are gone', (await admin.get(f'/goal-clips?game_id={GAME}')).json()['clips'] == []
              and not (MEDIA_DIR / first).exists())
        check('a removed goal can be uploaded again', (await upload(1, 'us'))[1].status_code == 200)
    finally:
        await pool.execute("DELETE FROM goal_clips")
        for client in clients:
            await client.aclose()
    return results
