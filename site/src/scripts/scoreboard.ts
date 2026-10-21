import { api } from './api-client';
import { featuredScore, periodLabel, type Score } from '../lib/scoreboard';
for(const board of document.querySelectorAll<HTMLElement>('[data-live-board]')) {
  const fallback=document.querySelector<HTMLElement>('[data-upcoming-hero]');
  let busy=false;
  let signature='';
  // Which games have a stream changes on game night, not at build time, so the
  // watch link is revealed from the API rather than rendered in.
  let streamed=new Set<string>();
  async function streams() {
    const response=await api('/broadcast');
    if(response.ok && Array.isArray(response.body?.streams))
      streamed=new Set(response.body.streams.map((s:{game_id:string})=>s.game_id));
  }
  async function refresh() {
    if(busy || document.hidden) return;
    busy=true;
    const response=await api('/scoreboard');
    busy=false;
    const connection=board.querySelector<HTMLElement>('[data-score-connection]')!;
    if(!response.ok || !Array.isArray(response.body?.games)) {
      if(!board.hidden) connection.textContent='Updates interrupted. Showing the last received score; reconnecting…';
      return;
    }
    const games:Score[]=response.body.games;
    document.dispatchEvent(new CustomEvent("scoreboard:updated",{detail:games}));
    const score=board.dataset.fixedGame
      ? games.find(g=>g.game_id===board.dataset.fixedGame && ['in_progress','final'].includes(g.status))
      : featuredScore(games);
    const fixture=Array.from(board.querySelectorAll<HTMLElement>('[data-live-fixture]')).find(el=>el.dataset.liveFixture===score?.game_id);
    const show=Boolean(score && fixture);
    board.hidden=!show;
    if(fallback) fallback.hidden=show;
    if(!score || !fixture) {signature='';return;}
    board.querySelector<HTMLAnchorElement>('[data-score-admin]')!.href=`/admin?game=${encodeURIComponent(score.game_id)}#sheet-tab`;
    connection.textContent=score.status==='in_progress'?'Scores update automatically.':'Final result';
    const watch=fixture.querySelector<HTMLElement>('[data-live-watch]');
    if(watch) watch.hidden=!streamed.has(score.game_id);
    const next=JSON.stringify([score.game_id,score.our_score,score.their_score,score.status,score.period]);
    if(next===signature) return;
    signature=next;
    board.querySelectorAll<HTMLElement>('[data-live-fixture]').forEach(el=>el.hidden=el!==fixture);
    const home=fixture.dataset.home==='true';
    fixture.querySelector('[data-away-score]')!.textContent=String((home?score.their_score:score.our_score) ?? '—');
    fixture.querySelector('[data-home-score]')!.textContent=String((home?score.our_score:score.their_score) ?? '—');
    board.querySelector('[data-score-state]')!.textContent=score.status==='final'?'Game complete':'Live game';
    board.querySelector('[data-score-period]')!.textContent=score.status==='final'?'Final':periodLabel(score.period);
  }
  async function identity() {
    const r=await api('/auth/me');
    board.querySelector<HTMLElement>('[data-score-admin]')!.hidden=!(r.ok && r.body?.role==='admin');
  }
  void identity();void streams().then(refresh);
  setInterval(()=>void refresh(),5000);
  // The stream list changes once or twice a night, not every five seconds.
  setInterval(()=>void streams(),60000);
  document.addEventListener('visibilitychange',()=>void refresh());
  document.addEventListener('auth:changed',()=>{void identity();void streams().then(refresh);});
}
