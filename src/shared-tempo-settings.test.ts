import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, memberAgents, agents, boxes, jobs, conversations, tokens, approvals, inbox, projects } from './core/data/schema.js';
import { dataAuthentication } from './core/data/authentication.js';
import { Operations } from './core/operations/index.js';
import { sharedRoot } from './shared-root.js';
const closes:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
const ownerToken='tempo-owner-answer-'.repeat(4),otherToken='tempo-other-answer-'.repeat(4);
const body='body-credential-'.repeat(4),unbound='unbound-agent-'.repeat(4),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:now()},{id:'other',role:'member',joinedAt:now()}]).run();
 db.insert(agents).values(['art','mark'].map(id=>({id,about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
 db.insert(boxes).values({id:'box',name:'Box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
 db.insert(projects).values({id:'pond',name:'Pond'}).run();
 db.insert(memberAgents).values({member:'owner',agent:'art'}).run();
 const errors:unknown[]=[];const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:e=>errors.push(e)});
 const conversation=root.services.conversations.open({agent:'art',venue:'loom',place:'chat',member:'owner',project:'pond',label:'Tempo settings'});
 db.insert(jobs).values({id:'body',box:'box',agent:'art',conversation:conversation.id,member:'owner',title:'Chat',state:'running',brief:'',model:'model',startedByKind:'agent',startedBy:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',queuedAt:now()}).run();
 db.update(conversations).set({job:'body'}).where(eq(conversations.id,conversation.id)).run();
 db.insert(tokens).values([{fingerprint:hash(body),label:'Body',kind:'agent',agent:'art',job:'body',createdAt:now()},
  {fingerprint:hash(unbound),label:'Agent',kind:'agent',agent:'art',createdAt:now()},
  {fingerprint:hash(ownerToken),label:'Owner answer',kind:'owner',member:'owner',createdAt:now()},
  {fingerprint:hash(otherToken),label:'Other answer',kind:'owner',member:'other',createdAt:now()}]).run();
 closes.push(()=>{client.close();},()=>root.close());
 const call=async(input:unknown={who:{kind:'person',id:'owner'},patch:{settleSeconds:60}},id='settings',token=body)=>root.http.request('http://loom/api/tempo/proposeSettings',{
  method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input,id})});
 const answer=(id:string,allow=true,receipt='answer',token=ownerToken)=>root.http.request('http://loom/api/tempo/answerSettings',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input:{id,allow},id:receipt})});
 return {db,client,clock,root,conversation,call,answer,errors};
}
it('binds the actual chat body, files a before/after card, and applies only on the owner answer',async()=>{
 const f=fixture();const first=await f.call();expect(first.status).toBe(200);const result=await first.json();
 const card=f.db.select().from(approvals).get()!;
 expect(result).toEqual({ok:true,value:{id:card.id}});
 expect(card).toMatchObject({agent:'art',askedFrom:f.conversation.id,conversation:f.conversation.id,actingFor:'owner',member:'owner',project:'pond',kind:'setting',operation:'tempo.settings',state:'pending'});
 expect(card.changeSummary).toContain('settle 5 → 60 seconds');
 expect(f.root.services.tempo.volume.timings({kind:'person',id:'owner'}).settleSeconds).toBe(5);
 expect(f.db.select().from(inbox).all()).toMatchObject([{toKind:'person',to:'owner',conversation:f.conversation.id,project:'pond',source:'approval',waitsOnId:card.id}]);
 expect(await (await f.call()).json()).toEqual(result);expect(f.db.select().from(approvals).all()).toHaveLength(1);
 expect(await (await f.answer(card.id)).json()).toEqual({ok:true,value:{saved:true}});
 expect(f.root.services.tempo.volume.timings({kind:'person',id:'owner'}).settleSeconds).toBe(60);
 expect(f.db.select().from(approvals).get()?.state).toBe('used');expect(f.errors).toEqual([]);
});
it('refuses unbound, stale, mismatched and replayed body authority and never accepts a supplied conversation',async()=>{
 const f=fixture();expect((await f.call(undefined,'unbound',unbound)).status).toBe(403);
 expect((await f.call({who:{kind:'person',id:'other'},patch:{settleSeconds:60}},'other')).status).toBe(403);
 expect((await f.call({who:{kind:'agent',id:'art'},patch:{settleSeconds:60},conversation:f.conversation.id},'spoof')).status).toBe(400);
 expect((await f.call()).status).toBe(200);
 f.db.update(conversations).set({job:null}).where(eq(conversations.id,f.conversation.id)).run();
 expect((await f.call()).status).toBe(403);
 f.db.update(conversations).set({job:'body',agent:'mark'}).where(eq(conversations.id,f.conversation.id)).run();
 expect((await f.call()).status).toBe(403);
 f.db.update(conversations).set({agent:'art'}).where(eq(conversations.id,f.conversation.id)).run();
 f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'body')).run();
 expect((await f.call()).status).toBe(401);
 f.db.update(jobs).set({state:'running',agent:'mark'}).where(eq(jobs.id,'body')).run();
 expect((await f.call(undefined,'mismatch')).status).toBe(401);
 expect(f.db.select().from(approvals).all()).toHaveLength(1);
});
it('denial leaves timings untouched and failed proposal receipts leave neither cards nor questions',async()=>{
 const f=fixture();f.client.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
 expect((await f.call()).status).toBe(503);expect(f.db.select().from(approvals).all()).toEqual([]);expect(f.db.select().from(inbox).all()).toEqual([]);
 f.client.exec('DROP TRIGGER fail_receipt');expect((await f.call()).status).toBe(200);
 const card=f.db.select().from(approvals).get()!;f.root.writes.run(()=>f.root.services.approvals.deny(card.id,'owner'));
 expect(f.root.services.tempo.volume.timings({kind:'person',id:'owner'}).settleSeconds).toBe(5);
});

it('withdraws captured authentication if the token is rebound to a different body',()=>{
 const f=fixture(),authenticate=dataAuthentication(f.db,()=>f.clock.now());
 const auth=authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+body}}))!;
 expect(auth.job).toBe('body');expect(auth.valid()).toBe(true);
 f.db.update(tokens).set({job:null}).where(eq(tokens.fingerprint,hash(body))).run();
 expect(auth.valid()).toBe(false);
 expect(authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+body}}))?.job).toBeUndefined();
});

it('keeps concurrent async body requests in their own authenticated conversations',async()=>{
 const f=fixture(),now=()=>new Date(f.clock.now()).toISOString();
 const second=f.root.services.conversations.open({agent:'art',venue:'loom',place:'second-chat',member:'other',label:'Second chat'});
 f.db.insert(jobs).values({id:'body2',box:'box',agent:'art',conversation:second.id,member:'other',title:'Second',state:'running',brief:'',model:'model',startedByKind:'agent',startedBy:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',queuedAt:now()}).run();
 f.db.update(conversations).set({job:'body2'}).where(eq(conversations.id,second.id)).run();
 const credential2='second-body-'.repeat(4);
 f.db.insert(tokens).values({fingerprint:hash(credential2),label:'Second body',kind:'agent',agent:'art',job:'body2',createdAt:now()}).run();
 let enterA!:()=>void,enterB!:()=>void,releaseA!:()=>void,releaseB!:()=>void;
 const readyA=new Promise<void>(resolve=>{enterA=resolve;}),readyB=new Promise<void>(resolve=>{enterB=resolve;});
 const gateA=new Promise<void>(resolve=>{releaseA=resolve;}),gateB=new Promise<void>(resolve=>{releaseB=resolve;});
 const original=Operations.prototype.callAsync;
 const spy=vi.spyOn(Operations.prototype,'callAsync').mockImplementation(async function(this:Operations,...args:Parameters<Operations['callAsync']>){
  if(args[2]==='tempo.proposeSettings'){
   if(args[4]==='a'){enterA();await gateA;}else if(args[4]==='b'){enterB();await gateB;}
  }
  return original.apply(this,args);
 });
 let a:Promise<Response>|undefined,b:Promise<Response>|undefined;
 try {
  a=f.call({who:{kind:'agent',id:'art'},patch:{settleSeconds:60}},'a');await readyA;
  b=f.call({who:{kind:'agent',id:'art'},patch:{settleSeconds:120}},'b',credential2);await readyB;
  releaseB();expect((await b).status).toBe(200);
  releaseA();expect((await a).status).toBe(200);
  const cards=f.db.select().from(approvals).all();
  expect(cards).toHaveLength(2);
  expect(cards.find(c=>c.changeSummary?.includes('→ 60 seconds'))).toMatchObject({conversation:f.conversation.id,askedFrom:f.conversation.id,member:'owner',actingFor:'owner',project:'pond'});
  expect(cards.find(c=>c.changeSummary?.includes('→ 120 seconds'))).toMatchObject({conversation:second.id,askedFrom:second.id,member:'other',actingFor:'other',project:null});
 } finally {releaseA();releaseB();await Promise.all([a,b]);spy.mockRestore();}
});
it('refuses revocation during async dispatch for both a fresh proposal and receipt replay',async()=>{
 for(const replay of [false,true]){
  const f=fixture();if(replay)expect((await f.call()).status).toBe(200);
  const beforeCards=f.db.select().from(approvals).all().length,beforeMail=f.db.select().from(inbox).all().length;
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const original=Operations.prototype.callAsync;
  const spy=vi.spyOn(Operations.prototype,'callAsync').mockImplementation(async function(this:Operations,...args:Parameters<Operations['callAsync']>){entered();await gate;return original.apply(this,args);});
  let pending:Promise<Response>|undefined;
  try {
   pending=f.call();await ready;
   f.db.update(tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(tokens.fingerprint,hash(body))).run();
   release();expect((await pending).status).toBe(403);
   expect(f.db.select().from(approvals).all()).toHaveLength(beforeCards);expect(f.db.select().from(inbox).all()).toHaveLength(beforeMail);
  } finally {release();await pending;spy.mockRestore();}
 }
});

it('answers through the actual owner door and rechecks role, credentials and card operation on replay',async()=>{
 const f=fixture();expect((await f.call()).status).toBe(200);const card=f.db.select().from(approvals).get()!;
 for(const token of [body,unbound,otherToken])expect((await f.answer(card.id,true,'denied-'+token[0],token)).status).toBe(403);
 f.db.insert(approvals).values({...card,id:'different-operation',operation:'other.operation'}).run();
 expect((await f.answer('different-operation')).status).toBe(403);expect((await f.answer('missing')).status).toBe(403);
 expect(f.root.services.tempo.volume.timings({kind:'person',id:'owner'}).settleSeconds).toBe(5);
 expect((await f.answer(card.id)).status).toBe(200);const after=f.db.select().from(inbox).all();
 expect((await f.answer(card.id)).status).toBe(200);expect(f.db.select().from(inbox).all()).toEqual(after);
 expect(f.db.select().from(approvals).where(eq(approvals.id,card.id)).get()).toMatchObject({state:'used',decidedBy:'owner'});
 f.root.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());
 expect((await f.answer(card.id)).status).toBe(403);
 f.root.writes.run(()=>f.db.update(members).set({role:'owner'}).where(eq(members.id,'owner')).run());
 f.db.update(tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(tokens.fingerprint,hash(ownerToken))).run();
 expect((await f.answer(card.id)).status).toBe(401);
});
it('denies through HTTP without applying timings, and rolls back an Allow whose receipt cannot commit',async()=>{
 const f=fixture();expect((await f.call()).status).toBe(200);const card=f.db.select().from(approvals).get()!;
 f.client.exec("CREATE TRIGGER reject_answer_receipt BEFORE INSERT ON operation_results WHEN NEW.operation='tempo.answerSettings' BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
 expect((await f.answer(card.id)).status).toBe(503);
 expect(f.db.select().from(approvals).get()?.state).toBe('pending');
 expect(f.root.services.tempo.volume.timings({kind:'person',id:'owner'}).settleSeconds).toBe(5);
 f.client.exec('DROP TRIGGER reject_answer_receipt');
 expect((await f.answer(card.id,false)).status).toBe(200);
 expect(f.db.select().from(approvals).get()).toMatchObject({state:'denied',decidedBy:'owner'});
 expect(f.root.services.tempo.volume.timings({kind:'person',id:'owner'}).settleSeconds).toBe(5);
});
