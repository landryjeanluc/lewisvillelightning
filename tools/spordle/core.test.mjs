import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, extractPageData, belongsToTeamPage, isTeamResponse, digest, describeChanges, pageProblem, teamUrl } from './core.mjs';

test('authentication and account context do not enter exported player data', () => {
  assert.deepEqual(sanitize({team: {name: 'Example', players: [{name: 'Player One', access_token: 'secret'}]}, api_provider: {api_key: 'secret'}, currentUser: {email: 'private'}, session: 'secret'}),
    {team: {name: 'Example', players: [{name: 'Player One'}]}});
});
test('refuse another team, unknown schema, and error pages', () => {
  assert.throws(() => extractPageData({query: {teamId: '99'}, props: {pageProps: {team: {id: 99}}}}));
  assert.throws(() => extractPageData({query: {teamId: '223790'}, props: {pageProps: {account: {}}}}));
  assert.throws(() => extractPageData({query: {teamId: '223790'}, props: {pageProps: {error: 'unauthorized', team: {}}}}));
});
test('only team sections are extracted', () => {
  assert.deepEqual(extractPageData({query: {teamId: '223790'}, props: {pageProps: {team: {id: 223790}, currentUser: {email: 'private'}, merchantAccount: {}, apiProviders: []}}}), {team: {id: 223790}});
});
test('response scope excludes lookalikes, writes, unrelated teams and accounts', () => {
  assert.ok(isTeamResponse('https://pub-api.play.spordle.com/api/sp/teams/223790/schedules'));
  assert.ok(isTeamResponse('https://pub-api.play.spordle.com/api/sp/games?filter=%7B%22homeTeamId%22%3A223790%7D'));
  for (const url of ['https://pub-api.play.spordle.com.evil.test/api/sp/teams/223790', 'https://pub-api.play.spordle.com/api/sp/teams/12237901', 'https://pub-api.play.spordle.com/api/sp/teams/123', 'https://pub-proxy.hcr.spordle.com/v1/public/members/223790']) assert.equal(isTeamResponse(url), false);
  assert.equal(isTeamResponse('https://pub-api.play.spordle.com/api/sp/teams/223790', 'POST'), false);
});
test('identify login/challenge pages without attempting to bypass them', () => {
  assert.equal(pageProblem('Vercel Security Checkpoint', teamUrl), 'browser_check_required');
  assert.equal(pageProblem('Login', 'https://myaccount.spordle.com/login'), 'login_required');
  assert.equal(pageProblem('Team', teamUrl), null);
  assert.equal(belongsToTeamPage(teamUrl + '1'), false);
});
test('key ordering is stable and section changes are reported', () => {
  assert.equal(digest({a: 1, b: 2}), digest({b: 2, a: 1}));
  assert.deepEqual(describeChanges({team: {id: 1}, games: [{time: '17:30'}]}, {team: {id: 1}, games: [{time: '18:00'}]}), ['games']);
});
