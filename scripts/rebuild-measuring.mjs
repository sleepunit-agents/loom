import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {FakeClock} from '../dist/core/clock.js';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';

export async function measuringDestinations({home}) {
  const example = await exampleHome(home);
  assert.equal(example.fictional, true);
  const clock = new FakeClock(Date.parse('2027-01-10T23:58:55Z'));
  const app = await startSharedHome({home, clock, host:'127.0.0.1', port:0, stdout() {}});
  const traces = [];
  const collector = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    traces.push({path:req.url, type:req.headers['content-type'], bytes:Buffer.concat(parts)});
    res.writeHead(200, {'content-type':'application/x-protobuf'}).end();
  });
  try {
    await new Promise((resolve,reject) => {
      collector.once('error',reject);
      collector.listen(0,'127.0.0.1',resolve);
    });
    const issue = input => app.writes.run(() => app.services.signin.issue({...input,label:'Fictional measuring check '+(input.member ?? input.agent)})).value.token;
    const owner = issue({kind:'owner',member:'alex'});
    const member = issue({kind:'owner',member:'robin'});
    const agent = issue({kind:'agent',agent:'fern'});
    const meter = await app.measuring;
    async function post(token, path, body, status=200) {
      const response = await fetch(app.url+path, {method:'POST', signal:AbortSignal.timeout(10000),
        headers:{authorization:'Bearer '+token,'content-type':'application/json'}, body:JSON.stringify(body)});
      assert.equal(response.status,status,path);
      return response.json();
    }
    async function read(token) {
      const result = await post(token,'/graphql',{query:'{ timingDays { day kind name count totalMs typicalMs slowestMs } measuringSettings { on } }'});
      assert.equal(result.errors,undefined);
      return result.data;
    }
    async function checkDailyRollups() {
      for (const elapsed of [30000,60000]) {
        clock.advance(elapsed);
        for (let i=0; i<2; i++) {
          const comment = await post(owner,'/api/tasks/command',{id:randomUUID(),
            input:{action:'comment',id:example.tasks[0],text:'Fictional timing sample'}});
          assert.equal(comment.ok,true);
        }
        await read(owner);
        await meter.flush();
      }
      const {timingDays} = await read(agent);
      for (const day of ['2027-01-10','2027-01-11']) {
        for (const [kind,name] of [['request','graphql'],['operation','tasks.command'],['job','runtime.tick']]) {
          const rows = timingDays.filter(row=>row.day===day && row.kind===kind && row.name===name);
          assert.equal(rows.length,1,day+' '+name);
          const [row] = rows;
          assert.ok(row.count>0 && row.totalMs>=row.slowestMs && row.slowestMs>0);
          assert.ok(Math.abs(row.typicalMs-row.totalMs/row.count)<1e-6);
          if (kind==='operation') assert.equal(row.count,2);
        }
      }
    }
    const count = app.services.comms.db.$client.prepare("SELECT coalesce(sum(count),0) FROM timing_days WHERE kind='request' AND name='graphql'").pluck();
    assert.equal(meter.enabled(),false);
    await read(owner);
    await meter.flush();
    assert.equal(count.get(),0);
    for (const [local,external] of [[true,false],[true,true],[false,true]]) {
      const input = {on:true, keep_days:local?7:0, send_outside:external,
        outside_address:external?`http://127.0.0.1:${collector.address().port}/v1/traces`:''};
      const proposal = await post(agent,'/api/household/propose',{id:randomUUID(),input:{change:'measuring',input,why:'Check fixture timings'}});
      assert.equal(proposal.ok,true);
      const answer = (token,status) => post(token,'/api/approvals/answer',
        {id:randomUUID(),input:{id:proposal.value.id,answer:'allow'}},status);
      await answer(agent,403);
      await answer(member,403);
      assert.equal((await answer(owner,200)).ok,true);
      await meter.settled();
      assert.equal(meter.enabled(),true);
      await meter.flush();
      const before = count.get(), sent = traces.length;
      const ownerView = await read(owner);
      assert.deepEqual(ownerView.measuringSettings,[{on:true}]);
      if (before>0) assert.ok(ownerView.timingDays.some(row=>row.kind==='request' && row.name==='graphql' && row.count>0));
      await meter.flush();
      assert.equal(count.get(),before+(local?1:0));
      const batches = traces.slice(sent);
      if (external) {
        assert.ok(batches.some(batch=>batch.path==='/v1/traces' && batch.type==='application/x-protobuf' && batch.bytes.includes(Buffer.from('graphql'))));
      } else assert.equal(batches.length,0);
      assert.deepEqual(await read(member),{timingDays:[],measuringSettings:[]});
      const agentView = await read(agent);
      assert.deepEqual(agentView.measuringSettings,[]);
      assert.ok(agentView.timingDays.some(row=>row.kind==='request' && row.name==='graphql' && row.count>0));
      if (local && !external) await checkDailyRollups();
    }
    return {ok:true,reason:'An owner approved each destination. The same GraphQL request incremented local counts in local and combined mode and reached the loopback OTLP receiver in external and combined mode. An agent read daily counts and durations through GraphQL for requests, task operations and scheduled jobs on two UTC dates. A regular member saw neither settings nor timings, and neither the agent nor the member could approve the change.'};
  } finally {
    try { await app.close(); }
    finally { if (collector.listening) await new Promise(resolve=>collector.close(resolve)); }
  }
}
