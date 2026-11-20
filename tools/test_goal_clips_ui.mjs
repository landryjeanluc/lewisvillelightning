#!/usr/bin/env node
/** Admin goal clips: upload by file name, tag each goal, copy totals to the scoresheet. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const dist=path.join(root,'site/dist');
const {chromium}=createRequire(path.join(root,'site/package.json'))('playwright-core');
const GAME='g-2026-10-23-shediac';
const uploads=new Map(), clips=[], tagged=[], sheets=[];
function listing(game) {
  const mine=clips.filter(c=>c.game_id===game).sort((a,b)=>a.seq-b.seq);
  const totals={};const line=id=>totals[id]??={g:0,a:0,plus_minus:0};
  for(const c of mine) {
    if(c.scorer)line(c.scorer).g++;
    for(const id of [c.assist1,c.assist2])if(id)line(id).a++;
    if(!c.power_play)for(const id of c.on_ice)line(id).plus_minus+=c.team==='us'?1:-1;
  }
  return {clips:mine,totals,our_goals:mine.filter(c=>c.team==='us').length,their_goals:mine.filter(c=>c.team==='them').length};
}
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const json=(body,code=200)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);
    if(url.pathname.startsWith('/api/')) {
      if(url.pathname==='/api/auth/me')return json({id:1,role:'admin',display_name:'Test admin'});
      if(url.pathname.startsWith('/api/stats/game/')) {
        if(req.method==='PUT'){sheets.push(JSON.parse(raw));return json({ok:true,saved:sheets.at(-1).lines.length,warnings:[],revision:1});}
        return json({game_id:url.pathname.split('/')[4],result:null,lines:[]});
      }
      if(url.pathname==='/api/goal-clips')return json(listing(url.searchParams.get('game_id')));
      if(url.pathname==='/api/goal-clips/uploads') {
        const body=JSON.parse(raw);
        if(clips.some(c=>c.game_id===body.game_id&&c.seq===body.seq))return json({detail:`Goal ${body.seq} of this game already has a clip. Remove it before uploading a replacement.`},409);
        uploads.set(body.id,{...body,received:0});return json({id:body.id,received:0,state:'uploading',chunk_bytes:64},201);
      }
      const parts=url.pathname.split('/');
      if(parts[3]==='uploads') {
        const upload=uploads.get(parts[4]);
        if(req.method==='PUT'){assert.equal(Number(url.searchParams.get('offset')),upload.received);upload.received+=raw.length;return json({received:upload.received});}
        assert.equal(upload.received,upload.bytes);
        const clip={id:upload.id,game_id:upload.game_id,seq:upload.seq,team:upload.team,scorer:null,assist1:null,assist2:null,on_ice:[],power_play:false,duration:2};
        clips.push(clip);return json(clip);
      }
      if(url.pathname.startsWith('/api/goal-clips/')) {
        const clip=clips.find(c=>c.id===parts[3]);
        if(req.method==='GET'){res.writeHead(200,{'content-type':'image/png'});return res.end(await readFile(path.join(dist,'brand/lightning-crest.png')));}
        if(req.method==='DELETE'){clips.splice(clips.indexOf(clip),1);return json({ok:true});}
        const body=JSON.parse(raw);tagged.push(body);
        if(body.assist1&&body.assist1===body.scorer)return json({detail:[{msg:'Value error, A player can be credited once per goal'}]},422);
        Object.assign(clip,body,{on_ice:[...new Set([...body.on_ice,body.scorer,body.assist1,body.assist2].filter(Boolean))]});
        return json(clip);
      }
      return json(url.pathname.endsWith('/count')?{pending:0}:[]);
    }
    let relative=decodeURIComponent(url.pathname);if(!path.extname(relative))relative=relative.replace(/\/$/,'')+'/index.html';
    const file=path.join(dist,relative);if(!file.startsWith(dist+path.sep))return res.writeHead(403).end();
    const data=await readFile(file);const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.ttf':'font/ttf'};
    res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});res.end(data);
  } catch {if(!res.headersSent)res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:390,height:844}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
const base=`http://127.0.0.1:${server.address().port}`;
const panel=page.locator('[data-goal-clips]');
const status=panel.locator('[data-clip-status]');
const file=name=>({name,mimeType:'video/mp4',buffer:Buffer.alloc(150,7)});
const goal=seq=>panel.locator(`[data-clip="${seq}"]`);
const field=(card,label)=>card.getByLabel(label,{exact:true});
let count=0;async function check(name,run){await run();console.log('  PASS  '+name);count++;}
try {
  await page.goto(base+'/admin?game='+GAME);
  await check('an empty game says so',async()=>{
    await status.getByText('No clips for this game yet.').waitFor();
    assert.equal(await panel.locator('[data-clip-apply]').isVisible(),false);
  });
  await check('files that are not this game\'s clips are refused before upload',async()=>{
    await panel.locator('[data-clip-files]').setInputFiles([file('holiday.mp4')]);
    await status.getByText('is not a clip from the replay tool',{exact:false}).waitFor();
    await panel.locator('[data-clip-files]').setInputFiles([file('g-2026-10-17-kent.goal-01.us.1-0.mp4')]);
    await status.getByText('belongs to another game',{exact:false}).waitFor();
    assert.equal(uploads.size,0);
  });
  await check('clips upload in pieces and appear in game order with the running score',async()=>{
    await panel.locator('[data-clip-files]').setInputFiles([file(GAME+'.goal-02.them.1-1.mp4'),file(GAME+'.goal-01.us.1-0.mp4')]);
    await status.getByText('2 of 2 clips added.').waitFor();
    assert.deepEqual(await panel.locator('.clip h3').allTextContents(),['Goal 1 · Lightning 1, opponent 0','Goal 2 · Lightning 1, opponent 1']);
    assert.match(await goal(1).locator('video').getAttribute('src'),/^\/api\/goal-clips\/[0-9a-f-]{36}\/video$/);
    assert.equal(await goal(1).locator('video').getAttribute('preload'),'none');
  });
  await check('a goal cannot hold two clips',async()=>{
    await panel.locator('[data-clip-files]').setInputFiles([file(GAME+'.goal-01.us.1-0.mp4')]);
    await status.getByText('already has a clip',{exact:false}).waitFor();
    assert.equal(await panel.locator('.clip').count(),2);
  });
  await check('tagging saves at once and the scorer joins the players on the ice',async()=>{
    await field(goal(1),'Scorer').selectOption('pl-02');
    await goal(1).getByText('Saved.',{exact:true}).waitFor();
    assert.equal(await goal(1).locator('[data-player="pl-02"]').getAttribute('aria-pressed'),'true');
    await goal(1).locator('[data-player="pl-14"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-clip-summary]')?.textContent.includes('Lightning 1, opponent 1.'));
    assert.deepEqual(tagged.at(-1),{team:'us',scorer:'pl-02',assist1:null,assist2:null,on_ice:['pl-02','pl-14'],power_play:false});
  });
  await check('a refused tag says why and that it was not saved',async()=>{
    await field(goal(1),'Assist').selectOption('pl-02');
    await goal(1).getByText('A player can be credited once per goal Not saved.',{exact:true}).waitFor();
    await field(goal(1),'Assist').selectOption('pl-07');
    await goal(1).getByText('Saved.',{exact:true}).waitFor();
  });
  await check('opponent goals take players on the ice but no scorer',async()=>{
    assert.equal(await field(goal(2),'Scorer').isVisible(),false);
    await goal(2).locator('[data-player="pl-14"]').click();
    await goal(2).getByText('Saved.',{exact:true}).waitFor();
    assert.equal(tagged.at(-1).team,'them');
  });
  await check('totals copy to the scoresheet and save with it',async()=>{
    await panel.getByRole('button',{name:'Copy goals, assists and +/− to the scoresheet'}).click();
    await status.getByText('Copied to the scoresheet.',{exact:false}).waitFor();
    const value=(player,f)=>page.locator(`#sheet tr[data-player="${player}"] [data-f="${f}"]`).inputValue();
    assert.deepEqual([await value('pl-02','g'),await value('pl-02','plus_minus'),await value('pl-07','a'),await value('pl-14','plus_minus')],['1','1','1','0']);
    assert.deepEqual([await page.locator('#ourScore').inputValue(),await page.locator('#theirScore').inputValue()],['1','1']);
    await page.locator('#sheet tr[data-player="pl-14"] [data-f="pim"]').fill('2');
    await page.locator('#sheet-finish').click();
    await page.locator('#status').getByText('Game finished.',{exact:false}).waitFor();
    const sheet=sheets.at(-1);
    assert.deepEqual([sheet.our_score,sheet.their_score,sheet.status],[1,1,'final']);
    assert.deepEqual(sheet.lines.find(l=>l.player_id==='pl-02'),{player_id:'pl-02',g:1,a:0,pim:0,plus_minus:1});
    assert.deepEqual(sheet.lines.find(l=>l.player_id==='pl-14'),{player_id:'pl-14',g:0,a:0,pim:2,plus_minus:0});
  });
  await check('fits a phone and survives changing game',async()=>{
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await mkdir(path.join(root,'private/verification'),{recursive:true});
    await goal(1).screenshot({path:path.join(root,'private/verification/goal-clips-admin-mobile.png')});
    await page.locator('#game').selectOption('g-2026-10-17-kent');
    await status.getByText('No clips for this game yet.').waitFor();
    assert.equal(await panel.locator('.clip').count(),0);
  });
  await check('removing a clip removes its card',async()=>{
    await page.locator('#game').selectOption(GAME);
    await goal(2).getByRole('button',{name:'Remove clip'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-goal-clips] .clip').length===1);
  });
  await check('no browser exceptions',async()=>assert.deepEqual(errors,[]));
  console.log(`\n${count}/${count} goal clip browser checks passed`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
