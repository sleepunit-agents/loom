import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as s from './core/data/schema.js';
import {bodyFixture,bodyCredentials as raw,credentialHash} from '../test/fixtures/conversation-body.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 const f=await bodyFixture(clean);
 expect((await f.call('digest',{summary:'Work',question:{to:'alice',answers:'yes-no',words:'Continue?'}},'question')).status).toBe(200);
 const item=f.db.select().from(s.digests).get()!.inboxItem!;
 const volume=(id:string,token=raw.body)=>f.root.http.request('/api/inbox/volume',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input:{item,volume:'mute'},id})});
 return {...f,item,volume};
}
it('permits the same waiting body to carry out its current member mailbox preference',async()=>{
 const f=await fixture();
 expect((await f.volume('running')).status).toBe(200);
 f.root.writes.run(()=>f.db.update(s.jobs).set({state:'waiting'}).where(eq(s.jobs.id,'job')).run());
 expect((await f.volume('waiting')).status).toBe(200);
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,f.item)).get()?.volume).toBe('mute');
});
it.each(['project-agent','member-agent','project-member','cv-job','job-member'] as const)('refuses delegated controls and replay after %s binding withdrawal',async change=>{
 const f=await fixture();expect((await f.volume('saved')).status).toBe(200);
 f.root.writes.run(()=>{
  if(change==='project-agent')f.db.delete(s.projectAgents).run();
  if(change==='member-agent')f.db.delete(s.memberAgents).run();
  if(change==='project-member')f.db.delete(s.projectMembers).run();
  if(change==='cv-job')f.db.update(s.conversations).set({job:null}).run();
  if(change==='job-member')f.db.update(s.jobs).set({member:'bob'}).run();
 });
 expect((await f.volume('saved')).status).toBe(403);
 expect((await f.volume('new')).status).toBe(403);
});
it.each(['starting','queued','done','failed','stopped','lost'] as const)('refuses %s bodies',async state=>{
 const f=await fixture();f.root.writes.run(()=>f.db.update(s.jobs).set({state}).run());
 expect([401,403]).toContain((await f.volume('phase')).status);
});
it('keeps ordinary agent and runner credentials out while preserving member direct controls',async()=>{
 const f=await fixture();
 for(const token of [raw.agent,raw.runner])expect((await f.volume('ordinary-'+token[0],token)).status).toBe(403);
 // Alice herself retains her ordinary direct mailbox authority.
 expect((await f.volume('member-direct',raw.member)).status).toBe(200);
});
it.each([false,true])('proposes settings with actual context provenance (public=%s)',async publicContext=>{
 const f=await fixture();
 f.root.writes.run(()=>{
  f.db.insert(s.members).values({id:'owner',role:'owner',joinedAt:new Date(f.clock.now()).toISOString()}).run();
  f.db.update(s.jobs).set({state:'waiting',...(publicContext?{member:null}:{})}).run();
  if(publicContext)f.db.update(s.conversations).set({member:null,venue:'wake'}).run();
 });
 const response=await f.root.http.request('/api/tempo/proposeSettings',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{who:{kind:'agent',id:'art'},patch:{settleSeconds:60}},id:'proposal'})});
 expect(response.status).toBe(200);
 expect(f.db.select().from(s.approvals).get()).toMatchObject({agent:'art',actingFor:publicContext?'unknown':'alice',member:publicContext?null:'alice',conversation:f.thread.conversation,askedFrom:f.thread.conversation,state:'pending'});
});

it('isolates identical settings receipt IDs between two valid bodies of the same agent',async()=>{
 const f=await fixture(),at=new Date(f.clock.now()).toISOString();
 f.root.writes.run(()=>{
  f.db.insert(s.members).values({id:'owner',role:'owner',joinedAt:at}).run();
  f.db.insert(s.memberAgents).values({member:'bob',agent:'art'}).run();
  f.db.insert(s.projectMembers).values({member:'bob',project:'pond'}).run();
 });
 const other=f.root.services.comms!.threads.open({member:'bob',agent:'art',project:'pond',title:'Bob'});
 const job=f.db.select().from(s.jobs).get()!,otherToken='z'.repeat(64);
 f.root.writes.run(()=>{
  f.db.insert(s.jobs).values({...job,id:'job2',member:'bob',conversation:other.conversation}).run();
  f.db.update(s.conversations).set({job:'job2'}).where(eq(s.conversations.id,other.conversation)).run();
  f.db.insert(s.tokens).values({fingerprint:credentialHash(otherToken),label:'Other body',kind:'agent',agent:'art',job:'job2',createdAt:at}).run();
 });
 const propose=(token:string,id:string)=>f.root.http.request('/api/tempo/proposeSettings',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input:{who:{kind:'agent',id:'art'},patch:{settleSeconds:60}},id})});
 const first=await propose(raw.body,'same');expect(first.status).toBe(200);const saved=await first.json();
 expect((await propose(otherToken,'same')).status).toBe(409);
 const second=await propose(otherToken,'fresh');expect(second.status).toBe(200);expect(await second.json()).not.toEqual(saved);
 expect(await(await propose(raw.body,'same')).json()).toEqual(saved);
 expect(f.db.select().from(s.approvals).all()).toEqual(expect.arrayContaining([expect.objectContaining({actingFor:'alice',member:'alice',conversation:f.thread.conversation}),expect.objectContaining({actingFor:'bob',member:'bob',conversation:other.conversation})]));
});
