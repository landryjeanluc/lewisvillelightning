import { api } from './api-client';
import { postAuth } from './auth-form';
import { upcomingEvents, type UpcomingEvent } from '../lib/schedule';
import { shortDate, time } from '../lib/format';

const el = <T extends HTMLElement = HTMLElement>(id:string) => document.getElementById(id) as T;
const field = (form:HTMLFormElement, name:string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const profile = el<HTMLFormElement>('profile-form');
const contact = el<HTMLFormElement>('contact-form');
const password = el<HTMLFormElement>('password-form');
const logout = el<HTMLButtonElement>('account-logout');
type Event = UpcomingEvent & {label:string; type:string; venue:string};
const events:Event[] = JSON.parse(el('account-events').textContent!);
let assignments:{game_id:string; name:string; note:string|null; claimed_by:string|null}[] = [];
let statuses:Record<string,string> = {};
const detail = (body:any, fallback:string) => typeof body?.detail === 'string' ? body.detail : fallback;
function node<K extends keyof HTMLElementTagNameMap>(tag:K, text:string, className='') {
  const result = document.createElement(tag); result.textContent=text; result.className=className; return result;
}
function eventCard(event:Event, title=event.label) {
  const card=node('article','','account-item');
  const link=node('a',title); link.href='/schedule/'+encodeURIComponent(event.id);
  const heading=node('h3',''); heading.append(link);
  const date=node('time',`${shortDate(event.startsAt)} · ${time(event.startsAt)}`); date.dateTime=event.startsAt;
  card.append(node('span',event.type==='game'?'Game':event.label,'eyebrow'),heading,date,node('p',event.venue,'dim'));
  return card;
}
function renderSchedule() {
  const upcoming=upcomingEvents(events.map(e => ({...e,status:statuses[e.id] ?? e.status})));
  el('account-schedule').replaceChildren(...upcoming.slice(0,3).map(e => eventCard(e)));
  if (!upcoming.length) el('account-schedule').append(node('p','No upcoming sessions have been posted. Check back for the next game or practice.','dim'));
  const cards=upcoming.flatMap(event => assignments.filter(a => a.game_id===event.id).map(a => {
    const card=eventCard(event,a.name);
    card.append(node('p',a.claimed_by ? `Claimed by ${a.claimed_by}` : 'Your family is assigned — a volunteer is still needed.'));
    if(a.note) card.append(node('p',a.note,'dim'));
    return card;
  }));
  el('account-assignments').replaceChildren(...cards);
  if(!cards.length) el('account-assignments').append(node('p','Your family has no upcoming game tasks assigned.','dim'));
}
async function loadDetails() {
  el('details-retry').hidden=true;
  const r=await api('/account');
  if (!r.ok || !r.body?.contact) {
    el('details-status').textContent = 'Could not load profile and family tasks. Your password settings are still available.';
    el('details-retry').hidden=false; return;
  }
  el('details-status').textContent='';
  const data=r.body;
  for(const key of ['display_name','email','phone']) field(contact,key).value=data.contact[key] ?? '';
  const p=data.player;
  if(p) {
    for(const key of ['position','shoots','nickname','bio']) field(profile,key).value=p[key] ?? '';
    el('player-number').textContent=`#${p.number} · ${p.name}`;
    el('player-section').hidden=false;
    const link=el<HTMLAnchorElement>('player-link');link.href='/players/'+encodeURIComponent(p.id);link.hidden=false;
    el('assignments-section').hidden=false;
  } else if(el('account-role').textContent!=='Team account') {
    el('details-status').textContent='Ask your coach to link your account to a player to see their profile, goals and family tasks.';
  }
  assignments=data.assignments ?? [];
  statuses=data.schedule_statuses ?? {};
  renderSchedule();
}
async function boot() {
  const r=await api('/auth/me');
  if(r.status===401 || (r.ok && !r.body)) {el('account-loading').hidden=true;el('account-gate').hidden=false;return;}
  if(!r.ok) {el('account-loading').textContent='Could not check your session. Please reload to try again.';return;}
  const user=r.body;
  el('account-loading').hidden=true;
  el('account-name').textContent=user.display_name;
  el('account-handle').textContent=`Sign-in: ${user.email}`;
  el('account-role').textContent=user.role==='parent'?'Parent account':user.role==='player'?'Player account':'Team account';
  if(user.role==='parent') el('profile-title').textContent='Your player’s profile';
  el('account-content').hidden=false;
  el('contact-section').hidden=user.role==='player';
  // Only enable editable details after their initial values load successfully.
  contact.querySelector('button')!.disabled=true;
  renderSchedule();
  await loadDetails();
  contact.querySelector('button')!.disabled=!el('details-retry').hidden;
}
function save(form:HTMLFormElement, path:string, statusId:string, success:string, done?:()=>void) {
  form.addEventListener('submit',async event => {
    event.preventDefault();
    const values=Object.fromEntries(new FormData(form));
    if(path.endsWith('/profile')) for(const key of ['bio','nickname','shoots']) values[key]=values[key] || '';
    const body:any={...values};
    if(path.endsWith('/profile') && !body.shoots) body.shoots=null;
    const button=form.querySelector('button')!;button.disabled=true;
    el(statusId).textContent='Saving…';
    const r=await api(path,{method:'PUT',body:JSON.stringify(body)});
    button.disabled=false;
    el(statusId).textContent=r.ok?success:detail(r.body,'Could not save. Check your entries and try again.');
    if(r.ok) done?.();
  });
}
save(profile,'/account/profile','profile-status','Player profile saved.');
save(contact,'/account/contact','contact-status','Contact details saved.',()=>{
  el('account-name').textContent=field(contact,'display_name').value;
  el('account-handle').textContent=`Sign-in: ${field(contact,'email').value.trim().toLowerCase()}`;
  field(contact,'current_password').value='';
});
el('details-retry').addEventListener('click',async()=>{await loadDetails();contact.querySelector('button')!.disabled=!el('details-retry').hidden;});
password.addEventListener('submit',async event => {
  event.preventDefault();const data=new FormData(password);
  if(data.get('new')!==data.get('confirm')) {el('account-status').textContent='The new passwords do not match.';return;}
  const button=password.querySelector('button')!;button.disabled=true;
  const result=await postAuth('change-password',{current:data.get('current'),new:data.get('new')});
  button.disabled=false;el('account-status').textContent=result.ok?'Password changed. Your other devices have been signed out.':result.detail;
  if(result.ok) password.reset();
});
logout.addEventListener('click',async()=>{
  logout.disabled=true;const result=await postAuth('logout',{});
  if(result.ok) {
    try {sessionStorage.removeItem('lvlnb.play-draft.v1');localStorage.removeItem('lvlnb.play-draft.v1');} catch { /* storage unavailable */ }
    location.replace('/login');
  } else {el('account-status').textContent=result.detail;logout.disabled=false;}
});
setInterval(renderSchedule,60000);
void boot();
