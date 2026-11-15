import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 const f=await bodyFixture(clean);f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();
 const value={agent:'art',houseRepository:'https://example.invalid/house.git',houseFile:'Housefile',houseBranch:'next',nestedContainers:true,gpu:true,boxes:['box'],ports:[{address:'127.0.0.1',port:8080}]};
 const post=(path:string,input:unknown,id:string,token=bodyCredentials.body)=>f.root.http.request('/api/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input,id})});
 const propose=(id='proposal',input:unknown=value,token=bodyCredentials.body)=>post('runtime/proposeAgentRunSettings',input,id,token);
 const answer=(id:string,choice='allow',receipt='answer')=>post('approvals/answer',{id,answer:choice},receipt,bodyCredentials.member);
 const read=()=>({settings:f.db.select().from(s.agentRunSettings).get(),boxes:f.db.select().from(s.agentBoxes).all(),ports:f.db.select().from(s.agentHousePorts).all()});
 return{...f,value,post,propose,answer,read};
}
it('files complete trusted before/after for an unconfigured agent and applies only on Allow',async()=>{
 const f=await fixture(),before=f.read();expect((await f.propose()).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
 expect(card).toMatchObject({operation:'runtime.agentRunSettings',project:'pond',member:'alice',actingFor:'alice',conversation:f.thread.conversation,askedFrom:f.thread.conversation,state:'pending'});expect(JSON.parse(card.details)).toEqual({agent:'art',before:null,after:f.value});expect(f.read()).toEqual(before);
 expect((await f.propose()).status).toBe(200);expect(f.db.select().from(s.approvals).all()).toHaveLength(1);expect((await f.answer(card.id)).status).toBe(200);
 expect(f.read()).toMatchObject({settings:{houseRepository:f.value.houseRepository,nestedContainers:true,gpu:true},boxes:[{agent:'art',box:'box',position:0}],ports:[{address:'127.0.0.1',port:8080}]});
 f.db.update(s.agentRunSettings).set({houseBranch:'later'}).run();expect((await f.answer(card.id)).status).toBe(200);expect(f.read().settings?.houseBranch).toBe('later');
});
it('keeps direct body edits forbidden and rejects unbound or forged provenance and credential-bearing repositories',async()=>{
 const f=await fixture();expect((await f.post('runtime/agentRunSettingsSet',f.value,'direct')).status).toBe(403);
 expect((await f.propose('unbound',undefined,bodyCredentials.agent)).status).toBe(403);
 for(const input of [{...f.value,member:'alice'},{...f.value,repositorySecret:'private'},{...f.value,houseRepository:'https://user:secret@example.invalid/repo'},{...f.value,houseFile:'../escape'}])expect((await f.propose('invalid',input)).status).toBe(400);
 expect((await f.propose('other-agent',{...f.value,agent:'mark'})).status).toBe(403);f.db.update(s.conversations).set({job:null}).run();expect((await f.propose('stale-body')).status).toBe(403);
});
it.each(['deny','settings','ownership','revoked','lent','tamper']as const)('refuses run setting effects for %s before decision',async change=>{
 const f=await fixture();if(change==='lent'){f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'alice')).run();f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'bob')).run();f.db.update(s.boxes).set({owner:'bob'}).run();f.db.insert(s.boxAgents).values({box:'box',agent:'art',lent:true}).run();}
 expect((await f.propose()).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
 if(change==='settings')f.db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'other',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
 if(change==='ownership')f.db.delete(s.memberAgents).where(eq(s.memberAgents.member,'alice')).run();
 if(change==='revoked')f.db.update(s.boxes).set({revokedAt:new Date(f.clock.now()).toISOString()}).run();
 if(change==='lent')f.db.delete(s.boxAgents).run();
 if(change==='tamper')f.db.update(s.approvals).set({target:'runtime:agent-run-settings:mark'}).run();
 let response:Response;
 if(change==='lent'){const token=f.root.writes.run(()=>f.root.services.signin.issue({kind:'owner',member:'bob',label:'Deciding owner fixture'}).token).value;response=await f.post('approvals/answer',{id:card.id,answer:'allow'},'answer',token);}
 else response=await f.answer(card.id,change==='deny'?'deny':'allow');
 expect(response.status).toBe(change==='deny'?200:change==='settings'?409:change==='revoked'||change==='lent'?400:403);expect(f.read().boxes).toEqual([]);expect(f.read().ports).toEqual([]);expect(f.db.select().from(s.approvals).get()?.state).toBe(change==='deny'?'denied':'pending');
});
it('preserves the repository secret reference and excludes it from the proposed edit',async()=>{
 const f=await fixture();f.db.insert(s.secrets).values({name:'fixture-repository-secret',description:'Metadata only',changedAt:new Date(f.clock.now()).toISOString(),changedBy:'alice'}).run();
 const {boxes,ports,...settings}=f.value;f.db.insert(s.agentRunSettings).values({...settings,repositorySecret:'fixture-repository-secret'}).run();
 expect((await f.propose('changed',{...f.value,houseBranch:'new'})).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;expect(card.details).not.toContain('fixture-repository-secret');expect((await f.answer(card.id)).status).toBe(200);expect(f.read().settings).toMatchObject({houseBranch:'new',repositorySecret:'fixture-repository-secret'});
});
it('rolls back settings and receipts without a false post-commit capacity notification',async()=>{
 const f=await fixture(),observed:boolean[]=[];const changed=vi.spyOn(f.root.services.tempo,'capacityChanged').mockImplementation(()=>{observed.push(f.db.$client.inTransaction);});
 f.db.$client.exec("CREATE TEMP TRIGGER fail_run_proposal BEFORE INSERT ON operation_results WHEN NEW.id IN ('failed-proposal','failed-answer') BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect((await f.propose('failed-proposal')).status).toBe(503);expect(f.db.select().from(s.approvals).all()).toEqual([]);
 await f.propose();const card=f.db.select().from(s.approvals).get()!;expect((await f.answer(card.id,'allow','failed-answer')).status).toBe(503);expect(f.read().settings).toBeUndefined();
 f.root.writes.run(()=>f.db.update(s.boxes).set({lastSeenAt:new Date(f.clock.now()).toISOString()}).run());expect(observed).toEqual([]);
 expect((await f.answer(card.id)).status).toBe(200);expect(observed).toEqual([false]);expect((await f.answer(card.id)).status).toBe(200);expect(observed).toEqual([false]);changed.mockRestore();
});

it('applies an approved persisted request after its body ends and its binding clears',async()=>{
 const f=await fixture();await f.propose();const card=f.db.select().from(s.approvals).get()!;
 f.root.writes.run(()=>{f.db.update(s.jobs).set({state:'done'}).run();f.db.update(s.conversations).set({job:null}).run();});
 expect((await f.answer(card.id)).status).toBe(200);expect(f.read().settings).toMatchObject({gpu:true,nestedContainers:true});expect(f.db.select().from(s.approvals).get()?.state).toBe('used');
});
it('rejects changes to an already configured branch, machine order and ports',async()=>{
 for(const change of ['branch','boxes','ports']as const){
  const f=await fixture();const {boxes,ports,...settings}=f.value;f.db.insert(s.agentRunSettings).values({...settings,gpu:false}).run();f.db.insert(s.agentBoxes).values({agent:'art',box:'box',position:0}).run();f.db.insert(s.agentHousePorts).values({agent:'art',address:'127.0.0.1',port:8080}).run();
  expect((await f.propose()).status).toBe(200);const card=f.db.select().from(s.approvals).get()!;
  if(change==='branch')f.db.update(s.agentRunSettings).set({houseBranch:'other'}).run();if(change==='boxes')f.db.delete(s.agentBoxes).run();if(change==='ports')f.db.update(s.agentHousePorts).set({port:9090}).run();
  const before=f.read();expect((await f.answer(card.id)).status).toBe(409);expect(f.read()).toEqual(before);
 }
});
it('rejects public or withdrawn body assignment without filing cards',async()=>{
 const f=await fixture();f.db.delete(s.memberAgents).where(eq(s.memberAgents.member,'alice')).run();expect((await f.propose('withdrawn')).status).toBe(403);
 f.db.insert(s.memberAgents).values({member:'alice',agent:'art'}).run();f.db.update(s.conversations).set({member:null,project:null}).run();f.db.update(s.jobs).set({member:null,project:null}).run();expect((await f.propose('public')).status).toBe(403);expect(f.db.select().from(s.approvals).all()).toEqual([]);
});
it.each([{what:'Keep everything'},{changeSummary:'Another change'},{actingFor:'bob'},{member:null},{details:'{}'}])('rejects inconsistent run card %j',async extra=>{
 const f=await fixture();await f.propose();const card=f.db.select().from(s.approvals).get()!;f.db.update(s.approvals).set(extra).run();const before=f.read();expect((await f.answer(card.id)).status).not.toBe(200);expect(f.read()).toEqual(before);expect(f.db.select().from(s.approvals).get()?.state).toBe('pending');
});
it('refuses to create an impossible typed approval from invalid existing configuration',async()=>{
 const f=await fixture();const {boxes,ports,...settings}=f.value;f.db.insert(s.agentRunSettings).values({...settings,houseFile:'../obsolete'}).run();expect((await f.propose()).status).toBe(409);expect(f.db.select().from(s.approvals).all()).toEqual([]);
});
