#!/usr/bin/env node
/** Live hero and score editor against the built site. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const {chromium}=createRequire(path.join(root,'site/package.json'))('playwright-core');
const dist=path.join(root,'site/dist');
const fixtures=JSON.parse(await readFile(path.join(root,'data/schedule.json'),'utf8')).events.filter(g=>g.type==='game');
const scores=fixtures.map(g=>({game_id:g.id,starts_at:new Date().toISOString(),status:'scheduled',period:null,our_score:null,their_score:null,revision:0,updated_at:null}));
let offline=false, reject=false;
const user={id:1,role:'admin',display_name:'Coach',email:'coach',player_id:null};
const calls=[];
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if(url.pathname.startsWith('/api/')) {
      let raw='';for await(const c of req) raw+=c;
      const body=raw?JSON.parse(raw):null;
      if(url.pathname==='/api/auth/me') return json(user);
      if(url.pathname==='/api/scoreboard') return offline?json({detail:'offline'},503):json({games:scores});
      if(url.pathname.startsWith('/api/scoreboard/')) {
        calls.push(body);const game=scores.find(g=>g.game_id===url.pathname.split('/').pop());
        if(reject || game.revision!==body.expected_revision) return json({detail:'The score changed on another device. Load the latest score before saving again.'},409);
        Object.assign(game,{...body,revision:game.revision+1});return json(game);
      }
      if(url.pathname.startsWith('/api/stats/game/')) return json({result:null,lines:[]});
      if(url.pathname==='/api/goals') return json({goals:[],players:[],admin:true,player_id:null,today:'2026-10-13'});
      if(url.pathname==='/api/profiles') return json({});
      if(url.pathname==='/api/moderation/count') return json({pending:0,held:0});
      return json([]);
    }
    let relative=decodeURIComponent(url.pathname);
    if(!path.extname(relative)) relative=relative.replace(/\/$/,'')+'/index.html';
    const filename=path.join(dist,relative);
    if(!filename.startsWith(dist+path.sep)) return res.writeHead(403).end();
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.ttf':'font/ttf'};
    res.writeHead(200,{'content-type':types[path.extname(filename)]||'application/octet-stream'});res.end(await readFile(filename));
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'chromium',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
const home=await context.newPage();const admin=await context.newPage();
const errors=[];for(const page of [home,admin]) page.on('pageerror',error=>errors.push(error.message));
let count=0;
async function check(name,run){await run();count++;console.log('  PASS  '+name);}
const field=name=>admin.locator(`#live-score-form [name=${name}]`);
const save=()=>admin.locator('#live-score-form button[type=submit]').click();
const liveFixture=()=>home.locator('[data-live-fixture]:visible');
try {
  await check('homepage changes fixtures and spotlight as time passes without rebuilding',async()=>{
    await home.clock.setFixedTime(new Date('2026-10-13T19:00:00Z'));
    await home.goto(base+'/');
    await home.locator(`[data-home-game="${fixtures[0].id}"]`).waitFor({state:'visible'});
    assert.equal(await home.locator('[data-home-game]:visible h1').textContent(),'Game Day');
    await home.clock.setFixedTime(new Date('2026-10-14T15:00:00Z'));
    await home.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await home.locator(`[data-home-game="${fixtures[1].id}"]`).waitFor({state:'visible'});
    assert.equal(await home.locator('[data-home-game]:visible h1').textContent(),'Next Game');
    await home.clock.setFixedTime(new Date('2026-10-15T15:00:00Z'));
    await home.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await home.locator('[data-home-game]:visible h1').textContent(),'Game Day');
    assert.equal(await home.locator('[data-home-spotlight]:visible').getAttribute('data-home-spotlight'),fixtures[1].id);
    assert.equal(await home.locator('[data-home-event]:visible').count(),0);
    assert.ok((await home.locator('[data-home-game]:visible .hero-info').textContent()).includes('4:30 PM'));
    assert.equal(await home.locator('[data-home-game]:visible .cta').getAttribute('href'),`/schedule/${fixtures[1].id}`);
  });
  await check('a previous game left in progress does not hide today’s fixture',async()=>{
    const saved={...scores[0]};
    Object.assign(scores[0],{status:'in_progress',starts_at:fixtures[0].startsAt,period:'2',our_score:1,their_score:2});
    await home.reload();
    await home.locator(`[data-home-game="${fixtures[1].id}"]`).waitFor({state:'visible'});
    await home.waitForResponse(r=>r.url().endsWith('/api/scoreboard'));
    assert.equal(await home.locator('[data-live-board]').isVisible(),false);
    assert.equal(await home.locator('[data-upcoming-hero]').isVisible(),true);
    Object.assign(scores[0],saved);
  });
  await check('cancelled games and exhausted schedules do not leave an old banner',async()=>{
    const saved={...scores[1]};scores[1].status='cancelled';
    await home.reload();await home.locator('[data-home-empty]').waitFor({state:'visible'});
    assert.equal(await home.locator('[data-home-spotlight]:visible').count(),0);
    Object.assign(scores[1],saved);
    await home.clock.setFixedTime(new Date('2026-10-16T15:00:00Z'));
    await home.reload();await home.locator('[data-home-empty]').waitFor({state:'visible'});
    assert.equal(await home.locator('[data-home-game]:visible').count(),0);
    await home.clock.setFixedTime(new Date());
  });
  await check('scheduled game retains the upcoming hero',async()=>{
    await home.goto(base+'/');await home.locator('[data-upcoming-hero]').waitFor({state:'visible'});
    assert.equal(await home.locator('[data-live-board]').isVisible(),false);
  });
  await check('admin deep link opens live scoring with a loaded game',async()=>{
    await admin.goto(base+'/admin#live-tab');await admin.locator('#editor').waitFor({state:'visible'});
    await admin.locator('#live-score-fields:not([disabled])').waitFor();assert.equal(await admin.locator('#live-tab').isVisible(),true);
    await field('game_id').selectOption(fixtures[0].id);await admin.getByText('Latest score loaded.',{exact:true}).waitFor();
  });
  await check('starting game publishes zero scores and first period',async()=>{
    await admin.locator('#live-start').click();await admin.getByText('Live score saved.',{exact:false}).waitFor();
    assert.equal(calls.at(-1).status,'in_progress');assert.equal(calls.at(-1).period,'1');assert.equal(calls.at(-1).our_score,0);
    await home.locator('[data-live-board]').waitFor({state:'visible',timeout:10000});
    assert.equal(await home.locator('[data-upcoming-hero]').isVisible(),false);
    assert.equal(await home.locator('[data-score-period]').textContent(),'1st period');
    assert.equal(await home.locator('[data-live-board] .cd, [data-live-board] time').count(),0);
  });
  await check('scores and period refresh on the homepage without a reload',async()=>{
    await field('our_score').fill('3');await field('their_score').fill('1');await field('period').selectOption('2');await save();
    await home.waitForFunction(()=>document.querySelector('[data-live-fixture]:not([hidden]) [data-home-score]')?.textContent==='3',{},{timeout:10000});
    assert.equal(await liveFixture().locator('[data-away-score]').textContent(),'1');assert.equal(await home.locator('[data-score-period]').textContent(),'2nd period');
  });
  await check('scoreboard and editor fit a phone',async()=>{
    for(const page of [home,admin]) assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await home.screenshot({path:'/tmp/lvlnb-live-score-mobile.png',fullPage:false});
  });
  await check('a conflicting save retains entered scores and offers explicit reload',async()=>{
    reject=true;await field('our_score').fill('4');await save();await admin.getByText('The score changed on another device.',{exact:false}).waitFor();
    assert.equal(await field('our_score').inputValue(),'4');assert.equal(await admin.locator('#live-score-fields').isDisabled(),false);
    reject=false;admin.once('dialog',dialog=>dialog.accept());await admin.locator('#live-refresh').click();await admin.getByText('Latest score loaded.',{exact:true}).waitFor();
    assert.equal(await field('our_score').inputValue(),'3');
  });
  await check('offline polling preserves last score and reports interruption',async()=>{
    offline=true;await home.getByText('Updates interrupted.',{exact:false}).waitFor({timeout:10000});
    assert.equal(await liveFixture().locator('[data-home-score]').textContent(),'3');offline=false;
    await home.getByText('Scores update automatically.',{exact:true}).waitFor({timeout:10000});
  });
  await check('final score stays in the hero for game day',async()=>{
    await field('status').selectOption('final');await save();await admin.getByText('Final score saved.',{exact:true}).waitFor();
    await home.locator('[data-score-period]').filter({hasText:'Final'}).waitFor({timeout:10000});
  });
  await check('away game puts Lightning score on away side even if static hero was another fixture',async()=>{
    await field('game_id').selectOption(fixtures[1].id);await admin.getByText('Latest score loaded.',{exact:true}).waitFor();
    await field('our_score').fill('5');await field('their_score').fill('2');await field('period').selectOption('OT');await admin.locator('#live-start').click();
    await home.locator(`[data-live-fixture="${fixtures[1].id}"]`).waitFor({state:'visible',timeout:10000});
    assert.equal(await liveFixture().locator('[data-away-score]').textContent(),'5');assert.equal(await liveFixture().locator('[data-home-score]').textContent(),'2');
    assert.equal(await home.locator('[data-score-period]').textContent(),'Overtime');
  });
  await check('cancelling a scoresheet game switch retains the original game and unsaved stats',async()=>{
    await admin.locator('[data-tab="sheet-tab"]').click();
    const original=await admin.locator('#game').inputValue();
    const other=fixtures.find(g=>g.id!==original).id;
    await admin.locator('#sheet [data-f=g]').first().fill('2');
    admin.once('dialog',dialog=>dialog.dismiss());await admin.locator('#game').selectOption(other);
    assert.equal(await admin.locator('#game').inputValue(),original);
    assert.equal(await admin.locator('#sheet [data-f=g]').first().inputValue(),'2');
    admin.once('dialog',dialog=>dialog.accept());await admin.locator('#reload-sheet').click();
    await admin.waitForFunction(()=>document.querySelector('#sheet [data-f=g]').value==='0');
  });
  await check('scoreboard controls are not offered to non-admins',async()=>{
    user.role='parent';await home.reload();await home.locator('[data-live-board]').waitFor({state:'visible'});
    assert.equal(await home.locator('[data-score-admin]').isVisible(),false);
  });
  await check('no browser exceptions in the live scoring flow',async()=>assert.deepEqual(errors,[]));
  console.log(`\n${count}/${count} scoreboard browser checks passed`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
