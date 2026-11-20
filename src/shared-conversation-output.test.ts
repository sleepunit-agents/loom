import { afterEach,expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bodyFixture,bodyCredentials as raw } from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const fixture=()=>bodyFixture(clean);
it('publishes encrypted replies and tool cards with actual run/model metadata and no private receipts',async()=>{
 const f=await fixture();
 expect(await(await f.call('message',{kind:'reply',clientId:'reply',words:'PRIVATE ANSWER t-41',model:'actual-model',outcome:'answered',latencyMs:123},'reply')).json()).toEqual({ok:true,value:{saved:true,seq:1}});
 expect(await(await f.call('message',{kind:'card',clientId:'card',words:'PRIVATE STEP',tool:'Read',cardState:'done',model:'actual-model'},'card')).json()).toEqual({ok:true,value:{saved:true,seq:2}});
 const messages=f.db.select().from(s.messages).all();expect(messages).toMatchObject([{kind:'reply',run:'job',sender:'art',clientId:'job:reply'},{kind:'card',run:'job',tool:'Read',cardState:'done'}]);expect(await f.root.services.comms!.key.open(messages[0].words!)).toBe('PRIVATE ANSWER t-41');
 expect(f.db.select().from(s.turns).all()).toMatchObject([{kind:'reply',fromKind:'agent',fromId:'art',run:'job',model:'actual-model',outcome:'answered',latencyMs:123},{kind:'action',run:'job',model:'actual-model'}]);expect(f.db.select().from(s.threadRefs).get()?.ref).toBe('t-41');
 expect(JSON.stringify([f.db.select().from(s.operationResults).all(),f.db.select().from(s.turns).all(),f.db.select().from(s.jobs).all(),f.db.select().from(s.inbox).all()])).not.toContain('PRIVATE');expect(f.db.select().from(s.turns).all().some(row=>row.model==='REQUESTED MODEL')).toBe(false);
 expect((await f.call('message',{kind:'reply',clientId:'reply',words:'PRIVATE ANSWER t-41',model:'actual-model',outcome:'answered',latencyMs:123},'reply')).status).toBe(200);expect(f.db.select().from(s.messages).all()).toHaveLength(2);expect((await f.call('message',{kind:'reply',clientId:'reply',words:'PRIVATE ANSWER t-41',model:'actual-model',outcome:'answered',latencyMs:123},'fresh-retry')).status).toBe(200);expect(f.db.select().from(s.messages).all()).toHaveLength(2);expect(f.db.select().from(s.turns).all()).toHaveLength(2);
});
it('reports actual working heartbeats, tells the body of a Stop, and never takes the Stop on the body\'s word',async()=>{
 const f=await fixture();const report=(input:unknown,id:string)=>f.call('status',input,id);
 expect(await(await report({state:'working',work:'Checking the pump'},'start')).json()).toEqual({ok:true,value:{saved:true,stopRequested:false}});
 const before=f.db.select().from(s.threads).get()!;expect(before).toMatchObject({working:true,workingSince:expect.any(String),workingBeat:expect.any(String)});f.clock.advance(1000);
 expect((await report({state:'working',work:'Checking the pump'},'beat')).status).toBe(200);expect(f.db.select().from(s.threads).get()).toMatchObject({workingSince:before.workingSince,workingBeat:new Date(f.clock.now()).toISOString()});
 f.root.writes.run(()=>f.root.services.comms!.threads.requestStop(f.thread.id));expect((await(await report({state:'working',work:'Checking the pump'},'read-stop')).json()).value.stopRequested).toBe(true);expect(f.db.select().from(s.threads).get()?.stopRequested).toBe(true);
 // A status report cannot take the Stop: loom takes it when the worker reports the body's exit (Jobs.finish).
 expect((await report({state:'idle',work:'Stopped',seenStop:true},'ack')).status).toBe(400);expect(f.db.select().from(s.threads).get()?.stopRequested).toBe(true);
 expect((await(await report({state:'idle',work:'Stopped'},'stopped')).json()).value.stopRequested).toBe(true);expect(f.db.select().from(s.threads).get()).toMatchObject({working:false,workingSince:null,workingBeat:null,stopRequested:true});expect(f.db.select().from(s.agentStatus).get()).toEqual({agent:'art',state:'idle',work:'',changedAt:new Date(f.clock.now()).toISOString()});
});
it('rejects non-body authority and input-selected attribution',async()=>{
 const f=await fixture(),message={kind:'reply',clientId:'one',words:'PRIVATE'};
 for(const token of [raw.member,raw.agent,raw.runner])for(const [name,input]of [['message',message],['status',{state:'working',work:'x'}]] as const)expect((await f.call(name,input,'denied-'+name,token)).status).toBe(403);
 for(const extra of [{job:'other'},{agent:'mark'},{thread:'other'},{run:'invented'}])expect((await f.call('message',{...message,...extra},'invalid')).status).toBe(400);
 expect((await f.call('status',{state:'working',work:'two\nlines'},'invalid')).status).toBe(400);expect(f.db.select().from(s.messages).all()).toEqual([]);expect(f.db.select().from(s.agentStatus).all()).toEqual([]);
});
it.each(['assignment','ended','thread','scope'] as const)('withholds sealed output after %s changes during preparation',async change=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});f.gate(()=>{entered();return new Promise<void>(r=>{release=r;});});
 const pending=f.call('message',{kind:'reply',clientId:'one',words:'PRIVATE LATE'},'held');await started;f.root.writes.run(()=>{
  if(change==='assignment')f.db.delete(s.memberAgents).run();if(change==='ended')f.db.update(s.jobs).set({state:'done'}).run();if(change==='scope')f.db.update(s.conversations).set({member:'bob'}).run();
  if(change==='thread'){const other=f.root.services.conversations.open({agent:'art',member:'alice',project:'pond',venue:'loom',place:'other',label:'Other'});f.db.update(s.threads).set({conversation:other.id}).run();}
 });release();const response=await pending;expect([403,404,503]).toContain(response.status);expect(await response.text()).not.toContain('PRIVATE LATE');expect(f.db.select().from(s.messages).all()).toEqual([]);expect(f.db.select().from(s.turns).all()).toEqual([]);
});
it('isolates sender retry IDs across jobs and records no inferred model',async()=>{
 const f=await fixture();const input={kind:'reply',clientId:'same',words:'First job'};
 expect((await f.call('message',input,'first')).status).toBe(200);const old=f.db.select().from(s.jobs).get()!;
 f.root.writes.run(()=>{f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,old.id)).run();f.db.insert(s.jobs).values({...old,id:'next-job',state:'running'}).run();f.db.update(s.tokens).set({job:'next-job'}).where(eq(s.tokens.job,old.id)).run();});
 expect((await f.call('message',{...input,words:'Second job'},'second')).status).toBe(200);expect(f.db.select().from(s.messages).all()).toMatchObject([{run:'job',clientId:'job:same'},{run:'next-job',clientId:'next-job:same'}]);expect(f.db.select().from(s.turns).all().map(row=>row.model)).toEqual([null,null]);
});
it('keys both private output and reported status fingerprints with the Comms key',async()=>{
 const f=await fixture(),input={kind:'reply',clientId:'one',words:'PRIVATE FINGERPRINT'};expect((await f.call('message',input,'message-fingerprint')).status).toBe(200);expect((await f.call('status',{state:'working',work:'Reported work'},'status-fingerprint')).status).toBe(200);
 for(const [name,canonical]of [['conversation.message','{"clientId":"one","kind":"reply","words":"PRIVATE FINGERPRINT"}'],['conversation.status','{"state":"working","work":"Reported work"}']]){
  const receipt=f.db.select().from(s.operationResults).where(eq(s.operationResults.operation,name)).get()!;expect(receipt.inputHash).toBe(f.root.services.comms!.key.hash('body-output\0job\0'+canonical));expect(receipt.inputHash).not.toContain('PRIVATE');expect(receipt.result).not.toContain('PRIVATE');expect(receipt.result).not.toContain('Reported work');
 }
});
it.each(['\r','\n','\v','\f','\u0085','\u2028','\u2029'])('refuses multiline status with separator %j',async separator=>{
 const f=await fixture();expect((await f.call('status',{state:'working',work:'First'+separator+'Second'},'multiline')).status).toBe(400);expect(f.db.select().from(s.agentStatus).all()).toEqual([]);expect(f.db.select().from(s.operationResults).all()).toEqual([]);
});
