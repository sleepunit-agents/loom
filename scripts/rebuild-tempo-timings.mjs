import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';

export async function checkTempoTimings(home) {
  const fixture = await exampleHome(home);
  assert.equal(fixture.fictional, true);
  const app = await startSharedHome({home, host:'127.0.0.1', port:0, stdout() {}});
  try {
    const issue = input => app.writes.run(() => app.services.signin.issue({...input,label:'Tempo timing walkthrough '+input.kind})).value.token;
    const owner = issue({kind:'owner',member:'alex'});
    const agent = issue({kind:'agent',agent:'fern'});
    const person = {kind:'person',id:'alex'};
    const body = {kind:'agent',id:'fern'};
    const defaults = {settleSeconds:5,dimDays:1,muteDays:7};
    const personal = {settleSeconds:9,dimDays:2,muteDays:4};
    const agentSettings = {settleSeconds:13,dimDays:3,muteDays:6};
    const stored = app.services.comms.db.$client.prepare('SELECT count(*) FROM tempo_settings WHERE who_kind=? AND who=?').pluck();
    async function request(token,path,input) {
      const response = await app.http.request(app.url+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input)});
      assert.equal(response.status,200,path);
      return response.json();
    }
    async function check(token,who,expected,count) {
      const result = await request(token,'/graphql',{query:'{tempoTimings{settleSeconds dimDays muteDays}}'});
      assert.equal(result.errors,undefined);
      assert.deepEqual(result.data.tempoTimings,expected);
      assert.equal(stored.get(who.kind,who.id),count);
    }
    async function change(who,settings) {
      const proposed = await request(agent,'/api/household/propose',{id:randomUUID(),input:{change:'tempoTimings',input:{who,...settings},why:'Exercise personal timings in this fictional household.'}});
      assert.equal(proposed.ok,true);
      const answer = await request(owner,'/api/approvals/answer',{id:randomUUID(),input:{id:proposed.value.id,answer:'allow'}});
      assert.equal(answer.ok,true);
    }
    await check(owner,person,defaults,0);
    await check(agent,body,defaults,0);
    await change(person,personal);
    await check(owner,person,personal,1);
    await check(agent,body,defaults,0);
    await change(body,agentSettings);
    await check(agent,body,agentSettings,1);
    await change(person,defaults);
    await check(owner,person,defaults,0);
    await check(agent,body,agentSettings,1);
    await change(body,defaults);
    await check(agent,body,defaults,0);
    return {ok:true,reason:'An owner approved custom settle, dim and mute timings for a person and an agent. Each read their own values through GraphQL. Returning each recipient to the defaults removed just their stored override.'};
  } finally { await app.close(); }
}
