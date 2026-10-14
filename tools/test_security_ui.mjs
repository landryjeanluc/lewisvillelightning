#!/usr/bin/env node
/** Browser regression tests for security fixes and formerly disconnected reads. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(root, 'site/package.json'));
const {chromium} = require('playwright-core');
const dist = path.join(root, 'site/dist');
const attack = '<img src=x onerror="window.__auditXss=1">';
let identity = {id:1, display_name:attack, email:'audit@example.invalid', role:'admin', player_id:'pl-02'};
let claimed = false;
const calls = [];
const firstGame = JSON.parse(await readFile(path.join(root, 'data/schedule.json'), 'utf8')).events.find(e => e.type === 'game').id;
const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.ttf':'font/ttf', '.webmanifest':'application/manifest+json'};
const server = createServer(async(req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      let raw = ''; for await(const part of req) raw += part;
      calls.push({path:url.pathname, method:req.method, body:raw ? JSON.parse(raw) : null});
      const p = url.pathname.slice(4);
      const json = value => {res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
      if (p === '/auth/me') return json(identity);
      if (p === '/auth/logout') {identity=null; return json({ok:true});}
      if (p.startsWith('/auth/')) return json({ok:true});
      if (p === '/users') return json([{...identity}]);
      if (p === '/news') return json([{id:1,title:attack,summary:null,body:attack,slug:'audit',status:'published',lang:'en',published_at:'2026-10-13T12:00:00Z'}]);
      if (p === '/profiles') return json({'pl-02':{bio:'A great teammate. **Strong skater.**'}});
      if (p.startsWith('/stats/game/')) return json({result:{our_score:3,their_score:1,status:'final'},lines:[]});
      if (p === '/stats/season') return json({team:{gp:1,w:1,l:0,t:0,gf:3,ga:1},skaters:[{player_id:'pl-02',display_name:'Test Player',gp:1,g:3,a:0,pts:3,pim:0,plus_minus:2}]});
      if (p.startsWith('/notes/')) return json({preview:{body:'Meet at the rink. **Bring water.**',author:'Coach'}});
      if (p.startsWith('/jobs/') && p.endsWith('/claim')) {claimed=!url.searchParams.has('release'); return json({ok:true});}
      if (p === `/jobs/${firstGame}`) return json([{job_type_id:1,name:'Scoresheet',family:'Test Family',player_id:'pl-02',claimed_by_id:claimed?1:null,claimed_by:claimed?'Guardian':null,note:null}]);
      if (p === '/chat/members') return json([{id:2,display_name:'Teammate'}]);
      if (p === '/chat/conversations') return json([{id:1,kind:'team',name:'Team room',last_message:attack,unread:1}]);
      if (p === '/chat/conversations/1/messages') return json({messages:[{id:1,conversation_id:1,sender_id:2,sender_name:'Teammate',body:attack,created_at:'2026-10-13T12:00:00Z',deleted_at:null,revision:1}],cursor:1,has_more:false});
      if (p.startsWith('/chat/')) return json({ok:true});
      if (p === '/moderation/count') return json({pending:0,held:0});
      if (p === '/goals') return json({goals:[],players:[],admin:identity?.role==='admin',today:'2026-10-13',player_id:identity?.player_id});
      return json([]);
    }
    let relative = decodeURIComponent(url.pathname);
    if (!path.extname(relative)) relative = relative.replace(/\/$/,'')+'/index.html';
    const filename = path.join(dist, relative);
    if (!filename.startsWith(dist+path.sep)) {res.writeHead(403).end();return;}
    const bytes = await readFile(filename);
    res.writeHead(200, {'content-type':types[path.extname(filename)]||'application/octet-stream','cache-control':'no-store'});res.end(bytes);
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH||'chromium',headless:true,args:['--no-sandbox']});
const context = await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
const page = await context.newPage();
const errors = [];page.on('pageerror', error => errors.push(error.message));
let count=0;
async function check(name, run) {await run();count++;console.log(`  PASS  ${name}`);}
try {
  await check('login recovers from network failure without trapping the submit button', async() => {
    await page.route('**/api/auth/login', route => route.abort());
    await page.goto(base+'/login');
    await page.locator('[name=email]').fill('audit@example.invalid');await page.locator('[name=password]').fill('password123');
    await page.locator('#f button').click();await page.getByText('Could not connect.',{exact:false}).waitFor();
    assert.equal(await page.locator('#f button').isEnabled(),true);
    await page.unroute('**/api/auth/login');
  });
  await check('login rejects a backslash-based external redirect', async() => {
    await page.goto(base+'/login?next='+encodeURIComponent('/\\evil.invalid'));
    await page.locator('[name=email]').fill('audit@example.invalid');await page.locator('[name=password]').fill('password123');
    await page.locator('#f button').click();await page.waitForURL(base+'/');
  });
  await check('admin account names and news titles render as text, never HTML', async() => {
    await page.goto(base+'/admin');await page.locator('#editor').waitFor({state:'visible'});
    await page.locator('[data-tab="people-tab"]').click();await page.locator('#people tr').waitFor();
    assert.equal(await page.locator('#people img').count(),0);assert.ok((await page.locator('#people').innerText()).includes(attack));
    await page.locator('[data-tab="news-tab"]').click();await page.locator('#np-list li').waitFor();
    assert.equal(await page.locator('#np-list img').count(),0);
  });
  await check('chat shows monitoring notice, treats messages as text and reports to admins', async() => {
    await page.goto(base+'/chat');await page.locator('#chat-app').waitFor({state:'visible'});
    await page.locator('.chat-room').first().click();
    await page.locator('.chat-safety summary').click();
    assert.match(await page.locator('#chat-hint').innerText(), /monitored/);
    await page.locator('.chat-message').waitFor();assert.equal(await page.locator('.chat-message img').count(),0);
    page.once('dialog', dialog => dialog.accept());await page.getByRole('button',{name:'Report',exact:true}).click();
    await page.getByRole('button',{name:'Reported',exact:true}).waitFor();
    assert.ok(calls.some(call=>call.path.endsWith('/report')));
  });
  await check('saved game scores and coach notes appear, and linked parents can claim jobs', async() => {
    identity={...identity, role:'parent'};await page.goto(base+'/schedule/'+firstGame);
    await page.getByText('Lightning 3 – Opponent 1',{exact:false}).waitFor();
    await page.getByText('Bring water.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Claim job',exact:true}).click();await page.getByRole('button',{name:'Release job',exact:true}).waitFor();
    assert.ok(claimed);
  });
  await check('children see job coverage without adult claim controls', async() => {
    identity={...identity,role:'player'};await page.goto(base+'/schedule/'+firstGame);await page.getByText('Scoresheet',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:/Claim job|Release job/}).count(),0);
  });
  await check('recorded season statistics and saved biographies reach player pages', async() => {
    await page.goto(base+'/stats');await page.getByText('Test Player',{exact:true}).waitFor();
    await page.goto(base+'/players/pl-02');await page.getByText('Strong skater.',{exact:true}).waitFor();
    await page.locator('[data-live-stats] tbody tr').waitFor();
  });
  await check('account password mismatch stays local, successful change clears password fields', async() => {
    await page.goto(base+'/account');await page.locator('#account-content').waitFor({state:'visible'});
    await page.locator('[name=current]').fill('original-password');await page.locator('[name=new]').fill('new-password123');await page.locator('[name=confirm]').fill('wrong-password');
    await page.getByRole('button',{name:'Change password',exact:true}).click();await page.getByText('The new passwords do not match.').waitFor();
    assert.equal(calls.filter(call=>call.path.endsWith('/change-password')).length,0);
    await page.locator('[name=confirm]').fill('new-password123');await page.getByRole('button',{name:'Change password',exact:true}).click();
    await page.getByText('Password changed.',{exact:false}).waitFor();assert.equal(await page.locator('[name=new]').inputValue(),'');
  });
  await check('logout clears private drafts and returns to sign-in', async() => {
    await page.evaluate(()=>sessionStorage.setItem('lvlnb.play-draft.v1','private draft'));
    await page.getByRole('button',{name:'Sign out on all devices'}).click();await page.waitForURL(base+'/login');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('lvlnb.play-draft.v1')),null);
  });
  await check('no script errors or injected execution occurred', async()=> {
    assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.__auditXss),undefined);
  });
  console.log(`${count}/${count} browser security and live-data checks passed`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
