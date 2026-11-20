import { runtimeSlackDescribePermit, runtimeDiscordHistoryPermit, runtimeHouseDestination } from './role.js';
import {afterEach,expect,it,vi} from 'vitest';
import * as policy from '../../core/index.js';
import * as effectModule from '../../core/effects.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startLoom} from '../../foundation.js';
import {builtinServices} from '../../core/services.js';
import {fixture,fixtureSharing} from '../../fixture.js';
import {FakeClock,type Viewer} from '../../core/index.js';
import {signin,hash} from '../../core/signin/index.js';
import {runtimeStore} from './store.js';
import {conversationId} from '../attention/conversations.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();syncBuiltinESMExports();for(const close of closes.splice(0).reverse())await close();});
async function setup(privateInput=false,project?:string){
 const home=mkdtempSync(join(tmpdir(),'runtime-metadata-'));fixture(home);closes.push(()=>rmSync(home,{recursive:true,force:true}));
 const sharing=structuredClone(fixtureSharing()),clock=new FakeClock();
 const app=await startLoom({home,clock,next:true,sharing:()=>sharing,stdout(){}});closes.push(app.close);sharing.services=builtinServices(app.db);
 const store=runtimeStore(app.db);let n=0;
 const call=(name:string,input:unknown,viewer:Viewer={kind:'member',id:'jonathan'})=>app.operations.call('direct',viewer,name,input,`fixture-${++n}`);
 const put=(kind:'job'|'binding',record:Record<string,unknown>)=>{const {changedAt:_,...value}=record;app.db.transaction(()=>store.put(kind,value as never,clock.now()))();};
 app.db.transaction(()=>{
  signin(app).tokens.replace({v:1,tokens:[]},{});
  store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());
  store.put('box',{id:'a',name:'A',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
 })();
 expect(call('signin.setPrincipal',{kind:'runner',id:'a',active:true})).toMatchObject({ok:true});
 const token=(role:string)=>{const secret=randomBytes(32).toString('hex');signin(app).tokens.change(ts=>ts.push({role,label:'fixture',sha256:hash(secret),created:new Date(clock.now()).toISOString()}));return secret;};
 const runner=token('runner:a'),unbound=token('agent:art');
 const post=async(secret:string,name:string,input:unknown,id=`http-${++n}`)=>(await fetch(`${app.url}/api/runtime/${name}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input,id})})).json();
 const work={agent:'art',...(project?{project}:{}),prompt:'SCHEDULED WORDS',note:'fixture',place:'lane:metadata',when:'1s'};
 const scheduled=privateInput?await app.operations.callAsync('socket',{kind:'member',id:'jonathan'},'clock.in',{...work,member:'jonathan',project:'pond'},'private-input',true):call('clock.in',work);
 expect(scheduled).toMatchObject({ok:true});const wake=(scheduled as {ok:true;value:{id:string}}).value.id;
 clock.advance(1000);for(let i=0;i<12;i++)await Promise.resolve();
 const job=store.ids('job')[0];expect(job).toBeTruthy();
 expect(await post(runner,'claimJob',{job})).toMatchObject({ok:true});
 const input=await post(runner,'takeInput',{job});expect(input).toMatchObject({ok:true,value:{credential:expect.any(String)}});
 const body=input.value.credential as string;
 expect(await post(runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 const conversation=store.read('job',job)!.conversation!,canonical=conversationId('art','runtime-clock',conversation);
 return {app,clock,store,call,put,runner,unbound,body,post,job,wake,conversation,canonical,token,sharing};
}
const turn={kind:'note',outcome:'progressed',model:'fixture',harness:'test'};
const digest={summary:'Scheduled work progressed.',needs_owner:null};
it('projects real authenticated public Clock turns and digests under canonical ids without changing Runtime transport',async()=>{
 const f=await setup(),before=f.store.read('binding',f.conversation);
 expect(f.conversation).not.toMatch(/^cv-[0-9a-f]{12}$/);
 const first=await f.post(f.body,'recordTurn',turn,'same-turn');
 expect(first).toMatchObject({ok:true,value:{conversation:f.canonical,seq:1}});
 expect(await f.post(f.body,'recordTurn',turn,'same-turn')).toEqual(first);
 const written=await f.post(f.body,'writeDigest',{digest},'same-digest');
 expect(written).toMatchObject({ok:true,value:{conversation:f.canonical,run:f.job,agent:'art',summary:digest.summary,revision:1,needs_owner:null}});
 expect(await f.post(f.body,'writeDigest',{digest},'same-digest')).toEqual(written);
 expect(f.call('attention.turns',{conversation:f.canonical})).toMatchObject({ok:true,value:[{from:{kind:'agent',id:'art'},run:f.job,venue:'runtime-clock',place:f.conversation,kind:'note'}]});
 expect(f.store.read('binding',f.conversation)).toEqual(before);
 expect(JSON.stringify(f.app.db.prepare('SELECT * FROM attention_turns').all())).not.toContain('SCHEDULED WORDS');
});
it('keeps managed-source decisions outside the public answer inbox and rolls back its receipt',async()=>{
 const f=await setup();expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:true});
 expect(await f.post(f.body,'writeDigest',{digest:{...digest,needs_owner:{ask:'Continue?',if_yes:'I continue.',if_no:'I stop.',refs:[],waits_on:{task:'t-1'}}}})).toMatchObject({ok:false,code:'unavailable'});
 expect(f.app.db.prepare('SELECT * FROM attention_asks').all()).toEqual([]);
 expect(f.app.db.prepare('SELECT * FROM attention_digests').all()).toEqual([]);
 expect(await f.post(f.body,'writeDigest',{digest})).toMatchObject({ok:true});
});
it('requires a recorded own turn before a digest and rejects caller-supplied routing, run, sender and words',async()=>{
 const f=await setup();expect(await f.post(f.body,'writeDigest',{digest})).toMatchObject({ok:false});
 for(const extra of [{conversation:'cv-123456789abc'},{run:'another'},{from:{kind:'person',slug:'jonathan'}},{text:'raw inbound'},{project:'pond'},{member:'jonathan'},{place:'foreign'},{agent:'mark'},{at:'2020-01-01T00:00:00Z'}]){
  expect(await f.post(f.body,'recordTurn',{...turn,...extra})).toMatchObject({ok:false});
  expect(await f.post(f.body,'writeDigest',{digest,...extra})).toMatchObject({ok:false});
 }
 expect(f.app.db.prepare('SELECT * FROM attention_conversations').all()).toEqual([]);
});
it('denies unbound, runner and forged body principals and every private Clock body',async()=>{
 for(const privateInput of [false,true]){
  const f=await setup(privateInput);
  for(const secret of [f.runner,f.unbound,f.token(`agent:mark@${f.job}`),...(privateInput?[f.body]:[])]){
   expect(await f.post(secret,'recordTurn',turn)).toMatchObject({ok:false});
   expect(await f.post(secret,'writeDigest',{digest})).toMatchObject({ok:false});
  }
  expect(f.app.db.prepare('SELECT * FROM attention_conversations').all()).toEqual([]);
 }
});
it.each(['source','withdrawn','credential','job','binding','box','policy','service','private','project'] as const)('rechecks current owning %s before metadata and digest writes',async drift=>{
 const f=await setup();expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:true});
 if(drift==='source')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.prompt','Changed source only') WHERE id=?").run(f.wake);
 if(drift==='withdrawn')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.withdrawn',json('true')) WHERE id=?").run(f.wake);
 if(drift==='credential')signin(f.app).tokens.change(tokens=>{for(const t of tokens)if(t.sha256===hash(f.body))t.revoked=new Date(f.clock.now()).toISOString();});
 if(drift==='job')f.put('job',{...f.store.read('job',f.job)!,state:'stopped',endedAt:f.clock.now()});
 if(drift==='binding')f.put('binding',{...f.store.read('binding',f.conversation)!,job:'another'});
 if(drift==='box')f.app.db.prepare("UPDATE runtime_boxes SET record=json_set(record,'$.revokedAt',?)").run(f.clock.now());
 if(drift==='policy')expect(f.call('runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{}},policy:{deny:['Bash']}})).toMatchObject({ok:true});
 if(drift==='service')f.put('job',{...f.store.read('job',f.job)!,service:'restricted'});
 if(drift==='private')f.put('job',{...f.store.read('job',f.job)!,member:'jonathan'});
 if(drift==='project')f.put('job',{...f.store.read('job',f.job)!,project:'pond'});
 expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:false});
 expect(await f.post(f.body,'writeDigest',{digest})).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(1);
 expect(f.app.db.prepare('SELECT * FROM attention_digests').all()).toEqual([]);
});

it('retains the owning project and isolates a replacement Runtime conversation at the same lane',async()=>{
 const f=await setup(false,'pond');
 expect(await f.post(f.body,'recordTurn',turn,'identity-turn')).toMatchObject({ok:true,value:{conversation:f.canonical}});
 expect(await f.post(f.body,'writeDigest',{digest})).toMatchObject({ok:true,value:{project:'pond',agent:'art'}});
 const first=f.canonical;
 expect(await f.post(f.runner,'finishJob',{job:f.job,state:'done'})).toMatchObject({ok:true});
 expect(f.call('clock.in',{agent:'art',project:'pond',prompt:'Replacement',note:'next',place:'lane:metadata',when:'1s'})).toMatchObject({ok:true});
 f.clock.advance(1000);for(let i=0;i<12;i++)await Promise.resolve();
 const next=f.store.ids('job').find(id=>id!==f.job)!;expect(next).toBeTruthy();
 expect(await f.post(f.runner,'claimJob',{job:next})).toMatchObject({ok:true});
 const input=await f.post(f.runner,'takeInput',{job:next});expect(input).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job:next,state:'running'})).toMatchObject({ok:true});
 expect(await f.post(input.value.credential,'recordTurn',turn,'identity-turn')).toMatchObject({ok:false,code:'conflict'});
 const second=await f.post(input.value.credential,'recordTurn',turn);expect(second).toMatchObject({ok:true});
 expect(second.value.conversation).not.toBe(first);
 expect(await f.post(input.value.credential,'writeDigest',{digest:{...digest,summary:'Replacement summary'}})).toMatchObject({ok:true,value:{conversation:second.value.conversation,project:'pond'}});
 expect(f.call('attention.digests',{conversation:first})).toMatchObject({ok:true,value:[{summary:digest.summary,run:f.job}]});
 expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:false});
});

it('refuses metadata when service exclusion is the only hold on an otherwise current public Clock body',async()=>{
 const f=await setup();
 f.app.db.transaction(()=>{
  const wakeRow=f.app.db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(f.wake) as {record:string};
  const wake=JSON.parse(wakeRow.record);wake.authorship.service='restricted';
  f.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify(wake),f.wake);
  const row=f.app.db.prepare('SELECT record FROM runtime_clock_turns WHERE id=?').get(`clock:${f.wake}`) as {record:string};
  const source=JSON.parse(row.record);source.authorship.service='restricted';source.service='restricted';
  // Keep sourceRecord's field ordering, because the owning Clock role compares
  // its exact serialization as well as agent/member/project/service identity.
  const record={text:source.text,member:source.member,project:source.project,agent:source.agent,service:'restricted',authorship:source.authorship,by:source.by,attempt:source.attempt};
  f.app.db.prepare('UPDATE runtime_clock_turns SET record=? WHERE id=?').run(JSON.stringify(record),`clock:${f.wake}`);
 })();
 f.put('job',{...f.store.read('job',f.job)!,service:'restricted'});
 const body=f.token(`agent:art/restricted@${f.job}`);
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true});
 const serviceRead=await f.post(body,'readConversation',{});
 expect(await f.post(body,'acknowledgeClockInput',{through:serviceRead.value.messages[0].seq})).toMatchObject({ok:true});
 expect(await f.post(body,'recordTurn',turn)).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(body,'writeDigest',{digest})).toMatchObject({ok:false,code:'denied'});
 expect(f.app.db.prepare('SELECT * FROM attention_conversations').all()).toEqual([]);
});

it('holds a waiting body even while its owning Clock read remains available',async()=>{
 const f=await setup();expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job:f.job,state:'waiting'})).toMatchObject({ok:true});
 expect(await f.post(f.body,'readConversation',{})).toMatchObject({ok:true});
 expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(f.body,'writeDigest',{digest})).toMatchObject({ok:false,code:'denied'});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(1);
 expect(f.app.db.prepare('SELECT * FROM attention_digests').all()).toEqual([]);
});
it.each(['conversation-create','conversation-update','digest-create','digest-update'] as const)('retains central Attention %s denial while owning Clock authority remains current',async kind=>{
 const f=await setup();
 if(kind!=='conversation-create')expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:true});
 if(kind==='digest-update')expect(await f.post(f.body,'writeDigest',{digest})).toMatchObject({ok:true});
 const beforeTurns=f.app.db.prepare('SELECT * FROM attention_turns').all(),beforeDigests=f.app.db.prepare('SELECT * FROM attention_digests').all();
 const name=kind.endsWith('create')?'mayCreate':'mayAct',original=policy[name];let denials=0;
 vi.spyOn(policy,name).mockImplementation((v,r,s,...rest)=>{
  if(v.kind==='agent'&&r.type===(kind.startsWith('conversation')?'attention.conversation':'attention.digest')){denials++;return false;}
  return original(v,r,s,...rest);
 });
 expect(await f.post(f.body,'readConversation',{})).toMatchObject({ok:true});
 const result=kind.startsWith('conversation')?await f.post(f.body,'recordTurn',turn):await f.post(f.body,'writeDigest',{digest:{...digest,summary:'Later summary'}});
 expect(result).toMatchObject({ok:false,code:'denied'});expect(denials).toBeGreaterThan(0);
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toEqual(beforeTurns);
 expect(f.app.db.prepare('SELECT * FROM attention_digests').all()).toEqual(beforeDigests);
});
it('performs both metadata writes without filesystem reads or outside-effect dispatch',async()=>{
 let effects:ReturnType<typeof effectModule.installEffects>|undefined;
 const install=effectModule.installEffects;
 vi.spyOn(effectModule,'installEffects').mockImplementation((...args)=>{effects=install(...args);return effects;});
 const f=await setup();expect(effects).toBeDefined();
 const outside=vi.spyOn(effects!,'beforeOutside').mockImplementation(()=>{throw Error('Metadata attempted an outside effect');});
 const finish=vi.spyOn(effects!,'finish').mockImplementation(()=>{throw Error('Metadata finished an outside effect');});
 const read=vi.spyOn(fs,'readFileSync').mockImplementation(()=>{throw Error('Metadata read a file');});
 const asyncRead=vi.spyOn(fsPromises,'readFile').mockImplementation(async()=>{throw Error('Metadata read a file');});
 syncBuiltinESMExports();
 const prepare=Database.prototype.prepare;
 vi.spyOn(Database.prototype,'prepare').mockImplementation(function(this:Database.Database,sql:string){
  if(this!==f.app.db)throw Error('Metadata queried another database');
  return prepare.call(this,sql);
 });
 const before=f.app.db.prepare('SELECT * FROM core_effects').all();
 expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:true});
 expect(await f.post(f.body,'writeDigest',{digest})).toMatchObject({ok:true});
 expect(read).not.toHaveBeenCalled();expect(asyncRead).not.toHaveBeenCalled();expect(outside).not.toHaveBeenCalled();expect(finish).not.toHaveBeenCalled();
 expect(f.app.db.prepare('SELECT * FROM core_effects').all()).toEqual(before);
});

it('refuses a current authenticated private Comms body whose own read succeeds',async()=>{
 const f=await setup();
 const opened=await f.app.operations.callAsync('socket',{kind:'member',id:'jonathan'},'comms.open',{agent:'art',id:'abcdefghijklmnop',text:'PRIVATE Comms sentinel'},'open-comms',true);
 expect(opened).toMatchObject({ok:true});let jobs:string[]=[];
 for(let i=0;i<15&&!jobs.length;i++){
  const claimable=await f.post(f.runner,'claimableJobs',{});expect(claimable).toMatchObject({ok:true});jobs=claimable.value.jobs;
 }
 expect(jobs).toHaveLength(1);const job=jobs[0];
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const input=await f.post(f.runner,'takeInput',{job});expect(input).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 const body=input.value.credential;
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'PRIVATE Comms sentinel'}]}});
 expect(await f.post(body,'recordTurn',turn)).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(body,'writeDigest',{digest})).toMatchObject({ok:false,code:'denied'});
 expect(f.app.db.prepare('SELECT * FROM attention_conversations').all()).toEqual([]);
});
it('derives each turn timestamp from the current foundation clock',async()=>{
 const f=await setup(),first=new Date(f.clock.now()).toISOString();
 expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:true});
 f.clock.advance(1234);const second=new Date(f.clock.now()).toISOString();expect(second).not.toBe(first);
 expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:true});
 expect(f.call('attention.turns',{conversation:f.canonical})).toMatchObject({ok:true,value:[{at:first},{at:second}]});
});

it('records accepted scheduled input once at ACK time, without projecting queued or merely read words',async()=>{
 const f=await setup(false,'pond');
 const turns=()=>f.call('attention.turns',{conversation:f.canonical});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toEqual([]);
 const read=await f.post(f.body,'readConversation',{});expect(read).toMatchObject({ok:true});
 const through=read.value.messages[0].seq;
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toEqual([]);
 f.clock.advance(567);
 const ack=await f.post(f.body,'acknowledgeClockInput',{through},'incoming-ack');expect(ack).toMatchObject({ok:true});
 expect(turns()).toMatchObject({ok:true,value:[{seq:1,agent:'art',project:'pond',kind:'wake',from:{kind:'schedule'},venue:'runtime-clock',place:f.conversation,at:new Date(f.clock.now()).toISOString()}]});
 expect(await f.post(f.body,'acknowledgeClockInput',{through},'incoming-ack')).toEqual(ack);
 f.clock.advance(1000);
 expect(await f.post(f.body,'acknowledgeClockInput',{through})).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(1);
 expect(JSON.stringify(f.app.db.prepare('SELECT * FROM attention_turns').all())).not.toContain('SCHEDULED WORDS');
 const reply=await f.post(f.body,'recordTurn',{kind:'reply',outcome:'answered'});expect(reply).toMatchObject({ok:true});expect(reply.value).not.toHaveProperty('latency_ms');
});
it.each(['create','update','sql'] as const)('rolls back scheduled acceptance and nested metadata receipts on %s failure',async failure=>{
 const f=await setup();
 if(failure==='update')expect(await f.post(f.body,'recordTurn',turn)).toMatchObject({ok:true});
 const before=f.app.db.prepare('SELECT * FROM attention_turns').all();
 const read=await f.post(f.body,'readConversation',{});expect(read).toMatchObject({ok:true});
 const through=read.value.messages[0].seq;
 if(failure==='sql')f.app.db.exec("CREATE TRIGGER fail_incoming BEFORE UPDATE OF consumed ON runtime_clock_turns BEGIN SELECT RAISE(ABORT,'fixture ACK failure'); END");
 else {const name=failure==='create'?'mayCreate':'mayAct',original=policy[name];vi.spyOn(policy,name).mockImplementation((v,r,s,...rest)=>r.type==='attention.conversation'?false:original(v,r,s,...rest));}
 expect(await f.post(f.body,'acknowledgeClockInput',{through},'rollback-incoming')).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns').get()).toEqual({consumed:null});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toEqual(before);
 expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id LIKE 'runtime-incoming:%'").all()).toEqual([]);
 if(failure==='sql')f.app.db.exec('DROP TRIGGER fail_incoming');else vi.restoreAllMocks();
 expect(await f.post(f.body,'acknowledgeClockInput',{through},'rollback-incoming')).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(before.length+1);
});
it('keeps private Clock accepted input out of public Attention metadata',async()=>{
 const f=await setup(true),read=await f.post(f.body,'readConversation',{});expect(read).toMatchObject({ok:true});
 expect(await f.post(f.body,'acknowledgeClockInput',{through:read.value.messages[0].seq})).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toEqual([]);
});
it('projects each joined scheduled source exactly once in source order across overlapping ACKs',async()=>{
 const f=await setup();
 const joined=await (await fetch(`${f.app.url}/api/clock/in`,{method:'POST',headers:{authorization:`Bearer ${f.body}`,'content-type':'application/json'},body:JSON.stringify({input:{agent:'art',prompt:'JOINED SECRET WORDS',note:'joined',place:f.store.read('binding',f.conversation)!.place,when:'1s'},id:'join-metadata'})})).json();
 expect(joined).toMatchObject({ok:true});
 f.clock.advance(1000);for(let i=0;i<12;i++)await Promise.resolve();
 expect(f.store.ids('job')).toEqual([f.job]);
 const read=await f.post(f.body,'readConversation',{});expect(read).toMatchObject({ok:true});expect(read.value.messages).toHaveLength(2);
 for(const through of read.value.messages.map((m:{seq:number})=>m.seq))expect(await f.post(f.body,'acknowledgeClockInput',{through})).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(2);
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns').all()).toEqual([{consumed:f.clock.now()},{consumed:f.clock.now()}]);
 expect(JSON.stringify(f.app.db.prepare('SELECT * FROM attention_turns').all())).not.toContain('SECRET WORDS');
});
it('native Clock completion uses the same atomic accepted-input metadata path',async()=>{
 const f=await setup(),execution=await f.post(f.body,'beginClockExecution',{});expect(execution).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toEqual([]);f.clock.advance(321);
 const name='mayCreate',original=policy[name];vi.spyOn(policy,name).mockImplementation((v,r,s,...rest)=>r.type==='attention.conversation'?false:original(v,r,s,...rest));
 expect(await f.post(f.body,'completeClockExecution',{execution:execution.value.execution},'native-metadata')).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT consumed FROM runtime_clock_turns').get()).toEqual({consumed:null});vi.restoreAllMocks();
 expect(await f.post(f.body,'completeClockExecution',{execution:execution.value.execution},'native-metadata')).toMatchObject({ok:true});
 const accepted=f.app.db.prepare('SELECT record FROM attention_turns').all() as {record:string}[];expect(accepted).toHaveLength(1);expect(JSON.parse(accepted[0].record).at).toBe(new Date(f.clock.now()).toISOString());
 expect(await f.post(f.body,'completeClockExecution',{execution:execution.value.execution},'native-metadata')).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(1);
 f.clock.advance(1000);const reply=await f.post(f.body,'recordTurn',{kind:'reply',outcome:'answered'});expect(reply).toMatchObject({ok:true});expect(reply.value).not.toHaveProperty('latency_ms');
});

it.each([false,true])('refuses an otherwise current owner Clock source (private=%s) as venue history authority',async privateInput=>{
 const f=await setup(privateInput),viewer=signin(f.app).token(hash(f.body))!.viewer;
 expect(await f.post(f.body,'readConversation',{})).toMatchObject({ok:true});
 expect(runtimeHouseDestination(f.app,()=>f.sharing,viewer)?.current()).toBe(true);
 expect(runtimeDiscordHistoryPermit(f.app,viewer,{workspace:'300',channel:'400',kind:'channel'})).toBeUndefined();
 expect(runtimeSlackDescribePermit(f.app,viewer,{venue:'slack',workspace:'TWORK',kind:'dm',place:'UHUMAN'})).toBeUndefined();
});
