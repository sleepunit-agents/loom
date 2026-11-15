import Database from 'better-sqlite3';
import { afterEach,expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { generateX25519Identity } from 'age-encryption';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import * as s from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { wordsKey } from './pieces/comms/crypto.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),raw={body:'b'.repeat(64),member:'m'.repeat(64),agent:'a'.repeat(64),runner:'r'.repeat(64)};
async function fixture(){
 const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(Date.parse('2026-11-14T18:00:00Z')),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(s.members).values({id:'alice',role:'member',joinedAt:now()}).run();db.insert(s.agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(s.memberAgents).values({member:'alice',agent:'art'}).run();
 db.insert(s.members).values({id:'bob',role:'member',joinedAt:now()}).run();db.insert(s.agents).values({id:'mark',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(s.projects).values([{id:'pond',name:'Pond'},{id:'other',name:'Other'}]).run();db.insert(s.projectMembers).values({project:'pond',member:'alice'}).run();db.insert(s.projectAgents).values({project:'pond',agent:'art'}).run();
 db.insert(s.boxes).values({id:'box',name:'Box',owner:'alice',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
 let gate:(()=>Promise<void>)|undefined;const key=wordsKey(await generateX25519Identity());
 const root=sharedRoot({db,clock,originAllowed:()=>true,commsKey:{...key,async seal(words){await gate?.();return key.seal(words);}},reportError:()=>{}});clean.push(()=>root.close());
 const thread=root.services.comms!.threads.open({member:'alice',agent:'art',project:'pond',title:'Private'});
 db.insert(s.jobs).values({id:'job',agent:'art',box:'box',member:'alice',project:'pond',conversation:thread.conversation,title:'Body',state:'running',brief:'',model:'REQUESTED MODEL',startedByKind:'member',startedBy:'alice',houseRepository:'fixture',houseFile:'HOUSE.md',houseBranch:'next',queuedAt:now()}).run();db.update(s.conversations).set({job:'job'}).where(eq(s.conversations.id,thread.conversation)).run();
 db.insert(s.tokens).values([{fingerprint:hash(raw.body),label:'Body',kind:'agent',agent:'art',job:'job',createdAt:now()},{fingerprint:hash(raw.agent),label:'Agent',kind:'agent',agent:'art',createdAt:now()},{fingerprint:hash(raw.member),label:'Owner',kind:'owner',member:'alice',createdAt:now()},{fingerprint:hash(raw.runner),label:'Runner',kind:'runner',box:'box',createdAt:now()}]).run();
 const call=(name:string,input:unknown,id:string,token=raw.body)=>root.http.request('/api/conversation/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input,id})});
 return {db,clock,root,thread,call,gate:(fn:()=>Promise<void>)=>{gate=fn;}};
}
it('records actual body turns and encrypted digest questions through the mounted HTTP boundary',async()=>{
 const f=await fixture();const turn={kind:'reply',model:'ACTUAL MODEL',outcome:'answered',latencyMs:12};
 for(const credential of [raw.member,raw.agent,raw.runner])expect((await f.call('turn',turn,'denied-'+credential[0],credential)).status).toBe(403);
 expect((await f.call('turn',{...turn,conversation:f.thread.conversation},'forged')).status).toBe(400);expect(f.db.select().from(s.operationResults).all()).toEqual([]);
 expect((await f.call('turn',turn,'turn')).status).toBe(200);expect((await f.call('turn',turn,'turn')).status).toBe(200);
 expect(f.db.select().from(s.turns).all()).toMatchObject([{conversation:f.thread.conversation,seq:1,fromKind:'agent',fromId:'art',run:'job',model:'ACTUAL MODEL',latencyMs:12}]);
 const input={summary:'Picked a pump',items:[{kind:'task',text:'t-fixture'}],question:{to:'alice',answers:'yes-no',words:'PRIVATE QUESTION',ifYes:'PRIVATE YES',ifNo:'PRIVATE NO'}};
 expect((await f.call('digest',input,'digest')).status).toBe(200);expect((await f.call('digest',input,'digest')).status).toBe(200);expect(f.db.select().from(s.digests).all()).toMatchObject([{run:'job',revision:1,summary:'Picked a pump'}]);
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
it('refuses member-private non-Comms questions before plaintext storage and keeps private fingerprints keyed',async()=>{
 const f=await fixture();f.root.writes.run(()=>f.db.update(s.conversations).set({venue:'wake'}).where(eq(s.conversations.id,f.thread.conversation)).run());
 const input={summary:'Work',question:{to:'alice',answers:'words',words:'PRIVATE WAKE QUESTION'}};
 expect((await f.call('digest',input,'unsupported')).status).toBe(403);expect(f.db.select().from(s.inbox).all()).toEqual([]);expect(f.db.select().from(s.operationResults).all()).toEqual([]);
 f.root.writes.run(()=>f.db.update(s.conversations).set({venue:'loom'}).where(eq(s.conversations.id,f.thread.conversation)).run());
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
