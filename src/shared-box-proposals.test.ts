import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 const f=await bodyFixture(clean);f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();
 const value={box:'box',name:'Workshop',hostsAny:false,reportOnly:false,alwaysOn:true,agents:[{agent:'art',lent:false},{agent:'mark',lent:true}],facts:['gpu:5090']};
 const post=(path:string,input:unknown,id:string,token=bodyCredentials.body)=>f.root.http.request('/api/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input,id})});
 const propose=(id='proposal',input:unknown=value,token=bodyCredentials.body)=>post('runtime/proposeBoxSettings',input,id,token);
 const answer=(id:string,choice='allow',receipt='answer')=>post('approvals/answer',{id,answer:choice},receipt,bodyCredentials.member);
 const read=()=>({box:f.db.select().from(s.boxes).get(),agents:f.db.select().from(s.boxAgents).all(),facts:f.db.select().from(s.boxFacts).all()});
 return{...f,value,post,propose,answer,read};
}
it('records exact private chat provenance and before/after; only Allow applies hosting, lending and facts',async()=>{
 const f=await fixture(),before=f.read();expect((await f.propose()).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
 expect(f.read()).toEqual(before);expect(card).toMatchObject({operation:'runtime.boxSettings',member:'alice',actingFor:'alice',conversation:f.thread.conversation,askedFrom:f.thread.conversation,state:'pending'});
 const detail=JSON.parse(card.details);expect(detail.owner).toBe('alice');expect(detail.before).toMatchObject({box:'box',name:'Box',agents:[],facts:[]});expect(detail.after).toEqual(f.value);
 expect((await f.propose()).status).toBe(200);expect(f.db.select().from(s.approvals).all()).toHaveLength(1);
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read()).toMatchObject({box:{name:'Workshop',alwaysOn:true},agents:[{agent:'art',lent:false},{agent:'mark',lent:true}],facts:[{fact:'gpu:5090',fromOwner:true}]});
 f.db.update(s.boxes).set({name:'Later'}).run();expect((await f.answer(card.id)).status).toBe(200);expect(f.read().box?.name).toBe('Later');
});
it('preserves body authority and refuses forged, unbound, public and unavailable targets',async()=>{
 const f=await fixture();expect((await f.post('runtime/boxSettingsSet',f.value,'direct')).status).toBe(403);
 expect((await f.propose('unbound',undefined,bodyCredentials.agent)).status).toBe(403);
 expect((await f.propose('forged',{...f.value,member:'alice'})).status).toBe(400);
 expect((await f.propose('missing',{...f.value,box:'missing'})).status).toBe(403);
 f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'alice')).run();f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'bob')).run();f.db.update(s.boxes).set({owner:'bob'}).run();expect((await f.propose('other-owner')).status).toBe(403);
 f.db.update(s.conversations).set({member:null}).run();f.db.update(s.jobs).set({member:null}).run();expect((await f.propose('public')).status).toBe(403);
});
it.each(['deny','settings','owner','revoked','lending','name','tamper']as const)('withholds machine changes for %s before decision',async change=>{
 const f=await fixture();expect((await f.propose()).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
 if(change==='settings')f.db.update(s.boxes).set({reportOnly:true}).run();
 if(change==='owner')f.db.update(s.boxes).set({owner:'bob'}).run();
 if(change==='revoked')f.db.update(s.boxes).set({revokedAt:new Date(f.clock.now()).toISOString()}).run();
 if(change==='lending')f.db.insert(s.memberAgents).values({member:'alice',agent:'mark'}).run();
 if(change==='name')f.db.insert(s.boxes).values({id:'other',name:'Workshop',owner:'alice',sameMachineAsLoom:false,hostsAny:false,reportOnly:true,alwaysOn:false,enrolledAt:new Date(f.clock.now()).toISOString()}).run();
 if(change==='tamper')f.db.update(s.approvals).set({changeSummary:'Different change'}).run();
 const before=f.read(),response=await f.answer(card.id,change==='deny'?'deny':'allow');expect(response.status).toBe(change==='deny'?200:change==='lending'?400:change==='revoked'||change==='tamper'?403:409);
 expect(f.read()).toEqual(before);expect(f.db.select().from(s.approvals).get()?.state).toBe(change==='deny'?'denied':'pending');
});
it('ignores changing worker facts when comparing owner settings, while retaining them on Allow',async()=>{
 const f=await fixture();await f.propose();const card=f.db.select().from(s.approvals).get()!;f.db.insert(s.boxFacts).values({box:'box',fact:'arch:amd64',fromOwner:false}).run();
 expect((await f.answer(card.id)).status).toBe(200);expect(f.db.select().from(s.boxFacts).all()).toEqual(expect.arrayContaining([expect.objectContaining({fact:'arch:amd64',fromOwner:false}),expect.objectContaining({fact:'gpu:5090',fromOwner:true})]));
});
it('rolls back proposal and Allow with receipts and notifies capacity only outside a committed transaction',async()=>{
 const f=await fixture(),observed:boolean[]=[];const changed=vi.spyOn(f.root.services.tempo,'capacityChanged').mockImplementation(()=>{observed.push(f.db.$client.inTransaction);});
 f.db.$client.exec("CREATE TEMP TRIGGER fail_box_proposal BEFORE INSERT ON operation_results WHEN NEW.id IN ('failed-proposal','failed-answer') BEGIN SELECT RAISE(ABORT,'fixture'); END");
 const before=f.read();expect((await f.propose('failed-proposal')).status).toBe(503);expect(f.db.select().from(s.approvals).all()).toEqual([]);expect(f.read()).toEqual(before);expect(observed).toEqual([]);
 await f.propose();const card=f.db.select().from(s.approvals).get()!;expect((await f.answer(card.id,'allow','failed-answer')).status).toBe(503);expect(f.read()).toEqual(before);expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');expect(observed).toEqual([]);
 // An unrelated committed write cannot publish a rolled-back approval effect.
 f.root.writes.run(()=>f.db.update(s.boxes).set({lastSeenAt:new Date(f.clock.now()).toISOString()}).run());expect(observed).toEqual([]);
 expect((await f.answer(card.id)).status).toBe(200);expect(observed).toEqual([false]);expect((await f.answer(card.id)).status).toBe(200);expect(observed).toEqual([false]);changed.mockRestore();
});

it('lets a household owner propose for another member machine using that owner lending rules',async()=>{
 const f=await fixture();f.db.update(s.boxes).set({owner:'bob'}).run();f.db.insert(s.memberAgents).values({member:'bob',agent:'mark'}).run();
 const value={...f.value,agents:[{agent:'art',lent:true},{agent:'mark',lent:false}]};
 expect((await f.propose('household-owner',value)).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
 expect(card.changeSummary).toContain('Before: Box: runs jobs');expect(card.changeSummary).toContain('After: Workshop: runs jobs, always on');expect(card.changeSummary).not.toContain('reportOnly');
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read().box).toMatchObject({owner:'bob',name:'Workshop'});expect(f.read().agents).toMatchObject([{agent:'art',lent:true},{agent:'mark',lent:false}]);
});
