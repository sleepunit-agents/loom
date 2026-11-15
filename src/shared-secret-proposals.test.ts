import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(options:Parameters<typeof bodyFixture>[1]={}){
 const f=await bodyFixture(clean,options);
 f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();
 const post=(path:string,input:unknown,id:string,token=bodyCredentials.body)=>f.root.http.request('/api/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input,id})});
 const propose=(id='proposal',input:unknown={action:'default',answer:'never'},token=bodyCredentials.body)=>post('secrets/proposeSettings',input,id,token);
 const answer=(id:string,choice='allow',receipt='answer')=>post('approvals/answer',{id,answer:choice},receipt,bodyCredentials.member);
 const read=()=>({default:f.db.select().from(s.household).get()?.secretsDefault??'ask',rules:f.db.select().from(s.secretRules).all(),assignments:f.db.select().from(s.secretRuleAgents).all()});
 return {...f,post,propose,answer,read};
}
it('proposes the exact default in private owner chat and changes it only on Allow',async()=>{
 const f=await fixture(),before=f.read();expect((await f.propose()).status).toBe(200);
 const card=f.db.select().from(s.approvals).get()!;
 expect(card).toMatchObject({kind:'setting',operation:'secrets.settings',target:'secrets:default',agent:'art',member:'alice',actingFor:'alice',conversation:f.thread.conversation,askedFrom:f.thread.conversation,state:'pending'});
 expect(JSON.parse(card.details)).toEqual({before:{action:'default',answer:'ask'},after:{action:'default',answer:'never'}});
 expect(card.changeSummary).toContain('Before:');expect(card.changeSummary).toContain('After:');expect(f.read()).toEqual(before);
 expect((await f.propose()).status).toBe(200);expect(f.db.select().from(s.approvals).all()).toHaveLength(1);
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read().default).toBe('never');expect(f.db.select().from(s.approvals).get()?.state).toBe('used');
 expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request','allow','use']);
 f.db.update(s.household).set({secretsDefault:'auto'}).run();expect((await f.answer(card.id)).status).toBe(200);expect(f.read().default).toBe('auto');
});
it('retains the direct owner door and rejects unbound, forged, public and nonowner proposals',async()=>{
 const f=await fixture();expect((await f.post('secrets/command',{action:'default',answer:'auto'},'direct')).status).toBe(403);
 expect((await f.propose('unbound',undefined,bodyCredentials.agent)).status).toBe(403);
 expect((await f.propose('member',undefined,bodyCredentials.member)).status).toBe(403);
 expect((await f.propose('forged',{action:'default',answer:'auto',member:'alice'})).status).toBe(400);
 f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'alice')).run();expect((await f.propose('not-owner')).status).toBe(403);
 f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();f.db.update(s.conversations).set({member:null}).run();f.db.update(s.jobs).set({member:null}).run();expect((await f.propose('public')).status).toBe(403);
 expect(f.read().default).toBe('ask');expect(f.db.select().from(s.approvals).all()).toEqual([]);
});
it.each(['deny','default','owner','assignment','project','conversation','summary','details','target']as const)('withholds changes for %s before decision',async change=>{
 const f=await fixture();await f.propose();const card=f.db.select().from(s.approvals).get()!;
 if(change==='default')f.db.insert(s.household).values({secretsDefault:'auto'}).onConflictDoUpdate({target:s.household.singleton,set:{secretsDefault:'auto'}}).run();
 if(change==='owner')f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'alice')).run();
 if(change==='assignment')f.db.delete(s.memberAgents).run();
 if(change==='project')f.db.delete(s.projectAgents).run();
 if(change==='conversation')f.db.update(s.conversations).set({member:'bob'}).run();
 if(change==='summary')f.db.update(s.approvals).set({changeSummary:'Not this change'}).run();
 if(change==='details')f.db.update(s.approvals).set({details:JSON.stringify({...JSON.parse(card.details),after:{action:'default',answer:'auto'}})}).run();
 if(change==='target')f.db.update(s.approvals).set({target:'secrets:rule:other'}).run();
 const before=f.read(),response=await f.answer(card.id,change==='deny'?'deny':'allow');
 expect(response.status).toBe(change==='deny'?200:change==='owner'||change==='assignment'||change==='project'||change==='conversation'?403:409);
 expect(f.read()).toEqual(before);expect(f.db.select().from(s.approvals).get()?.state).toBe(change==='deny'?'denied':'pending');
});
it('creates a canonical standing rule without storing any Secret value or request words on the card',async()=>{
 const f=await fixture();f.db.insert(s.secrets).values({name:'example-token',description:'Metadata only',changedAt:new Date(f.clock.now()).toISOString(),changedBy:'alice'}).run();
 const input={action:'rule',secret:'example-token',answer:'auto',minutes:17,agents:[{agent:'mark',when:'on_request'},{agent:'art',when:'at_start'},{agent:'mark',when:'on_request'}]};
 expect((await f.propose('rule',input)).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
 expect(JSON.parse(card.details).before).toEqual({action:'rule',secret:'example-token',rule:null});
 expect(JSON.parse(card.details).after.agents).toEqual([{agent:'art',when:'at_start'},{agent:'mark',when:'on_request'}]);
 expect(f.read().rules).toEqual([]);expect((await f.answer(card.id)).status).toBe(200);
 expect(f.read().rules).toEqual([{secret:'example-token',answer:'auto',minutes:17}]);expect(f.read().assignments).toHaveLength(2);
 expect((await f.propose('unchanged',input)).status).toBe(400);
 expect((await f.propose('missing-secret',{...input,secret:'missing'})).status).toBe(400);
 expect((await f.propose('missing-agent',{...input,agents:[{agent:'missing',when:'on_request'}]})).status).toBe(400);
});
it('refuses a stale standing rule on Allow',async()=>{
 const f=await fixture();f.db.insert(s.secrets).values({name:'example-token',description:'',changedAt:new Date(f.clock.now()).toISOString(),changedBy:'alice'}).run();
 await f.propose('rule',{action:'rule',secret:'example-token',answer:'never',minutes:10,agents:[]});
 const card=f.db.select().from(s.approvals).get()!;f.root.services.secrets.requests.setRule({secret:'example-token',answer:'ask',minutes:30,agents:[]});
 expect((await f.answer(card.id)).status).toBe(409);expect(f.read().rules[0]?.answer).toBe('ask');
});
it('rolls back both prepared cards and approved metadata if receipt commit fails',async()=>{
 const f=await fixture();f.db.$client.exec("CREATE TEMP TRIGGER fail_secret_proposal BEFORE INSERT ON operation_results WHEN NEW.id IN ('failed-proposal','failed-answer') BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect((await f.propose('failed-proposal')).status).toBe(503);expect(f.db.select().from(s.approvals).all()).toEqual([]);
 await f.propose();const card=f.db.select().from(s.approvals).get()!;
 expect((await f.answer(card.id,'allow','failed-answer')).status).toBe(503);expect(f.read().default).toBe('ask');expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read().default).toBe('never');
});
it('keeps the prepared card usable after the proposing body ends without retaining body authority',async()=>{
 const f=await fixture();await f.propose();const card=f.db.select().from(s.approvals).get()!;
 f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run();f.db.update(s.conversations).set({job:null}).run();
 expect((await f.propose('ended-body')).status).toBe(401);expect((await f.answer(card.id)).status).toBe(200);expect(f.read().default).toBe('never');
});
it.each(['secret','agent']as const)('rechecks the referenced %s at Allow and rolls back its decision',async missing=>{
 const f=await fixture();f.db.insert(s.secrets).values({name:'example-token',description:'Private metadata',changedAt:new Date(f.clock.now()).toISOString(),changedBy:'alice'}).run();
 await f.propose('rule',{action:'rule',secret:'example-token',answer:'auto',minutes:10,agents:[{agent:'mark',when:'on_request'}]});
 const card=f.db.select().from(s.approvals).get()!;
 if(missing==='secret')f.db.delete(s.secrets).where(eq(s.secrets.name,'example-token')).run();
 else f.db.delete(s.agents).where(eq(s.agents.id,'mark')).run();
 expect((await f.answer(card.id)).status).toBe(400);expect(f.read().rules).toEqual([]);expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request']);
});
it('does not let a nonowner decide a valid owner proposal',async()=>{
 const f=await fixture();await f.propose();const card=f.db.select().from(s.approvals).get()!;
 f.db.insert(s.tokens).values({fingerprint:(await import('../test/fixtures/conversation-body.js')).credentialHash('d'.repeat(64)),label:'Bob',kind:'owner',member:'bob',createdAt:new Date(f.clock.now()).toISOString()}).run();
 expect((await f.post('approvals/answer',{id:card.id,answer:'allow'},'bob-answer','d'.repeat(64))).status).toBe(403);expect(f.read().default).toBe('ask');expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');
});
it('binds a proposal receipt to the current body job rather than the agent identity alone',async()=>{
 const f=await fixture();await f.propose();const job=f.db.select().from(s.jobs).where(eq(s.jobs.id,'job')).get()!;
 f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run();
 f.db.insert(s.jobs).values({...job,id:'second-job'}).run();f.db.update(s.conversations).set({job:'second-job'}).run();
 const token='e'.repeat(64);const {credentialHash}=await import('../test/fixtures/conversation-body.js');
 f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Second body',kind:'agent',agent:'art',job:'second-job',createdAt:new Date(f.clock.now()).toISOString()}).run();
 expect((await f.propose('proposal',undefined,token)).status).toBe(409);expect(f.db.select().from(s.approvals).all()).toHaveLength(1);
 expect((await f.propose('new-receipt',undefined,token)).status).toBe(200);expect(f.db.select().from(s.approvals).all()).toHaveLength(2);
});
it('excludes unrelated private Secret descriptions from the prepared card and receipts',async()=>{
 const marker='PRIVATE unrelated explanation 9b23',privateValue='PRIVATE holder value 8fe6';let reads=0;
 const f=await fixture({secretInputs:{source:{async read(){reads++;return Buffer.from(privateValue);}}}});
 f.db.insert(s.secrets).values({name:'example-token',description:marker,changedAt:new Date(f.clock.now()).toISOString(),changedBy:'alice'}).run();
 await f.propose('rule',{action:'rule',secret:'example-token',answer:'never',minutes:10,agents:[]});
 const card=f.db.select().from(s.approvals).get()!;await f.answer(card.id);
 const records=[f.db.select().from(s.approvals).all(),f.db.select().from(s.approvalRecord).all(),f.db.select().from(s.operationResults).all(),f.db.select().from(s.inbox).all()];
 expect(JSON.stringify(records)).not.toContain(marker);expect(JSON.stringify(records)).not.toContain(privateValue);expect(JSON.stringify(records)).not.toContain(bodyCredentials.body);expect(reads).toBe(0);
 expect((await f.propose('value-injection',{action:'default',answer:'auto',value:privateValue})).status).toBe(400);
 expect((await f.post('secrets/command',{action:'default',answer:'auto'},'owner-direct',bodyCredentials.member)).status).toBe(200);expect(f.read().default).toBe('auto');
});
it('rechecks the proposing owner when another current owner answers',async()=>{
 const f=await fixture();f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'bob')).run();
 const {credentialHash}=await import('../test/fixtures/conversation-body.js'),token='f'.repeat(64);
 f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Bob owner',kind:'owner',member:'bob',createdAt:new Date(f.clock.now()).toISOString()}).run();
 await f.propose();const card=f.db.select().from(s.approvals).get()!;
 f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'alice')).run();
 expect((await f.post('approvals/answer',{id:card.id,answer:'allow'},'other-owner-answer',token)).status).toBe(403);
 expect(f.read().default).toBe('ask');expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');
 f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();
 expect((await f.post('approvals/answer',{id:card.id,answer:'allow'},'other-owner-retry',token)).status).toBe(200);
 expect(f.read().default).toBe('never');
 expect((await f.post('approvals/answer',{id:card.id,answer:'allow'},'different-answer-receipt',token)).status).toBe(409);
});
