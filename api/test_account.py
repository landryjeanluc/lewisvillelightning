"""Account ownership, private contacts and moderation against real PostgreSQL."""
import bcrypt
import httpx

from app import signer, contract


async def run_account_tests(app, pool, ok):
    results = []
    def check(name, condition):
        results.append(ok("account: " + name, condition))

    transport = httpx.ASGITransport(app=app)
    password = " account-password "
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=4)).decode()
    ids = {}
    for role, pid in (("player", "pl-02"), ("parent", "pl-02"), ("viewer", None), ("admin", None), ("other", "pl-03")):
        ids[role] = await pool.fetchval("INSERT INTO users(email,display_name,password_hash,role,player_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
            f"account-{role}", f"Account {role}", hashed, "parent" if role == "other" else role, pid)
    clients = {role: httpx.AsyncClient(transport=transport, base_url="http://t/api", cookies={"lvlnb_session": signer.dumps([uid, 1])}) for role, uid in ids.items()}
    player, parent, viewer, admin, other = (clients[k] for k in ids)
    profile = {"position": "LW", "shoots": "L", "nickname": "Flash", "bio": "Working on my skating."}
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as anon:
            check("anonymous account details denied", (await anon.get('/account')).status_code == 401)
            check("anonymous profile writes denied", (await anon.put('/account/profile', json=profile)).status_code == 401)
        await pool.execute("DELETE FROM player_profiles WHERE player_id='pl-02'")
        read = (await player.get('/account')).json()
        check("linked player receives roster defaults", read['player']['id'] == 'pl-02' and read['player']['position'] == contract.players['pl-02']['position'])
        await pool.execute("INSERT INTO player_profiles(player_id,captain,card_art,photo,favourite_player) VALUES('pl-02','A','/uploads/art.png','/uploads/photo.png','Favourite')")
        check("player can save own profile", (await player.put('/account/profile', json=profile)).status_code == 200)
        stored = await pool.fetchrow("SELECT * FROM player_profiles WHERE player_id='pl-02'")
        check("coach-managed fields survive self-service saves", stored['captain'] == 'A' and stored['card_art'] == '/uploads/art.png' and stored['photo'] == '/uploads/photo.png' and stored['favourite_player'] == 'Favourite')
        check("public profile read reflects player edits", (await parent.get('/profiles')).json()['pl-02']['nickname'] == 'Flash')
        for extra in ({'player_id':'pl-03'}, {'captain':'C'}, {'card_art':'/uploads/x.png'}, {'role':'admin'}):
            check("ownership and coach fields cannot be supplied", (await player.put('/account/profile', json={**profile, **extra})).status_code == 422)
        check("player cannot use coach profile editor", (await player.put('/profiles/pl-03', json={'bio':'Changed'})).status_code == 403)
        check("invalid position refused", (await player.put('/account/profile', json={**profile,'position':'X'})).status_code == 422)
        check("oversized nickname refused", (await player.put('/account/profile', json={**profile,'nickname':'a'*101})).status_code == 422)
        check("parent may edit linked player", (await parent.put('/account/profile', json=profile)).status_code == 200)
        check("viewer has no player or assignments", (await viewer.get('/account')).json()['player'] is None and (await viewer.put('/account/profile', json=profile)).status_code == 403)
        await pool.execute("UPDATE users SET player_id='pl-02' WHERE id=$1", ids['viewer'])
        check("stray viewer link never grants profile rights", (await viewer.put('/account/profile', json=profile)).status_code == 403)
        r = await player.put('/account/profile', json={**profile,'nickname':'I am gonna kill you','bio':'That was a stupid play'})
        check("high-severity nickname holds entire save", r.status_code == 422 and (await player.get('/account')).json()['player']['nickname'] == 'Flash')
        flags = await pool.fetch("SELECT surface,held FROM flagged_content WHERE author_id=$1", ids['player'])
        check("rejected save flags accurately marked unpublished", len(flags) >= 2 and all(f['held'] for f in flags))
        await player.put('/account/profile', json={**profile,'nickname':'idiot'})
        flag = await pool.fetchval("SELECT id FROM flagged_content WHERE author_id=$1 AND surface='profile:nickname' AND NOT held ORDER BY id DESC LIMIT 1", ids['player'])
        r = await admin.post(f'/moderation/{flag}/review', json={'action':'remove'})
        stored = (await player.get('/account')).json()['player']
        check("moderator removes nickname without touching bio", r.status_code == 200 and stored['nickname'] is None and stored['bio'] == profile['bio'])
        await player.put('/account/profile', json={**profile,'nickname':'idiot'})
        flag = await pool.fetchval("SELECT id FROM flagged_content WHERE author_id=$1 AND surface='profile:nickname' ORDER BY id DESC LIMIT 1", ids['player'])
        await player.put('/account/profile', json=profile)
        await admin.post(f'/moderation/{flag}/review', json={'action':'remove'})
        check("stale moderation does not remove newer nickname", (await player.get('/account')).json()['player']['nickname'] == 'Flash')
        contact = {'display_name':'New Parent','email':'account-parent','phone':'+1 (506) 555-0100'}
        check("parent can save name and optional phone with existing handle", (await parent.put('/account/contact',json=contact)).status_code == 200)
        check("name is reflected in current session", (await parent.get('/auth/me')).json()['display_name'] == 'New Parent')
        check("phone private to own account", (await parent.get('/account')).json()['contact']['phone'] == contact['phone'] and contact['phone'] not in (await admin.get('/users')).text and contact['phone'] not in (await other.get('/account')).text)
        check("email change requires password", (await parent.put('/account/contact',json={**contact,'email':'parent@example.invalid'})).status_code == 403)
        check("contact update is atomic on password failure", (await parent.get('/account')).json()['contact']['email'] == 'account-parent')
        await pool.execute("INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,'old-account-token',now()+interval '1 hour')", ids['parent'])
        updated = {**contact,'email':'Parent@Example.invalid','current_password':password}
        check("email changes preserve exact password whitespace", (await parent.put('/account/contact',json=updated)).status_code == 200)
        check("email normalized and outstanding reset tokens invalidated", (await parent.get('/auth/me')).json()['email'] == 'parent@example.invalid' and not await pool.fetchval("SELECT EXISTS(SELECT 1 FROM password_resets WHERE user_id=$1)", ids['parent']))
        check("another account cannot take an existing email", (await other.put('/account/contact',json=updated)).status_code == 409)
        check("children cannot change sign-in/contact identity", (await player.put('/account/contact',json=contact)).status_code == 403)
        check("extra contact permissions rejected", (await parent.put('/account/contact',json={**updated,'role':'admin'})).status_code == 422)
        check("blank name rejected", (await parent.put('/account/contact',json={**updated,'display_name':'  '})).status_code == 422)
        check("invalid phone rejected", (await parent.put('/account/contact',json={**updated,'phone':'<script>'})).status_code == 422)
        check("phone can be removed", (await parent.put('/account/contact',json={**updated,'phone':''})).status_code == 200 and (await parent.get('/account')).json()['contact']['phone'] is None)
        gid = next(iter(contract.games))
        task = await pool.fetchval("INSERT INTO job_types(name,sort) VALUES('Account test 50/50',99) RETURNING id")
        await pool.execute("INSERT INTO game_jobs(game_id,job_type_id,player_id,note,claimed_by) VALUES($1,$2,'pl-02','Arrive early',$3)",gid,task,ids['parent'])
        own = (await parent.get('/account')).json()['assignments']
        theirs = (await other.get('/account')).json()['assignments']
        check("family assignments include task and claiming volunteer", any(a['name']=='Account test 50/50' and a['claimed_by']=='New Parent' and a['note']=='Arrive early' for a in own))
        check("another family cannot see own account assignments", not any(a['name']=='Account test 50/50' for a in theirs))
        await pool.execute("UPDATE users SET player_id=NULL WHERE id=$1",ids['parent'])
        check("removed family link immediately removes access", (await parent.get('/account')).json()['player'] is None and (await parent.get('/account')).json()['assignments'] == [])
        check("writes are audited without storing phone/password values", await pool.fetchval("SELECT count(*) FROM audit_log WHERE user_id=$1 AND action='self_contact_update'", ids['parent']) >= 2 and password not in str(await pool.fetch("SELECT payload FROM audit_log WHERE user_id=$1",ids['parent'])))
    finally:
        for client in clients.values():
            await client.aclose()
    return results
