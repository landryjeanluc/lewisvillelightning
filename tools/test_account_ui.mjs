#!/usr/bin/env node
/** Account flows against a built site, including mobile and failed saves. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const {chromium}=createRequire(path.join(root,'site/package.json'))('playwright-core');
const dist=path.join(root,'site/dist');
let user={id:1,role:'player',display_name:'Test Player',email:'test-player',player_id:'pl-02'};
let profile={id:'pl-02',name:'Test Player',number:2,position:'C',shoots:'L',nickname:'Flash',bio:'Working on skating.'};
let contacts={display_name:'Test Parent',email:'test-parent',phone:null};
let failProfile=false,failDetails=false,failGoals=false;
const calls=[];
const baseEvent={startsAt:'2099-10-13T17:00:00-03:00',endsAt:null,status:'scheduled',venue:'Test arena'};
const events=[{...baseEvent,id:'game-a',type:'game',label:'vs Test Team'},
  {...baseEvent,id:'practice-a',startsAt:'2099-10-14T17:00:00-03:00',type:'practice',label:'Ice practice'},
  {...baseEvent,id:'training-a',startsAt:'2099-10-15T17:00:00-03:00',type:'practice',label:'Off-ice practice'},
  {...baseEvent,id:'cancelled',type:'game',label:'Cancelled opponent',status:'cancelled'},
  {...baseEvent,id:'live-cancelled',type:'game',label:'Cancelled by coach'},
  {...baseEvent,id:'past',type:'game',label:'Past opponent',startsAt:'2020-01-01T12:00:00Z'}];
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if(url.pathname.startsWith('/api/')) {
      let raw='';for await(const chunk of req) raw+=chunk;
      const body=raw?JSON.parse(raw):null;calls.push({path:url.pathname,body});
      if(url.pathname==='/api/auth/me') return json(user);
      if(url.pathname==='/api/account') return failDetails?json({detail:'offline'},503):json({contact:contacts,player:user?.player_id?profile:null,
        assignments:[{game_id:'game-a',name:'50/50',note:'Meet the coordinator',claimed_by:'Test Parent'},
          {game_id:'cancelled',name:'Cancelled task'}, {game_id:'past',name:'Past task'}],schedule_statuses:{'live-cancelled':'cancelled'}});
      if(url.pathname==='/api/account/profile') {
        if(failProfile) return json({detail:'This profile was held for coach review.'},422);
        profile={...profile,...body};return json({ok:true});
      }
      if(url.pathname==='/api/account/contact') {contacts={...body};return json({ok:true});}
      if(url.pathname==='/api/goals') return failGoals?json({detail:'offline'},503):json({admin:false,today:'2099-10-01',player_id:user?.player_id,players:[{id:'pl-02',name:'Test Player',number:2}],
        goals:[{id:1,title:'Practice shots',scope:'player',player_id:'pl-02',unit:'shots',target:100,total:30,family_total:30,starts_on:'2099-10-01',ends_on:'2099-10-31',archived:false},
          {id:2,title:'Team work',scope:'team',player_id:null,unit:'minutes',target:1000,total:200,family_total:15,starts_on:'2099-10-01',ends_on:'2099-10-31',archived:false},
          {id:3,title:'Other child private goal',scope:'player',player_id:'pl-03',unit:'shots',target:100,total:10,starts_on:'2099-10-01',ends_on:'2099-10-31',archived:false}]});
      if(url.pathname==='/api/profiles') return json({'pl-02':profile});
      return json([]);
    }
    let relative=decodeURIComponent(url.pathname);
    if(!path.extname(relative)) relative=relative.replace(/\/$/,'')+'/index.html';
    const filename=path.join(dist,relative);
    if(!filename.startsWith(dist+path.sep)) return res.writeHead(403).end();
    let bytes=await readFile(filename);
    if(url.pathname==='/account') bytes=Buffer.from(bytes.toString().replace(/(<script id="account-events"[^>]*>)[\s\S]*?(<\/script>)/,'$1'+JSON.stringify(events)+'$2'));
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.ttf':'font/ttf'};
    res.writeHead(200,{'content-type':types[path.extname(filename)]||'application/octet-stream'});res.end(bytes);
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
let count=0;
async function check(name,run){await run();count++;console.log('  PASS  '+name);}
try {
  await check('player sees own profile and progress without contact identity controls',async()=>{
    await page.goto(base+'/account');await page.locator('#player-section').waitFor({state:'visible'});
    await page.locator('[data-pgoals-done]').waitFor();
    assert.equal(await page.locator('#profile-form [name=nickname]').inputValue(),'Flash');
    assert.equal(await page.locator('#contact-section').isVisible(),false);
    assert.match(await page.locator('[data-player-goals]').innerText(),/Practice shots/i);
    assert.match(await page.locator('[data-player-goals]').innerText(),/share: 15 minutes/);
    assert.doesNotMatch(await page.locator('[data-player-goals]').innerText(),/Other child/i);
    assert.equal(await page.locator('progress').first().getAttribute('value'),'30');
  });
  await check('upcoming schedule includes ice and off-ice practices and excludes cancellations and old games',async()=>{
    const text=await page.locator('#account-schedule').innerText();
    assert.match(text,/Ice practice/i);assert.match(text,/Off-ice practice/i);assert.match(text,/vs Test Team/i);
    assert.doesNotMatch(text,/Cancelled|Past/i);
  });
  await check('family sees assigned task and claiming parent, only for upcoming games',async()=>{
    const text=await page.locator('#account-assignments').innerText();assert.match(text,/50\/50/);assert.match(text,/Claimed by Test Parent/);
    assert.doesNotMatch(text,/Cancelled task|Past task/i);
    assert.equal(await page.locator('#account-assignments a').getAttribute('href'),'/schedule/game-a');
  });
  await check('mobile account fits viewport',async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true));
  if(process.env.ACCOUNT_SCREENSHOTS) {
    await page.screenshot({path:'/tmp/lvlnb-account-mobile.png',fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:'/tmp/lvlnb-account-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
  }
  await check('player saves editable hockey details without sending privileged fields',async()=>{
    await page.locator('#profile-form [name=position]').selectOption('D');await page.locator('#profile-form [name=nickname]').fill('Skater');
    await page.locator('#profile-form button').click();await page.getByText('Player profile saved.',{exact:true}).waitFor();
    const saved=calls.findLast(c=>c.path==='/api/account/profile').body;
    assert.equal(saved.position,'D');assert.deepEqual(Object.keys(saved).sort(),['bio','nickname','position','shoots']);
  });
  await check('moderation rejection keeps unsaved text and permits correction',async()=>{
    failProfile=true;await page.locator('#profile-form [name=bio]').fill('Text to correct');await page.locator('#profile-form button').click();
    await page.getByText('This profile was held for coach review.',{exact:true}).waitFor();
    assert.equal(await page.locator('#profile-form [name=bio]').inputValue(),'Text to correct');assert.equal(await page.locator('#profile-form button').isEnabled(),true);failProfile=false;
  });
  await check('parent can update name, email and optional phone',async()=>{
    user={...user,role:'parent',display_name:'Test Parent',email:'test-parent'};
    await page.goto(base+'/account');await page.locator('#contact-form button:not([disabled])').waitFor();
    await page.locator('#contact-form [name=display_name]').fill('New Parent');await page.locator('#contact-form [name=email]').fill('parent@example.invalid');
    await page.locator('#contact-form [name=phone]').fill('+1 506 555 0100');await page.locator('#contact-form [name=current_password]').fill('test-password');
    await page.locator('#contact-form button').click();await page.getByText('Contact details saved.',{exact:true}).waitFor();
    assert.equal(await page.locator('#account-name').textContent(),'New Parent');assert.equal(await page.locator('#contact-form [name=current_password]').inputValue(),'');
    assert.match(await page.locator('#account-handle').innerText(),/parent@example.invalid/);
  });
  await check('failed account load is retryable and does not enable a blank contact save',async()=>{
    failDetails=true;await page.goto(base+'/account');await page.locator('#details-retry').waitFor({state:'visible'});
    assert.equal(await page.locator('#contact-form button').isDisabled(),true);assert.equal(await page.locator('#password-form').isVisible(),true);
    failDetails=false;await page.locator('#details-retry').click();await page.locator('#player-section').waitFor({state:'visible'});
    assert.equal(await page.locator('#contact-form button').isEnabled(),true);
  });
  await check('failed goals read shows a recovery path rather than implying zero progress',async()=>{
    failGoals=true;await page.goto(base+'/account');await page.getByText('Could not load your progress.',{exact:false}).waitFor();failGoals=false;
  });
  await check('unlinked parent receives an explanation without another player profile',async()=>{
    user={...user,player_id:null};await page.goto(base+'/account');await page.getByText('Ask your coach to link your account',{exact:false}).waitFor();
    assert.equal(await page.locator('#player-section').isVisible(),false);assert.equal(await page.locator('#assignments-section').isVisible(),false);
  });
  await check('nickname on player page is text and updated position is visible',async()=>{
    profile={...profile,nickname:'<img src=x onerror="window.accountXss=1">',position:'D'};
    await page.goto(base+'/players/pl-02');await page.locator('[data-nickname]').waitFor({state:'visible'});
    assert.equal(await page.locator('[data-nickname] img').count(),0);assert.equal(await page.locator('[data-position]').first().innerText(),'D');
    assert.equal(await page.evaluate(()=>window.accountXss),undefined);
  });
  await check('signed-out visitor sees sign-in gate and no account details',async()=>{
    user=null;await page.goto(base+'/account');await page.locator('#account-gate').waitFor({state:'visible'});
    assert.equal(await page.locator('#account-content').isVisible(),false);
  });
  await check('all account routes run without browser exceptions',async()=>assert.deepEqual(errors,[]));
  console.log(`\n${count}/${count} account browser checks passed`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
