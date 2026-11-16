import { afterEach,expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
import { bodyFixture,bodyCredentials as raw,credentialHash as hash } from '../test/fixtures/conversation-body.js';
const fixture=()=>bodyFixture(clean);
it('records actual body turns and encrypted digest questions through the mounted HTTP boundary',async()=>{
 const f=await fixture();const turn={kind:'reply',model:'ACTUAL MODEL',outcome:'answered',latencyMs:12};
 for(const credential of [raw.member,raw.agent,raw.runner])expect((await f.call('turn',turn,'denied-'+credential[0],credential)).status).toBe(403);
 expect((await f.call('turn',{...turn,conversation:f.thread.conversation},'forged')).status).toBe(400);expect(f.db.select().from(s.operationResults).all()).toEqual([]);
 expect(await (await f.call('turn',turn,'turn')).json()).toEqual({ok:true,value:{saved:true,conversation:f.thread.conversation,seq:1}});expect((await f.call('turn',turn,'turn')).status).toBe(200);
 expect(f.db.select().from(s.turns).all()).toMatchObject([{conversation:f.thread.conversation,seq:1,fromKind:'agent',fromId:'art',run:'job',model:'ACTUAL MODEL',latencyMs:12}]);
 const input={summary:'Picked a pump',items:[{kind:'task',text:'t-fixture'}],question:{to:'alice',answers:'yes-no',words:'PRIVATE QUESTION',ifYes:'PRIVATE YES',ifNo:'PRIVATE NO'}};
 const response=await (await f.call('digest',input,'digest')).json();const dg=f.db.select().from(s.digests).get()!;expect(response).toEqual({ok:true,value:{saved:true,digest:dg.id,revision:1,item:dg.inboxItem}});expect((await f.call('digest',input,'digest')).status).toBe(200);expect(f.db.select().from(s.turns).all()[1]).toMatchObject({fromKind:'agent',fromId:'art',run:'job'});expect(f.db.select().from(s.digests).all()).toMatchObject([{run:'job',revision:1,summary:'Picked a pump'}]);
 const old=f.db.select().from(s.digests).get()!.inboxItem!;
 expect((await f.call('digest',{...input,summary:'Revised'},'rewrite')).status).toBe(200);expect(f.db.select().from(s.digests).get()?.revision).toBe(2);expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,old)).get()?.state).toBe('resolved');
 expect(JSON.stringify(f.db.select().from(s.inbox).all())).not.toContain('PRIVATE');expect(JSON.stringify(f.db.select().from(s.operationResults).all())).not.toContain('PRIVATE');expect((await f.root.services.comms!.words(f.thread.id,1))).toContain('PRIVATE QUESTION');
 expect((await f.call('turn',{kind:'note',logTail:'PRIVATE'},'logs')).status).toBe(400);
});
it.each(['job','conversation','ownership','owner-ownership','project-member','project-agent','cv-agent','cv-member','cv-project','token','box'])('withdraws a prepared private digest after current %s authority changes',async change=>{
 const f=await fixture();if(change==='owner-ownership')f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'alice')).run();let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{began=r;});f.gate(()=>{began();return new Promise<void>(r=>{release=r;});});
 const pending=f.call('digest',{summary:'Work',question:{to:'alice',answers:'words',words:'PRIVATE YIELD'}},'pending');await started;
 f.root.writes.run(()=>{if(change==='job')f.db.update(s.jobs).set({state:'done'}).run();if(change==='conversation')f.db.update(s.conversations).set({job:null}).run();if(change==='ownership'||change==='owner-ownership')f.db.delete(s.memberAgents).run();if(change==='project-member')f.db.delete(s.projectMembers).run();if(change==='project-agent')f.db.delete(s.projectAgents).run();if(change==='cv-agent')f.db.update(s.conversations).set({agent:'mark'}).run();if(change==='cv-member')f.db.update(s.conversations).set({member:'bob'}).run();if(change==='cv-project')f.db.update(s.conversations).set({project:'other'}).run();if(change==='token')f.db.update(s.tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(s.tokens.fingerprint,hash(raw.body))).run();if(change==='box')f.db.update(s.boxes).set({revokedAt:new Date(f.clock.now()).toISOString()}).run();});release();
 expect([401,403]).toContain((await pending).status);expect(f.db.select().from(s.digests).all()).toEqual([]);expect(f.db.select().from(s.messages).all()).toEqual([]);expect(f.db.select().from(s.operationResults).all()).toEqual([]);
});
it('binds retry fingerprints to the authenticated run and never guesses a requested model',async()=>{
 const f=await fixture();expect((await f.call('turn',{kind:'note'},'same')).status).toBe(200);expect(f.db.select().from(s.turns).get()?.model).toBeNull();
 const thread=f.root.services.comms!.threads.open({member:'alice',agent:'art',project:'pond',title:'Other'}),job=f.db.select().from(s.jobs).get()!;
 f.root.writes.run(()=>{f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run();f.db.insert(s.jobs).values({...job,id:'job2',conversation:thread.conversation}).run();f.db.update(s.conversations).set({job:'job2'}).where(eq(s.conversations.id,thread.conversation)).run();f.db.update(s.tokens).set({job:'job2'}).where(eq(s.tokens.fingerprint,hash(raw.body))).run();});
 expect((await f.call('turn',{kind:'note'},'same')).status).toBe(409);expect(f.db.select().from(s.turns).all()).toHaveLength(1);
 expect((await f.call('turn',{kind:'note'},'new')).status).toBe(200);expect(f.db.select().from(s.turns).all()).toMatchObject([{run:'job',model:null},{run:'job2',model:null}]);
});
it('encrypts member-private non-Comms questions and keeps private fingerprints keyed',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.update(s.conversations).set({venue:'wake'}).where(eq(s.conversations.id,f.thread.conversation)).run());
 const input={summary:'Work',question:{to:'alice',answers:'words',words:'PRIVATE WAKE QUESTION'}};
 expect((await f.call('digest',input,'private')).status).toBe(200);expect(JSON.stringify(f.db.select().from(s.inbox).all())).not.toContain('PRIVATE WAKE QUESTION');
 expect((await f.call('digest',input,'private')).status).toBe(200);
 const receipt=f.db.select().from(s.operationResults).get()!;
 const canonical='{"question":{"answers":"words","to":"alice","words":"PRIVATE WAKE QUESTION"},"summary":"Work"}';
 for(const guess of [canonical,`body-conversation\0job\0${canonical}`])expect(receipt.inputHash).not.toBe(hash(guess));
 expect(receipt.inputHash).toBe(f.root.services.comms!.key.hash(`body-conversation\0job\0${canonical}`));
});
it('reports a memberless conversation through its assigned body without borrowing a private recipient',async()=>{
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null,venue:'wake'}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null}).where(eq(s.jobs.id,'job')).run();});
 expect((await f.call('turn',{kind:'note'},'public-turn')).status).toBe(200);expect((await f.call('digest',{summary:'Public scheduled work'},'public-digest')).status).toBe(200);
 expect(f.db.select().from(s.turns).get()).toMatchObject({conversation:f.thread.conversation,run:'job',fromId:'art'});expect(f.db.select().from(s.digests).get()).toMatchObject({run:'job',summary:'Public scheduled work',inboxItem:null});
});
it('keeps successive jobs in the same conversation on independent digest revisions',async()=>{
 const f=await fixture();const question={to:'alice',answers:'words',words:'PRIVATE RUN QUESTION'};
 expect((await f.call('digest',{summary:'First',question},'run1')).status).toBe(200);const first=f.db.select().from(s.digests).get()!,job=f.db.select().from(s.jobs).get()!;
 f.root.writes.run(()=>{f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run();f.db.insert(s.jobs).values({...job,id:'job2'}).run();f.db.update(s.conversations).set({job:'job2'}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.tokens).set({job:'job2'}).where(eq(s.tokens.fingerprint,hash(raw.body))).run();});
 expect((await f.call('digest',{summary:'Second',question},'run2')).status).toBe(200);expect(f.db.select().from(s.digests).all()).toMatchObject([{run:'job',revision:1,summary:'First'},{run:'job2',revision:1,summary:'Second'}]);
 expect((await f.call('digest',{summary:'Second revised'},'run2-rewrite')).status).toBe(200);expect(f.db.select().from(s.digests).all()).toMatchObject([{run:'job',revision:1,summary:'First'},{run:'job2',revision:2,summary:'Second revised'}]);
 expect(f.db.select().from(s.inbox).where(eq(s.inbox.id,first.inboxItem!)).get()?.state).toBe('waiting');expect(f.db.select().from(s.turns).all()).toMatchObject([{run:'job'},{run:'job2'}]);
});
it('records a public digest question as a wordless turn of the authenticated run',async()=>{
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set({member:null,venue:'wake'}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.jobs).set({member:null}).where(eq(s.jobs.id,'job')).run();});
 const response=await f.call('digest',{summary:'Project work',question:{to:'alice',answers:'yes-no',words:'Proceed with the public plan?'}},'public-question');expect(response.status).toBe(200);
 expect(f.db.select().from(s.turns).all()).toMatchObject([{conversation:f.thread.conversation,run:'job',kind:'note',fromKind:'agent',fromId:'art'}]);expect(f.db.select().from(s.conversationPeople).all()).toEqual([{conversation:f.thread.conversation,whoKind:'agent',who:'art'}]);
});
it.each([[false,'ended'],[true,'ended'],[false,'expired'],[true,'expired']] as const)('keeps fallback digest authority and replay gates (existing %s, %s)',async(existing,change)=>{
 const f=await fixture(),input={summary:'Fallback',ifAbsent:true};
 if(existing)expect((await f.call('digest',{summary:'Authored'},'authored')).status).toBe(200);
 for(const token of [raw.member,raw.agent,raw.runner])expect((await f.call('digest',input,'denied-'+token[0],token)).status).toBe(403);
 expect((await f.call('digest',input,'fallback')).status).toBe(200);
 const rows=f.db.select().from(s.digests).all();
 expect((await f.call('digest',input,'fallback')).status).toBe(200);expect(f.db.select().from(s.digests).all()).toEqual(rows);
 f.root.writes.run(()=>{if(change==='ended')f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run();else f.db.update(s.tokens).set({expiresAt:new Date(f.clock.now()).toISOString()}).where(eq(s.tokens.fingerprint,hash(raw.body))).run();});
 for(const id of ['fallback','fresh-after-end'])expect((await f.call('digest',input,id)).status).toBe(401);
 expect(f.db.select().from(s.digests).all()).toEqual(rows);
});
it('keeps a digest authored after fallback preparation without creating another question',async()=>{
 const f=await fixture(),service=f.root.services.comms!,conversation=f.thread.conversation;
 const fallback=await service.prepareDigest({conversation,run:'job',summary:'Fallback',ifAbsent:true});
 const authored=await service.digest({conversation,run:'job',summary:'Authored later',question:{to:'alice',answers:'words',words:'Keep this question'}});
 expect(fallback()).toEqual(authored);expect(f.db.select().from(s.digests).all()).toEqual([authored]);
 expect(f.db.select().from(s.inbox).all()).toHaveLength(1);
});
