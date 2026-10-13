import { api } from './api-client';
import type { Score } from '../lib/scoreboard';
const form=document.getElementById('live-score-form') as HTMLFormElement;
const fields=document.getElementById('live-score-fields') as HTMLFieldSetElement;
const message=document.getElementById('live-save-status')!;
const refresh=document.getElementById('live-refresh') as HTMLButtonElement;
const start=document.getElementById('live-start') as HTMLButtonElement;
const field=(name:string)=>form.elements.namedItem(name) as HTMLInputElement|HTMLSelectElement;
const select=field('game_id') as HTMLSelectElement;
let revision=0, loadedGame='', dirty=false, busy=false;
const detail=(body:any)=>typeof body?.detail==='string'?body.detail:'Could not load or save the score. Please try again.';
function startVisibility() {start.hidden=field('status').value!=='scheduled';}
async function load(preferred?:string) {
  if(busy) return;
  busy=true;fields.disabled=true;refresh.disabled=true;message.textContent='Loading game scores…';
  const result=await api('/scoreboard');
  busy=false;refresh.disabled=false;
  if(!result.ok || !Array.isArray(result.body?.games)) {message.textContent=detail(result.body);return;}
  const games:Score[]=result.body.games;
  const initial=games.find(g=>g.status==='in_progress') ?? [...games].sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at)).find(g=>g.status==='scheduled' && Date.parse(g.starts_at)>=Date.now());
  const gid=preferred ?? initial?.game_id ?? select.value;
  const game=games.find(g=>g.game_id===gid);
  if(!game || !Array.from(select.options).some(o=>o.value===gid)) {message.textContent='No matching game is available. Reload the page after the schedule updates.';return;}
  select.value=gid;loadedGame=gid;revision=game.revision;
  field('our_score').value=String(game.our_score ?? 0);field('their_score').value=String(game.their_score ?? 0);
  field('status').value=game.status;field('period').value=game.period ?? '1';
  document.getElementById('live-opponent')!.textContent=select.selectedOptions[0].dataset.opponent ?? 'Opponent';
  dirty=false;fields.disabled=false;startVisibility();message.textContent='Latest score loaded.';
}
form.addEventListener('input',event=>{if(event.target!==select) dirty=true;});
field('status').addEventListener('change',startVisibility);
select.addEventListener('change',()=>{
  if(dirty && !confirm('Discard unsaved scoreboard changes and switch games?')) {select.value=loadedGame;return;}
  void load(select.value);
});
refresh.addEventListener('click',()=>{
  if(dirty && !confirm('Replace your unsaved changes with the latest saved score?')) return;
  void load(loadedGame || undefined);
});
form.querySelectorAll<HTMLButtonElement>('[data-goal]').forEach(button=>button.addEventListener('click',()=>{
  const input=field(button.dataset.goal!);input.value=String(Math.min(1000,Number(input.value || 0)+1));dirty=true;
}));
start.addEventListener('click',()=>{field('status').value='in_progress';dirty=true;startVisibility();form.requestSubmit();});
form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy || !loadedGame) return;
  const body={our_score:Number(field('our_score').value),their_score:Number(field('their_score').value),
    period:field('period').value,status:field('status').value,expected_revision:revision};
  busy=true;fields.disabled=true;refresh.disabled=true;message.textContent='Saving…';
  const result=await api('/scoreboard/'+encodeURIComponent(loadedGame),{method:'PUT',body:JSON.stringify(body)});
  busy=false;fields.disabled=false;refresh.disabled=false;
  if(!result.ok) {message.textContent=detail(result.body);return;}
  revision=result.body.revision;dirty=false;startVisibility();
  message.textContent=body.status==='final'?'Final score saved.':body.status==='in_progress'?'Live score saved. The homepage will update within a few seconds.':'Game status saved.';
});
window.addEventListener('beforeunload',event=>{if(dirty || busy) event.preventDefault();});
document.addEventListener('auth:changed',()=>{if(!loadedGame && !busy) void load();});
void load();
