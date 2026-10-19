import { api } from './api-client';

type Highlight = {id:string; title:string; duration:number; game_date:string|null; video_url:string; poster_url:string};
type Upload = {id:string; player_id:string; title:string; game_id:string|null; bytes:number};
const section = document.querySelector<HTMLElement>('[data-player-highlights]');
if (section) {
  const root = section;
  const playerId = root.dataset.playerHighlights!;
  const state = root.querySelector<HTMLElement>('[data-highlight-state]')!;
  const list = root.querySelector<HTMLElement>('[data-highlight-list]')!;
  const feedback = root.querySelector<HTMLElement>('[data-highlight-feedback]')!;
  const add = root.querySelector<HTMLButtonElement>('[data-highlight-add]')!;
  const reload = root.querySelector<HTMLButtonElement>('[data-highlight-reload]')!;
  const form = root.querySelector<HTMLFormElement>('[data-highlight-form]')!;
  const title = form.elements.namedItem('title') as HTMLInputElement;
  const game = form.elements.namedItem('game_id') as HTMLSelectElement;
  const clip = form.elements.namedItem('clip') as HTMLInputElement;
  const progress = form.querySelector<HTMLProgressElement>('progress')!;
  const message = form.querySelector<HTMLElement>('[data-highlight-upload-state]')!;
  const cancel = form.querySelector<HTMLButtonElement>('[data-highlight-cancel]')!;
  let busy = false;
  let pending: Upload|null = null;
  let pendingFile: File|null = null;

  function text<K extends keyof HTMLElementTagNameMap>(tag:K, value:string, className='') {
    const el = document.createElement(tag); el.textContent = value; el.className = className; return el;
  }
  function error(result:{status:number;body:any}) {
    if ([401,403].includes(result.status)) return 'Please sign in with your admin account and try again.';
    return typeof result.body?.detail === 'string' ? result.body.detail : 'Could not save this highlight. Your clip is still selected; try again.';
  }
  function card(highlight:Highlight, manage:boolean) {
    const article = document.createElement('article'); article.className='card hl-card'; article.dataset.highlightId=highlight.id;
    const video = document.createElement('video'); video.controls=true; video.playsInline=true; video.preload='none';
    // URLs are server-generated. Keep even an unexpected API value on-origin.
    video.src='/api/highlights/'+encodeURIComponent(highlight.id)+'/video';
    video.poster='/api/highlights/'+encodeURIComponent(highlight.id)+'/poster';
    video.setAttribute('aria-label',highlight.title);
    const content=document.createElement('div');content.className='hl-content';
    const duration=Math.ceil(highlight.duration);
    content.append(text('h3',highlight.title),text('p',[highlight.game_date,`${Math.floor(duration/60)}:${String(duration%60).padStart(2,'0')}`].filter(Boolean).join(' · '),'dim hl-meta'));
    const warning=text('p','','dim hl-error'); warning.hidden=true; warning.setAttribute('role','status');
    video.addEventListener('error',()=>{warning.textContent='Could not play this clip. Refresh the page and check that you’re signed in.';warning.hidden=false;});
    content.append(warning);
    if(manage) {
      const remove=text('button','Remove highlight','hl-remove');remove.type='button';
      remove.addEventListener('click',async()=>{
        if(!confirm(`Remove “${highlight.title}” from this player’s highlights?`))return;
        remove.disabled=true;
        const result=await api('/highlights/'+highlight.id,{method:'DELETE'});
        if(result.ok){video.pause();await load();}
        else {warning.textContent=error(result);warning.hidden=false;remove.disabled=false;}
      });content.append(remove);
    }
    article.append(video,content);return article;
  }
  async function load() {
    reload.hidden=true;
    const result=await api('/highlights?player_id='+encodeURIComponent(playerId));
    if(!result.ok || !Array.isArray(result.body?.highlights)) {
      state.textContent=result.status===401 ? 'Sign in to watch player highlights.' : 'Could not load highlights. Please try again.';
      if([401,403].includes(result.status)){list.replaceChildren();add.hidden=true;form.hidden=true;}
      state.hidden=false;reload.hidden=false;return;
    }
    const highlights:Highlight[]=result.body.highlights;
    const manage=result.body.can_manage===true;
    add.hidden=!manage;
    list.replaceChildren(...highlights.map(h=>card(h,manage)));
    state.hidden=highlights.length>0;
    state.textContent=manage ? 'No highlights yet. Add a clip of a great play to get started.' : 'No highlights yet. Check back after the next game.';
  }
  add.addEventListener('click',()=>{form.hidden=false;title.focus();});
  reload.addEventListener('click',()=>void load());
  cancel.addEventListener('click',async()=>{
    if(busy)return;
    if(pending) {
      const result=await api('/highlights/'+pending.id,{method:'DELETE'});
      if(!result.ok&&result.status!==404){message.textContent=error(result);return;}
    }
    pending=null;pendingFile=null;form.reset();form.hidden=true;message.textContent='';progress.hidden=true;add.focus();
  });
  window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    const file=clip.files?.[0];if(!file)return;
    if(!/\.mp4$/i.test(file.name)||file.size===0||file.size>100*1024*1024) {
      message.textContent='Choose an MP4 clip up to 100 MB.';return;
    }
    busy=true;for(const control of Array.from(form.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,button,select')))control.disabled=true;
    progress.hidden=false;message.textContent='Starting upload…';
    try {
      if(pending&&(pendingFile!==file||pending.title!==title.value.trim()||pending.game_id!==(game.value||null))) {
        const discarded=await api('/highlights/'+pending.id,{method:'DELETE'});
        if(!discarded.ok&&discarded.status!==404)throw new Error(error(discarded));
        pending=null;
      }
      pending ??= {id:crypto.randomUUID(),player_id:playerId,title:title.value.trim(),game_id:game.value||null,bytes:file.size};
      pendingFile=file;
      const started=await api('/highlights/uploads',{method:'POST',body:JSON.stringify(pending)});
      if(!started.ok)throw new Error(error(started));
      let offset:number=started.body.received;
      progress.value=offset/file.size*100;
      while(offset<file.size) {
        const end=Math.min(file.size,offset+started.body.chunk_bytes);
        const response=await fetch('/api/highlights/uploads/'+pending.id+'?offset='+offset,{
          method:'PUT',credentials:'same-origin',headers:{'content-type':'application/octet-stream'},body:file.slice(offset,end),signal:AbortSignal.timeout(120000),
        });
        const body=await response.json().catch(()=>null);
        if(!response.ok)throw new Error(error({status:response.status,body}));
        if(body.received<=offset)throw new Error('The upload did not advance. Please retry.');
        offset=body.received;progress.value=offset/file.size*100;
        message.textContent=`Uploading… ${Math.round(progress.value)}%`;
      }
      message.textContent='Preparing your highlight…';
      const published=await api('/highlights/uploads/'+pending.id+'/publish',{method:'POST',signal:AbortSignal.timeout(120000)});
      if(!published.ok)throw new Error(error(published));
      pending=null;pendingFile=null;form.reset();progress.hidden=true;
      form.hidden=true;message.textContent='';
      feedback.textContent='Highlight added. The team can watch it now.';
      await load();
      add.focus();
    } catch(err) {message.textContent=err instanceof Error?err.message:'Upload interrupted. Try again to continue.';}
    finally {busy=false;for(const control of Array.from(form.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,button,select')))control.disabled=false;}
  });
  void load();
}
