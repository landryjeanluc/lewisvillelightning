#!/usr/bin/env node
/** Mobile conversations, keyboard-sized viewports, drafts and read receipts. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const {chromium}=createRequire(path.join(root,'site/package.json'))('playwright-core');
const dist=path.join(root,'site/dist');
let authenticated=true,failSend=false,failDirect=false;
let revision=30;
let releaseSend;
let sendDelay=null;
const calls=[];
const rooms=[{id:1,kind:'team',name:'Team room',unread:6,last_message:'See you at practice!'},
  {id:2,kind:'direct',name:'A teammate with a long display name',unread:2,last_message:'Bring your water bottle.'}];
const messages=new Map([[1,Array.from({length:18},(_,i)=>({id:i+1,conversation_id:1,sender_id:i%3===0?1:2,sender_name:i%3===0?'Me':'Teammate',body:`Message ${i+1}: See you at practice. Remember your water bottle and have fun!`,created_at:'2026-10-14T15:00:00Z',deleted_at:null,revision:i+1}))],
  [2,[{id:21,conversation_id:2,sender_id:2,sender_name:'Teammate',body:'Hello!',created_at:'2026-10-14T15:00:00Z',deleted_at:null,revision:21}]]]);
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if(url.pathname.startsWith('/api/')) {
      let raw='';for await(const c of req) raw+=c;
      const body=raw?JSON.parse(raw):null;calls.push({path:url.pathname,method:req.method,body});
      if(url.pathname==='/api/auth/me') return json(authenticated?{id:1,display_name:'Test Player',role:'player'}:null);
      if(!authenticated) return json({detail:'Sign in'},401);
      if(url.pathname==='/api/chat/members') return json([{id:2,display_name:'Teammate'},{id:3,display_name:'Another teammate'}]);
      if(url.pathname==='/api/chat/conversations') return json(rooms);
      if(url.pathname==='/api/chat/direct') {
        if(failDirect) return json({detail:'Could not start a conversation. Try again.'},503);
        if(!rooms.some(r=>r.id===3)) {rooms.push({id:3,kind:'direct',name:'Another teammate',unread:0,last_message:null});messages.set(3,[]);}
        return json({id:3});
      }
      const match=url.pathname.match(/^\/api\/chat\/conversations\/(\d+)\/messages$/);
      if(match) {
        const id=Number(match[1]),list=messages.get(id);
        if(req.method==='POST') {
          if(failSend) return json({detail:'Connection interrupted'},503);
          if(sendDelay) await sendDelay;
          const message={id:++revision,conversation_id:id,sender_id:1,sender_name:'Test Player',body:body.body,created_at:new Date().toISOString(),deleted_at:null,revision};
          list.push(message);return json(message);
        }
        const after=url.searchParams.get('after'),before=url.searchParams.get('before');
        const page=after!==null?list.filter(m=>m.revision>Number(after)):before?list.filter(m=>m.id<Number(before)):list.slice(-12);
        return json({messages:page,cursor:Math.max(0,...list.map(m=>m.revision)),has_more:!after && !before && list.length>12});
      }
      if(url.pathname.endsWith('/read')) {const room=rooms.find(r=>r.id===Number(url.pathname.split('/')[4]));if(room)room.unread=0;return json({ok:true});}
      if(url.pathname.endsWith('/report')) return json({ok:true});
      return json([]);
    }
    let relative=decodeURIComponent(url.pathname);
    if(!path.extname(relative)) relative=relative.replace(/\/$/,'')+'/index.html';
    const filename=path.join(dist,relative);
    if(!filename.startsWith(dist+path.sep)) return res.writeHead(403).end();
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.ttf':'font/ttf'};
    const bytes=await readFile(filename);res.writeHead(200,{'content-type':types[path.extname(filename)]||'application/octet-stream'});res.end(bytes);
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'chromium',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
let count=0;
async function check(name,run){await run();count++;console.log('  PASS  '+name);}
const open=id=>page.locator(`.chat-room[data-id="${id}"]`).click();
const back=async()=>{await page.locator('#chat-back').click();await page.locator('.chat-sidebar').waitFor({state:'visible'});};
try {
  await check('phone starts with full-width conversations and does not read unopened messages',async()=>{
    await page.goto(base+'/chat');await page.locator('.chat-room').first().waitFor();
    assert.equal(await page.locator('.chat-thread').isVisible(),false);
    assert.equal(calls.filter(c=>c.path.endsWith('/read')).length,0);
    const box=await page.locator('.chat-room').first().boundingBox();assert.ok(box.width>300 && box.height>=60);
    await page.screenshot({path:'/tmp/lvlnb-chat-list.png',fullPage:true});
  });
  await check('opening a room shows only the conversation with header and composer in view',async()=>{
    await open(1);await page.locator('.chat-message').first().waitFor();
    assert.equal(await page.locator('.chat-sidebar').isVisible(),false);
    assert.equal(await page.locator('.site-head').isVisible(),false);
    assert.match(await page.locator('.chat-safety summary').textContent(),/monitored/);
    const send=await page.locator('#chat-send').boundingBox(),head=await page.locator('#chat-back').boundingBox();
    assert.ok(send.y+send.height<=844 && head.y>=0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:'/tmp/lvlnb-chat-thread.png',fullPage:false});
  });
  await check('drafts survive back navigation and switching conversations',async()=>{
    await page.locator('#chat-body').fill('Draft for the team');await back();await open(2);
    await page.locator('#chat-body:not([disabled])').waitFor();assert.equal(await page.locator('#chat-body').inputValue(),'');
    await page.locator('#chat-body').fill('Private draft');await back();await open(1);
    assert.equal(await page.locator('#chat-body').inputValue(),'Draft for the team');
  });
  await check('browser back returns to conversations and browser forward restores the thread',async()=>{
    await page.goBack();await page.locator('.chat-sidebar').waitFor({state:'visible'});
    await page.goForward();await page.locator('.chat-thread').waitFor({state:'visible'});
    assert.equal(await page.locator('#chat-body').inputValue(),'Draft for the team');
  });
  await check('keyboard-sized viewport keeps send and message history usable',async()=>{
    await page.setViewportSize({width:390,height:420});await page.locator('#chat-body').focus();
    await page.waitForFunction(()=>document.getElementById('chat-app').getBoundingClientRect().height<=420);
    const send=await page.locator('#chat-send').boundingBox(),history=await page.locator('#chat-scroll').boundingBox();
    assert.ok(send.y+send.height<=420 && history.height>90);
    await page.screenshot({path:'/tmp/lvlnb-chat-keyboard.png',fullPage:false});
    await page.setViewportSize({width:390,height:844});
  });
  await check('narrow phones and landscape keep the conversation and composer on screen',async()=>{
    for(const viewport of [{width:320,height:568},{width:844,height:390}]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(height=>Math.abs(document.getElementById('chat-app').getBoundingClientRect().height-height)<2,viewport.height);
      const box=await page.locator('#chat-send').boundingBox();
      assert.ok(box.y+box.height<=viewport.height+1);assert.equal(await page.locator('.chat-sidebar').isVisible(),false);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
    await page.setViewportSize({width:390,height:844});
  });
  await check('visual viewport offsets keep the composer above the keyboard',async()=>{
    await page.evaluate(()=>{
      Object.defineProperty(visualViewport,'height',{value:360,configurable:true});
      Object.defineProperty(visualViewport,'offsetTop',{value:50,configurable:true});
      visualViewport.dispatchEvent(new Event('resize'));
    });
    const shell=await page.locator('#chat-app').boundingBox(),button=await page.locator('#chat-send').boundingBox();
    assert.equal(shell.y,50);assert.equal(shell.height,360);assert.ok(button.y+button.height<=410);
    await page.evaluate(()=>{delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'));});
  });
  await check('textarea grows for multiline text and touch Enter does not send',async()=>{
    await page.locator('#chat-body').fill('First line');const before=await page.locator('#chat-body').boundingBox();
    await page.locator('#chat-body').press('End');await page.locator('#chat-body').press('Enter');await page.locator('#chat-body').pressSequentially('Second line');
    assert.equal(await page.locator('#chat-body').inputValue(),'First line\nSecond line');
    assert.ok((await page.locator('#chat-body').boundingBox()).height>before.height);
    assert.equal(calls.filter(c=>c.method==='POST' && c.path.endsWith('/messages')).length,0);
  });
  await check('failed send retains draft and retry uses the same message id',async()=>{
    failSend=true;await page.locator('#chat-send').click();await page.locator('#chat-error').waitFor({state:'visible'});
    assert.equal(await page.locator('#chat-body').inputValue(),'First line\nSecond line');
    const failed=calls.filter(c=>c.method==='POST' && c.path.endsWith('/messages')).at(-1).body;
    failSend=false;await page.locator('#chat-body').focus();await page.locator('#chat-send').click();
    await page.waitForFunction(()=>document.getElementById('chat-body').value==='');
    const retried=calls.filter(c=>c.method==='POST' && c.path.endsWith('/messages')).at(-1).body;
    assert.equal(failed.client_id,retried.client_id);assert.equal(await page.locator('#chat-body').evaluate(el=>document.activeElement===el),true);
  });
  await check('typing while a send completes does not erase the newer draft',async()=>{
    sendDelay=new Promise(resolve=>{releaseSend=resolve;});
    await page.locator('#chat-body').fill('Sending this first');await page.locator('#chat-send').click();
    await page.locator('#chat-send[aria-busy="true"]').waitFor();
    await page.locator('#chat-body').fill('My next message');releaseSend();sendDelay=null;
    await page.locator('#chat-send[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('#chat-body').inputValue(),'My next message');
    await page.locator('#chat-body').fill('');
  });
  await check('new arrivals do not pull the reader away from earlier messages',async()=>{
    await page.locator('#chat-scroll').evaluate(el=>el.scrollTop=0);
    messages.get(1).push({id:++revision,conversation_id:1,sender_id:2,sender_name:'Teammate',body:'New arrival while reading',created_at:new Date().toISOString(),deleted_at:null,revision});
    await page.locator('#chat-latest').waitFor({state:'visible',timeout:10000});
    assert.equal(await page.locator('#chat-scroll').evaluate(el=>el.scrollTop),0);
    await page.locator('#chat-latest').click();assert.equal(await page.locator('#chat-latest').isVisible(),false);
  });
  await check('earlier messages load without jumping to the bottom',async()=>{
    await page.locator('#chat-scroll').evaluate(el=>el.scrollTop=0);await page.locator('#chat-older').click();
    await page.locator('.chat-message[data-id="1"]').waitFor();
    assert.ok(await page.locator('#chat-scroll').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight>100));
  });
  await check('starting a conversation shows recoverable errors in the list view',async()=>{
    await back();await page.locator('.chat-start summary').click();await page.locator('#chat-member').selectOption('3');
    failDirect=true;await page.locator('#chat-new button').click();await page.locator('#chat-list-error').waitFor({state:'visible'});
    failDirect=false;await page.locator('#chat-new button').click();await page.getByRole('heading',{name:'Another teammate',exact:true}).waitFor();
    assert.equal(await page.locator('.chat-sidebar').isVisible(),false);assert.equal(await page.locator('#chat-body').inputValue(),'');
  });
  await check('monitoring details and reporting stay accessible in the conversation',async()=>{
    await back();await open(1);await page.locator('.chat-safety summary').click();
    assert.match(await page.locator('#chat-hint').innerText(),/flagged or reported/);
    page.once('dialog',dialog=>dialog.accept());await page.locator('.chat-report').last().click();await page.getByText('Reported',{exact:true}).waitFor();
  });
  await check('desktop keeps list and thread together',async()=>{
    const desktop=await browser.newPage({viewport:{width:1440,height:1000},serviceWorkers:'block'});
    await desktop.goto(base+'/chat');await desktop.locator('.chat-message').first().waitFor();
    assert.equal(await desktop.locator('.chat-sidebar').isVisible(),true);assert.equal(await desktop.locator('.chat-thread').isVisible(),true);
    assert.equal(await desktop.locator('#chat-back').isVisible(),false);await desktop.close();
  });
  await check('session expiry clears messages and restores navigation',async()=>{
    authenticated=false;await page.locator('#chat-login').waitFor({state:'visible',timeout:10000});
    assert.equal(await page.locator('#chat-app').isVisible(),false);assert.equal(await page.locator('.site-head').isVisible(),true);
    assert.equal(await page.locator('.chat-message').count(),0);
  });
  await check('chat has no browser exceptions',async()=>assert.deepEqual(errors,[]));
  console.log(`\n${count}/${count} mobile chat browser checks passed`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
