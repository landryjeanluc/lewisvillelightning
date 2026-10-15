"""Live scoring permissions, concurrent editors, and preservation of player stats."""
import asyncio
import httpx
from app import signer, contract


async def run_scoreboard_tests(app, pool, ok):
    results = []
    def check(name, condition):
        results.append(ok("scoreboard: " + name, condition))

    transport = httpx.ASGITransport(app=app)
    clients = {}
    for role in ('admin', 'parent', 'player'):
        uid = await pool.fetchval("INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$1,'unused',$2) RETURNING id", f'score-{role}', role)
        clients[role] = httpx.AsyncClient(transport=transport, base_url='http://t/api', cookies={'lvlnb_session':signer.dumps([uid,1])})
    admin, parent, player = (clients[r] for r in ('admin','parent','player'))
    gid = next(iter(contract.games))
    payload = {'our_score':0,'their_score':0,'period':'1','status':'in_progress','expected_revision':0}
    try:
        await pool.execute('DELETE FROM game_results WHERE game_id=$1',gid)
        await pool.execute('DELETE FROM game_stats WHERE game_id=$1',gid)
        await pool.execute("INSERT INTO game_stats(game_id,player_id,g,a,pim,plus_minus) VALUES($1,'pl-02',2,1,4,-1)",gid)
        async with httpx.AsyncClient(transport=transport,base_url='http://t/api') as anon:
            check('anonymous feed is private', (await anon.get('/scoreboard')).status_code == 401)
            check('anonymous writes denied', (await anon.put(f'/scoreboard/{gid}',json=payload)).status_code == 401)
        for client in (parent,player):
            check('family can read scores but cannot write', (await client.get('/scoreboard')).status_code == 200 and (await client.put(f'/scoreboard/{gid}',json=payload)).status_code == 403)
        response = await parent.get('/scoreboard')
        check('feed does not cache private results', response.headers.get('cache-control') == 'no-store')
        baseline = next(g for g in response.json()['games'] if g['game_id']==gid)
        check('no stored score falls back to schedule without inventing a live game',baseline['status']==contract.games[gid]['status'] and baseline['revision']==0)
        check('unknown game rejected',(await admin.put('/scoreboard/no-game',json=payload)).status_code==404)
        for invalid in ({'our_score':-1},{'our_score':1.5},{'our_score':True},{'their_score':1001},{'period':'4'},{'period':None},{'status':'whatever'},{'expected_revision':-1},{'lines':[]}):
            check('invalid score or period refused',(await admin.put(f'/scoreboard/{gid}',json={**payload,**invalid})).status_code==422)
        replies = await asyncio.gather(*(admin.put(f'/scoreboard/{gid}',json={**payload,'our_score':n}) for n in (1,2)))
        check('two simultaneous starts cannot overwrite each other',sorted(r.status_code for r in replies)==[200,409])
        row = await pool.fetchrow('SELECT * FROM game_stats WHERE game_id=$1',gid)
        check('live updates preserve goals assists penalties and plus-minus',row['g']==2 and row['a']==1 and row['pim']==4 and row['plus_minus']==-1)
        current=(await admin.get(f'/stats/game/{gid}')).json()['result']
        check('scoresheet reads live period and revision',current['period']=='1' and current['revision']==1 and current['status']=='in_progress')
        r=await admin.put(f'/scoreboard/{gid}',json={**payload,'our_score':3,'their_score':2,'period':'INT1','expected_revision':1})
        check('intermission and score corrections are saved',r.status_code==200 and r.json()['period']=='INT1' and r.json()['revision']==2)
        r=await admin.put(f'/stats/game/{gid}',json={'our_score':9,'their_score':8,'lines':[],'expected_revision':1})
        check('stale full scoresheet cannot overwrite live score or delete stats',r.status_code==409 and await pool.fetchval('SELECT count(*) FROM game_stats WHERE game_id=$1',gid)==1)
        r=await admin.put(f'/stats/game/{gid}',json={'our_score':3,'their_score':2,'status':'in_progress','expected_revision':2,'lines':[{'player_id':'pl-02','g':3}]})
        check('full scoresheet advances shared revision',(r.status_code,r.json().get('revision'))==(200,3))
        check('older scoresheet clients retain the live period',await pool.fetchval('SELECT period FROM game_results WHERE game_id=$1',gid)=='INT1')
        check('old live editor detects scoresheet changes',(await admin.put(f'/scoreboard/{gid}',json={**payload,'expected_revision':2})).status_code==409)
        gp=(await parent.get('/stats/season')).json()['team']['gp']
        r=await admin.put(f'/scoreboard/{gid}',json={**payload,'our_score':3,'their_score':2,'status':'final','period':'OT','expected_revision':3})
        check('final result feeds season totals',r.status_code==200 and (await parent.get('/stats/season')).json()['team']['gp']==gp+1)
        check('finishing the game preserves scoresheet stats',await pool.fetchval('SELECT g FROM game_stats WHERE game_id=$1',gid)==3)
        r=await admin.put(f'/scoreboard/{gid}',json={**payload,'status':'cancelled','expected_revision':4})
        check('cancellation clears period and advances revision',r.status_code==200 and r.json()['period'] is None and r.json()['revision']==5)
        check('score changes are audited',await pool.fetchval("SELECT count(*) FROM audit_log WHERE game_id=$1 AND action='live_score'",gid)==4)
        lines=[{'player_id':'pl-02','g':2,'a':1,'pim':4,'plus_minus':-1}]
        sheet={'our_score':2,'their_score':1,'status':'in_progress','period':'2','expected_revision':5,'lines':lines}
        for client in (parent,player):
            check('family cannot change the combined game editor',(await client.put(f'/stats/game/{gid}',json=sheet)).status_code==403)
        check('combined editor rejects an invalid period',(await admin.put(f'/stats/game/{gid}',json={**sheet,'period':'4'})).status_code==422)
        gp=(await parent.get('/stats/season')).json()['team']['gp']
        r=await admin.put(f'/stats/game/{gid}',json=sheet)
        current=(await parent.get(f'/stats/game/{gid}')).json()
        check('one save records period score and all player stats',r.status_code==200 and current['result']['period']=='2' and current['result']['status']=='in_progress' and current['lines']==lines)
        check('live player entries do not count as completed stats',(await parent.get('/stats/season')).json()['team']['gp']==gp)
        r=await admin.put(f'/stats/game/{gid}',json={**sheet,'status':'final','period':'3','expected_revision':6})
        totals=(await parent.get('/stats/season')).json()
        check('finish game publishes result and player stats together',r.status_code==200 and totals['team']['gp']==gp+1 and any(p['player_id']=='pl-02' and p['g']>=2 and p['pim']>=4 for p in totals['skaters']))
        check('finish game keeps the full recorded player line',(await parent.get(f'/stats/game/{gid}')).json()['lines']==lines)
    finally:
        for client in clients.values():
            await client.aclose()
    return results
