import {afterEach,expect,it,vi} from 'vitest';
import {asc,eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 let roles=['first','second'].map(model=>({model,provider:'provider',harness:'codex',series:'series'}));
 const f=await bodyFixture(clean,{modelRoles:()=>roles});f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();f.db.insert(s.agentModels).values({agent:'art',model:'first',position:0}).run();
 const post=(path:string,input:unknown,id:string,token=bodyCredentials.body)=>f.root.http.request('/api/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input,id})});
 const propose=(id='proposal',input:unknown={agent:'art',models:['second','first']},token=bodyCredentials.body)=>post('runtime/proposeAgentModels',input,id,token);
 const answer=(id:string,choice='allow',receipt='answer')=>post('approvals/answer',{id,answer:choice},receipt,bodyCredentials.member);
 const read=()=>f.db.select().from(s.agentModels).orderBy(asc(s.agentModels.position)).all().map(row=>row.model);
 return{...f,post,propose,answer,read,roles:(values:typeof roles)=>{roles=values;}};
}
it('files a bound inline before/after card and changes model order only on actual Allow',async()=>{
 const f=await fixture(),result=await(await f.propose()).json();const card=f.db.select().from(s.approvals).get()!;
 expect(result).toEqual({ok:true,value:{id:card.id}});expect(f.read()).toEqual(['first']);
 expect(card).toMatchObject({agent:'art',member:'alice',actingFor:'alice',conversation:f.thread.conversation,askedFrom:f.thread.conversation,state:'pending',operation:'runtime.agentModels'});
 expect(JSON.parse(card.details)).toEqual({agent:'art',before:['first'],after:['second','first']});expect(card.changeSummary).toContain('["first"] → ["second","first"]');
 expect(f.db.select().from(s.inbox).all()).toEqual(expect.arrayContaining([expect.objectContaining({source:'approval',waitsOnId:card.id,conversation:f.thread.conversation})]));
 expect(await(await f.propose()).json()).toEqual(result);expect(f.db.select().from(s.approvals).all()).toHaveLength(1);
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read()).toEqual(['second','first']);expect(f.db.select().from(s.approvals).get()?.state).toBe('used');
 // Receipt replay cannot reapply a previously approved ordering.
 f.db.delete(s.agentModels).run();f.db.insert(s.agentModels).values({agent:'art',model:'first',position:0}).run();
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read()).toEqual(['first']);
});
it('keeps owner commands forbidden to bodies and rejects forged, public or stale proposal provenance',async()=>{
 const f=await fixture();expect((await f.post('runtime/agentModelsSet',{agent:'art',models:['second']},'direct')).status).toBe(403);
 expect((await f.propose('unbound',undefined,bodyCredentials.agent)).status).toBe(403);
 for(const extra of [{member:'alice'},{conversation:f.thread.conversation},{operation:'other'},{actingFor:'alice'}])expect((await f.propose('forged',{agent:'art',models:['second'],...extra})).status).toBe(400);
 expect((await f.propose('other',{agent:'mark',models:['second']})).status).toBe(403);
 expect((await f.propose()).status).toBe(200);f.db.update(s.conversations).set({job:null}).run();expect((await f.propose()).status).toBe(403);
 f.db.update(s.conversations).set({job:'job',member:null}).run();f.db.update(s.jobs).set({member:null}).run();expect((await f.propose('public')).status).toBe(403);
});
it.each(['deny','stale','ownership','catalogue','tamper'] as const)('preserves models for %s at decision time',async change=>{
 const f=await fixture();expect((await f.propose()).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
 if(change==='stale'){f.db.delete(s.agentModels).run();f.db.insert(s.agentModels).values({agent:'art',model:'second',position:0}).run();}
 if(change==='ownership')f.db.delete(s.memberAgents).where(eq(s.memberAgents.member,'alice')).run();
 if(change==='catalogue')f.roles([{model:'first',provider:'provider',harness:'codex',series:'series'}]);
 if(change==='tamper')f.db.update(s.approvals).set({changeSummary:'Different approved action'}).run();
 const before=f.read(),response=await f.answer(card.id,change==='deny'?'deny':'allow');expect(response.status).toBe(change==='deny'?200:change==='stale'?409:change==='catalogue'?400:403);
 expect(f.read()).toEqual(before);expect(f.db.select().from(s.approvals).get()?.state).toBe(change==='deny'?'denied':'pending');
});
it('rolls back proposal and Allow with failed receipts, and notifies capacity only after a committed Allow',async()=>{
 const f=await fixture(),observed:boolean[]=[];const changed=vi.spyOn(f.root.services.tempo,'capacityChanged').mockImplementation(()=>{observed.push(f.db.$client.inTransaction);});
 f.db.$client.exec("CREATE TEMP TRIGGER fail_models BEFORE INSERT ON operation_results WHEN NEW.id IN ('failed-proposal','failed-answer') BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect((await f.propose('failed-proposal')).status).toBe(503);expect(f.db.select().from(s.approvals).all()).toEqual([]);expect(f.read()).toEqual(['first']);expect(observed).toEqual([]);
 expect((await f.propose()).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;expect(observed).toEqual([]);
 expect((await f.answer(card.id,'allow','failed-answer')).status).toBe(503);expect(f.read()).toEqual(['first']);expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');expect(observed).toEqual([]);
 f.root.writes.run(()=>f.db.update(s.boxes).set({lastSeenAt:new Date(f.clock.now()).toISOString()}).run());expect(observed).toEqual([]);
 expect((await f.answer(card.id)).status).toBe(200);expect(observed).toEqual([false]);expect(f.read()).toEqual(['second','first']);
 expect((await f.answer(card.id)).status).toBe(200);expect(observed).toEqual([false]);changed.mockRestore();
});
it.each([{models:[]},{models:['first','first']},{models:['unknown']}])('refuses invalid model choices $models',async({models})=>{const f=await fixture();expect((await f.propose('invalid',{agent:'art',models})).status).toBe(400);expect(f.db.select().from(s.approvals).all()).toEqual([]);});

it('retains a pending typed card across Root restart and applies after the requesting body has ended',async()=>{
 const f=await fixture();expect((await f.propose()).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
 await f.root.close();f.db.update(s.jobs).set({state:'done'}).run();
 const root=sharedRoot({db:f.db,clock:f.clock,originAllowed:()=>true,commsKey:f.key,reportError:error=>{throw error;},modelRoles:()=>['first','second'].map(model=>({model,provider:'provider',harness:'codex',series:'series'}))});clean.push(()=>root.close());
 const response=await root.http.request('/api/approvals/answer',{method:'POST',headers:{authorization:'Bearer '+bodyCredentials.member,'content-type':'application/json'},body:JSON.stringify({input:{id:card.id,answer:'allow'},id:'after-restart'})});
 expect(response.status).toBe(200);expect(f.read()).toEqual(['second','first']);expect(f.db.select().from(s.approvals).get()?.state).toBe('used');
});

it('checks the requesting member ownership separately from the authorized deciding owner',async()=>{
 const f=await fixture();await f.propose();const card=f.db.select().from(s.approvals).get()!;
 const token=f.root.writes.run(()=>{f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'bob')).run();f.db.insert(s.memberAgents).values({member:'bob',agent:'art'}).run();f.db.delete(s.memberAgents).where(eq(s.memberAgents.member,'alice')).run();return f.root.services.signin.issue({kind:'owner',member:'bob',label:'Deciding owner fixture'}).token;}).value;
 expect((await f.post('approvals/answer',{id:card.id,answer:'allow'},'other-decider',token)).status).toBe(403);expect(f.read()).toEqual(['first']);expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');
});
it('refuses an ordinary member answer and modified target or acting-for fields',async()=>{
 const f=await fixture();await f.propose();const card=f.db.select().from(s.approvals).get()!;
 const token=f.root.writes.run(()=>f.root.services.signin.issue({kind:'owner',member:'bob',label:'Ordinary member fixture'}).token).value;
 expect((await f.post('approvals/answer',{id:card.id,answer:'allow'},'ordinary-decider',token)).status).toBe(403);
 for(const extra of [{target:'runtime:agent-models:mark'},{actingFor:'bob'}]){
  f.db.update(s.approvals).set({...extra}).run();expect((await f.answer(card.id)).status).toBe(403);expect(f.read()).toEqual(['first']);
  f.db.update(s.approvals).set({target:card.target,actingFor:card.actingFor}).run();
 }
 expect((await f.propose('unchanged',{agent:'art',models:['first']})).status).toBe(400);
});
