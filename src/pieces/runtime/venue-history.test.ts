import { slackDescribe } from '../bridges/slack-describe.js';
import { runtimeSlackDescribePermit, runtimeDiscordHistoryPermit } from './role.js';
import { discordApi } from '../bridges/discord-api.js';
import { venueSchema } from '../bridges/model.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { provenanceStore } from './provenance-store.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Result } from '../../core/index.js';
import { fixture } from '../../fixture.js';
import { signin, hash } from '../../core/signin/index.js';
import { runtimeStore } from './store.js';
const value=<T>(r:Result):T=>{expect(r.ok).toBe(true);return (r as {ok:true;value:T}).value;};
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{try{for(const f of cleanups.splice(0).reverse())await f();}finally{vi.restoreAllMocks();}});
async function setup(staging=false,member='jonathan'){
 const home=mkdtempSync(join(tmpdir(),'runtime-private-'));fixture(home);cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();const app=await startLoom({home,clock,next:true,staging,stdout:()=>{}});cleanups.push(()=>app.close());
 const auth=signin(app);app.db.transaction(()=>auth.tokens.replace({v:1,tokens:[]},{}))();let n=0;
 if(member!=='jonathan')app.db.transaction(()=>new HouseholdDatabase(app.db).change(home,raw=>{const m=(raw.members as Array<{person:string;agents:string[]}>).find(m=>m.person===member)!;m.agents=['art'];}))();
 const token=(role:string,person?:string)=>{const secret=randomBytes(32).toString('hex');auth.tokens.change(ts=>ts.push({role,...(person?{member:person}:{}),sha256:hash(secret),label:role,created:new Date(clock.now()).toISOString()}));return secret;};
 const owner=token('owner'),runner=token('runner:a'),unbound=token('agent:art');
 app.operations.call('direct',{kind:'member',id:'jonathan'},'signin.setPrincipal',{kind:'runner',id:'a',active:true},'enable');
 app.db.transaction(()=>{const store=runtimeStore(app.db);store.put('settings',{id:'art',agent:'art',boxes:['a'],house:{repo:'/fixture/art',houseFile:'house/house.json'}},clock.now());store.put('box',{id:'a',name:'A',owner:'jonathan',local:true,mayHost:'*',lentTo:member==='jonathan'?[]:['art'],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());})();
 const cookie=auth.createSession(hash(member==='jonathan'?owner:token('owner',member)));
 let ws=new WebSocket(app.url.replace('http:','ws:')+'/live',{headers:{cookie:`loom_ui=${cookie}`,origin:app.url}});await once(ws,'open');cleanups.push(()=>ws.terminate());
 const socket=(name:string,input:unknown)=>new Promise<Result>(resolve=>{const request=`socket-${++n}`;const receive=(raw:unknown)=>{const message=JSON.parse(String(raw));if(message.kind==='result'&&message.request===request){ws.off('message',receive);resolve(message.result);}};ws.on('message',receive);ws.send(JSON.stringify({kind:'call',name,input,id:request,request}));});
 const post=async(secret:string,name:string,input:unknown)=>{const [piece,op]=name.split('.');const r=await fetch(`${app.url}/api/${piece}/${op}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input,id:`http-${++n}`})});return r.json() as Promise<Result>;};
 const queued=async()=>{
  let jobs:string[]=[];
  for(let i=0;i<15&&!jobs.length;i++)jobs=value<{jobs:string[]}>(await post(runner,'runtime.claimableJobs',{})).jobs;
  expect(jobs).toHaveLength(1);return jobs[0];
 };
 const open=async()=>{const r=await socket('comms.open',{agent:'art',id:'abcdefghijklmnop',text:'PRIVATE inbound sentinel'});expect(r.ok).toBe(true);return value<{thread:string}>(r).thread;};
 return {app,clock,home,owner,runner,unbound,socket,post,open,queued,token};
}
const place={workspace:'300',channel:'400',kind:'channel' as const};
async function running(){
 const f=await setup(),thread=await f.open(),job=await f.queued();
 value(await f.post(f.runner,'runtime.claimJob',{job}));
 const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 const viewer=signin(f.app).token(hash(body))!.viewer;
 expect(runtimeDiscordHistoryPermit(f.app,viewer,place)).toBeUndefined();
 value(await f.post(f.runner,'runtime.reportJob',{job,state:'running'}));
 const permit=runtimeDiscordHistoryPermit(f.app,viewer,place);expect(permit?.current()).toBe(true);
 return {...f,thread,job,body,viewer,permit:permit!};
}
it('issues an exact permit from the real signed-in claimed owner body and consumes it in the merged Discord transport',async()=>{
 const f=await running();
 const use=vi.fn(async<T>(_name:string,read:(secret:string)=>Promise<T>)=>read('TEST-CREDENTIAL'));
 const request=vi.fn<typeof fetch>(async url=>Response.json(String(url).includes('/messages?')?
  [{id:'500',channel_id:'400',guild_id:'300',type:0,author:{id:'600'},content:'HISTORY WORDS'}]:{id:'400',guild_id:'300',type:0}));
 const venue=venueSchema.parse({id:'discord',platform:'discord',agent:'art',workspace:'300',bot:'100',tokenSecret:'discord'});
 const api=discordApi({withValue:use},()=>true,request);
 expect(f.permit).toMatchObject({agent:'art',...place});expect(Object.isFrozen(f.permit)).toBe(true);
 expect(await api.history(venue,{channel:'400',kind:'channel'},f.permit)).toEqual({messages:[expect.objectContaining({text:'HISTORY WORDS',user:'600'})]});
 expect(request).toHaveBeenCalledTimes(2);
 expect(await api.history(venue,{channel:'401',kind:'channel'},f.permit)).toBe('wait');
 expect(await api.history({...venue,workspace:'301'},{channel:'400',kind:'channel'},f.permit)).toBe('wait');
 expect(await api.history({...venue,agent:'mark'},{channel:'400',kind:'channel'},f.permit)).toBe('wait');
 expect(await api.history(venue,{channel:'400',kind:'thread'},f.permit)).toBe('wait');
 expect(request).toHaveBeenCalledTimes(2);
 const leaked=JSON.stringify(f.permit);expect(leaked).not.toMatch(/PRIVATE|HISTORY|CREDENTIAL|owner|jonathan|job/);
});
it('denies copied, unbound, wrong-job, service and non-body callers and malformed places',async()=>{
 const f=await running();
 for(const viewer of [{...f.viewer},{kind:'member',id:'jonathan'},{kind:'runner',id:'a'},{kind:'service',id:'bridges'},
  ...[f.unbound,f.token('agent:art@another'),f.token(`agent:art/discord@${f.job}`),f.token(`agent:mark@${f.job}`)].map(t=>signin(f.app).token(hash(t))!.viewer)] as const)
  expect(runtimeDiscordHistoryPermit(f.app,viewer,place)).toBeUndefined();
 for(const patch of [{channel:'01'},{workspace:'300/other'},{kind:'dm'},{principal:'owner'},{agent:'art'},{job:f.job}])
  expect(runtimeDiscordHistoryPermit(f.app,f.viewer,{...place,...patch} as typeof place)).toBeUndefined();
 expect(runtimeDiscordHistoryPermit(f.app,f.viewer,{...place,kind:'thread'})?.current()).toBe(true);
});
it.each(['credential','job','binding','claim','box','policy','history','membership','archive','service','close'] as const)('revokes the issued permit on current owning %s drift',async drift=>{
 const f=await running(),slack=runtimeSlackDescribePermit(f.app,f.viewer,slackPlace)!,store=runtimeStore(f.app.db),conversation=store.read('job',f.job)!.conversation!;
 if(drift==='credential')signin(f.app).tokens.change(ts=>{for(const t of ts)if(t.sha256===hash(f.body))t.revoked=new Date(f.clock.now()).toISOString();});
 if(drift==='job')value(await f.post(f.runner,'runtime.finishJob',{job:f.job,state:'done'}));
 if(drift==='binding')f.app.db.prepare("UPDATE runtime_bindings SET record=json_set(record,'$.place','different') WHERE id=?").run(conversation);
 if(drift==='claim')f.app.db.prepare("UPDATE runtime_jobs SET record=json_set(record,'$.claimedAt',?) WHERE id=?").run(f.clock.now()+1,f.job);
 if(drift==='box')f.app.db.prepare("UPDATE runtime_boxes SET record=json_set(record,'$.revokedAt',?) WHERE id='a'").run(f.clock.now());
 if(drift==='policy')value(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{}},policy:{}},'policy'));
 if(drift==='history')f.app.db.transaction(()=>{const p=provenanceStore(f.app.db);p.put(conversation,{...p.read(conversation)!,history:{owners:['jonathan'],owner:true,people:[],unknown:true}});})();
 if(drift==='membership')f.app.db.transaction(()=>new HouseholdDatabase(f.app.db).change(f.home,raw=>{const ms=raw.members as Array<{person:string;agents:unknown;role:string}>;ms.find(m=>m.person==='pollock')!.role='owner';ms.find(m=>m.person==='pollock')!.agents='*';ms.find(m=>m.person==='jonathan')!.agents=['art'];}))();
 if(drift==='archive')value(await f.socket('comms.change',{thread:f.thread,action:'archive'}));
 if(drift==='service')f.app.db.prepare("UPDATE runtime_jobs SET record=json_set(record,'$.service','discord') WHERE id=?").run(f.job);
 if(drift==='close')await f.app.close();
 expect(slack.current()).toBe(false);if(drift!=='claim')expect(runtimeSlackDescribePermit(f.app,f.viewer,slackPlace)).toBeUndefined();
 expect(f.permit.current()).toBe(false);if(drift!=='claim')expect(runtimeDiscordHistoryPermit(f.app,f.viewer,place)).toBeUndefined();
});
it('does not turn an authenticated nonowner private body into venue-read authority',async()=>{
 const f=await setup(false,'pollock');await f.open();const job=await f.queued();
 value(await f.post(f.runner,'runtime.claimJob',{job}));const body=value<{credential:string}>(await f.post(f.runner,'runtime.takeInput',{job})).credential;
 value(await f.post(f.runner,'runtime.reportJob',{job,state:'running'}));
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true});
 expect(runtimeDiscordHistoryPermit(f.app,signin(f.app).token(hash(body))!.viewer,place)).toBeUndefined();
 expect(runtimeSlackDescribePermit(f.app,signin(f.app).token(hash(body))!.viewer,slackPlace)).toBeUndefined();
});
it('withholds late history when the real owning credential is revoked between requests',async()=>{
 const f=await running(),use=vi.fn(async<T>(_name:string,read:(secret:string)=>Promise<T>)=>read('TEST-CREDENTIAL'));
 const request=vi.fn<typeof fetch>(async()=>{signin(f.app).tokens.change(ts=>{for(const t of ts)if(t.sha256===hash(f.body))t.revoked=new Date(f.clock.now()).toISOString();});return Response.json({id:'400',guild_id:'300',type:0});});
 const api=discordApi({withValue:use},()=>true,request),venue=venueSchema.parse({id:'discord',platform:'discord',agent:'art',workspace:'300',bot:'100',tokenSecret:'discord'});
 expect(await api.history(venue,{channel:'400',kind:'channel'},f.permit)).toBe('wait');expect(request).toHaveBeenCalledTimes(1);expect(use).toHaveBeenCalledTimes(1);
});
it('refuses an otherwise current service body whose job and credential agree',async()=>{
 const f=await running();
 f.app.db.prepare("UPDATE runtime_jobs SET record=json_set(record,'$.service','discord') WHERE id=?").run(f.job);
 const body=f.token(`agent:art/discord@${f.job}`),viewer=signin(f.app).token(hash(body))!.viewer;
 expect(await f.post(body,'runtime.readConversation',{})).toMatchObject({ok:true});
 expect(runtimeDiscordHistoryPermit(f.app,viewer,place)).toBeUndefined();
 expect(runtimeSlackDescribePermit(f.app,viewer,slackPlace)).toBeUndefined();
});
it('pins the original route even when the replacement is independently valid',async()=>{
 const f=await running(),slack=runtimeSlackDescribePermit(f.app,f.viewer,slackPlace)!;
 value(await f.socket('comms.change',{thread:f.thread,action:'project',project:'other'}));
 expect(await f.post(f.body,'runtime.readConversation',{})).toMatchObject({ok:true});
 expect(runtimeDiscordHistoryPermit(f.app,f.viewer,place)?.current()).toBe(true);
 expect(runtimeSlackDescribePermit(f.app,f.viewer,slackPlace)?.current()).toBe(true);expect(slack.current()).toBe(false);
 expect(f.permit.current()).toBe(false);
});
it('pins the transport place independently of an unchanged current principal and conversation',async()=>{
 const f=await running(),slack=runtimeSlackDescribePermit(f.app,f.viewer,slackPlace)!,next='th:replacement-place',store=runtimeStore(f.app.db),job=store.read('job',f.job)!;
 f.app.db.transaction(()=>{
  // Coherent owning metadata replacement: keep exactly one live thread for the
  // same conversation and member. No copied viewer or hypothetical role proof.
  f.app.db.prepare("INSERT INTO comms_threads SELECT ?,member,agent,project,json_set(record,'$.id',?) FROM comms_threads WHERE id=?").run(next,next,f.thread);
  f.app.db.prepare("DELETE FROM comms_threads WHERE id=?").run(f.thread);
  const {changedAt:_,...binding}=store.read('binding',job.conversation!)!;store.put('binding',{...binding,place:next},f.clock.now());
 })();
 expect(await f.post(f.body,'runtime.describeConversation',{})).toMatchObject({ok:true});
 expect(runtimeDiscordHistoryPermit(f.app,f.viewer,place)?.current()).toBe(true);
 expect(runtimeSlackDescribePermit(f.app,f.viewer,slackPlace)?.current()).toBe(true);expect(slack.current()).toBe(false);
 expect(f.permit.current()).toBe(false);
});
it('revokes an issued permit and refuses new issuance for an otherwise current waiting body',async()=>{
 const f=await running();value(await f.post(f.runner,'runtime.reportJob',{job:f.job,state:'waiting'}));
 expect(await f.post(f.body,'runtime.readConversation',{})).toMatchObject({ok:true});
 expect(runtimeSlackDescribePermit(f.app,f.viewer,slackPlace)).toBeUndefined();
 expect(runtimeDiscordHistoryPermit(f.app,f.viewer,place)).toBeUndefined();expect(f.permit.current()).toBe(false);
});
it('refuses owner-body issuance when retained sender history resolves to a named nonowner',async()=>{
 const f=await running(),conversation=runtimeStore(f.app.db).read('job',f.job)!.conversation!;
 f.app.db.transaction(()=>provenanceStore(f.app.db).note(conversation,'art',{
  key:'retained-nonowner',sender:{kind:'person',person:'pollock'},at:f.clock.now(),
 },['jonathan']))();
 expect(await f.post(f.body,'runtime.readConversation',{})).toMatchObject({ok:true});
 expect(runtimeSlackDescribePermit(f.app,f.viewer,slackPlace)).toBeUndefined();
 expect(runtimeDiscordHistoryPermit(f.app,f.viewer,place)).toBeUndefined();expect(f.permit.current()).toBe(false);
});

const slackPlace={venue:'slack',workspace:'TWORK',kind:'dm' as const,place:'UHUMAN'};
it('consumes an actual owning Slack describe permit for exact authenticated platform reads',async()=>{
 const f=await running(),permit=runtimeSlackDescribePermit(f.app,f.viewer,slackPlace)!;
 expect(permit?.current()).toBe(true);expect(Object.isFrozen(permit)).toBe(true);
 const use=vi.fn(async<T>(_name:string,read:(secret:string)=>Promise<T>)=>read('TEST-CREDENTIAL'));
 const request=vi.fn<typeof fetch>(async()=>Response.json({ok:true,user:{id:'UHUMAN',team_id:'TWORK',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false}}));
 const venue=venueSchema.parse({id:'slack',platform:'slack',agent:'art',workspace:'TWORK',bot:'UBOT',tokenSecret:'slack'});
 expect(await slackDescribe(venue,permit,{withValue:use},()=>true,request).describe()).toEqual({kind:'dm',place:'UHUMAN',humans:['UHUMAN']});
 for(const patch of [{id:'other'},{agent:'mark'},{workspace:'TOTHER'}])
  await expect(slackDescribe({...venue,...patch},permit,{withValue:use},()=>true,request).describe()).rejects.toThrow('Bridge describe unavailable');
 expect(request).toHaveBeenCalledOnce();
 expect(JSON.stringify(permit)).not.toMatch(/PRIVATE|CREDENTIAL|jonathan|job/);
 signin(f.app).tokens.change(ts=>{for(const t of ts)if(t.sha256===hash(f.body))t.revoked=new Date(f.clock.now()).toISOString();});
 expect(permit.current()).toBe(false);expect(runtimeSlackDescribePermit(f.app,f.viewer,slackPlace)).toBeUndefined();
 await expect(slackDescribe(venue,permit,{withValue:use},()=>true,request).describe()).rejects.toThrow('Bridge describe unavailable');
 expect(request).toHaveBeenCalledOnce();
});
it('refuses copied or unbound Slack callers and malformed exact places',async()=>{
 const f=await running();
 for(const viewer of [{...f.viewer},signin(f.app).token(hash(f.unbound))!.viewer,{kind:'member',id:'jonathan'}] as const)
  expect(runtimeSlackDescribePermit(f.app,viewer,slackPlace)).toBeUndefined();
 for(const patch of [{workspace:'T/other'},{venue:''},{place:'USLACKBOT'},{kind:'group'},{kind:'channel'},{agent:'art'},{principal:'owner'}])
  expect(runtimeSlackDescribePermit(f.app,f.viewer,{...slackPlace,...patch} as typeof slackPlace)).toBeUndefined();
 const group=runtimeSlackDescribePermit(f.app,f.viewer,{...slackPlace,kind:'group',place:'GPRIVATE'})!;
 expect(group).toMatchObject({agent:'art',...slackPlace,kind:'group',place:'GPRIVATE'});expect(group.current()).toBe(true);
 const venue=venueSchema.parse({id:'slack',platform:'slack',agent:'art',workspace:'TWORK',bot:'UBOT',tokenSecret:'slack'});
 const use={withValue:async<T>(_name:string,read:(secret:string)=>Promise<T>)=>read('TEST-CREDENTIAL')};
 const request=vi.fn<typeof fetch>(async(url,init)=>{
  const fields=new URLSearchParams(String(init?.body));
  if(String(url).endsWith('conversations.info'))return Response.json({ok:true,channel:{id:'GPRIVATE',is_mpim:true,is_im:false}});
  if(String(url).endsWith('conversations.members'))return Response.json({ok:true,members:['UBOT','UHUMAN','UOTHER'],response_metadata:{next_cursor:''}});
  return Response.json({ok:true,user:{id:fields.get('user'),team_id:'TWORK',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false}});
 });
 expect(await slackDescribe(venue,group,use,()=>true,request).describe()).toEqual({kind:'group',place:'GPRIVATE',humans:['UHUMAN','UOTHER']});
 expect(request).toHaveBeenCalledTimes(4);
});
