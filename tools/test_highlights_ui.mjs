#!/usr/bin/env node
/** Player highlight controls, retry behavior and privacy against the built site. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
const dist=path.join(root,'site/dist');
const {chromium}=createRequire(path.join(root,'site/package.json'))('playwright-core');
const sampleMp4=execFileSync('uv',['run','--project',path.join(root,'api'),'--frozen','python','-c',`
import av, sys
from io import BytesIO
from PIL import Image
buffer = BytesIO()
with av.open(buffer, 'w', format='mp4') as output:
    stream = output.add_stream('libx264', rate=24)
    stream.width, stream.height, stream.pix_fmt = 320, 180, 'yuv420p'
    for i in range(48):
        frame = av.VideoFrame.from_image(Image.new('RGB', (320, 180), (i*5, 40, 90)))
        for packet in stream.encode(frame): output.mux(packet)
    for packet in stream.encode(): output.mux(packet)
sys.stdout.buffer.write(buffer.getvalue())
`]);
let role='admin', offline=false, failChunk=true, failDelete=false;
const uploads=new Map(), highlights=[];
const offsets=[], started=[];
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const json=(body,code=200)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);
    if(url.pathname.startsWith('/api/')) {
      if(url.pathname==='/api/auth/me')return json(role?{id:1,role,display_name:'Test user',player_id:'pl-02'}:null);
      if(url.pathname.startsWith('/api/highlights')) {
        if(!role)return json({detail:'Sign in'},401);
        if(url.pathname==='/api/highlights')return offline?json({detail:'Offline'},503):json({highlights:highlights.filter(h=>h.player_id===url.searchParams.get('player_id')),can_manage:role==='admin'});
        if(req.method==='GET' && url.pathname.endsWith('/poster')) {res.writeHead(200,{'content-type':'image/png'});return res.end(await readFile(path.join(dist,'brand/lightning-crest.png')));}
        if(req.method==='GET' && url.pathname.endsWith('/video')) {
          const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
          const start=range?Number(range[1]):0, end=range&&range[2]?Number(range[2]):sampleMp4.length-1;
          res.writeHead(range?206:200,{'content-type':'video/mp4','accept-ranges':'bytes','content-length':end-start+1,...(range?{'content-range':`bytes ${start}-${end}/${sampleMp4.length}`}:{})});
          return res.end(sampleMp4.subarray(start,end+1));
        }
        if(role!=='admin')return json({detail:'Admin only'},403);
        if(url.pathname==='/api/highlights/uploads') {
          const body=JSON.parse(raw);started.push(body);if(!uploads.has(body.id))uploads.set(body.id,{...body,received:0,state:'uploading'});
          return json({...uploads.get(body.id),chunk_bytes:64},201);
        }
        const id=url.pathname.split('/')[4];const upload=uploads.get(id);
        if(req.method==='PUT') {
          const offset=Number(url.searchParams.get('offset'));offsets.push(offset);
          if(failChunk&&offset>0){failChunk=false;return json({detail:'Upload interrupted. Try again.'},503);}
          assert.equal(offset,upload.received);upload.received+=raw.length;return json({received:upload.received});
        }
        if(req.method==='POST'&&url.pathname.endsWith('/publish')) {
          assert.equal(upload.received,upload.bytes);
          const h={...upload,duration:2,game_date:'2026-10-23',video_url:'/api/highlights/'+id+'/video',poster_url:'/api/highlights/'+id+'/poster'};
          highlights.push(h);return json(h);
        }
        if(req.method==='DELETE') {
          if(failDelete)return json({detail:'Could not remove clip. Try again.'},503);
          const target=url.pathname.split('/')[3];const i=highlights.findIndex(h=>h.id===target);if(i>=0)highlights.splice(i,1);uploads.delete(target);return json({ok:true});
        }
        return json({},404);
      }
      if(url.pathname==='/api/stats/season')return json({team:{gp:0,w:0,l:0},skaters:[]});
      if(url.pathname==='/api/goals')return json({goals:[],players:[],admin:false,player_id:null});
      return json({});
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
const section=page.locator('[data-player-highlights]');
const form=section.locator('form');
let count=0;async function check(name,run){await run();console.log('  PASS  '+name);count++;}
try {
  await page.goto(base+'/players/pl-02');
  await check('admin can add a highlight from the player profile',async()=>{
    await section.getByRole('button',{name:'Add a highlight',exact:true}).waitFor();
    await section.getByRole('button',{name:'Add a highlight',exact:true}).click();
    assert.equal(await form.isVisible(),true);
  });
  await check('failed upload retains clip and retry resumes without duplication',async()=>{
    await form.locator('[name=title]').fill('<img src=x onerror=alert(1)> Great pass');
    await form.locator('[name=game_id]').selectOption('g-2026-10-23-shediac');
    await form.locator('[name=clip]').setInputFiles({name:'highlight.mp4',mimeType:'video/mp4',buffer:Buffer.alloc(192,7)});
    await form.getByRole('button',{name:'Upload highlight',exact:true}).click();
    await form.getByText('Upload interrupted. Try again.',{exact:true}).waitFor();
    assert.equal(await form.locator('[name=clip]').evaluate(el=>el.files.length),1);
    await form.getByRole('button',{name:'Upload highlight',exact:true}).click();
    await section.getByText('Highlight added. The team can watch it now.',{exact:true}).waitFor();
    assert.equal(started[0].id,started[1].id);assert.deepEqual(offsets,[0,64,64,128]);assert.equal(highlights.length,1);
  });
  await check('titles are text and playback uses private video with native controls',async()=>{
    const card=section.locator('.hl-card');assert.equal(await card.locator('h3').textContent(),'<img src=x onerror=alert(1)> Great pass');
    assert.equal(await card.locator('img').count(),0);
    const video=card.locator('video');assert.equal(await video.getAttribute('preload'),'none');
    assert.equal(await video.getAttribute('playsinline'),'');assert.equal(await video.getAttribute('controls'),'');
    assert.match(await video.getAttribute('src'),/^\/api\/highlights\//);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await mkdir(path.join(root,'private/verification'),{recursive:true});
    await section.screenshot({path:path.join(root,'private/verification/highlights-admin-mobile.png')});
  });
  await check('parents see clips without upload or delete controls',async()=>{
    role='parent';await page.reload();await section.locator('.hl-card').waitFor();
    assert.equal(await section.locator('[data-highlight-add]').isVisible(),false);
    assert.equal(await section.locator('.hl-remove').count(),0);
    await section.locator('video').evaluate(async video=>{video.muted=true;await video.play();});
    await page.waitForFunction(()=>document.querySelector('[data-player-highlights] video')?.currentTime>0.1);
    await section.locator('video').evaluate(video=>video.pause());
    await section.screenshot({path:path.join(root,'private/verification/highlights-parent-mobile.png')});
  });
  await check('highlights are attached only to the chosen player',async()=>{
    await page.goto(base+'/players/pl-03');await section.getByText('No highlights yet. Check back after the next game.').waitFor();
    assert.equal(await section.locator('video').count(),0);
  });
  await check('failed load offers a working retry and signed-out page shows no clips',async()=>{
    offline=true;await page.goto(base+'/players/pl-02');await section.getByRole('button',{name:'Try again'}).waitFor();
    offline=false;await section.getByRole('button',{name:'Try again'}).click();await section.locator('video').waitFor();
    role=null;await page.reload();await section.getByText('Sign in to watch player highlights.').waitFor();assert.equal(await section.locator('video').count(),0);
  });
  await check('failed deletion keeps the clip and successful deletion restores empty state',async()=>{
    role='admin';failDelete=true;await page.reload();await section.getByRole('button',{name:'Remove highlight'}).click();
    await section.getByText('Could not remove clip. Try again.').waitFor();assert.equal(await section.locator('video').count(),1);
    failDelete=false;await section.getByRole('button',{name:'Remove highlight'}).click();await section.getByText('No highlights yet. Add a clip of a great play to get started.').waitFor();assert.equal(await section.locator('video').count(),0);
  });
  await check('no browser exceptions',async()=>assert.deepEqual(errors,[]));
  console.log(`\n${count}/${count} highlight browser checks passed`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
