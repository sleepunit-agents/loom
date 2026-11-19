import {testProgramPin} from './runtime/pinned-program.fixture.js';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProgramResult } from './runtime/house-program.js';
import { applyProgramResult } from './shared-program-result.js';
import { Conversations } from './core/conversations/index.js';
import { tempoQueryFields } from './core/tempo/queries.js';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, agents, memberAgents, tokens, inbox, changes, projects, projectMembers, agentModels, agentRunSettings, jobs, measuringSettings, timingDays, triggers, triggerLog, programFirings, conversations, boxes } from './core/data/schema.js';
import { mayReadProgramWork, type SharedTempoOptions } from './shared-tempo.js';
import { sharedRoot } from './shared-root.js';
const cleanup: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const credential='tempo-owner-credential-'.repeat(3), hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function fixture(tempo?: SharedTempoOptions, measuring=false, fields?:Parameters<typeof sharedRoot>[0]['fields']){
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:now()},{id:'sam',role:'member',joinedAt:now()}]).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(memberAgents).values({member:'owner',agent:'art'}).run();
 db.insert(agentModels).values({agent:'art',model:'model',position:0}).run();
 db.insert(agentRunSettings).values({agent:'art',houseRepository:testProgramPin.repository,houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
 db.insert(tokens).values({fingerprint:hash(credential),label:'Owner',kind:'owner',member:'owner',createdAt:now()}).run();
 if(measuring)db.insert(measuringSettings).values({singleton:1,on:true,sendOutside:false,keepDays:90}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,tempo,fields,reportError(error){throw error;}});
 cleanup.push(()=>{client.close();},()=>root.close());
 const call=(name:string,input:unknown,id:string)=>root.http.request('http://loom/api/'+name.replace('.','/'),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},body:JSON.stringify({input,id})});
 const trigger={id:'delivery',ownerKind:'household',sourceKind:'time',times:now(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Check pump',note:'Delivery'};
 const notice=async(auth=credential)=>{
  const response=await root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+auth},body:JSON.stringify({query:'{ settledInboxNotice { id count } }'})});
  const result=await response.json();expect(result.errors).toBeUndefined();return result.data.settledInboxNotice;
 };
 return {client,db,clock,now,root,call,trigger,notice};
}
it('real shared root fires once, settles then queues a job and withdraws command authority before replay',async()=>{
 const f=fixture();
 expect((await f.call('tempo.set',f.trigger,'set')).status).toBe(200);
 expect(f.db.select().from(inbox).all()).toMatchObject([{source:'trigger',words:'Check pump'}]);
 expect(f.db.select().from(jobs).all()).toEqual([]);
 f.clock.advance(4999);expect(f.db.select().from(jobs).all()).toEqual([]);
 f.clock.advance(1);expect(f.db.select().from(jobs).all()).toMatchObject([{agent:'art',state:'queued'}]);
 expect((await f.call('tempo.set',f.trigger,'set')).status).toBe(200);
 expect(f.db.select().from(inbox).all()).toHaveLength(1);
 f.root.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());
 expect((await f.call('tempo.set',f.trigger,'set')).status).toBe(403);
});
it('holds paused triggers, resumes through shared commands, then stops timers before root closes',async()=>{
 const f=fixture();
 expect((await f.call('tempo.pause',{agent:'art'},'pause')).status).toBe(200);
 expect((await f.call('tempo.set',f.trigger,'set')).status).toBe(200);
 f.clock.advance(10000);expect(f.db.select().from(inbox).all()).toEqual([]);
 expect((await f.call('tempo.resume',{agent:'art'},'resume')).status).toBe(200);
 expect(f.db.select().from(inbox).all()).toHaveLength(1);
 await f.root.close();
 const before=f.db.select().from(jobs).all();f.clock.advance(10000);
 expect(f.db.select().from(jobs).all()).toEqual(before);
});

it('publishes settled person notifications and rejects unknown operation targets while allowing the built-in sweep',async()=>{
 const f=fixture(),publish=vi.fn();
 // Exercise the actual default notification admission, including the post-settle publication.
 const stop=f.root.writes.observe(publish);
 expect((await f.call('tempo.set',{...f.trigger,toKind:'person',to:'owner'},'person')).status).toBe(200);
 // The real generated live hub receives the same committed/settled notification.
 const { DataLive }=await import('./core/data/live.js');
 const notified=vi.spyOn(DataLive.prototype,'changed');
 notified.mockClear();f.clock.advance(5000);expect(notified).toHaveBeenCalled();notified.mockRestore();stop();
 // An operation the program cannot run is refused when the trigger is set, in plain words, and nothing is stored.
 const unknown=await f.call('tempo.set',{...f.trigger,times:f.now(),id:'unknown',targetKind:'operation',target:'unknown'},'unknown');
 expect(unknown.status).toBe(400);expect(await unknown.json()).toMatchObject({ok:false,code:'invalid',message:'Unknown operation'});
 expect(f.root.services.tempo.triggers).toBeDefined();
 expect(f.client.prepare("SELECT state FROM triggers WHERE id='unknown'").get()).toBeUndefined();
 expect((await f.call('tempo.set',{...f.trigger,times:f.now(),id:'sweep',targetKind:'operation',target:'tempo.sweep'},'sweep')).status).toBe(200);
 expect(f.client.prepare("SELECT state FROM triggers WHERE id='sweep'").get()).toEqual({state:'fired'});
});

it('forwards durable Changes revisions and extra sweep contributors into the installed service',async()=>{
 const revision=vi.fn(()=> 'revision-1');
 const f=fixture({changeRevision:revision,contributors:[{name:'Extra',open:()=>[{id:'extra',words:'Extra work',openedAt:'2026-11-14T00:00:00Z'}]}]});
 const at=f.now();f.db.insert(changes).values({id:'pr',repository:'org/repo',number:1,title:'PR',body:'',url:'https://example.test/pr',state:'open',draft:false,authorLogin:'art',branch:'feature',headCommit:'abc',baseBranch:'next',checks:'running',review:'required',mergeable:'unknown',waitingOn:'ci',openedAt:at,updatedAt:at}).run();
 expect((await f.call('tempo.set',{...f.trigger,id:'watch-pr',sourceKind:'pull-request',times:null,watches:'change:pr'},'watch-pr')).status).toBe(200);
 expect(revision).toHaveBeenCalledWith('pr');
 expect(f.db.select().from(inbox).all()).toMatchObject([{source:'trigger',words:'Check pump'}]);
 const summaries=f.root.services.tempo.sweep.run({kind:'agent',id:'art'},'extra');
 expect(summaries).toMatchObject([{part:'Extra',count:1}]);
});

it('rolls a Tempo write back when the actual shared receipt insert fails',async()=>{
 const f=fixture();
 f.client.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
 expect((await f.call('tempo.set',f.trigger,'set')).status).toBe(503);
 expect(f.client.prepare('SELECT id FROM triggers').all()).toEqual([]);
 expect(f.db.select().from(inbox).all()).toEqual([]);
 f.clock.advance(5000);expect(f.db.select().from(jobs).all()).toEqual([]);
 f.client.exec('DROP TRIGGER reject_receipt');
 expect((await f.call('tempo.set',{...f.trigger,times:f.now()},'set')).status).toBe(200);
 expect(f.db.select().from(inbox).all()).toHaveLength(1);
});
it('exposes an observable word-free notice only after the person batch settles',async()=>{
 const f=fixture(),reader='other-notice-token-'.repeat(3);
 f.db.insert(tokens).values({fingerprint:hash(reader),label:'Other',kind:'owner',member:'sam',createdAt:f.now()}).run();
 const read=(auth=reader)=>f.notice(auth);
 expect(await read()).toBeNull();
 expect((await f.call('tempo.set',{...f.trigger,toKind:'person',to:'sam'},'other-person')).status).toBe(200);
 expect(await read()).toBeNull();f.clock.advance(4999);expect(await read()).toBeNull();f.clock.advance(1);
 expect(await read()).toMatchObject({id:expect.any(String),count:1});
 expect(await read(credential)).toBeNull();
 const notice=await read();expect(JSON.stringify(notice)).not.toContain('Check pump');
 f.root.services.tempo.committed();f.root.writes.run(()=>{});f.clock.advance(5000);expect(await read()).toEqual(notice);
 const item=f.db.select().from(inbox).get()!;
 f.root.writes.run(()=>f.db.update(inbox).set({state:'done'}).where(eq(inbox.id,item.id)).run());
 expect(await read()).toBeNull();
});

it('labels a person sweep for its ordinary recipient and preserves a trusted notifier',async()=>{
 const f=fixture(),sam='sam-sweep-token-'.repeat(3);
 f.db.insert(tokens).values({fingerprint:hash(sam),label:'Sam',kind:'owner',member:'sam',createdAt:f.now()}).run();
 const remove=f.root.services.tempo.sweep.register({name:'Fixture',open:who=>who.id==='sam'?[{id:'work',words:'Sweep work',openedAt:f.now()}]:[]});
 f.root.writes.run(()=>f.root.services.tempo.sweep.run({kind:'person',id:'sam'},'sweep-one'));remove();
 expect(f.db.select().from(inbox).get()).toMatchObject({member:'sam',to:'sam',toKind:'person'});
 f.clock.advance(5000);expect(await f.notice(sam)).toMatchObject({count:1});
 const notify=vi.fn(()=>true),g=fixture({notify});
 expect((await g.call('tempo.set',{...g.trigger,toKind:'person',to:'owner'},'custom-person')).status).toBe(200);
 g.clock.advance(4999);expect(notify).not.toHaveBeenCalled();g.clock.advance(1);
 const item=g.db.select().from(inbox).get()!;
 expect(notify).toHaveBeenCalledExactlyOnceWith('owner',[item.id]);
 g.root.services.tempo.capacityChanged();expect(notify).toHaveBeenCalledOnce();
});

it('withdraws a selected notice when recipient sharing changes during a sibling await',async()=>{
 const {GraphQLString}=await import('graphql/index.js');let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const f=fixture(undefined,false,{held:{type:GraphQLString,async resolve(){entered();await gate;return 'ready';}}}),sam='sam-frame-token-'.repeat(3);
 f.db.insert(tokens).values({fingerprint:hash(sam),label:'Sam',kind:'owner',member:'sam',createdAt:f.now()}).run();
 f.db.insert(projects).values({id:'pond',name:'Pond'}).run();f.db.insert(projectMembers).values({member:'sam',project:'pond'}).run();
 f.root.writes.run(()=>f.root.services.conversations.send({toKind:'person',to:'sam',source:'notice',fromKind:'agent',project:'pond',words:'PRIVATE PROJECT WORDS'}));
 f.clock.advance(5000);const selected=await f.notice(sam);expect(selected).toMatchObject({count:1});
 const pending=f.root.http.request('/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+sam},body:JSON.stringify({query:'{ settledInboxNotice { id count } held }'})});
 try{
  await ready;f.root.writes.run(()=>f.db.delete(projectMembers).run());release();
  const response=await pending,text=await response.text();expect(text).not.toContain(selected.id);
  if(response.status===200)expect(JSON.parse(text).data.settledInboxNotice).toBeNull();
  else expect([401,403,503]).toContain(response.status);
 }finally{release();await pending;}
});


it('loads configured repository instructions at firing through the actual shared command',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os'),{join}=await import('node:path');
 const repository=mkdtempSync(join(tmpdir(),'tempo-root-lane-'));
 try{
  mkdirSync(join(repository,'routines'));writeFileSync(join(repository,'routines/check.md'),'Old words');
  const f=fixture({repository});
  const trigger={...f.trigger,times:new Date(f.clock.now()+1000).toISOString(),instructions:null,file:'routines/check.md'};
  expect((await f.call('tempo.set',trigger,'file-backed')).status).toBe(200);
  expect(f.db.select().from(inbox).all()).toEqual([]);
  writeFileSync(join(repository,'routines/check.md'),'Read at firing');f.clock.advance(1000);
  expect(f.db.select().from(inbox).all()).toMatchObject([{source:'trigger',words:'Read at firing'}]);
  const unsafe={...trigger,id:'unsafe',times:new Date(f.clock.now()+1000).toISOString(),file:'missing'};
  expect((await f.call('tempo.set',unsafe,'missing-file')).status).toBe(200);f.clock.advance(1000);
  expect(f.client.prepare("SELECT state FROM triggers WHERE id='unsafe'").get()).toEqual({state:'failed'});
  expect(f.db.select().from(inbox).all()).toHaveLength(1);
 }finally{rmSync(repository,{recursive:true,force:true});}
});

it('records scheduled Tempo work by its fixed job name only while Measuring is on',async()=>{
 const f=fixture(undefined,true);
 await f.root.ready;
 expect((await f.call('tempo.set',f.trigger,'set')).status).toBe(200);
 f.clock.advance(5000);
 expect(f.db.select().from(timingDays).all()).toContainEqual(expect.objectContaining({kind:'job',name:'tempo.tick',count:1}));
 const g=fixture();
 expect((await g.call('tempo.set',g.trigger,'set')).status).toBe(200);
 g.clock.advance(5000);
 expect(g.db.select().from(timingDays).all()).toEqual([]);
});

it('retries an unconfirmed Run now with the same receipt rather than delivering duplicate work',async()=>{
 const {tempoActions}=await import('../web/src/pieces/tempo/commands.js');
 const f=fixture();expect((await f.call('tempo.set',{...f.trigger,times:'23:59',lifespan:'until-stopped'},'standing')).status).toBe(200);
 let lose=true;const ids:string[]=[];
 const actions=tempoActions(async(input,init)=>{
  ids.push(JSON.parse(String(init?.body)).id);const headers=new Headers(init?.headers);headers.set('authorization','Bearer '+credential);
  const response=await f.root.http.fetch(new Request(new URL(String(input),'http://loom'),{...init,headers}));
  if(lose){lose=false;throw new Error('Lost reply');}return response;
 });
 await expect(actions.runNow('delivery')).rejects.toThrow('Lost reply');expect(f.db.select().from(inbox).all()).toHaveLength(1);
 await actions.runNow('delivery');expect(f.db.select().from(inbox).all()).toHaveLength(1);expect(ids[1]).toBe(ids[0]);
 await actions.runNow('delivery');expect(f.db.select().from(inbox).all()).toHaveLength(2);expect(ids[2]).not.toBe(ids[1]);
});

// Whose work a firing is follows who set the trigger (policy.ts, "Scheduled work").
function scheduling(){
 const f=fixture(),raw={sam:'sam-tempo-token-'.repeat(3),art:'art-terminal-token-'.repeat(3),body:'art-body-for-sam-'.repeat(3)},at=f.now();
 f.db.insert(memberAgents).values({member:'sam',agent:'art'}).run();
 f.db.insert(boxes).values({id:'box',name:'box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:at}).run();
 // A body of art doing sam's private work, and art's own terminal session.
 f.db.insert(jobs).values({id:'sam-job',agent:'art',box:'box',member:'sam',title:'',brief:'',model:'model',state:'running',startedByKind:'agent',startedBy:'art',houseRepository:testProgramPin.repository,houseFile:'Housefile',houseBranch:'next',queuedAt:at}).run();
 f.db.insert(tokens).values([{fingerprint:hash(raw.sam),label:'Sam',kind:'owner',member:'sam',createdAt:at},{fingerprint:hash(raw.art),label:'Art',kind:'agent',agent:'art',createdAt:at},
  {fingerprint:hash(raw.body),label:'Body',kind:'agent',agent:'art',job:'sam-job',createdAt:at}]).run();
 const as=(credential:string)=>(name:string,input:unknown,id:string)=>f.root.http.request('http://loom/api/'+name.replace('.','/'),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},body:JSON.stringify({input,id})});
 const work={ownerKind:'agent',owner:'art',sourceKind:'time',lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'Look at the pond',note:'Pond'};
 // What one firing left: the trigger's recorded owner, and the member on its mail, its conversation and its job.
 const fired=(id:string)=>{
  const mail=f.db.select().from(inbox).all().filter(row=>row.source==='trigger'&&row.sourceId?.startsWith(id+':')),cv=mail[0]?.conversation?f.db.select().from(conversations).where(eq(conversations.id,mail[0].conversation)).get():undefined;
  const t=f.db.select().from(triggers).where(eq(triggers.id,id)).get()!;
  return {owner:[t.ownerKind,t.owner],mail:mail.map(row=>row.member),place:cv?.place,conversation:cv?.member,jobs:f.db.select().from(jobs).all().filter(job=>job.conversation&&job.conversation===cv?.id).map(job=>job.member)};
 };
 return {...f,raw,as,work,fired};
}
it('fires a trigger a member who is not a household owner set for an agent, or had their body set, as private work for that member',async()=>{
 const f=scheduling();
 // Sam names the agent as owner, as an agent's own trigger is written. It is recorded as sam's.
 expect((await f.as(f.raw.sam)('tempo.set',{...f.work,id:'by-sam',times:f.now()},'by-sam')).status).toBe(200);
 // Sam's body sets one for itself in sam's private work.
 expect((await f.as(f.raw.body)('tempo.set',{...f.work,id:'by-body',times:f.now()},'by-body')).status).toBe(200);
 f.clock.advance(5000);
 for(const id of ['by-sam','by-body'])expect([id,f.fired(id)]).toEqual([id,{owner:['member','sam'],mail:['sam'],place:id+':for:sam',conversation:'sam',jobs:['sam']}]);
 // Whom the work is for is stored with the trigger when it is set, apart from who set it.
 const worksFor=(id:string)=>f.db.select({member:triggers.member}).from(triggers).where(eq(triggers.id,id)).get()?.member;
 expect([worksFor('by-sam'),worksFor('by-body')]).toEqual(['sam','sam']);
 // A firing reads that, and not the owner: a trigger the agent is recorded as having set, for sam's work, is sam's private work.
 f.root.writes.run(()=>f.db.insert(triggers).values({id:'for-sam',ownerKind:'agent',owner:'art',member:'sam',sourceKind:'time',times:f.now(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'x',note:'F',enabled:true,state:'standing',nextDueAt:f.now(),createdAt:f.now(),changedAt:f.now()}).run());
 f.clock.advance(5000);expect(f.fired('for-sam')).toEqual({owner:['agent','art'],mail:['sam'],place:'for-sam:for:sam',conversation:'sam',jobs:['sam']});
 // Neither may schedule an operation for the agent, or reword a trigger that is the agent's own.
 expect((await f.as(f.raw.sam)('tempo.set',{...f.work,id:'sweep',times:f.now(),targetKind:'operation',target:'tempo.sweep',instructions:undefined},'sweep')).status).toBe(403);
 expect((await f.call('tempo.set',{...f.work,id:'own',times:new Date(f.clock.now()+3600000).toISOString()},'own')).status).toBe(200);
 for(const who of [f.raw.sam,f.raw.body])expect((await f.as(who)('tempo.edit',{id:'own',instructions:'Read every project and tell me'},'reword-'+who)).status).toBe(403);
 expect((await f.as(f.raw.art)('tempo.edit',{id:'own',instructions:'Look closer'},'reword-art')).status).toBe(200);
 // The member is judged when the trigger fires. Once sam has lost the agent the firing fails and starts nothing.
 expect((await f.as(f.raw.sam)('tempo.set',{...f.work,id:'later',times:new Date(f.clock.now()+60000).toISOString()},'later')).status).toBe(200);
 f.root.writes.run(()=>f.db.delete(memberAgents).where(eq(memberAgents.member,'sam')).run());f.clock.advance(60000);
 expect(f.fired('later')).toMatchObject({mail:[],jobs:[]});
 expect(f.db.select().from(triggerLog).where(eq(triggerLog.trigger,'later')).all().map(row=>row.event+' '+row.note).slice(-2)).toEqual([expect.stringMatching(/^failed /),'failure inbox: The member this was set for no longer has the agent, or is not in its project']);
 // Made a household owner, sam directs the whole agent: the same stored trigger fires as the agent's own.
 f.root.writes.run(()=>{f.db.insert(memberAgents).values({member:'sam',agent:'art'}).run();f.db.update(members).set({role:'owner'}).where(eq(members.id,'sam')).run();
  f.db.insert(triggers).values({id:'promoted',ownerKind:'member',owner:'sam',member:'sam',sourceKind:'time',times:f.now(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'art',instructions:'x',note:'P',enabled:true,state:'standing',nextDueAt:f.now(),createdAt:f.now(),changedAt:f.now()}).run();});
 f.clock.advance(5000);expect(f.fired('promoted')).toEqual({owner:['member','sam'],mail:[null],place:'promoted',conversation:null,jobs:[null]});
});
it('keeps a trigger an agent set for itself, and one an owner set, the whole agent\'s: twenty standing triggers fire as they always have',async()=>{
 const f=scheduling(),at=f.now();
 // Rows as a household has them today, written before this rule: the agent's own lanes (words, and the sweep), and the owner's.
 const stored=Array.from({length:20},(_,i)=>({id:'lane-'+i,ownerKind:'agent' as const,owner:'art',sourceKind:'time' as const,times:'09:00',lifespan:'until-stopped' as const,
  ...(i%5===4?{targetKind:'operation' as const,target:'tempo.sweep'}:{targetKind:'inbox' as const,instructions:'Lane '+i}),toKind:'agent' as const,to:'art',note:'Lane '+i,enabled:true,state:'standing' as const,nextDueAt:at,createdAt:at,changedAt:at}));
 f.root.writes.run(()=>f.db.insert(triggers).values([...stored,{...stored[0],id:'owners',ownerKind:'member' as const,owner:'owner'},{...stored[0],id:'households',ownerKind:'household' as const,owner:null}]).run());
 // Set through the door now: by the agent in a terminal session, and by an owner in the agent's name.
 expect((await f.as(f.raw.art)('tempo.set',{...f.work,id:'new-own',times:at},'new-own')).status).toBe(200);
 expect((await f.call('tempo.set',{...f.work,id:'new-owner',times:at},'new-owner')).status).toBe(200);
 // Neither is for a member, and a caller cannot say one is: who the work is for is never taken from the request.
 await f.call('tempo.set',{...f.work,id:'claimed',times:new Date(f.clock.now()+3600000).toISOString(),member:'sam'},'claimed');
 expect(f.db.select({id:triggers.id,member:triggers.member}).from(triggers).where(inArray(triggers.id,['new-own','new-owner','claimed'])).orderBy(triggers.id).all()).toEqual([{id:'claimed',member:null},{id:'new-own',member:null},{id:'new-owner',member:null}]);
 f.clock.advance(5000);
 for(const t of stored.filter(t=>t.targetKind==='inbox'))expect([t.id,f.fired(t.id)]).toEqual([t.id,{owner:['agent','art'],mail:[null],place:t.id,conversation:null,jobs:[null]}]);
 expect(f.fired('owners')).toEqual({owner:['member','owner'],mail:[null],place:'owners',conversation:null,jobs:[null]});
 expect(f.fired('households')).toEqual({owner:['household',null],mail:[null],place:'households',conversation:null,jobs:[null]});
 for(const id of ['new-own','new-owner'])expect([id,f.fired(id)]).toEqual([id,{owner:['agent','art'],mail:[null],place:id,conversation:null,jobs:[null]}]);
 // Every one fired, the sweeps included, and each standing lane stands for its next time.
 const log=f.db.select().from(triggerLog).all();
 for(const t of stored)expect([t.id,log.filter(row=>row.trigger===t.id).map(row=>row.event)]).toEqual([t.id,['fired']]);
 expect(f.db.select().from(triggers).all().filter(t=>t.id.startsWith('lane-')).map(t=>[t.state,t.enabled,t.ownerKind,t.owner])).toEqual(stored.map(()=>['standing',true,'agent','art']));
 // The agent still runs, rewords and restarts its own.
 for(const [name,input] of [['tempo.runNow',{id:'lane-0'}],['tempo.edit',{id:'lane-0',instructions:'Lane 0, again'}],['tempo.stop',{id:'lane-1'}],['tempo.start',{id:'lane-1'}]] as const)expect([name,(await f.as(f.raw.art)(name,input,name)).status]).toEqual([name,200]);
});

it('prepares a draft, supplies it to a later program and spends each local day once', async () => {
 const f = fixture();
 const program = { ...testProgramPin, name: 'planning', args: ['draft'], timeoutMs: 2000, secrets:{} };
 const producer = { ...f.trigger, id: 'prepare', ownerKind: 'agent', owner: 'art', times: '01:00', lifespan: 'until-stopped', program };
 const post = { ...producer, id: 'post', times: '01:05', program: { ...program, args: ['post'] }, readStateFrom: producer.id, programPeriod: 'day' };
 for (const trigger of [producer, post]) expect((await f.call('tempo.set', trigger, trigger.id)).status).toBe(200);
 f.clock.advance(3_600_000);
 const prepare = f.db.select().from(jobs).get()!;
 expect(prepare).toMatchObject({ startedByKind: 'program', startedBy: 'prepare', agent: 'art', brief: 'Check pump', conversation: expect.any(String) });
 f.db.transaction(() => {
   applyProgramResult(f.db, new Conversations(f.db, f.now), undefined, () => true, prepare,
     { version: 1, wake: false, state: { draft: 'today' } }, () => {});
   f.db.update(jobs).set({ state: 'done', endedAt: f.now() }).where(eq(jobs.id, prepare.id)).run();
 });
 const q = { id: producer.id };
 expect(tempoQueryFields(f.db, { kind: 'member', id: 'owner' }).tempoProgram.resolve(null,q)).toMatchObject({programState:{draft:'today'}});
 expect(tempoQueryFields(f.db, { kind: 'agent', id: 'art' }).tempoProgram.resolve(null,q)).toMatchObject({program});
 expect(tempoQueryFields(f.db, { kind: 'agent', id: 'art' }, () => false).tempoProgram.resolve(null,q)).toBeNull();
 expect(tempoQueryFields(f.db, { kind: 'member', id: 'sam' }).tempoProgram.resolve(null,q)).toBeNull();
 f.clock.advance(300_000);
 const row = f.db.select().from(programFirings).where(eq(programFirings.trigger, post.id)).get()!;
 expect(row).toMatchObject({ status: 'pending', program: { ...post.program, state: { draft: 'today' } } });
 expect(f.db.select().from(inbox).all()).toEqual([]);
 f.db.update(programFirings).set({ status: 'done' }).where(eq(programFirings.id, row.id)).run();
 f.db.update(jobs).set({ state: 'done', endedAt: f.now() }).where(eq(jobs.id, row.job)).run();
 expect((await f.call('tempo.runNow', { id: post.id }, 'second')).status).toBe(200);
 expect(f.db.select().from(programFirings).all()).toHaveLength(2);
 expect(f.db.select().from(triggerLog).all()).toContainEqual(expect.objectContaining({ trigger: post.id, event: 'skipped' }));
 f.clock.advance(24 * 3_600_000);
 expect(f.db.select().from(programFirings).where(eq(programFirings.trigger, post.id)).all()).toHaveLength(2);
});

it('runs the five-minute watch at its offset and skips overlap while the original job is pending', async () => {
 const f = fixture();
 const times = Array.from({ length: 288 }, (_, i) => {
   const minute = 2 + 5 * i;
   return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
 }).join(',');
 const program = { ...testProgramPin, name: 'pond-field', args: ['grant-watch'], timeoutMs: 240000, secrets:{} };
 const watch = { ...f.trigger, id: 'watch', ownerKind: 'agent', owner: 'art', times, lifespan: 'until-stopped', program };
 expect((await f.call('tempo.set', watch, 'watch')).status).toBe(200);
 f.clock.advance(119_999);
 expect(f.db.select().from(jobs).all()).toEqual([]);
 f.clock.advance(300_001);
 expect(f.db.select().from(jobs).all()).toHaveLength(1);
 expect(f.db.select().from(triggerLog).all()).toContainEqual(expect.objectContaining({ trigger: 'watch', event: 'skipped' }));
 expect(f.db.select().from(inbox).all()).toEqual([]);
});

it('lets a nightly miner defer, wake once and use its saved date on another check that night', async () => {
 const f = fixture();
 const trigger = { ...f.trigger, id: 'miner', ownerKind: 'agent', owner: 'art', lifespan: 'until-stopped',
   times: '00:01,00:06,00:11', program: { ...testProgramPin, name: 'miner', args: [], secrets:{}, timeoutMs: 5000 } };
 expect((await f.call('tempo.set', trigger, 'set-miner')).status).toBe(200);
 const finish = (result: ProgramResult) => f.db.transaction(() => {
   const firing = f.db.select().from(programFirings).where(eq(programFirings.status, 'pending')).get()!;
   const job = f.db.select().from(jobs).where(eq(jobs.id, firing.job)).get()!;
   applyProgramResult(f.db, new Conversations(f.db, f.now), undefined, () => true, job, result, () => {});
   f.db.update(jobs).set({ state: 'done', endedAt: f.now() }).where(eq(jobs.id, job.id)).run();
   return firing.program.state;
 });
 f.clock.advance(60_000);
 expect(finish({ version: 1, wake: false, state: null, line: 'Busy; check again.' })).toBeUndefined();
 f.clock.advance(300_000);
 const day = f.now().slice(0, 10);
 expect(finish({ version: 1, wake: true, state: { day }, payload: { date: day } })).toBeNull();
 // Before the resulting inbox batch settles, another manual firing sees the updated marker.
 expect((await f.call('tempo.runNow', { id: trigger.id }, 'check-again')).status).toBe(200);
 expect(finish({ version: 1, wake: false, line: 'Already woke today.' })).toEqual({ day });
 expect(f.db.select().from(inbox).all()).toHaveLength(1);
});

it('counts a late pre-midnight slot on the local date its program is actually admitted', async () => {
 const f = fixture();
 const trigger = { ...f.trigger, id: 'night', ownerKind: 'agent', owner: 'art', times: '23:59,00:01', lifespan: 'until-stopped',
   programPeriod: 'day', program: { ...testProgramPin, name: 'night', args: [], secrets:{}, timeoutMs: 5000 } };
 expect((await f.call('tempo.set', trigger, 'night')).status).toBe(200);
 const late = new Date(f.clock.now() - 60_000).toISOString();
 f.db.update(triggers).set({nextDueAt:late}).where(eq(triggers.id,trigger.id)).run();
 f.root.services.tempo.triggers.tick();
 const firing = f.db.select().from(programFirings).get()!;
 expect(firing.period).toBe(f.now().slice(0,10));
 f.db.update(programFirings).set({status:'done'}).where(eq(programFirings.id,firing.id)).run();
 f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,firing.job)).run();
 f.clock.advance(60_000);
 expect(f.db.select().from(programFirings).all()).toHaveLength(1);
});

it('guards program reads and controls against an unscoped body acting on a non-owner member’s word', async () => {
 const f = fixture();
 f.db.insert(memberAgents).values({member:'sam',agent:'art'}).run();
 const schedule = { ...f.trigger, ownerKind:'agent', owner:'art', program:{ ...testProgramPin, name:'watch', args:[], secrets:{}, timeoutMs:5000} };
 expect((await f.call('tempo.set', schedule, 'watch')).status).toBe(200);
 const job = f.db.select().from(jobs).get()!;
 const agent = {kind:'agent' as const,id:'art'};
 expect(mayReadProgramWork(f.db, agent, job)).toBe(true);
 f.db.insert(inbox).values({id:'member-mail',toKind:'agent',to:'art',agent:'art',job:job.id,conversation:job.conversation,
   source:'trigger',sourceId:'member-mail',fromKind:'schedule',words:'from Sam',at:f.now(),changedAt:f.now(),
   state:'waiting',onWordKind:'member',onWord:'sam'}).run();
 expect(mayReadProgramWork(f.db, agent, job)).toBe(false);
 expect(tempoQueryFields(f.db, agent, () => mayReadProgramWork(f.db, agent, job)).tempoProgram.resolve(null,{id:schedule.id})).toBeNull();
});

it('requires an owner to set new executable pins and keeps a reviewed definition fixed on edit', async () => {
 const f=scheduling(), program={...testProgramPin,name:'watch',args:[],secrets:{},timeoutMs:1000};
 const schedule={...f.work,id:'checked',times:'09:00',lifespan:'until-stopped',program};
 for (const credential of Object.values(f.raw))
   expect((await f.as(credential)('tempo.set',schedule,'new-pins')).status).toBe(403);
 expect((await f.call('tempo.set', schedule,'owned')).status).toBe(200);
 expect((await f.call('tempo.edit',{id:'checked',program:{...program,commit:'2'.repeat(40)}},'replace')).status).toBe(400);
 expect(f.db.select().from(triggers).where(eq(triggers.id,'checked')).get()?.program).toEqual(program);
});
