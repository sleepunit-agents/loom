import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, agents, memberAgents, tokens, inbox, changes, projects, projectMembers, agentModels, agentRunSettings, jobs, measuringSettings, timingDays } from './core/data/schema.js';
import type { SharedTempoOptions } from './shared-tempo.js';
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
 db.insert(agentRunSettings).values({agent:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false}).run();
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

it('fails settings closed without chat provenance and forwards configured adapters from trusted composition',async()=>{
 const f=fixture();
 expect((await f.call('tempo.proposeSettings',{who:{kind:'agent',id:'art'},patch:{settleSeconds:60}},'settings')).status).toBe(403);
 const settings=vi.fn(()=>({id:'proposal'})),admit=vi.fn(()=>true),operation=vi.fn(),instructions=vi.fn(()=> 'From repository');
 const g=fixture({settings,admit,operation,instructions,repository:'/must-not-be-read'});
 expect(await (await g.call('tempo.proposeSettings',{who:{kind:'agent',id:'art'},patch:{settleSeconds:60}},'settings')).json()).toEqual({ok:true,value:{id:'proposal'}});
 expect(settings).toHaveBeenCalledWith({kind:'member',id:'owner'},{kind:'agent',id:'art'},{settleSeconds:60});
 expect((await g.call('tempo.set',{...g.trigger,instructions:null,file:'routines/check.md'},'file')).status).toBe(200);
 expect(instructions).toHaveBeenCalledWith('routines/check.md');
 g.clock.advance(5000);expect(admit).toHaveBeenCalledWith({kind:'agent',id:'art'},expect.arrayContaining([expect.objectContaining({words:'From repository'})]));
 expect((await g.call('tempo.set',{...g.trigger,times:g.now(),id:'operation',targetKind:'operation',target:'custom.operation'},'operation')).status).toBe(200);
 expect(operation).toHaveBeenCalledWith('custom.operation',expect.objectContaining({id:'operation'}),expect.any(String));
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
