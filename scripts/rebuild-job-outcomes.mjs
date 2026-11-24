import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleHome } from '../dist/example-home.js';
import { FakeClock } from '../dist/core/clock.js';
import { startSharedHome } from '../dist/shared-startup.js';
import { httpWorkerControl } from '../dist/runtime/worker-http.js';
import { REPORT_MS, SILENCE_MS } from '../dist/runtime/silence.js';

import { nativeProtocolSmoke } from './rebuild-native-protocol.mjs';

// Report Tempo separately so a trigger assertion cannot hide the worker history after restart.
function jobEndWatch(post, job, otherJob, ending) {
  const target={id:'watch-example-job',job,words:'The example shed job ended.'};
  const other={id:'watch-public-job',job:otherJob,words:'The example path job ended.'};
  let before, delivery, otherDelivery, failure;
  const check=async work=>{
    if(failure)return;
    try { await work(); } catch(error) { failure={ok:false,ending,error:String(error)}; }
  };
  const read=async({id,job}=target)=>{
    const packet=await post('/graphql',{query:`query($id:String!){
      triggers(where:{id:{eq:$id}}){id enabled state watches}
      triggerLog(where:{trigger:{eq:$id}}){event}
      inboxItems(limit:100){id source sourceId toKind to refs body{words}}
    }`,variables:{id}});
    assert.equal(packet.errors,undefined);
    const {triggers,triggerLog,inboxItems}=packet.data;
    assert.equal(triggers.length,1);
    assert.equal(triggers[0].watches,'job:'+job);
    return {state:triggers[0].state,enabled:triggers[0].enabled,firings:triggerLog.filter(row=>row.event==='fired').length,
      deliveries:inboxItems.filter(row=>row.refs.includes(id))};
  };
  const fired=async(watch=target)=>{
    const {id,words}=watch;
    const snapshot=await read(watch);
    assert.equal(snapshot.state,'fired');
    assert.equal(snapshot.enabled,false);
    assert.equal(snapshot.firings,1);
    assert.equal(snapshot.deliveries.length,1);
    const [item]=snapshot.deliveries;
    assert.equal(item.source,'trigger');
    assert.ok(item.sourceId.startsWith(id+':'));
    assert.equal(item.toKind,'person');
    assert.equal(item.to,'alex');
    assert.equal(item.body.words,words);
    return snapshot;
  };
  const set=async({id,job,words})=>{
    const result=await post('/api/tempo/set',{id:crypto.randomUUID(),input:{id,ownerKind:'member',owner:'alex',sourceKind:'job',
      watches:'job:'+job,lifespan:'once',targetKind:'inbox',toKind:'person',to:'alex',instructions:words,note:words}});
    assert.equal(result.ok,true,result.message);
    assert.equal(result.value.id,id);
    const pending=await read({id,job});
    assert.ok(pending.enabled);
    assert.equal(pending.firings,0);
    assert.deepEqual(pending.deliveries,[]);
    return pending;
  };
  return {
    start:()=>check(async()=>{
      before=await set(target);
      if(ending==='stopped')await set(other);
    }),
    running:()=>check(async()=>assert.deepEqual(await read(),before)),
    unrelatedStop:(request,state)=>check(async()=>{
      const result=await post('/api/runtime/jobStop',request);
      assert.equal(result.ok,true,result.message);
      assert.equal(state(),'running');
      assert.deepEqual(await read(),before);
      otherDelivery=await fired(other);
    }),
    replayStop:(request,result)=>check(async()=>{
      delivery=await fired();
      assert.deepEqual(await read(other),otherDelivery);
      assert.deepEqual(await post('/api/runtime/jobStop',request),result);
      assert.deepEqual(await read(),delivery);
      assert.deepEqual(await read(other),otherDelivery);
    }),
    ended:()=>check(async()=>{
      if(delivery)assert.deepEqual(await read(),delivery);
      else delivery=await fired();
    }),
    async restarted(){
      await check(async()=>{
        assert.deepEqual(await read(),delivery);
        if(otherDelivery)assert.deepEqual(await read(other),otherDelivery);
      });
      return failure??{ok:true,ending,deliveries:delivery.deliveries.length,firings:delivery.firings};
    },
  };
}

async function verifyOutcome(ending) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-job-outcome-'));
  const home = join(dir, 'home');
  let app, child;
  try {
    const example = await exampleHome(home);
    assert.equal(example.fictional, true);
    const { box, job, conversation } = example.runtime;
    const clock = new FakeClock(Date.parse(example.createdAt));
    const open = () => startSharedHome({ home, clock, port: 0, stdout() {} });
    app = await open();
    const issue = key => app.writes.run(() => app.services.signin.issue(key)).value.token;
    const owner = issue({ kind: 'owner', member: 'alex', label: 'Example reader' });
    const state = () => app.services.comms.db.$client.prepare('SELECT state FROM jobs WHERE id=?').get(job.id).state;
    const post = async (path, payload, timeout=30_000) => {
      const response = await fetch(app.url + path, { method: 'POST', signal: AbortSignal.timeout(timeout), redirect: 'error',
        headers: { authorization: 'Bearer ' + owner, 'content-type': 'application/json' },
        body: JSON.stringify(payload) });
      assert.equal(response.status, 200);
      return response.json();
    };

    const watch = jobEndWatch((path,payload)=>post(path,payload,3000), job.id, example.runtime.publicJob.id, ending);
    await watch.start();
    assert.equal(state(), 'queued');
    if (ending === 'done') {
      const result = await nativeProtocolSmoke({ app, example, clock, home, signal: AbortSignal.timeout(30_000),
        async native({job:runningJob}){
          if(runningJob.id===job.id)await watch.running();
          return {text:'Fictional shed check complete.',model:'fixture-observed-native-model',actions:[]};
        },
      });
      const run = result.runs.find(item => item.job === job.id);
      assert.equal(run?.running, true);
      assert.equal(run.currentJob, job.id);
      assert.equal(run.conversation, conversation);
    } else {
      const runner = issue({ kind: 'runner', box, label: 'Example worker' });
      const worker = () => httpWorkerControl({ url: app.url, token: runner, slots: 12, signal: AbortSignal.timeout(30_000) });
      let assignment;
      do {
        assignment = await worker().next();
        assert.ok(assignment, 'The example worker must receive the original job');
      } while (assignment.id !== job.id);
      assert.equal(assignment.box, box);
      assert.equal(state(), 'starting');
      // Only the process exit is synthetic. The coordinator sees normal worker calls or silence.
      child = spawn(process.execPath, ['-e', 'process.stdin.once("data", b => process.exit(Number(b)))'],
        { env: {}, stdio: ['pipe', 'ignore', 'ignore'] });
      await once(child, 'spawn');
      const exited = once(child, 'exit');
      await worker().started(job.id, 'example-build');
      assert.equal(state(), 'running');
      await watch.running();
      if (ending === 'lost') {
        child.kill('SIGKILL');
        assert.equal((await exited)[1], 'SIGKILL');
        clock.advance(SILENCE_MS - 1);
        assert.equal(state(), 'running');
        await watch.running();
        clock.advance(2 * REPORT_MS + 1001);
      } else if (ending === 'stopped') {
        const stop = id => ({id: crypto.randomUUID(), input: {job: id, reason: 'write-off'}});
        await watch.unrelatedStop(stop(example.runtime.publicJob.id), state);
        const request = stop(job.id);
        const result = await post('/api/runtime/jobStop', request);
        assert.equal(result.ok, true, result.message);
        await watch.replayStop(request, result);
        assert.equal(await worker().heartbeat(job.id, 'running'), false);
        child.kill();
        await exited;
      } else {
        const code = 23;
        child.stdin.end(String(code));
        const [actual] = await exited;
        assert.equal(actual, code);
        await worker().finish(job.id, actual, '', 'body');
      }
    }
    assert.equal(state(), ending);
    await watch.ended();
    await app.close();
    app = await open();
    const triggerResult=await watch.restarted();
    try {
      const result = await post('/graphql', { query: '{jobHistory(agent:"moss",first:40){id state conversation}}' });
      assert.equal(result.errors, undefined);
      const row = result.data.jobHistory.find(item => item.id === job.id);
      assert.equal(row?.state, ending);
      assert.equal(row.conversation, conversation);
      return {history:{ok:true,ending},trigger:triggerResult};
    } catch(error) {
      return {history:{ok:false,ending,error:String(error)},trigger:triggerResult};
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

export async function jobOutcomeEvidence() {
  const endings = [];
  for (const ending of ['done', 'failed', 'stopped', 'lost']) endings.push(await verifyOutcome(ending));
  const triggers=endings.map(row=>row.trigger);
  const history=endings.map(row=>row.history).find(result=>!result.ok)??{ok:true, reason:'The normal worker ran the assigned body. Member history preserved the success, failure, owner stop and silence timeout after restart.'};
  return { ...history,
    jobEndTrigger: triggers.find(result=>!result.ok) ?? {ok:true, endings:triggers, reason:'Each ending fired its own trigger once and delivered one notice to its intended member. Stopping another job left the trigger waiting. A retried owner stop and a coordinator restart preserved the original delivery.'},
  };
}
