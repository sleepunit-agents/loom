import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture} from '../test/fixtures/conversation-body.js';
import {Jobs} from './runtime/jobs.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
it.each(['failed','lost','stopped','done'] as const)('shows actual %s delivery outcome without confirming mail or touching other messages',async outcome=>{
 const f=await bodyFixture(clean),jobs=new Jobs(f.db,()=>new Date(f.clock.now()).toISOString());
 expect((await f.send('Accepted','accepted')).status).toBe(200);const take=await (await f.root.http.request('/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+'b'.repeat(64),'content-type':'application/json'},body:JSON.stringify({input:{}})})).json();expect((await f.call('confirm',{items:[take.value.items[0].id]},'confirm')).status).toBe(200);
 expect((await f.send('Not accepted','pending')).status).toBe(200);const other=f.root.services.comms!.threads.open({member:'alice',agent:'art',title:'Other'});await f.root.services.comms!.send({thread:other.id,sender:'alice',kind:'message',clientId:'other',words:'Other message'});
 // Mail sent to an already running body gets its exact job when it takes it.
 expect((await f.root.http.request('/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+'b'.repeat(64),'content-type':'application/json'},body:JSON.stringify({input:{}})})).status).toBe(200);
 const finish=()=>{if(outcome==='failed'||outcome==='done')jobs.finish('job','box',outcome==='failed'?1:0);else if(outcome==='stopped')jobs.stop('job','alice','reset');else{f.db.update(s.jobs).set({heardAt:new Date(f.clock.now()-120001).toISOString()}).where(eq(s.jobs.id,'job')).run();jobs.sweep();}};
 expect(()=>f.root.writes.run(()=>{finish();throw Error('Rollback');})).toThrow('Rollback');expect(f.db.select().from(s.messages).all().map(row=>row.delivery)).toEqual(['delivered','sending','sending']);
 f.root.writes.run(finish);// A failed or lost body that left this mail unconfirmed is tried again (Jobs.retry), so the mail is held for the next attempt; it shows failed only when the attempts run out.
 expect(f.db.select().from(s.messages).all().map(row=>row.delivery)).toEqual(['delivered','held','sending']);expect(f.db.select().from(s.inbox).all().map(row=>row.state)).toEqual(['done','waiting','waiting']);
});
it('holds queued and retrying original mail, sends on claim and shows failure only after the actual exhausted start chain',async()=>{
 const f=await bodyFixture(clean),jobs=new Jobs(f.db,()=>new Date(f.clock.now()).toISOString());f.db.insert(s.agentModels).values({agent:'art',model:'fixture',position:0}).run();f.db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'fixture',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
 const thread=f.root.services.comms!.threads.open({member:'alice',agent:'art',title:'Retries'}),message=await f.root.services.comms!.send({thread:thread.id,sender:'alice',kind:'message',clientId:'retry-me',words:'Fictitious retry'});
 const delivery=()=>f.db.select().from(s.messages).where(eq(s.messages.thread,thread.id)).get()?.delivery;expect(delivery()).toBe('sending');let job=jobs.admit(thread.conversation)!;expect(delivery()).toBe('held');expect(jobs.admit(thread.conversation)?.id).toBe(job.id);expect(delivery()).toBe('held');
 for(let attempt=0;attempt<4;attempt++){
  expect(jobs.claim(job.id,'box')).toBeDefined();expect(delivery()).toBe('sending');const result=jobs.finish(job.id,'box',1);expect(f.root.services.conversations.item(message.inboxItem!).state).toBe('waiting');
  if(attempt===3){expect(result.retry).toBeUndefined();expect(delivery()).toBe('failed');break;}
  expect(delivery()).toBe('held');job=result.retry!;expect(jobs.claim(job.id,'box')).toBeUndefined();expect(delivery()).toBe('held');f.clock.advance(1000*2**attempt);
 }
 expect(jobs.admit(thread.conversation)).toBeUndefined();expect(delivery()).toBe('failed');
});
it('keeps late input unconfirmed while restoring its sending state when the running body actually takes it',async()=>{
 const f=await bodyFixture(clean);await f.send('Late input','late');f.db.update(s.messages).set({delivery:'held'}).run();
 const response=await f.root.http.request('/api/conversation/take',{method:'POST',headers:{authorization:'Bearer '+'b'.repeat(64),'content-type':'application/json'},body:JSON.stringify({input:{}})});expect(response.status).toBe(200);expect(f.db.select().from(s.messages).get()?.delivery).toBe('sending');expect(f.db.select().from(s.inbox).get()?.state).toBe('taken');
 const item=f.db.select().from(s.inbox).get()!;expect((await f.call('confirm',{items:[item.id]},'accepted')).status).toBe(200);expect(f.db.select().from(s.messages).get()?.delivery).toBe('delivered');
});
