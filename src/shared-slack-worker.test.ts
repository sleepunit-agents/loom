/** Real Root/worker/body code; fake holder process and Slack/provider IO leaves. */
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {exampleHome} from './example-home.js';
import {exampleSettleMs} from './example-runtime.js';
import {startSharedHome} from './shared-startup.js';
import * as s from './core/data/schema.js';
import type {bridgeSlackSocket} from './pieces/bridges/slack-socket.js';
// The shared executor is an MJS measurement port over the built worker/body.
// @ts-expect-error measurement scripts do not ship declarations
import {nativeProtocolSmoke} from '../scripts/rebuild-native-protocol.mjs';
type Holder=Awaited<ReturnType<typeof import('../test/fixtures/shared-holder.js').inProcessSharedHolder>>;
const wire=vi.hoisted(()=>({slack:vi.fn<typeof bridgeSlackSocket>(),holders:[] as Holder[]}));
vi.mock('./shared-holder-process.js',async()=>{const {inProcessSharedHolder}=await import('../test/fixtures/shared-holder.js');return{async startSharedHolder(...args:Parameters<typeof inProcessSharedHolder>){const value=await inProcessSharedHolder(...args);wire.holders.push(value);return value;}};});
vi.mock('./pieces/bridges/slack-socket.js',async original=>({...await original<typeof import('./pieces/bridges/slack-socket.js')>(),bridgeSlackSocket:wire.slack}));
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.unstubAllGlobals();vi.unstubAllEnvs();wire.slack.mockReset();wire.holders.length=0;});
it('runs Slack input through the actual worker/body and returns one reply to its originating thread',async()=>{
 vi.stubEnv('LOOM_PUBLIC_URL',undefined);vi.stubEnv('LOOM_WORKER_SOCKET',undefined);
 const parent=mkdtempSync(join(tmpdir(),'loom-slack-worker-')),home=join(parent,'home'),webRoot=join(parent,'web');clean.push(()=>rmSync(parent,{recursive:true,force:true}));mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>Fictitious household</main>');
 const example=await exampleHome(home,webRoot),clock=new FakeClock(Date.parse(example.createdAt));
 const stamp=(fraction:string)=>String(Math.floor(clock.now()/1000))+'.'+fraction;
 const file=join(home,'program.json'),program=JSON.parse(readFileSync(file,'utf8'));program.secretHolder=true;writeFileSync(file,JSON.stringify(program),{mode:0o600});
 let link='';const posted:Array<Record<string,unknown>>=[];const realFetch=globalThis.fetch;
 vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));if(url.hostname==='127.0.0.1')return realFetch(input,init);
  expect(url.origin).toBe('https://slack.com');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer FICTITIOUS_SLACK_BOT');
  if(url.pathname==='/api/auth.test')return Response.json({ok:true,user_id:'UBOT',team_id:'TWORK',bot_id:'BBOT'});
  if(url.pathname==='/api/bots.info')return Response.json({ok:true,bot:{id:'BBOT',user_id:'UBOT',app_id:'AAPP',deleted:false}});
  if(url.pathname==='/api/conversations.info')return Response.json({ok:true,channel:{id:'CROOM',context_team_id:'TWORK',is_channel:true}});
  if(url.pathname==='/api/chat.postMessage'){const body=JSON.parse(String(init?.body));posted.push(body);return Response.json({ok:true,channel:body.channel,ts:stamp('000900')});}
  throw Error('Unexpected outside request');
 }));
 wire.slack.mockImplementation(options=>{options.state?.('connected');return{close:async()=>{}};});
 const app=await startSharedHome({home,webRoot,clock,port:0,stdout:text=>{link=text.trim();}});clean.push(()=>app.close());
 // Drain the example household's two existing jobs before this single-job proof.
 const base={app,example,clock,home};expect((await nativeProtocolSmoke(base)).runs).toHaveLength(2);
 const signin=await fetch(link,{method:'POST',redirect:'manual'});expect(signin.status).toBe(303);const cookie=signin.headers.get('set-cookie')!.split(';')[0];
 const command=async(operation:string,input:unknown)=>{
  // Bridge settings have no outside command: installed code sets them, anyone else proposes.
  if(operation==='bridges/command'&&(input as {action?:string}).action!=='review'){app.writes.run(()=>app.services.setup.bridge(input as never));return;}
const response=await fetch(app.url+'/api/'+operation,{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true});};
 await command('secrets/set',{id:randomUUID(),name:'SLACK_BOT',value:'FICTITIOUS_SLACK_BOT',mode:'add'});await command('secrets/set',{id:randomUUID(),name:'SLACK_APP',value:'FICTITIOUS_SLACK_APP',mode:'add'});
 await command('bridges/command',{action:'channel',platform:'slack',workspace:'TWORK',channel:'CROOM',answers:'moss',botsMayTalk:false});
 await command('bridges/command',{action:'person',platform:'slack',workspace:'TWORK',user:'UOWNER',member:'alex'});
 await command('bridges/command',{action:'connection',id:'slack-daily',platform:'slack',workspace:'TWORK',botUser:'UBOT',agent:'moss',tokenSecret:'SLACK_BOT',appSecret:'SLACK_APP',enabled:true,only:[],ignore:[]});
 const daemon=app.services.bridges.daemon!,db=app.services.comms!.db;await daemon.idle();clock.advance(5000);await wire.holders[0].source.generation();await daemon.idle();clock.advance(5000);await expect.poll(()=>wire.slack.mock.calls.length).toBe(1);await daemon.idle();
 const socket=wire.slack.mock.calls[0][0],root=stamp('000001'),words='A fictitious day-one Slack question';
 // Envelope/event shapes follow Slack's Socket Mode and message.channels docs.
 const frame={type:'events_api',envelope_id:'slack-daily',accepts_response_payload:false,retry_attempt:0,retry_reason:'',payload:{type:'event_callback',event_id:'slack-daily',team_id:'TWORK',api_app_id:'AAPP',event_time:Math.floor(clock.now()/1000),authorizations:[{enterprise_id:null,team_id:'TWORK',user_id:'UBOT',is_bot:true,is_enterprise_install:false}],event:{type:'message',channel:'CROOM',channel_type:'channel',user:'UOWNER',text:words,ts:root,event_ts:root}}};
 await socket.receive({},Buffer.from(JSON.stringify(frame)));clock.advance(0);await daemon.idle();
 const incoming=db.select().from(s.bridgeIncoming).get()!;expect(incoming).toMatchObject({state:'delivered',member:'alex',thread:root});expect(db.select().from(s.inbox).all().filter(row=>row.source==='slack')).toHaveLength(1);
 clock.advance(exampleSettleMs);await daemon.idle();const job=db.select().from(s.jobs).where(eq(s.jobs.conversation,incoming.conversation!)).get()!;expect(job).toMatchObject({agent:'moss',state:'queued'});
 // SPINE owns the executor/cleanup; targets assert its complete pending queue.
 let providerCalls=0;
 const result=await nativeProtocolSmoke({...base,targets:[{id:job.id,words}],native:async()=>{providerCalls++;return{text:'A fictitious day-one Slack answer',model:'fixture-slack-observed-model',actions:[]};}});
 expect(providerCalls).toBe(1);
 expect(result.runs).toMatchObject([{job:job.id,running:true,currentJob:job.id,state:'done',bootstrapErased:true}]);await daemon.idle();
 expect(posted).toEqual([expect.objectContaining({channel:'CROOM',thread_ts:root,text:'A fictitious day-one Slack answer'})]);
 expect(db.select().from(s.bridgeSends).get()).toMatchObject({state:'sent',thread:root});expect(db.select().from(s.jobs).where(eq(s.jobs.id,job.id)).get()?.state).toBe('done');
 await socket.receive({},Buffer.from(JSON.stringify(frame)));clock.advance(0);await daemon.idle();expect(posted).toHaveLength(1);
 await socket.receive({},Buffer.from(JSON.stringify({...frame,envelope_id:'slack-retry',retry_attempt:1,retry_reason:'timeout'})));clock.advance(0);await daemon.idle();expect(posted).toHaveLength(1);
 await socket.receive({},Buffer.from(JSON.stringify({...frame,envelope_id:'slack-redelivery',payload:{...frame.payload,event_id:'slack-redelivery'}})));clock.advance(0);await daemon.idle();expect(posted).toHaveLength(1);
 const echo={...frame,envelope_id:'slack-self-echo',payload:{...frame.payload,event_id:'slack-self-echo',event:{...frame.payload.event,user:'UBOT',bot_id:'BBOT',subtype:'bot_message',thread_ts:root,ts:stamp('000900'),event_ts:stamp('000900'),text:'A fictitious day-one Slack answer'}}};
 await socket.receive({},Buffer.from(JSON.stringify(echo)));clock.advance(0);await daemon.idle();expect(posted).toHaveLength(1);expect(db.select().from(s.bridgeIncoming).all().find(row=>row.user==='UBOT')?.state).toBe('dropped');
 const ownUser={...echo,envelope_id:'slack-own-user',payload:{...echo.payload,event_id:'slack-own-user',event:{...frame.payload.event,user:'UBOT',thread_ts:root,ts:stamp('000902'),event_ts:stamp('000902')}}};
 await socket.receive({},Buffer.from(JSON.stringify(ownUser)));clock.advance(0);await daemon.idle();expect(posted).toHaveLength(1);
 expect(db.select().from(s.bridgeIncoming).all().filter(row=>row.user==='UBOT')).toHaveLength(2);
 expect(db.select().from(s.bridgeIncoming).all().filter(row=>row.user==='UBOT').every(row=>row.state==='dropped')).toBe(true);
 clock.advance(exampleSettleMs);await daemon.idle();
 expect(db.select().from(s.inbox).all().filter(row=>row.source==='slack')).toHaveLength(1);expect(db.select().from(s.jobs).where(eq(s.jobs.conversation,incoming.conversation!)).all()).toHaveLength(1);
 expect(db.select().from(s.bridgeSends).all()).toHaveLength(1);
});
