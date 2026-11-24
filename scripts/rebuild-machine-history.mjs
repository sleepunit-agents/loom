import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { boxes, jobs, machineReads } from '../dist/core/data/schema.js';
import { httpWorkerControl } from '../dist/runtime/worker-http.js';
import { eq } from 'drizzle-orm';

export async function machineHistory({ app, example }) {
  assert.equal(example.fictional, true);
  const { signin, conversations, comms } = app.services;
  const db = comms.db;
  const machine = 'history-' + randomUUID();
  const job = randomUUID();
  const agent = 'fern';
  const member = 'alex';
  const write = fn => app.writes.run(fn).value;
  const room = write(() => {
    const room = conversations.open({agent, venue:'wake', place:job, label:'Garden diagnostic'});
    const now = new Date().toISOString();
    db.insert(boxes).values({id:machine,name:'Garden diagnostic',owner:member,readers:[agent],
      sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now}).run();
    db.insert(jobs).values({id:job,agent,conversation:room.id,box:machine,state:'starting',
      title:'Garden diagnostic',brief:'',model:'fixture',startedByKind:'agent',startedBy:agent,
      houseRepository:'',houseFile:'',houseBranch:'next',queuedAt:now}).run();
    return room;
  });
  const issued = [];
  function issue(input) {
    const credential = write(() => signin.issue({...input,label:'Garden diagnostic '+(input.member ?? input.box)}));
    issued.push(credential.fingerprint);
    return credential.token;
  }
  const signal = AbortSignal.timeout(12000);
  async function request(token,path,input,status=200) {
    const response = await fetch(app.url+'/api/'+path,{method:'POST',signal,
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({id:randomUUID(),input})});
    assert.equal(response.status,status,path);
    const result = await response.json();
    assert.equal(result.ok,status===200,path);
    return result.value;
  }
  let body;
  try {
    const worker = issue({kind:'runner',box:machine});
    const owner = issue({kind:'owner',member});
    const other = issue({kind:'owner',member:'robin'});
    const control = httpWorkerControl({url:app.url,token:worker,signal});
    body = await control.enrollBody(job,signal);
    await control.started(job,'fixture');
    const token = body.token.toString('ascii');
    const input = {machine,read:'memory',args:{}};
    const poll = () => request(worker,'runtime/machineReadNext',{reads:['memory']});
    assert.equal(await poll(),null);
    const sample = 'Garden sample 🌱 '+randomUUID();
    async function answer(ok,output) {
      const [result] = await Promise.all([
        request(token,'machine/read',input),
        (async () => {
          let ticket;
          while (!(ticket = await poll())) await delay(10,undefined,{signal});
          assert.equal(ticket.read,input.read);
          assert.equal(await request(worker,'runtime/machineReadDone',{id:ticket.id,ok,output}),true);
        })(),
      ]);
      return result;
    }
    assert.deepEqual(await answer(true,sample),{source:'machine',machine,read:'memory',lines:[sample]});
    const failure = 'Garden sensor offline '+randomUUID();
    assert.deepEqual(await answer(false,failure),{refusal:'Machine read unavailable'});
    const rows = await request(owner,'machine/history',{machine});
    const stored = db.select().from(machineReads).where(eq(machineReads.machine,machine)).all();
    assert.equal(rows.length,2);
    assert.deepEqual(rows.toSorted((a,b)=>a.id.localeCompare(b.id)),stored.toSorted((a,b)=>a.id.localeCompare(b.id)));
    for (const row of rows) {
      assert.deepEqual([row.machine,row.job,row.conversation,row.agent,row.read,row.args],
        [machine,job,room.id,agent,'memory','{}']);
      assert.ok(Number.isFinite(Date.parse(row.askedAt)));
      assert.ok(!JSON.stringify(row).includes(sample) && !JSON.stringify(row).includes(failure));
    }
    assert.deepEqual(Object.fromEntries(rows.map(row=>[row.outcome,row.bytes])),
      {answered:Buffer.byteLength(sample),'Machine read unavailable':0});
    await request(other,'machine/history',{machine},403);
    return {ok:true,reason:'The machine owner read both diagnostic requests. Stored rows matched the history, including the job, read kind, time, outcome and UTF-8 byte count. Neither the sample nor the worker’s error text appeared there. A second member was refused.'};
  } finally {
    body?.erase?.();
    for (const fingerprint of issued) write(() => signin.revoke(fingerprint));
  }
}
