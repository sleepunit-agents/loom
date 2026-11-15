import {afterEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw,credentialHash as hash} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const stop of clean.splice(0).reverse())await stop();});
const change='github:acme/app#1',head='a'.repeat(40),target={kind:'merge' as const,target:change+'@'+head};
const request={...target,what:'Merge the pump',why:'Ready',ask:'Merge?',ifYes:'Agent merges exact head',ifNo:'Wait'};
async function fixture(){
 const f=await bodyFixture(clean),at=new Date(f.clock.now()).toISOString(),owner='o'.repeat(64);
 f.db.insert(s.members).values({id:'pat',role:'owner',joinedAt:at}).run();f.db.insert(s.tokens).values({fingerprint:hash(owner),label:'Fixture owner',kind:'owner',member:'pat',createdAt:at}).run();
 f.db.insert(s.changes).values({id:change,repository:'acme/app',number:1,title:'Pump',body:'',url:'',state:'open',draft:false,authorLogin:'art',agent:'art',project:'pond',branch:'work',headCommit:head,baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you',openedAt:at,updatedAt:at}).run();
 const call=(name:string,input:unknown,id:string=randomUUID(),token=raw.body)=>f.root.http.request('/api/approvals/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input,id})});
 const ask=async(id:string=randomUUID())=>{const response=await call('request',request,id);expect(response.status).toBe(200);return (await response.json()).value.id as string;};
 const snapshot=()=>({cards:f.db.select().from(s.approvals).all(),record:f.db.select().from(s.approvalRecord).all(),notices:f.db.select().from(s.approvalNotices).all(),receipts:f.db.select().from(s.operationResults).all()});
 return {...f,owner,call,ask,snapshot};
}
it('requests through the actual mounted HTTP body proof with server-derived provenance and one receipt',async()=>{
 const f=await fixture();for(const token of [raw.member,raw.agent,raw.runner])expect((await f.call('request',request,'denied-'+token[0],token)).status).toBe(403);
 for(const claim of [{agent:'mark'},{actingFor:'pat'},{member:'bob'},{project:'other'},{conversation:'forged'},{askedFrom:'forged'},{job:'other'}])expect((await f.call('request',{...request,...claim})).status).toBe(400);
 const id=await f.ask('same');expect(await f.ask('same')).toBe(id);
 expect(f.db.select().from(s.approvals).all()).toEqual([expect.objectContaining({id,agent:'art',actingFor:'alice',member:'alice',project:'pond',conversation:f.thread.conversation,askedFrom:f.thread.conversation,state:'pending'})]);
 expect(f.db.select().from(s.inbox).all().filter(row=>row.source==='approval')).toEqual([expect.objectContaining({to:'pat',waitsOnId:id,member:'alice'})]);
 expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request']);
 const cookie=await f.root.http.request('/api/approvals/request',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+raw.memberCookie},body:JSON.stringify({input:request,id:'cookie'})});expect(cookie.status).toBe(403);
});
it('reads current named-person grants without treating visibility, unknown context or owner words as authority',async()=>{
 const f=await fixture(),rules=f.root.services.approvalRules;
 rules.set({kind:'merge',scope:'project:pond',tier:'do'},'pat');expect((await (await f.call('rule',target)).json()).value).toEqual({tier:'ask',scope:null,person:null});
 rules.set({kind:'merge',scope:'project:pond',person:'alice',tier:'tell'},'pat');expect((await (await f.call('rule',target)).json()).value).toEqual({tier:'tell',scope:'project:pond',person:'alice'});
 f.root.writes.run(()=>f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'pat')).run());expect((await (await f.call('rule',target)).json()).value.tier).toBe('ask');
 f.root.writes.run(()=>f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'pat')).run());
 f.root.writes.run(()=>{f.db.update(s.jobs).set({member:null}).run();f.db.update(s.conversations).set({member:null}).where(eq(s.conversations.id,f.thread.conversation)).run();});
 expect((await (await f.call('rule',target)).json()).value.tier).toBe('ask');const id=await f.ask();expect(f.root.services.approvals.get(id)).toMatchObject({actingFor:'unknown',member:null});
 expect(f.db.select().from(s.approvalNotices).all()).toEqual([]);
});
it('spends one exact allowance without forge effects, records refused uses, and withdraws only its conversation cards',async()=>{
 const f=await fixture(),id=await f.ask();
 expect((await f.call('answer',{id,answer:'allow'},randomUUID(),f.owner)).status).toBe(200);
 expect((await (await f.call('use',{id,...target,kind:'command'},'wrong')).json()).value).toEqual({id,used:false});
 expect((await (await f.call('use',{id,...target},'use')).json()).value).toEqual({id,used:true});expect((await (await f.call('use',{id,...target},'use')).json()).value).toEqual({id,used:true});
 expect((await (await f.call('use',{id,...target},'second')).json()).value).toEqual({id,used:false});
 expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request','allow','refused-use','use','refused-use']);expect(f.db.select().from(s.changes).get()?.state).toBe('open');
 const next=await f.ask();expect((await f.call('withdraw',{id:next},'withdraw')).status).toBe(200);expect((await f.call('withdraw',{id:next},'withdraw')).status).toBe(200);expect(f.root.services.approvals.get(next).state).toBe('withdrawn');
 f.db.update(s.approvals).set({conversation:null}).where(eq(s.approvals.id,next)).run();expect((await f.call('withdraw',{id:next},'withdraw')).status).toBe(403);
});
it('rechecks exact head, labels, current body and conversation bindings before fresh and cached results',async()=>{
 const f=await fixture(),id=await f.ask('request');const before=f.snapshot();
 f.root.writes.run(()=>f.db.update(s.changes).set({headCommit:'b'.repeat(40)}).run());expect((await f.call('request',request,'request')).status).toBe(403);expect((await f.call('rule',target)).status).toBe(409);expect((await f.call('use',{id,...target})).status).toBe(403);expect(f.snapshot()).toEqual(before);
 f.root.writes.run(()=>f.db.update(s.changes).set({headCommit:head,project:'other'}).run());expect((await f.call('request',request,'request')).status).toBe(403);
 f.root.writes.run(()=>f.db.update(s.changes).set({project:'pond',agent:'mark'}).run());expect((await f.call('request',request,'request')).status).toBe(403);
 f.root.writes.run(()=>f.db.update(s.changes).set({agent:'art'}).run());
 const other=f.root.services.comms!.threads.open({member:'alice',agent:'art',project:'pond',title:'Other'});
 f.root.writes.run(()=>{f.db.update(s.conversations).set({job:null}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.conversations).set({job:'job'}).where(eq(s.conversations.id,other.conversation)).run();f.db.update(s.jobs).set({conversation:other.conversation}).where(eq(s.jobs.id,'job')).run();});
 expect((await f.call('request',request,'request')).status).toBe(409);expect((await f.call('withdraw',{id})).status).toBe(403);
 f.root.writes.run(()=>f.db.delete(s.memberAgents).run());expect((await f.call('request',request,'new')).status).toBe(403);
});
it('has no partial approval, question, audit or receipt if transaction persistence fails',async()=>{
 const f=await fixture(),before=f.snapshot(),inbox=f.db.select().from(s.inbox).all();
 f.db.$client.exec("CREATE TRIGGER fail_work_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 expect((await f.call('request',request,'broken')).status).toBe(503);expect(f.snapshot()).toEqual(before);expect(f.db.select().from(s.inbox).all()).toEqual(inbox);
});

it.each(['stopped','revoked','box'] as const)('denies fresh and cached Work requests after body %s',async mutation=>{
 const f=await fixture();await f.ask('request');const before=f.snapshot();
 f.root.writes.run(()=>{if(mutation==='stopped')f.db.update(s.jobs).set({state:'done'}).run();else if(mutation==='box')f.db.update(s.boxes).set({revokedAt:new Date(f.clock.now()).toISOString()}).run();else f.db.update(s.tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(s.tokens.fingerprint,hash(raw.body))).run();});
 expect([401,403]).toContain((await f.call('request',request,'request')).status);expect([401,403]).toContain((await f.call('request',request,'new')).status);expect(f.snapshot()).toEqual(before);
});

it('keeps operation-backed proposals with typed producers and never executes a supplied handler',async()=>{
 const f=await fixture(),before=f.snapshot();
 for(const kind of ['setting','dangerous'] as const)expect((await f.call('request',{...request,kind,target:'tempo:person:alice',operation:'tempo.settings',changeSummary:'forged',details:'{}'})).status).toBe(400);
 expect((await f.call('request',{...request,operation:'tempo.settings'})).status).toBe(400);expect(f.snapshot()).toEqual(before);
 const response=await f.root.http.request('/api/tempo/proposeSettings',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.body},body:JSON.stringify({input:{who:{kind:'person',id:'alice'},patch:{settleSeconds:60}},id:'prepared'})});
 expect(response.status).toBe(200);const id=(await response.json()).value.id;
 expect(f.root.services.approvals.get(id)).toMatchObject({kind:'setting',operation:'tempo.settings',state:'pending',actingFor:'alice',conversation:f.thread.conversation});expect(f.db.select().from(s.tempoSettings).all()).toEqual([]);
 expect((await (await f.call('use',{id,kind:'setting',target:'tempo:person:alice'})).json()).value.used).toBe(false);
 expect((await f.call('answer',{id,answer:'allow'},randomUUID(),f.owner)).status).toBe(200);expect(f.root.services.approvals.get(id).state).toBe('used');expect(f.db.select().from(s.tempoSettings).get()).toMatchObject({who:'alice',settleSeconds:60});
});
it('reads all four rule kinds without creating requests or running any effect',async()=>{
 const f=await fixture();for(const kind of ['merge','command','setting','dangerous'] as const){f.root.services.approvalRules.set({kind,scope:'*',person:'alice',tier:'do'},'pat');const input={kind,target:kind==='merge'?target.target:'fixture:target'};expect((await (await f.call('rule',input)).json()).value).toEqual({tier:'do',scope:'*',person:'alice'});}
 expect(f.db.select().from(s.approvals).all()).toEqual([]);expect(f.db.select().from(s.approvalRecord).all()).toEqual([]);expect(f.db.select().from(s.tempoSettings).all()).toEqual([]);expect(f.db.select().from(s.changes).get()?.state).toBe('open');
});
