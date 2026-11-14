import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {startLoom} from '../../foundation.js';
import {builtinServices} from '../../core/services.js';
import {fixture,fixtureSharing} from '../../fixture.js';
import * as policy from '../../core/index.js';
import {FakeClock,exportDatabase,type Viewer} from '../../core/index.js';
import {signin,hash} from '../../core/signin/index.js';
import {runtimeStore} from './store.js';
import {runtimeDestination} from './destination.js';
import {provenanceStore} from './provenance-store.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closes.splice(0).reverse())await close();});
async function setup(project?:string,privateInput=false,afterRead?:()=>void){
 const home=mkdtempSync(join(tmpdir(),'runtime-public-input-'));fixture(home);closes.push(()=>rmSync(home,{recursive:true,force:true}));
 const sharing=structuredClone(fixtureSharing()),clock=new FakeClock();
 let app=await startLoom({home,clock,next:true,sharing:()=>sharing,stdout(){},install(app){
  if(!afterRead)return;
  const register=app.operations.register.bind(app.operations);
  vi.spyOn(app.operations,'register').mockImplementation(op=>{
   if(op.name==='runtime.readPublicInputs'){const prepare=op.prepare!;register({...op,async prepare(...args){const value=await prepare(...args);afterRead();return value;}});}
   else register(op);
  });
 }});closes.push(()=>app.close());sharing.services=builtinServices(app.db);
 let n=0;
 const call=(name:string,input:unknown,viewer:Viewer={kind:'member',id:'jonathan'})=>app.operations.call('direct',viewer,name,input,`fixture-${++n}`);
 const put=(kind:'job'|'binding',record:Record<string,unknown>)=>{const {changedAt:_,...value}=record;app.db.transaction(()=>runtimeStore(app.db).put(kind,value as never,clock.now()))();};
 app.db.transaction(()=>{
  signin(app).tokens.replace({v:1,tokens:[]},{});
  runtimeStore(app.db).put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());
  runtimeStore(app.db).put('box',{id:'a',name:'A',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
 })();
 expect(call('signin.setPrincipal',{kind:'runner',id:'a',active:true})).toMatchObject({ok:true});
 const token=(role:string,member?:string)=>{const secret=randomBytes(32).toString('hex');signin(app).tokens.change(ts=>ts.push({role,...(member?{member}:{}),label:'fixture',sha256:hash(secret),created:new Date(clock.now()).toISOString()}));return secret;};
 const runner=token('runner:a'),unbound=token('agent:art'),owner=token('owner');
 const post=async(secret:string,name:string,input:unknown,id=`http-${++n}`)=>{
  const [piece,op]=name.includes('.')?name.split('.'):['runtime',name];
  return (await fetch(`${app.url}/api/${piece}/${op}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input,id})})).json();
 };
 const work={agent:'art',...(project?{project}:{}),prompt:'Scheduled input',note:'fixture',place:'lane:public-input',when:'1s'};
 const scheduled=privateInput?await app.operations.callAsync('socket',{kind:'member',id:'jonathan'},'clock.in',{...work,member:'jonathan'},'private-schedule',true):call('clock.in',work);
 expect(scheduled).toMatchObject({ok:true});
 clock.advance(1000);for(let i=0;i<12;i++)await Promise.resolve();
 const job=runtimeStore(app.db).ids('job')[0];expect(job).toBeTruthy();
 expect(await post(runner,'claimJob',{job})).toMatchObject({ok:true});
 const input=await post(runner,'takeInput',{job});expect(input).toMatchObject({ok:true});const body=input.value.credential;
 expect(await post(runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 if(!privateInput)expect(await post(body,'recordTurn',{kind:'note',outcome:'progressed'})).toMatchObject({ok:true});
 const question={ask:'Continue the public work?',if_yes:'I continue.',if_no:'I stop.',refs:[]};
 const ask=async(needs:unknown=question)=>{
  const result=await post(body,'writeDigest',{digest:{summary:'Awaiting a decision',needs_owner:needs}});expect(result).toMatchObject({ok:true});return result.value.ask as string;
 };
 return {get app(){return app;},get store(){return runtimeStore(app.db);},clock,call,put,runner,owner,body,unbound,post,job,token,sharing,ask,question,
  async restart(staging=false){await app.close();app=await startLoom({home,clock,next:true,staging,sharing:()=>sharing,stdout(){}});},
 };
}
it.each(['yes','no','words'] as const)('delivers the actual member %s answer to the original public body and deduplicates it',async kind=>{
 const f=await setup('pond'),ask=await f.ask(kind==='words'?{ask:'What next?',answers:'words'}:f.question);
 f.clock.advance(271);
 const answer=kind==='words'?{kind,text:'  PUBLIC owner words\n\n'}:{kind};
 const result=await f.post(f.owner,'attention.answer',{id:ask,answer},'answer-once');expect(result).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer},'answer-once')).toEqual(result);
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer})).toMatchObject({ok:false,code:'conflict'});
 const read=await f.post(f.body,'readPublicInputs',{});expect(read).toMatchObject({ok:true,value:{conversation:f.store.read('job',f.job)!.conversation,messages:[{id:`public-answer:${ask}`,from:{kind:'person',slug:'jonathan'},agent:'art',project:'pond',at:new Date(f.clock.now()).toISOString()}]}});
 expect(await f.post(f.body,'readPublicInputs',{})).toEqual(read);
 expect(f.app.db.prepare('SELECT consumed FROM runtime_public_inputs').get()).toEqual({consumed:null});
 const message=read.value.messages[0];
 expect(message.text).toBe(kind==='words'?'  PUBLIC owner words\n\n':`${kind==='yes'?'Yes':'No'}, to: ${f.question.ask}\n${kind==='yes'?f.question.if_yes:f.question.if_no}`);
 expect(await f.post(f.body,'acknowledgePublicInputs',{through:message.seq},'ack-once')).toMatchObject({ok:true,value:{job:f.job,acknowledged:true}});
 expect(await f.post(f.body,'acknowledgePublicInputs',{through:message.seq},'ack-once')).toMatchObject({ok:true});
 expect(await f.post(f.body,'readPublicInputs',{})).toMatchObject({ok:true,value:{messages:[]}});
 expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toHaveLength(1);
 expect(JSON.stringify(f.app.db.prepare("SELECT * FROM core_operations WHERE name LIKE 'runtime.%'").all())).not.toContain(message.text);
});
it.each(['done','dismiss'] as const)('records %s without assigning work or adding public words',async kind=>{
 const f=await setup(),ask=await f.ask();expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind}})).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toEqual([]);
});
it('persists answer ownership across restart and holds the actual words in staging until release',async()=>{
 const f=await setup(),ask=await f.ask();await f.restart(true);
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 expect(await f.post(f.body,'readPublicInputs',{})).toMatchObject({ok:false,code:'conflict'});
 const row=f.app.db.prepare('SELECT seq,released,consumed FROM runtime_public_inputs').get() as {seq:number};
 expect(row).toMatchObject({released:null,consumed:null});
 expect(await f.post(f.body,'acknowledgePublicInputs',{through:row.seq})).toMatchObject({ok:false});
 const effect=`runtime:public-read:${f.job}:${row.seq}`;
 expect(f.call('core.releaseEffect',{id:effect})).toMatchObject({ok:true});
 expect(await f.post(f.body,'readPublicInputs',{})).toMatchObject({ok:true,value:{messages:[{text:expect.stringContaining('Yes, to:')}]}});
 expect(await f.post(f.body,'readPublicInputs',{})).toMatchObject({ok:true});
 expect(f.app.effects!.status(effect)).toBe('done');
});
it.each(['claim','house','binding','project','source','withdrawn','policy','box'] as const)('rolls the answer and receipt back when original %s changes',async drift=>{
 const f=await setup(),ask=await f.ask(),original=f.store.read('job',f.job)!,cv=original.conversation!;
 if(drift==='claim')f.put('job',{...original,claimedAt:original.claimedAt!+1});
 if(drift==='house'){
  const house={...original.made!,repo:'/another'};f.put('job',{...original,made:house});
  const {changedAt:_,...settings}=f.store.read('settings','art')!;f.app.db.transaction(()=>f.store.put('settings',{...settings,house:{repo:'/another',houseFile:'house/house.json'}},f.clock.now()))();
 }
 if(drift==='binding')f.put('binding',{...f.store.read('binding',cv)!,place:'lane:other'});
 if(drift==='project')f.put('job',{...original,project:'pond'});
 if(drift==='source')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.prompt','new')").run();
 if(drift==='withdrawn')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.withdrawn',json('true'))").run();
 if(drift==='policy')expect(f.call('runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{}},policy:{deny:['Bash']}})).toMatchObject({ok:true});
 if(drift==='box')f.app.db.prepare("UPDATE runtime_boxes SET record=json_set(record,'$.revokedAt',?)").run(f.clock.now());
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}},'denied-answer')).toMatchObject({ok:false});
 expect(f.call('attention.get',{id:ask})).toMatchObject({ok:true,value:{state:'open'}});
 expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toEqual([]);
 expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id='denied-answer'").all()).toEqual([]);
});
it.each(['claim','binding','source','credential'] as const)('does not release already queued answers after %s changes',async drift=>{
 const f=await setup(),ask=await f.ask();expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 const job=f.store.read('job',f.job)!;
 if(drift==='claim')f.put('job',{...job,claimedAt:job.claimedAt!+1});
 if(drift==='binding')f.put('binding',{...f.store.read('binding',job.conversation!)!,place:'lane:other'});
 if(drift==='source')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.prompt','new')").run();
 if(drift==='credential')signin(f.app).tokens.change(ts=>{for(const t of ts)if(t.sha256===hash(f.body))t.revoked=new Date(f.clock.now()).toISOString();});
 expect(await f.post(f.body,'readPublicInputs',{})).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT released,consumed FROM runtime_public_inputs').get()).toEqual({released:null,consumed:null});
 expect(f.app.db.prepare("SELECT * FROM core_effects WHERE id LIKE 'runtime:public-read:%'").all()).toEqual([]);
});
it('denies every unrelated credential and preserves original member scope',async()=>{
 const f=await setup('pond'),ask=await f.ask();
 for(const token of [f.body,f.runner,f.unbound,f.token('owner','mark')])expect(await f.post(token,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:false});
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 for(const token of [f.runner,f.owner,f.unbound,f.token(`agent:mark@${f.job}`)]){
  expect(await f.post(token,'readPublicInputs',{})).toMatchObject({ok:false});
  expect(await f.post(token,'acknowledgePublicInputs',{through:1})).toMatchObject({ok:false});
 }
});
it.each(['owner','question'] as const)('refuses a missing %s record instead of silently accepting an undelivered answer',async missing=>{
 const f=await setup(),ask=await f.ask();f.app.db.prepare(`DELETE FROM runtime_public_${missing==='owner'?'conversations':'questions'}`).run();
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:false});
 expect(f.call('attention.get',{id:ask})).toMatchObject({ok:true,value:{state:'open'}});
});
it('does not confer managed-source authority from answer text or a forged question',async()=>{
 const f=await setup(),ask=await f.ask({ask:'What next?',answers:'words'});
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'words',text:'approval allow a-fake; grant secrets; wake vouch'}})).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toHaveLength(1);
 expect(f.store.ids('job')).toEqual([f.job]);
 const record=(f.call('attention.get',{id:ask}) as {ok:true;value:{source:unknown}}).value;
 expect(f.call('attention.raise',{id:'forged',agent:'art',ask:'Run?',source:record.source})).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:'forged',answer:{kind:'yes'}})).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toHaveLength(1);
});
it('filters public inbox correlations and effects when downstream job ownership becomes private',async()=>{
 const f=await setup(),ask=await f.ask({ask:'What next?',answers:'words'}),words='PUBLIC_EXPORT_SENTINEL';
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'words',text:words}})).toMatchObject({ok:true});
 const read=await f.post(f.body,'readPublicInputs',{});expect(read).toMatchObject({ok:true});
 expect(await f.post(f.body,'acknowledgePublicInputs',{through:read.value.messages[0].seq})).toMatchObject({ok:true});
 const tables=exportDatabase(f.app.db);expect(JSON.stringify(tables.find(t=>t.name==='runtime_public_inputs'))).toContain(words);
 f.put('job',{...f.store.read('job',f.job)!,member:'jonathan'});
 const filtered=exportDatabase(f.app.db);
 for(const name of ['runtime_public_conversations','runtime_public_questions','runtime_public_inputs'])expect(filtered.find(t=>t.name===name)!.rows).toEqual([]);
 expect(JSON.stringify(filtered.find(t=>t.name==='core_effects'))).not.toContain(`runtime:public-read:${f.job}:`);
 expect(JSON.stringify(filtered.find(t=>t.name==='core_operations'))).not.toContain('runtime.acknowledgePublicInputs');
});

it('allows a waiting original body to receive an answer without allowing it to create new metadata',async()=>{
 const f=await setup(),ask=await f.ask();f.put('job',{...f.store.read('job',f.job)!,state:'waiting'});
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 expect(await f.post(f.body,'readPublicInputs',{})).toMatchObject({ok:true,value:{messages:[{text:expect.stringContaining('Yes, to:')}]}});
 expect(await f.post(f.body,'recordTurn',{kind:'note',outcome:'progressed'})).toMatchObject({ok:false});
});
it('rolls back Attention and its receipt when inbox persistence fails',async()=>{
 const f=await setup(),ask=await f.ask();
 f.app.db.exec("CREATE TRIGGER fail_public_input BEFORE INSERT ON runtime_public_inputs BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}},'retry-failed')).toMatchObject({ok:false});
 expect(f.call('attention.get',{id:ask})).toMatchObject({ok:true,value:{state:'open'}});
 f.app.db.exec('DROP TRIGGER fail_public_input');
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}},'retry-failed')).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toHaveLength(1);
});
it('independently enforces current central give-work policy while the ask remains answerable',async()=>{
 const f=await setup(),ask=await f.ask();const original=policy.mayAct;
 vi.spyOn(policy,'mayAct').mockImplementation((v,r,s,action,op)=>action==='give-work'?false:original(v,r,s,action,op));
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:false,code:'denied'});
 expect(f.call('attention.get',{id:ask})).toMatchObject({ok:true,value:{state:'open'}});
 expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toEqual([]);
});
it('denies the new public inbox to a real current private Clock body',async()=>{
 const f=await setup('pond',true);
 expect(await f.post(f.body,'readConversation',{})).toMatchObject({ok:true,value:{messages:[{text:'Scheduled input'}]}});
 expect(await f.post(f.body,'readPublicInputs',{})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(f.body,'acknowledgePublicInputs',{through:1})).toMatchObject({ok:false,code:'denied'});
});
it('denies a real service Clock body even when all owning source and credential checks pass',async()=>{
 const f=await setup(),wake=(f.app.db.prepare('SELECT id FROM clock_wakes').get() as {id:string}).id;
 f.app.db.transaction(()=>{
  const row=f.app.db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(wake) as {record:string};
  const w=JSON.parse(row.record);w.authorship.service='restricted';f.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify(w),wake);
  const turn=f.app.db.prepare('SELECT record FROM runtime_clock_turns WHERE id=?').get(`clock:${wake}`) as {record:string};
  const source=JSON.parse(turn.record);source.authorship.service='restricted';
  const record={text:source.text,member:source.member,project:source.project,agent:source.agent,service:'restricted',authorship:source.authorship,by:source.by,attempt:source.attempt};
  f.app.db.prepare('UPDATE runtime_clock_turns SET record=? WHERE id=?').run(JSON.stringify(record),`clock:${wake}`);
 })();
 f.put('job',{...f.store.read('job',f.job)!,service:'restricted'});const body=f.token(`agent:art/restricted@${f.job}`);
 expect(await f.post(body,'readConversation',{})).toMatchObject({ok:true});
 expect(await f.post(body,'readPublicInputs',{})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(body,'acknowledgePublicInputs',{through:1})).toMatchObject({ok:false,code:'denied'});
});

it.each([40000,40001])('enforces the public answer words boundary transactionally at %i characters',async length=>{
 const f=await setup(),ask=await f.ask({ask:'What next?',answers:'words'}),text='x'.repeat(length);
 const result=await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'words',text}},'boundary-answer');
 if(length===40000){
  expect(result).toMatchObject({ok:true});
  const read=await f.post(f.body,'readPublicInputs',{});expect(read).toMatchObject({ok:true,value:{messages:[{text}]}});
 }else{
  expect(result).toMatchObject({ok:false,code:'invalid'});
  expect(f.call('attention.get',{id:ask})).toMatchObject({ok:true,value:{state:'open'}});
  expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toEqual([]);
  expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id='boundary-answer'").all()).toEqual([]);
 }
});

it('rejects a separately valid replacement claim after preparation instead of returning the old prepared words',async()=>{
 let drift=()=>{};const f=await setup(undefined,false,()=>drift()),ask=await f.ask();
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 drift=()=>{const job=f.store.read('job',f.job)!;f.put('job',{...job,claimedAt:job.claimedAt!+1});};
 const result=await f.post(f.body,'readPublicInputs',{});expect(result).toMatchObject({ok:false,code:'denied'});
 expect(JSON.stringify(result)).not.toContain('Yes, to:');
 expect(f.app.db.prepare('SELECT consumed FROM runtime_public_inputs').get()).toEqual({consumed:null});
});
it.each(['claim','house','binding','scope'] as const)('refuses fresh acknowledgements and prior receipt replay after an independently valid %s change',async drift=>{
 const f=await setup(),first=await f.ask();
 expect(await f.post(f.owner,'attention.answer',{id:first,answer:{kind:'yes'}})).toMatchObject({ok:true});
 const initial=await f.post(f.body,'readPublicInputs',{}),through=initial.value.messages[0].seq;
 expect(await f.post(f.body,'acknowledgePublicInputs',{through},'original-ack')).toMatchObject({ok:true});
 const second=await f.ask();expect(await f.post(f.owner,'attention.answer',{id:second,answer:{kind:'no'}})).toMatchObject({ok:true});
 const pending=await f.post(f.body,'readPublicInputs',{});expect(pending).toMatchObject({ok:true});
 const job=f.store.read('job',f.job)!,binding=f.store.read('binding',job.conversation!)!;
 if(drift==='claim')f.put('job',{...job,claimedAt:job.claimedAt!+1});
 if(drift==='binding')f.put('binding',{...binding,place:'lane:changed-ack'});
 if(drift==='house'){
  f.put('job',{...job,made:{...job.made!,repo:'/changed-ack'}});
  const {changedAt:_,...settings}=f.store.read('settings','art')!;
  f.app.db.transaction(()=>f.store.put('settings',{...settings,house:{repo:'/changed-ack',houseFile:'house/house.json'}},f.clock.now()))();
 }
 if(drift==='scope'){
  f.put('job',{...job,project:'pond'});f.put('binding',{...binding,project:'pond'});
  f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.project','pond')").run();
  const rows=f.app.db.prepare('SELECT id,record FROM runtime_clock_turns').all() as {id:string;record:string}[];
  for(const row of rows){const s=JSON.parse(row.record),record={text:s.text,member:s.member,project:'pond',agent:s.agent,service:s.service,authorship:s.authorship,by:s.by,attempt:s.attempt,file:s.file};f.app.db.prepare('UPDATE runtime_clock_turns SET record=? WHERE id=?').run(JSON.stringify(record),row.id);}
 }
 // The replacement remains independently current: only the old release and
 // retry generation are forbidden, rather than all owning body operations.
 expect(await f.post(f.body,'readConversation',{})).toMatchObject({ok:true});
 const before=f.app.db.prepare('SELECT id,released,consumed FROM runtime_public_inputs ORDER BY seq').all();
 expect(await f.post(f.body,'acknowledgePublicInputs',{through:pending.value.messages[0].seq},'replacement-ack')).toMatchObject({ok:false,code:'conflict'});
 expect(await f.post(f.body,'acknowledgePublicInputs',{through},'original-ack')).toMatchObject({ok:false,code:'conflict'});
 expect(f.app.db.prepare('SELECT id,released,consumed FROM runtime_public_inputs ORDER BY seq').all()).toEqual(before);
 expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id='replacement-ack'").all()).toEqual([]);
});
it.each(['done','dismiss','yes','no','words'] as const)('lets a project member %s only when the answer assigns no work',async kind=>{
 const f=await setup('pond'),ask=await f.ask(kind==='words'?{ask:'What next?',answers:'words'}:f.question),member=f.token('owner','pollock');
 const scope={type:'attention.ask',agent:'art',project:'pond'};
 expect(policy.mayAct({kind:'member',id:'pollock'},scope,f.sharing,'answer-person')).toBe(true);
 expect(policy.mayAct({kind:'member',id:'pollock'},scope,f.sharing,'give-work')).toBe(false);
 const answer=kind==='words'?{kind,text:'New work'}:{kind};
 const result=await f.post(member,'attention.answer',{id:ask,answer},`project-${kind}`);
 if(kind==='done'||kind==='dismiss')expect(result).toMatchObject({ok:true,value:{answer:{kind,by:{kind:'member',id:'pollock'}}}});
 else {
  expect(result).toMatchObject({ok:false,code:'denied'});
  expect(f.call('attention.get',{id:ask})).toMatchObject({ok:true,value:{state:'open'}});
  expect(f.app.db.prepare('SELECT * FROM core_operations WHERE id=?').all(`project-${kind}`)).toEqual([]);
 }
 expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toEqual([]);
});

it.each(['yes','no','words'] as const)('continues terminal public work once for %s with a new owning claim',async kind=>{
 const f=await setup('pond'),ask=await f.ask(kind==='words'?{ask:'What next?',answers:'words'}:f.question);
 const original=f.store.read('job',f.job)!;
 expect(await f.post(f.runner,'finishJob',{job:f.job,state:'done'})).toMatchObject({ok:true});
 f.clock.advance(100);
 const answer=kind==='words'?{kind,text:'  successor words\n\n'}:{kind};
 const result=await f.post(f.owner,'attention.answer',{id:ask,answer},'terminal-answer');expect(result).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer},'terminal-answer')).toEqual(result);
 const job=f.store.ids('job').find(id=>id!==f.job)!;
 expect(f.store.ids('job')).toHaveLength(2);
 const next=f.store.read('job',job)!;
 expect(next).toMatchObject({agent:'art',project:'pond',state:'queued'});
 expect(next.conversation).not.toBe(original.conversation);
 expect(f.store.read('binding',original.conversation!)!.job).toBe(f.job);
 const link=f.app.db.prepare('SELECT * FROM runtime_public_continuations').get() as {original_job:string;question:string;original_destination:string};
 expect(link).toMatchObject({original_job:f.job,question:ask});
 expect(JSON.parse(link.original_destination)).toMatchObject({job:f.job,claimedAt:original.claimedAt,made:original.made});
 expect(await f.post(f.body,'readPublicInputs',{})).toMatchObject({ok:false});
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const input=await f.post(f.runner,'takeInput',{job});expect(input,JSON.stringify(input)).toMatchObject({ok:true,value:{conversation:next.conversation,credential:expect.any(String)}});
 expect(input.value.brief).not.toContain('successor words');
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 const read=await f.post(input.value.credential,'readPublicInputs',{});expect(read).toMatchObject({ok:true,value:{messages:[{question:ask,from:{kind:'person',slug:'jonathan'},agent:'art',project:'pond'}]}});
 expect(read.value.messages[0].text).toBe(kind==='words'?'  successor words\n\n':`${kind==='yes'?'Yes':'No'}, to: ${f.question.ask}\n${kind==='yes'?f.question.if_yes:f.question.if_no}`);
 expect(await f.post(input.value.credential,'acknowledgePublicInputs',{through:read.value.messages[0].seq})).toMatchObject({ok:true,value:{job,acknowledged:true}});
 expect(await f.post(input.value.credential,'recordTurn',{kind:'reply',outcome:'answered'})).toMatchObject({ok:true});
 const second=await f.post(input.value.credential,'writeDigest',{digest:{summary:'Continued',needs_owner:f.question}});expect(second).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:second.value.ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 expect(f.store.ids('job')).toHaveLength(2);
});
it.each(['done','dismiss'] as const)('allows terminal %s without a successor or give-work',async kind=>{
 const f=await setup('pond'),ask=await f.ask();expect(await f.post(f.runner,'finishJob',{job:f.job,state:'failed'})).toMatchObject({ok:true});
 expect(await f.post(f.token('owner','pollock'),'attention.answer',{id:ask,answer:{kind}})).toMatchObject({ok:true});
 expect(f.store.ids('job')).toEqual([f.job]);expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toEqual([]);
});
it('rolls a terminal successor back with the failed answer and retries exactly once after restart',async()=>{
 const f=await setup(),ask=await f.ask();expect(await f.post(f.runner,'finishJob',{job:f.job,state:'failed'})).toMatchObject({ok:true});
 f.app.db.exec("CREATE TRIGGER fail_successor BEFORE INSERT ON runtime_public_inputs BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}},'terminal-retry')).toMatchObject({ok:false});
 expect(f.store.ids('job')).toEqual([f.job]);expect(f.store.ids('binding')).toHaveLength(1);
 expect(f.app.db.prepare('SELECT * FROM runtime_public_continuations').all()).toEqual([]);
 expect(f.call('attention.get',{id:ask})).toMatchObject({ok:true,value:{state:'open'}});
 f.app.db.exec('DROP TRIGGER fail_successor');await f.restart();
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}},'terminal-retry')).toMatchObject({ok:true});
 expect(f.store.ids('job')).toHaveLength(2);
});
it.each(['claim','binding','source','withdrawn','policy','box','stopped','uncertain','reset'] as const)('refuses a terminal successor after original %s drift',async drift=>{
 const f=await setup(),ask=await f.ask();expect(await f.post(f.runner,'finishJob',{job:f.job,state:'done'})).toMatchObject({ok:true});
 const original=f.store.read('job',f.job)!;
 if(drift==='claim')f.put('job',{...original,claimedAt:original.claimedAt!+1});
 if(drift==='binding')f.put('binding',{...f.store.read('binding',original.conversation!)!,place:'lane:other'});
 if(drift==='source')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.prompt','changed')").run();
 if(drift==='withdrawn')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.withdrawn',json('true'))").run();
 if(drift==='box')f.app.db.prepare("UPDATE runtime_boxes SET record=json_set(record,'$.revokedAt',?)").run(f.clock.now());
 if(drift==='policy')expect(f.call('runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{}},policy:{deny:['Bash']}})).toMatchObject({ok:true});
 if(drift==='stopped'||drift==='uncertain')f.put('job',{...original,state:drift});
 if(drift==='reset')f.put('job',{...original,principalReset:{approval:'a-fixture',by:'jonathan',at:f.clock.now()}});
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:false});
 expect(f.store.ids('job')).toEqual([f.job]);expect(f.call('attention.get',{id:ask})).toMatchObject({ok:true,value:{state:'open'}});
});
it.each(['original-claim','new-claim','new-binding','source','credential'] as const)('holds successor words and ACK after %s drift',async drift=>{
 const f=await setup(),ask=await f.ask();expect(await f.post(f.runner,'finishJob',{job:f.job,state:'done'})).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 const job=f.store.ids('job').find(id=>id!==f.job)!;
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 const input=await f.post(f.runner,'takeInput',{job});expect(input).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 const record=f.store.read('job',job)!;
 if(drift==='original-claim')f.put('job',{...f.store.read('job',f.job)!,claimedAt:f.clock.now()+1});
 if(drift==='new-claim')f.put('job',{...record,claimedAt:record.claimedAt!+1});
 if(drift==='new-binding')f.put('binding',{...f.store.read('binding',record.conversation!)!,place:'other'});
 if(drift==='source')f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.prompt','changed')").run();
 if(drift==='credential')signin(f.app).tokens.change(ts=>{for(const t of ts)if(t.sha256===hash(input.value.credential))t.revoked=new Date(f.clock.now()).toISOString();});
 expect(await f.post(input.value.credential,'readPublicInputs',{})).toMatchObject({ok:false});
 expect(await f.post(input.value.credential,'acknowledgePublicInputs',{through:1})).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT released,consumed FROM runtime_public_inputs').get()).toEqual({released:null,consumed:null});
});

async function terminalSuccessor(f:Awaited<ReturnType<typeof setup>>){
 const ask=await f.ask({ask:'Which next step?',answers:'words'});
 expect(await f.post(f.runner,'finishJob',{job:f.job,state:'done'})).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'words',text:'  CONTINUATION_SENTINEL\n'}})).toMatchObject({ok:true});
 const job=f.store.ids('job').find(id=>id!==f.job)!;
 expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});
 return {ask,job};
}
it('holds both terminal start and answer words across restart in staging',async()=>{
 const f=await setup('pond'),{job,ask}=await terminalSuccessor(f);await f.restart(true);
 expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:false,code:'conflict'});
 expect(f.call('core.releaseEffect',{id:`runtime:input:${job}`})).toMatchObject({ok:true});
 const input=await f.post(f.runner,'takeInput',{job});expect(input).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 expect(await f.post(input.value.credential,'readPublicInputs',{})).toMatchObject({ok:false,code:'conflict'});
 const row=f.app.db.prepare('SELECT seq FROM runtime_public_inputs').get() as {seq:number};
 expect(f.call('core.releaseEffect',{id:`runtime:public-read:${job}:${row.seq}`})).toMatchObject({ok:true});
 const read=await f.post(input.value.credential,'readPublicInputs',{});
 expect(read).toMatchObject({ok:true,value:{messages:[{text:'  CONTINUATION_SENTINEL\n',origin:{job:f.job,question:{id:ask,ask:'Which next step?'}}}]}});
 expect(await f.post(input.value.credential,'readPublicInputs',{})).toEqual(read);
 expect(await f.post(input.value.credential,'acknowledgePublicInputs',{through:row.seq})).toMatchObject({ok:true});
});
it.each(['original','successor'] as const)('filters the entire successor correlation after %s becomes private',async which=>{
 const f=await setup(),{job}=await terminalSuccessor(f);
 const input=await f.post(f.runner,'takeInput',{job});expect(input).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 const read=await f.post(input.value.credential,'readPublicInputs',{});expect(read).toMatchObject({ok:true});
 expect(await f.post(input.value.credential,'acknowledgePublicInputs',{through:read.value.messages[0].seq})).toMatchObject({ok:true});
 expect(JSON.stringify(exportDatabase(f.app.db).find(t=>t.name==='runtime_public_inputs'))).toContain('CONTINUATION_SENTINEL');
 const privateJob=which==='original'?f.job:job;f.put('job',{...f.store.read('job',privateJob)!,member:'jonathan'});
 const tables=exportDatabase(f.app.db);
 for(const name of ['runtime_public_inputs','runtime_public_questions','runtime_public_conversations','runtime_public_continuations'])expect(tables.find(t=>t.name===name)!.rows).toEqual([]);
 expect(JSON.stringify(tables.find(t=>t.name==='core_effects'))).not.toContain(`runtime:input:${job}`);
 expect(JSON.stringify(tables.find(t=>t.name==='core_operations'))).not.toContain('runtime.acknowledgePublicInputs');
});
it.each(['claim','source'] as const)('rechecks successor %s after release preparation',async drift=>{
 let change=()=>{};const f=await setup(undefined,false,()=>change()),{job}=await terminalSuccessor(f);
 const input=await f.post(f.runner,'takeInput',{job});expect(input).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 change=()=>{if(drift==='claim')f.put('job',{...f.store.read('job',job)!,claimedAt:f.clock.now()+1});else f.app.db.prepare("UPDATE clock_wakes SET record=json_set(record,'$.prompt','changed')").run();};
 expect(await f.post(input.value.credential,'readPublicInputs',{})).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT consumed FROM runtime_public_inputs').get()).toEqual({consumed:null});
});
it('keeps terminal answer-person and creation authority independent',async()=>{
 const f=await setup('pond'),ask=await f.ask();expect(await f.post(f.runner,'finishJob',{job:f.job,state:'done'})).toMatchObject({ok:true});
 expect(await f.post(f.token('owner','pollock'),'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:false});
 const original=policy.mayCreate;
 vi.spyOn(policy,'mayCreate').mockImplementation((v,r,s,op)=>op==='runtime.queueBody'?false:original(v,r,s,op));
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:false});
 expect(f.store.ids('job')).toEqual([f.job]);expect(f.call('attention.get',{id:ask})).toMatchObject({ok:true,value:{state:'open'}});
});
it('continues a successor question after its own body ends without retargeting either predecessor',async()=>{
 const f=await setup(),{job}=await terminalSuccessor(f),input=await f.post(f.runner,'takeInput',{job});expect(input).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 expect(await f.post(input.value.credential,'recordTurn',{kind:'reply',outcome:'progressed'})).toMatchObject({ok:true});
 const asked=await f.post(input.value.credential,'writeDigest',{digest:{summary:'Next generation',needs_owner:f.question}});expect(asked).toMatchObject({ok:true});
 expect(await f.post(f.runner,'finishJob',{job,state:'done'})).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:asked.value.ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 const third=f.store.ids('job').find(id=>id!==f.job&&id!==job)!;expect(third).toBeTruthy();
 expect(await f.post(f.runner,'claimJob',{job:third})).toMatchObject({ok:true});
 const next=await f.post(f.runner,'takeInput',{job:third});expect(next).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job:third,state:'running'})).toMatchObject({ok:true});
 expect(await f.post(next.value.credential,'readPublicInputs',{})).toMatchObject({ok:true,value:{messages:[{origin:{job}}]}});
 expect(f.store.read('binding',f.store.read('job',f.job)!.conversation!)!.job).toBe(f.job);
 expect(f.store.read('binding',f.store.read('job',job)!.conversation!)!.job).toBe(job);
});

it.each(['claim','binding','original-claim'] as const)('rejects changed successor %s before issuing credentials or releasing runner input',async drift=>{
 const f=await setup(),{job}=await terminalSuccessor(f),record=f.store.read('job',job)!;
 if(drift==='claim')f.put('job',{...record,claimedAt:record.claimedAt!+1});
 if(drift==='binding')f.put('binding',{...f.store.read('binding',record.conversation!)!,place:'other'});
 if(drift==='original-claim')f.put('job',{...f.store.read('job',f.job)!,claimedAt:f.clock.now()+1});
 expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT * FROM core_effects WHERE id=?').get(`runtime:input:${job}`)).toBeUndefined();
 expect(signin(f.app).tokens.document()!.tokens.filter(t=>t.role===`agent:art@${job}`)).toEqual([]);
});

it('retains distinct predecessor senders without redelivering their queued inputs',async()=>{
 const f=await setup(),ask=await f.ask(),original=f.store.read('job',f.job)!,provenance=provenanceStore(f.app.db);
 f.app.db.transaction(()=>{
  provenance.note(original.conversation!,'art',{key:'old-mark',sender:{kind:'person',person:'mark'},at:f.clock.now()},['jonathan']);
  provenance.note(original.conversation!,'art',{key:'old-unknown',sender:{kind:'unknown'},at:f.clock.now()},['jonathan']);
 })();
 const before=provenance.read(original.conversation!)!;
 expect(before.history).toMatchObject({owner:true,people:['mark'],unknown:true});expect(before.queue.length).toBeGreaterThan(1);
 expect(await f.post(f.runner,'finishJob',{job:f.job,state:'done'})).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 const successor=f.store.ids('job').find(id=>id!==f.job)!,after=provenance.read(f.store.read('job',successor)!.conversation!)!;
 expect(after.history).toEqual(before.history);
 expect(after.queue).toEqual([{key:`public-answer:${ask}`,sender:{kind:'person',person:'jonathan'},at:f.clock.now()}]);
 expect(provenance.read(original.conversation!)).toEqual(before);
});
it('accepts the 100th generation but rolls back a 101st answer before creating unusable work',async()=>{
 const f=await setup(),rootAsk=await f.ask(),root=f.store.read('job',f.job)!,provenance=provenanceStore(f.app.db);
 expect(await f.post(f.runner,'finishJob',{job:f.job,state:'done'})).toMatchObject({ok:true});
 // Materialize 98 already-owned generations, then exercise the actual HTTP
 // metadata/answer/claim/credential path at both sides of the production bound.
 let prior=f.store.read('job',f.job)!;
 f.app.db.transaction(()=>{
  for(let n=2;n<=99;n++){
   const job=`generation-${n}`,conversation=`generation-conversation-${n}`;
   f.store.put('binding',{id:conversation,agent:'art',venue:'wake',place:`generation:${n}`,job},f.clock.now());
   const {changedAt:_,...record}=root;
   f.store.put('job',{...record,id:job,conversation,state:n===99?'running':'done',...(n===99?{}:{endedAt:f.clock.now()})},f.clock.now());
   provenance.put(conversation,{agent:'art',history:provenance.read(root.conversation!)!.history,queue:[]});
   const next=f.store.read('job',job)!;
   f.app.db.prepare('INSERT INTO runtime_public_continuations VALUES (?,?,?,?,?)').run(job,prior.id,rootAsk,runtimeDestination(f.app.db,prior),runtimeDestination(f.app.db,next));
   prior=next;
  }
 })();
 const body99=f.token(`agent:art@${prior.id}`);
 expect(await f.post(body99,'recordTurn',{kind:'note',outcome:'progressed'})).toMatchObject({ok:true});
 const ask99=await f.post(body99,'writeDigest',{digest:{summary:'At bound',needs_owner:f.question}});expect(ask99).toMatchObject({ok:true});
 expect(await f.post(f.runner,'finishJob',{job:prior.id,state:'done'})).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:ask99.value.ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 expect(f.store.ids('job')).toHaveLength(100);
 const job100=f.store.ids('job').find(id=>f.store.read('job',id)!.state==='queued')!;
 expect(await f.post(f.runner,'claimJob',{job:job100})).toMatchObject({ok:true});
 const input=await f.post(f.runner,'takeInput',{job:job100});expect(input).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job:job100,state:'running'})).toMatchObject({ok:true});
 expect(await f.post(input.value.credential,'readPublicInputs',{})).toMatchObject({ok:true});
 expect(await f.post(input.value.credential,'recordTurn',{kind:'note',outcome:'progressed'})).toMatchObject({ok:true});
 const ask100=await f.post(input.value.credential,'writeDigest',{digest:{summary:'No next generation',needs_owner:f.question}});expect(ask100).toMatchObject({ok:true});
 expect(await f.post(f.runner,'finishJob',{job:job100,state:'done'})).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:ask100.value.ask,answer:{kind:'yes'}},'generation-limit')).toMatchObject({ok:false,code:'conflict'});
 expect(f.store.ids('job')).toHaveLength(100);expect(f.call('attention.get',{id:ask100.value.ask})).toMatchObject({ok:true,value:{state:'open'}});
 expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id='generation-limit'").all()).toEqual([]);
});
it.each(['missing-root','cycle'] as const)('does not release a Clock continuation brief with %s ancestry',async drift=>{
 const f=await setup(),{job}=await terminalSuccessor(f);
 if(drift==='missing-root')f.app.db.prepare('DELETE FROM runtime_clock_turns').run();
 else f.app.db.prepare('UPDATE runtime_public_continuations SET original_job=? WHERE job=?').run(job,job);
 expect(await f.post(f.runner,'takeInput',{job})).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT * FROM core_effects WHERE id=?').get(`runtime:input:${job}`)).toBeUndefined();
});
it.each(['original-claim','new-claim','binding'] as const)('fences released successor ACKs and exact receipt retries after %s drift',async drift=>{
 const f=await setup(),{job}=await terminalSuccessor(f),input=await f.post(f.runner,'takeInput',{job});expect(input).toMatchObject({ok:true});
 expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});
 const read=await f.post(input.value.credential,'readPublicInputs',{});expect(read).toMatchObject({ok:true});
 const through=read.value.messages[0].seq;
 const ack=await f.post(input.value.credential,'acknowledgePublicInputs',{through},'successor-ack');expect(ack).toMatchObject({ok:true,value:{job,acknowledged:true}});
 expect(await f.post(input.value.credential,'acknowledgePublicInputs',{through},'successor-ack')).toEqual(ack);
 const before=f.app.db.prepare('SELECT * FROM runtime_public_inputs').all();
 const receipt=f.app.db.prepare("SELECT * FROM core_operations WHERE id='successor-ack'").all();expect(receipt).toHaveLength(1);
 const record=f.store.read('job',job)!;
 if(drift==='original-claim')f.put('job',{...f.store.read('job',f.job)!,claimedAt:f.clock.now()+1});
 if(drift==='new-claim')f.put('job',{...record,claimedAt:record.claimedAt!+1});
 if(drift==='binding')f.put('binding',{...f.store.read('binding',record.conversation!)!,place:'replacement'});
 expect(await f.post(input.value.credential,'acknowledgePublicInputs',{through})).toMatchObject({ok:false});
 expect(await f.post(input.value.credential,'acknowledgePublicInputs',{through},'successor-ack')).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT * FROM runtime_public_inputs').all()).toEqual(before);
 expect(f.app.db.prepare("SELECT * FROM core_operations WHERE id='successor-ack'").all()).toEqual(receipt);
});

it.each([false,true])('projects accepted public answers with their actual sender and successor=%s, surviving restart and retries',async successor=>{
 const f=await setup('pond'),ask=await f.ask({ask:'What next?',answers:'words'}),text='  VERBATIM ACCEPTED SENTINEL\n';
 if(successor)expect(await f.post(f.runner,'finishJob',{job:f.job,state:'done'})).toMatchObject({ok:true});
 expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'words',text}})).toMatchObject({ok:true});
 let body=f.body,job=f.job;
 if(successor){job=f.store.ids('job').find(id=>id!==f.job)!;expect(await f.post(f.runner,'claimJob',{job})).toMatchObject({ok:true});const input=await f.post(f.runner,'takeInput',{job});expect(input).toMatchObject({ok:true});body=input.value.credential;expect(await f.post(f.runner,'reportJob',{job,state:'running'})).toMatchObject({ok:true});}
 const before=f.app.db.prepare('SELECT * FROM attention_turns').all();
 await f.restart(true);
 expect(await f.post(body,'readPublicInputs',{})).toMatchObject({ok:false,code:'conflict'});
 const row=f.app.db.prepare('SELECT seq FROM runtime_public_inputs WHERE job=?').get(job) as {seq:number};
 expect(await f.post(body,'acknowledgePublicInputs',{through:row.seq})).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toEqual(before);
 expect(f.call('core.releaseEffect',{id:`runtime:public-read:${job}:${row.seq}`})).toMatchObject({ok:true});
 expect(await f.post(body,'readPublicInputs',{})).toMatchObject({ok:true,value:{messages:[{text}]}});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toEqual(before);
 f.clock.advance(765);
 expect(await f.post(body,'acknowledgePublicInputs',{through:row.seq},'metadata-ack')).toMatchObject({ok:true});
 await f.restart();f.clock.advance(1000);
 expect(await f.post(body,'acknowledgePublicInputs',{through:row.seq},'metadata-ack')).toMatchObject({ok:true});
 expect(await f.post(body,'acknowledgePublicInputs',{through:row.seq})).toMatchObject({ok:true});
 const turns=f.app.db.prepare('SELECT record FROM attention_turns ORDER BY rowid').all() as {record:string}[];
 expect(turns).toHaveLength(before.length+1);
 const incoming=JSON.parse(turns.at(-1)!.record);
 expect(incoming).toMatchObject({kind:'message',from:{kind:'person',slug:'jonathan'},project:'pond',agent:'art',venue:'runtime-clock',place:f.store.read('job',job)!.conversation,at:new Date(f.clock.now()-1000).toISOString()});
 expect(incoming).not.toHaveProperty('run');expect(incoming).not.toHaveProperty('text');expect(JSON.stringify(turns)).not.toContain(text.trim());
 expect(await f.post(body,'recordTurn',{kind:'reply',outcome:'answered'})).toMatchObject({ok:true,value:{latency_ms:1000}});
});
it('rolls back public answer acceptance and metadata on SQL failure, then retries once',async()=>{
 const f=await setup(),ask=await f.ask();expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 const read=await f.post(f.body,'readPublicInputs',{});expect(read).toMatchObject({ok:true});const through=read.value.messages[0].seq;
 const before=f.app.db.prepare('SELECT * FROM attention_turns').all();
 f.app.db.exec("CREATE TRIGGER fail_public_incoming BEFORE UPDATE OF consumed ON runtime_public_inputs BEGIN SELECT RAISE(ABORT,'fixture ACK failure'); END");
 expect(await f.post(f.body,'acknowledgePublicInputs',{through},'public-metadata-rollback')).toMatchObject({ok:false});
 expect(f.app.db.prepare('SELECT consumed FROM runtime_public_inputs').get()).toEqual({consumed:null});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toEqual(before);
 f.app.db.exec('DROP TRIGGER fail_public_incoming');
 expect(await f.post(f.body,'acknowledgePublicInputs',{through},'public-metadata-rollback')).toMatchObject({ok:true});
 expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(before.length+1);
});
it('retains central Attention policy when accepting a released public answer',async()=>{
 const f=await setup(),ask=await f.ask();expect(await f.post(f.owner,'attention.answer',{id:ask,answer:{kind:'yes'}})).toMatchObject({ok:true});
 const read=await f.post(f.body,'readPublicInputs',{});expect(read).toMatchObject({ok:true});const through=read.value.messages[0].seq,before=f.app.db.prepare('SELECT * FROM attention_turns').all();
 const original=policy.mayAct;let denials=0;vi.spyOn(policy,'mayAct').mockImplementation((v,r,s,...rest)=>{if(r.type==='attention.conversation'){denials++;return false;}return original(v,r,s,...rest);});
 expect(await f.post(f.body,'acknowledgePublicInputs',{through},'policy-incoming')).toMatchObject({ok:false,code:'denied'});expect(denials).toBeGreaterThan(0);
 expect(f.app.db.prepare('SELECT consumed FROM runtime_public_inputs').get()).toEqual({consumed:null});expect(f.app.db.prepare('SELECT * FROM attention_turns').all()).toEqual(before);
 vi.restoreAllMocks();expect(await f.post(f.body,'acknowledgePublicInputs',{through},'policy-incoming')).toMatchObject({ok:true});
});
