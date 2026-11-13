import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import type {WebSocket} from 'ws';
import {startLoom} from '../../foundation.js';
import {fixture} from '../../fixture.js';
import {FakeClock,type Result} from '../../core/index.js';
import {signin,hash} from '../../core/signin/index.js';
import {HouseholdDatabase} from '../../core/household/document.js';
import {SharingDatabase} from '../../core/household/sharing.js';
import {installSecrets} from '../secrets/index.js';
import {installSecretServices} from '../secrets/service.js';
import {installBridges} from '../bridges/index.js';
import {venueSchema} from '../bridges/model.js';
import {put} from '../bridges/store.js';
import {discordInbox} from '../bridges/discord-inbox.js';
import {slackInbox} from '../bridges/slack-inbox.js';
import {runtimeStore} from './store.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
const value=<T>(r:Result)=>{expect(r.ok,JSON.stringify(r)).toBe(true);return (r as {ok:true;value:T}).value;};
async function until(condition:()=>boolean){for(let i=0;i<5000;i++){if(condition())return;await Promise.resolve();}throw Error('condition not reached');}
async function setup(staging=false,platform:'slack'|'discord'='slack'){
 const home=mkdtempSync(join(tmpdir(),'runtime-bridge-'));fixture(home);const clock=new FakeClock();
 const posts:unknown[]=[];
 const source={generation:async()=> '00000000-0000-4000-8000-000000000000',read:async()=>Buffer.from('BRIDGE-TOKEN')};
 const request=vi.fn<typeof fetch>(async(url,init)=>{
  const method=String(url).split('/').pop();
  if(platform==='discord'){
   if(String(url).endsWith('users/@me'))return Response.json({id:'100',bot:true});
   if(String(url).endsWith('guilds/300'))return Response.json({id:'300'});
   if(init?.method==='POST'){posts.push(JSON.parse(String(init.body)));return Response.json({id:'900',channel_id:'400'});}
   return Response.json({id:'400',type:1,recipients:[{id:'200'}]});
  }
  if(method==='auth.test')return Response.json({ok:true,team_id:'T123',user_id:'U123',bot_id:'B123'});
  if(method==='bots.info')return Response.json({ok:true,bot:{id:'B123',user_id:'U123',deleted:false,app_id:'A123'}});
  if(method==='apps.connections.open')return Response.json({ok:true,url:'wss://wss-primary.slack.com/link?ticket=PRIVATE'});
  if(method==='conversations.info')return Response.json({ok:true,channel:{id:'D123',is_im:true,is_mpim:false,user:'U200'}});
  if(method==='chat.postMessage'){posts.push(JSON.parse(String(init?.body)));return Response.json({ok:true,channel:'D123',ts:'1794503533.000001'});}
  return Response.json({ok:true,user:{id:'U200',team_id:'T123',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false}});
 });
 const socket=()=>Object.assign(new EventEmitter(),{readyState:1,terminate:vi.fn(),send:vi.fn(),ping:vi.fn()}) as unknown as WebSocket;
 const venue=venueSchema.parse(platform==='discord'?{id:'discord',platform:'discord',workspace:'300',bot:'100',agent:'art',tokenSecret:'bot'}:{id:'slack',platform:'slack',workspace:'T123',bot:'U123',agent:'art',tokenSecret:'bot',appSecret:'app'});
 let foundation!:import('../../core/app.js').Foundation;
 let app=await startLoom({home,next:true,staging,clock,stdout:()=>{},bridges:{source,request,socket,discordSocket:socket},install(a){
  foundation=a;
  const sharing=()=>new SharingDatabase(a.db,home).sharing();installSecrets(a.db,a.operations,a.live,sharing);installSecretServices(a.db,a.operations,sharing);installBridges(a,sharing);
  for(const name of ['bot','app'])for(const [verb,input] of [['describe',{name,description:name}],['grantService',{service:'bridges',name}]] as const)value(a.operations.call('direct',{kind:'member',id:'jonathan'},`secrets.${verb}`,input,`${verb}-${name}`));
  put(a.db,'venues',venue);put(a.db,'links',{id:'person',platform,workspace:venue.workspace,user:platform==='slack'?'U200':'200',person:'jonathan'});
 }});
 cleanups.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
 let n=0;
 const token=(role:string)=>{const secret=randomBytes(32).toString('hex');signin(app).tokens.change(ts=>ts.push({role,sha256:hash(secret),label:role,created:new Date(clock.now()).toISOString()}));return secret;};
 const owner=token('owner'),runner=token('runner:a'),unbound=token('agent:art');
 value(app.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'a',active:true},'enable'));
 app.db.transaction(()=>{const store=runtimeStore(app.db);store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());store.put('box',{id:'a',name:'A',owner:'jonathan',local:true,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());})();
 const post=async(secret:string,name:string,input:unknown)=>{const [piece,op]=name.split('.');return (await fetch(`${app.url}/api/${piece}/${op}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input,id:`http-${++n}`})})).json() as Promise<Result>;};
 const receive=async(text='INBOUND PRIVATE',ts='1794503533.000000')=>{
  if(platform==='discord'){
   const epoch='00000000-0000-4000-8000-000000000000';const inbox=discordInbox(app.db,clock,{venue,credentialEpoch:epoch},()=>epoch);
   const checkpoint=(seq:number)=>({seq,session:'SESSION',url:'wss://gateway.discord.gg/?v=10&encoding=json'});
   const previous=inbox.load();if(!previous)await inbox.commit({type:'READY',seq:1,data:{user:{id:'100'},session_id:'SESSION'}},checkpoint(1));
   const seq=(previous?.seq??1)+1;await inbox.commit({type:'MESSAGE_CREATE',seq,data:{id:ts.replace('.',''),channel_id:'400',type:0,content:text,timestamp:'2026-11-13T00:00:00.000Z',author:{id:'200'},mentions:[],mention_roles:[]}},checkpoint(seq));
  }else await slackInbox(app.db,clock,{venue,app:'A123'}).receive({type:'event_callback',team_id:'T123',api_app_id:'A123',event_id:`Ev${ts.replace('.','')}`,event:{type:'message',channel:'D123',user:'U200',ts,text}});
  clock.advance(5000);
 };
 const release=()=>{for(const row of app.db.prepare("SELECT id FROM core_effects WHERE state='due'").all() as {id:string}[])value(app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',row,`release-${++n}`));clock.advance(0);};
 const running=async()=>{
  const jobs=value<{jobs:string[]}>(await post(runner,'runtime.claimableJobs',{})).jobs;expect(jobs).toHaveLength(1);const job=jobs[0];
  value(await post(runner,'runtime.claimJob',{job}));const input=await post(runner,'runtime.takeInput',{job});
  const body=value<{credential:string}>(input).credential;expect(body).toBeTruthy();
  value(await post(runner,'runtime.reportJob',{job,state:'running'}));return {job,body,input};
 };
 return {get app(){return app;},foundation,home,clock,posts,request,token,owner,runner,unbound,post,receive,release,running,async restart(){await app.close();app=await startLoom({home,next:true,staging,clock,stdout:()=>{},bridges:{source,request,socket,discordSocket:socket}});}};
}
it('routes a real installed DM through claim, scoped body input/read/reply and the actual durable engine',async()=>{
 const f=await setup();await f.receive();await until(()=>runtimeStore(f.app.db).ids('job').length===1);
 const {job,body,input}=await f.running();expect(JSON.stringify(input)).not.toContain('INBOUND PRIVATE');
 expect(runtimeStore(f.app.db).read('job',job)).toMatchObject({member:'jonathan',state:'running'});
 const read=await f.post(body,'runtime.readConversation',{});expect(read).toMatchObject({ok:true,value:{messages:[expect.objectContaining({text:'INBOUND PRIVATE',at:'2026-11-12T17:12:13.000Z'})]}});
 for(const secret of [f.owner,f.runner,f.unbound,f.token(`agent:mark@${job}`)]){
  expect(await f.post(secret,'runtime.readConversation',{})).toMatchObject({ok:false});
  expect(await f.post(secret,'runtime.reply',{id:'forged',text:'forged'})).toMatchObject({ok:false});
 }
 expect(await f.post(body,'runtime.reply',{id:'reply-1',job:'wrong',text:'no'})).toMatchObject({ok:false,code:'denied'});
 value(await f.post(body,'runtime.reply',{id:'reply-1',text:'OUTBOUND PRIVATE <@U200>'}));
 value(await f.post(body,'runtime.reply',{id:'reply-1',text:'OUTBOUND PRIVATE <@U200>'}));
 expect(await f.post(body,'runtime.reply',{id:'reply-1',text:'DIFFERENT'})).toMatchObject({ok:false,code:'conflict'});
 await until(()=>f.posts.length===1);expect(f.posts[0]).toMatchObject({channel:'D123',text:'OUTBOUND PRIVATE &lt;@U200&gt;',mrkdwn:false});
 expect(f.app.db.prepare('SELECT * FROM bridges_outbox').all()).toHaveLength(1);
 await f.receive('SECOND PRIVATE','1794503534.000000');await until(()=>f.app.db.prepare("SELECT id FROM runtime_bridge_turns WHERE direction='in'").all().length===2);
 expect(runtimeStore(f.app.db).ids('job')).toEqual([job]);
 value(await f.post(body,'runtime.reply',{id:'reply-1',text:'OUTBOUND PRIVATE <@U200>'}));expect(f.posts).toHaveLength(1);
 await f.restart();expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true});
 value(await f.post(body,'runtime.reply',{id:'reply-1',text:'OUTBOUND PRIVATE <@U200>'}));expect(f.posts).toHaveLength(1);
 for(const table of ['runtime_inputs','runtime_jobs','runtime_bindings','core_operations']){const rows=JSON.stringify(f.app.db.prepare(`SELECT * FROM ${table}`).all());expect(rows).not.toContain('PRIVATE');expect(rows).not.toContain(body);}
 const viewer=signin(f.app).token(hash(body))!.viewer;
 f.app.db.transaction(()=>new HouseholdDatabase(f.app.db).change(f.home,h=>{const members=h.members as Array<{person:string;role:string;agents:string[]|string}>;const m=members.find(m=>m.person==='jonathan')!;m.agents=[];m.role='member';const other=members.find(m=>m.person==='pollock')!;other.role='owner';other.agents='*';}))();
 expect(await f.app.operations.callAsync('direct',viewer,'runtime.reply',{id:'revoked',text:'NO'})).toMatchObject({ok:false,code:'denied'});
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:false});
});
it('keeps connection, inspection, body input and reply effects held separately in staging',async()=>{
 const f=await setup(true);await f.receive();expect(f.request).not.toHaveBeenCalled();expect(runtimeStore(f.app.db).ids('job')).toEqual([]);
 f.release();await until(()=>!!f.app.db.prepare("SELECT id FROM core_effects WHERE id LIKE 'bridges:inspect:%'").get());f.release();
 await until(()=>runtimeStore(f.app.db).ids('job').length===1);
 const job=runtimeStore(f.app.db).ids('job')[0];value(await f.post(f.runner,'runtime.claimJob',{job}));
 expect(await f.post(f.runner,'runtime.takeInput',{job})).toMatchObject({ok:false,code:'conflict'});f.release();
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;value(await f.post(f.runner,'runtime.reportJob',{job,state:'running'}));
 value(await f.post(body,'runtime.reply',{id:'staged',text:'STAGED PRIVATE'}));expect(f.posts).toEqual([]);
 await until(()=>!!f.app.db.prepare("SELECT id FROM core_effects WHERE id LIKE 'bridges:bridge-reply:%'").get());f.release();await until(()=>f.posts.length===1);
});
it('stops a bound body once and prevents old credentials from replying to the next body',async()=>{
 const f=await setup();await f.receive();await until(()=>runtimeStore(f.app.db).ids('job').length===1);const first=await f.running();
 const changes:string[]=[];const stop=f.app.live.observe(cs=>changes.push(...cs.filter(c=>c.type==='runtime.job').map(c=>c.id)));
 await f.receive('stop','1794503534.000000');await until(()=>runtimeStore(f.app.db).read('job',first.job)?.state==='stopped');
 expect(changes).toContain(first.job);expect(changes).not.toContain('*');stop();
 expect(await f.post(first.body,'runtime.reply',{id:'late',text:'NO'})).toMatchObject({ok:false});
 await f.receive('next','1794503535.000000');await until(()=>runtimeStore(f.app.db).ids('job').length===2);const second=await f.running();expect(second.job).not.toBe(first.job);
 await f.receive('stop','1794503534.000000');expect(runtimeStore(f.app.db).read('job',second.job)?.state).toBe('running');
});

it('rolls back the start and receipt together, deduplicates beyond registry expiry, and refuses public source forgery',async()=>{
 const {createFoundation}=await import('../../core/app.js');
 const {installRuntime}=await import('./index.js');
 const {bridgeRuntime,BRIDGE_BRIEF}=await import('./bridges.js');
 const home=mkdtempSync(join(tmpdir(),'bridge-runtime-receipt-')),clock=new FakeClock();
 const app=createFoundation({home,clock});cleanups.push(async()=>{app.close();rmSync(home,{recursive:true,force:true});});
 const sharing=()=>({members:{jonathan:{owner:true,agents:['art']}},projects:{},services:{}});
 const bodies=bridgeRuntime(app,sharing,()=>undefined);installRuntime(app.db,app.operations,app.live,sharing,{privateStart:bodies.privateStart});bodies.connect({currentIncoming:()=>true,reply(){throw Error('No body replies in receipt fixture');}});
 app.db.transaction(()=>{const store=runtimeStore(app.db);store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());store.put('box',{id:'a',name:'A',owner:'jonathan',local:true,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());})();
 const incoming={id:'source',key:{agent:'art',who:'jonathan',venue:'discord:100:dm:jonathan'},person:'jonathan',text:'PRIVATE',at:'2026-11-13T00:00:00.000Z',address:{channel:'200',dm:true}};
 const admission={agent:'art',person:'jonathan',venue:incoming.key.venue,channel:'200',dm:true,readers:[],peer:false};
 expect(await bodies.runtime.admit(admission)).toBe('allow');
 expect(await bodies.runtime.admit({...admission,person:'stranger'})).toBe('drop');
 for(const patch of [{group:true},{peer:true},{dm:false},{readers:['stranger']}])expect(await bodies.runtime.admit({...admission,...patch})).toBe('wait');
 expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'runtime.acceptBridge',incoming,'forgery')).toMatchObject({ok:false,code:'denied'});
 expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'runtime.startBody',{agent:'art',member:'jonathan',conversation:'forged',title:'Forged',brief:BRIDGE_BRIEF},'forged-start')).toMatchObject({ok:false,code:'unavailable'});
 app.db.exec("CREATE TRIGGER fail_bridge_turn BEFORE INSERT ON runtime_bridge_turns BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 expect(await bodies.runtime.deliver(incoming)).toBe('retry');expect(runtimeStore(app.db).ids('job')).toEqual([]);expect(runtimeStore(app.db).ids('binding')).toEqual([]);
 app.db.exec('DROP TRIGGER fail_bridge_turn');expect(await bodies.runtime.deliver(incoming)).toBe('delivered');
 expect(await bodies.runtime.deliver(incoming)).toBe('delivered');clock.advance(31*86400_000);expect(await bodies.runtime.deliver(incoming)).toBe('delivered');
 expect(runtimeStore(app.db).ids('job')).toHaveLength(1);expect(app.db.prepare('SELECT * FROM runtime_bridge_turns').all()).toHaveLength(1);
 expect(await bodies.runtime.deliver({...incoming,text:'CHANGED'})).toBe('retry');expect(app.db.prepare('SELECT * FROM runtime_bridge_turns').all()).toHaveLength(1);
 expect(await bodies.runtime.deliver({...incoming,id:'other',address:{channel:'200',dm:false}})).toBe('held');
 bodies.close();expect(await bodies.runtime.deliver(incoming)).toBe('retry');
});
it('holds an already queued reply when an outside account is relinked to another admitted member',async()=>{
 const f=await setup(true);await f.receive();f.release();await until(()=>!!f.app.db.prepare("SELECT id FROM core_effects WHERE id LIKE 'bridges:inspect:%'").get());f.release();await until(()=>runtimeStore(f.app.db).ids('job').length===1);
 const job=runtimeStore(f.app.db).ids('job')[0];value(await f.post(f.runner,'runtime.claimJob',{job}));await f.post(f.runner,'runtime.takeInput',{job});f.release();
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;value(await f.post(f.runner,'runtime.reportJob',{job,state:'running'}));
 value(await f.post(body,'runtime.reply',{id:'relinked',text:'ONLY FOR JONATHAN'}));await until(()=>!!f.app.db.prepare("SELECT id FROM core_effects WHERE id LIKE 'bridges:bridge-reply:%'").get());
 f.app.db.transaction(()=>new HouseholdDatabase(f.app.db).change(f.home,h=>{(h.members as Array<{person:string;agents:string[]}>).find(m=>m.person==='pollock')!.agents=['art'];}))();
 value(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'bridges.putLinks',{id:'person',platform:'slack',workspace:'T123',user:'U200',person:'pollock'},'relink'));
 f.release();await until(()=>!!f.app.db.prepare("SELECT id FROM bridges_outbox WHERE state='held'").get());expect(f.posts).toEqual([]);
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:false});expect(await f.post(body,'runtime.reply',{id:'new',text:'NO'})).toMatchObject({ok:false});
});
it('rolls back reply transcript, outbox and live notification together before a successful retry',async()=>{
 const f=await setup();await f.receive();await until(()=>runtimeStore(f.app.db).ids('job').length===1);const {body}=await f.running();
 const changed:string[]=[];const stop=f.app.live.observe(changes=>changed.push(...changes.filter(c=>c.type==='bridges.send').map(c=>c.id)));
 f.app.db.exec("CREATE TRIGGER fail_reply_turn BEFORE INSERT ON runtime_bridge_turns WHEN NEW.direction='out' BEGIN SELECT RAISE(ABORT,'reply interrupted'); END");
 expect(await f.post(body,'runtime.reply',{id:'atomic',text:'ATOMIC WORDS'})).toMatchObject({ok:false,code:'unavailable'});
 expect(f.app.db.prepare('SELECT * FROM bridges_outbox').all()).toEqual([]);expect(f.app.db.prepare("SELECT * FROM runtime_bridge_turns WHERE direction='out'").all()).toEqual([]);expect(changed).toEqual([]);expect(f.posts).toEqual([]);
 f.app.db.exec('DROP TRIGGER fail_reply_turn');value(await f.post(body,'runtime.reply',{id:'atomic',text:'ATOMIC WORDS'}));await until(()=>f.posts.length===1);expect(changed.length).toBeGreaterThan(0);stop();
});
it.each(['box','house'] as const)('denies retained body read/reply proof after %s execution configuration changes',async kind=>{
 const f=await setup();await f.receive();await until(()=>runtimeStore(f.app.db).ids('job').length===1);const {body}=await f.running();
 const viewer=signin(f.app).token(hash(body))!.viewer;
 f.app.db.transaction(()=>{const store=runtimeStore(f.app.db);if(kind==='box'){const {changedAt:_,...box}=store.read('box','a')!;store.put('box',{...box,revokedAt:f.clock.now()},f.clock.now());}else{const {changedAt:_,...settings}=store.read('settings','art')!;store.put('settings',{...settings,house:{repo:'/fixture/changed',houseFile:'house/other.json'}},f.clock.now());}})();
 expect(await f.app.operations.callAsync('direct',viewer,'runtime.readConversation',{})).toMatchObject({ok:false,code:'denied'});
 expect(await f.app.operations.callAsync('direct',viewer,'runtime.reply',{id:'late',text:'NO'})).toMatchObject({ok:false,code:'denied'});expect(f.posts).toEqual([]);
});
it('denies retained body viewers at root shutdown while SQLite is still open',async()=>{
 const {closeNext}=await import('../../next.js');const {Bridges}=await import('../bridges/engine.js');
 const f=await setup();await f.receive();await until(()=>runtimeStore(f.app.db).ids('job').length===1);const {body}=await f.running();
 const viewer=signin(f.app).token(hash(body))!.viewer;
 // A snapshot-true source fake isolates the runtime's own close guard from the
 // engine's independent closed-source guard.
 const snapshot=vi.spyOn(Bridges.prototype,'currentIncoming').mockReturnValue(true);
 try{await closeNext(f.foundation);expect(f.app.db.open).toBe(true);
  expect(await f.app.operations.callAsync('direct',viewer,'runtime.readConversation',{})).toMatchObject({ok:false,code:'denied'});
  expect(await f.app.operations.callAsync('direct',viewer,'runtime.reply',{id:'closed',text:'NO'})).toMatchObject({ok:false,code:'denied'});
 }finally{snapshot.mockRestore();}
});
it('upgrades version-seven storage atomically without altering existing runtime metadata',async()=>{
 const {createFoundation}=await import('../../core/app.js');const {migrate}=await import('../../core/index.js');const {schema}=await import('./schema/001.js');
 const home=mkdtempSync(join(tmpdir(),'runtime-bridge-upgrade-')),app=createFoundation({home});cleanups.push(async()=>{app.close();rmSync(home,{recursive:true,force:true});});
 migrate(app.db,'runtime',schema.filter(m=>m.number<8));app.db.transaction(()=>runtimeStore(app.db).put('settings',{id:'art',agent:'art',boxes:['a']},123))();
 const before=app.db.prepare('SELECT * FROM runtime_settings').all();app.db.exec("CREATE TRIGGER fail_bridge_migration BEFORE INSERT ON core_migrations WHEN NEW.piece='runtime' AND NEW.number=8 BEGIN SELECT RAISE(ABORT,'interrupted'); END");
 expect(()=>migrate(app.db,'runtime',schema)).toThrow('interrupted');expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'runtime_bridge_%'").all()).toEqual([]);expect(app.db.prepare('SELECT * FROM runtime_settings').all()).toEqual(before);
 app.db.exec('DROP TRIGGER fail_bridge_migration');migrate(app.db,'runtime',schema);expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('runtime_bridge_turns','runtime_bridge_stops')").all()).toHaveLength(2);expect(app.db.prepare('SELECT * FROM runtime_settings').all()).toEqual(before);
});
it('runs Discord private receipt intake through installed body read/reply and the real adapter',async()=>{
 const f=await setup(false,'discord');await f.receive('DISCORD PRIVATE');await until(()=>runtimeStore(f.app.db).ids('job').length===1);
 const {body}=await f.running();expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true,value:{messages:[expect.objectContaining({text:'DISCORD PRIVATE'})]}});
 value(await f.post(body,'runtime.reply',{id:'discord-reply',text:'DISCORD OUTBOUND <@200>'}));await until(()=>f.posts.length===1);
 expect(f.posts[0]).toMatchObject({content:'DISCORD OUTBOUND <@200>',allowed_mentions:{parse:[],replied_user:false}});
 value(await f.post(body,'runtime.reply',{id:'discord-reply',text:'DISCORD OUTBOUND <@200>'}));expect(f.posts).toHaveLength(1);
 expect(f.app.db.prepare('SELECT state,event FROM bridges_discord_receipts').get()).toEqual({state:'consumed',event:null});
});
it('deduplicates the trusted runtime stop callback against a replacement body across restart',async()=>{
 const module=await import('./bridges.js'),original=module.bridgeRuntime,roles:ReturnType<typeof original>[]=[];
 const capture=vi.spyOn(module,'bridgeRuntime').mockImplementation((...args)=>{const role=original(...args);roles.push(role);return role;});
 try{const f=await setup();await f.receive();await until(()=>runtimeStore(f.app.db).ids('job').length===1);await f.running();
  await f.receive('stop','1794503534.000000');await until(()=>!!f.app.db.prepare('SELECT id FROM runtime_bridge_stops').get());
  const {id}=f.app.db.prepare('SELECT id FROM runtime_bridge_stops').get() as {id:string};
  await f.receive('replacement','1794503535.000000');await until(()=>runtimeStore(f.app.db).ids('job').length===2);const {job,body}=await f.running();
  const stopped={agent:'art',person:'jonathan',venue:'slack:T123:dm:jonathan',id};
  await roles[0].runtime.stop(stopped);expect(runtimeStore(f.app.db).read('job',job)?.state).toBe('running');
  await f.restart();expect(roles).toHaveLength(2);await roles[1].runtime.stop(stopped);
  expect(runtimeStore(f.app.db).read('job',job)?.state).toBe('running');expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true});
 }finally{capture.mockRestore();}
});
