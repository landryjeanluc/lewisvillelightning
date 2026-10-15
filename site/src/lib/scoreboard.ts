import { TZ } from './format';
export type Score = {
  game_id:string; starts_at:string; our_score:number|null; their_score:number|null;
  status:string; period:string|null; revision:number; updated_at:string|null;
};
export const periodLabel = (period:string|null) => ({'1':'1st period','2':'2nd period','3':'3rd period',OT:'Overtime',SO:'Shootout',INT1:'1st intermission',INT2:'2nd intermission'}[period ?? ''] ?? 'Period not set');
const day = (date:Date) => new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
/** A live game wins over the static next fixture, even after a rebuild during play. */
export function featuredScore(games:Score[], now=new Date()):Score|undefined {
  const newest=[...games].sort((a,b)=>Date.parse(b.starts_at)-Date.parse(a.starts_at));
  const today = newest.filter(g=>day(new Date(g.starts_at))===day(now));
  return today.find(g=>g.status==='in_progress') ?? today.find(g=>g.status==='final');
}
