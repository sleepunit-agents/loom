import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Two different places may have the same agent and request the same catalog entry.
 * The worker supplies only the request. Loom supplies its job and conversation. */
export function requestSourceObserver({app,clock}) {
 const db=app.services.comms.db.$client;
 const name='walkthrough-shed-catalog';
 app.writes.run(()=>{
  db.prepare('INSERT INTO secrets(name,description,changed_at,changed_by) VALUES(?,?,?,?)').run(name,'Fictional catalog entry',new Date(clock.now()).toISOString(),'alex');
  db.prepare('INSERT INTO secret_changes(id,secret,action,by,at) VALUES(?,?,?,?,?)').run(randomUUID(),name,'add','alex',new Date(clock.now()).toISOString());
  app.services.secrets.requests.setRule({secret:name,answer:'ask',minutes:5,agents:[{agent:'moss',when:'on_request'}]});
 });
 const seen=new Set();
 return {
  async observe(job,call) {
   const id=randomUUID();
   const input={id,secret:name,scope:'job',why:'Inspect the fictional shed schedule.',minutes:5};
   const response=await call('secrets.request',input);
   assert.deepEqual(response,{id,state:'pending'});
   assert.deepEqual(await call('secrets.request',input),response);
   assert.deepEqual(db.prepare('SELECT job,agent,conversation FROM secret_requests WHERE id=?').get(id),
    {job:job.id,agent:job.agent,conversation:job.conversation});
   assert.deepEqual(db.prepare("SELECT conversation FROM inbox WHERE source='secret-request' AND source_id=? AND to_kind='person' AND [to]='alex'").all(id),[{conversation:job.conversation}]);
   assert.ok(job.conversation);
   seen.add(job.conversation);
  },
  result() {
   assert.equal(seen.size,2);
   return {ok:true,reason:'Two job-scoped requests for the same fictional catalog entry kept their respective conversations. Each retried request produced one question for the owner.'};
  },
 };
}
