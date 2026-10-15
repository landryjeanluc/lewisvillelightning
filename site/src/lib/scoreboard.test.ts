import test from 'node:test';
import assert from 'node:assert/strict';
import {featuredScore,periodLabel,type Score} from './scoreboard';
const game:Score={game_id:'today',starts_at:'2026-10-13T20:30:00Z',our_score:2,their_score:1,status:'in_progress',period:'2',revision:1,updated_at:null};
test('live game takes priority over next fixture and final results',()=>{
  assert.equal(featuredScore([{...game,status:'final'},{...game,game_id:'live'}],new Date('2026-10-14T01:00:00Z'))?.game_id,'live');
  assert.equal(featuredScore([{...game,status:'scheduled'}]),undefined);
});
test('final stays in the hero for the game day in Atlantic time',()=>{
  assert.equal(featuredScore([{...game,status:'final'}],new Date('2026-10-14T01:00:00Z'))?.game_id,'today');
  assert.equal(featuredScore([{...game,status:'final'}],new Date('2026-10-14T12:00:00Z')),undefined);
  for(const status of ['cancelled','postponed']) assert.equal(featuredScore([{...game,status}]),undefined);
});
test('period labels include intermissions and overtime, never a fabricated clock',()=>{
  assert.equal(periodLabel('2'),'2nd period');assert.equal(periodLabel('INT2'),'2nd intermission');
  assert.equal(periodLabel('OT'),'Overtime');assert.equal(periodLabel(null),'Period not set');
});
test('an unfinished old game cannot override the current game day',()=>{
  assert.equal(featuredScore([game],new Date('2026-10-15T15:00:00Z')),undefined);
  assert.equal(featuredScore([game],new Date('2026-10-14T02:59:59Z'))?.game_id,'today');
  assert.equal(featuredScore([game],new Date('2026-10-14T03:00:00Z')),undefined);
  const current = {...game,game_id:'current',starts_at:'2026-10-15T19:30:00Z'};
  assert.equal(featuredScore([game,current],new Date('2026-10-15T20:00:00Z'))?.game_id,'current');
});
