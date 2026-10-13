import assert from 'node:assert/strict';
import test from 'node:test';
import { upcomingEvents, practiceLabel } from './schedule';
import { scheduleSchema } from './schema';
import { eventLines } from './ics';

test('upcoming sessions are sorted, include ongoing sessions, and exclude ended or cancelled events',()=>{
  const event={id:'next',startsAt:'2026-10-13T17:00:00-03:00',endsAt:null,status:'scheduled'};
  const events=[event,{...event,id:'ongoing',startsAt:'2026-10-13T16:00:00-03:00'},
    {...event,id:'ended',startsAt:'2026-10-12T17:00:00-03:00'},
    ...['cancelled','postponed','final'].map(status=>({...event,id:status,status}))];
  assert.deepEqual(upcomingEvents(events,Date.parse('2026-10-13T19:30:00Z')).map(e=>e.id),['ongoing','next']);
  assert.equal(upcomingEvents([{...event,endsAt:'2026-10-13T20:30:00Z'}],Date.parse('2026-10-13T20:30:00Z')).length,0);
});
test('old practices default to ice; off-ice practices preserve their label in calendar exports',()=>{
  const practice={id:'training',type:'practice',startsAt:'2026-10-13T17:00:00-03:00',endsAt:null,
    venue:{name:'Training room',surface:null,address:null,mapUrl:null},status:'scheduled',notes:null};
  const parse=(event:unknown)=>scheduleSchema.parse({version:1,source:{provider:'test',fetchedAt:null},events:[event]}).events[0];
  const ice=parse(practice);assert.equal(ice.type==='practice' && ice.practiceKind,'on_ice');
  const off=parse({...practice,practiceKind:'off_ice'});
  assert.ok(eventLines(off,'20261013T120000Z').some(line=>line.includes('off-ice practice')));
  assert.equal(practiceLabel({practiceKind:'off_ice'}),'Off-ice practice');
  assert.throws(()=>parse({...practice,practiceKind:'unknown'}));
});
