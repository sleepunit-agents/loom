/** Normal first install, real in-process holder protocol/store, fake platform IO.
 * These fixtures do not claim physical child-process isolation. */
import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {initializeSharedHome} from './shared-initialize.js';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {startSharedHome} from './shared-startup.js';
import * as s from './core/data/schema.js';
import type {bridgeSlackSocket} from './pieces/bridges/slack-socket.js';
const wire=vi.hoisted(()=>({slack:vi.fn<typeof bridgeSlackSocket>()}));
vi.mock('./shared-holder-process.js',async()=>({startSharedHolder:(await import('../test/fixtures/shared-holder.js')).inProcessSharedHolder}));
vi.mock('./pieces/bridges/slack-socket.js',async original=>({...await original<typeof import('./pieces/bridges/slack-socket.js')>(),bridgeSlackSocket:wire.slack}));
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.unstubAllGlobals();vi.restoreAllMocks();vi.unstubAllEnvs();wire.slack.mockReset();});
it('uses the owned holder for owner-configured Slack authentication, admission, sends and revocation',async()=>{
 vi.stubEnv('LOOM_PUBLIC_URL',undefined);vi.stubEnv('LOOM_WORKER_SOCKET',undefined);
 const parent=mkdtempSync(join(tmpdir(),'loom-default-bridges-')),home=join(parent,'home'),webRoot=join(parent,'web');
 mkdirSync(home);mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>Fictitious home</main>');
 clean.push(()=>rmSync(parent,{recursive:true,force:true}));
 const clock=new FakeClock(Date.parse('2026-11-15T18:00:00Z'));let link='';
 const closed=vi.fn(async()=>{});let transport:Parameters<typeof bridgeSlackSocket>[0]|undefined;
 wire.slack.mockImplementation(options=>{transport=options;options.state?.('connected');return{close:closed};});
 const realFetch=globalThis.fetch,platform=vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.hostname==='127.0.0.1')return realFetch(input,init);
  expect(url.origin).toBe('https://slack.com');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer FICTITIOUS_BOT_TOKEN');
  if(url.pathname==='/api/auth.test')return Response.json({ok:true,user_id:'UBOT',team_id:'TWORK',bot_id:'BBOT'});
  if(url.pathname==='/api/bots.info')return Response.json({ok:true,bot:{id:'BBOT',user_id:'UBOT',app_id:'AAPP',deleted:false}});
  if(url.pathname==='/api/conversations.info')return Response.json({ok:true,channel:{id:'CROOM',context_team_id:'TWORK',is_channel:true}});
  if(url.pathname==='/api/chat.postMessage')return Response.json({ok:true,channel:'CROOM',ts:'1794765600.000009'});
  throw Error('Unexpected platform endpoint');
 });
 vi.stubGlobal('fetch',platform);
 const app=await startSharedHome({home,webRoot,clock,port:0,stdout:text=>{link=text.trim();}});clean.push(()=>app.close());
 const program=JSON.parse(readFileSync(join(home,'program.json'),'utf8'));
 expect(program.adapters).toBeUndefined();expect(app.services.bridges.daemon).toBeDefined();
 const daemon=app.services.bridges.daemon!,db=app.services.comms!.db;
 const response=await fetch(link,{method:'POST',redirect:'manual'});expect(response.status).toBe(303);
 const cookie=response.headers.get('set-cookie')!.split(';')[0];
 const command=async(path:string,input:unknown)=>{
  const result=await fetch(app.url+'/api/'+path,{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});
  expect(result.status).toBe(200);expect(await result.json()).toMatchObject({ok:true});
 };
 for(const [name,value]of [['TOKEN','FICTITIOUS_BOT_TOKEN'],['APP','FICTITIOUS_APP_TOKEN']])await command('secrets/set',{id:randomUUID(),name,value,mode:'add'});
 // Refresh the holder epoch before starting authentication; do not jump across
 // an in-flight private IPC deadline merely to refresh a different timer.
 clock.advance(5000);
 await command('bridges/command',{action:'channel',platform:'slack',workspace:'TWORK',channel:'CROOM',answers:'assistant',botsMayTalk:false});
 await command('bridges/command',{action:'person',platform:'slack',workspace:'TWORK',user:'UUSER',member:program.signinMember});
 await command('bridges/command',{action:'connection',id:'slack-example',platform:'slack',workspace:'TWORK',botUser:'UBOT',agent:'assistant',tokenSecret:'TOKEN',appSecret:'APP',enabled:true,only:[],ignore:[]});
 await daemon.idle();clock.advance(5000);
 await expect.poll(()=>db.select().from(s.bridgeConnections).get()?.state).toBe('connected');
 await daemon.idle();expect(wire.slack).toHaveBeenCalledOnce();
 expect(transport!.beforeConnect()).toBe(true);
 await transport!.secrets.withValue('APP',async value=>{expect(value).toBe('FICTITIOUS_APP_TOKEN');});
 const raw=Buffer.from(JSON.stringify({type:'events_api',envelope_id:'ack',payload:{type:'event_callback',event_id:'incoming',team_id:'TWORK',event:{type:'message',channel:'CROOM',user:'UUSER',text:'A fictitious garden question',ts:'1794765600.000001'}}}));
 await transport!.receive({},raw);clock.advance(0);await daemon.idle();
 const incoming=db.select().from(s.bridgeIncoming).get()!;
 expect(incoming).toMatchObject({state:'delivered',member:program.signinMember,connection:'slack-example'});
 expect(db.select().from(s.inbox).all().filter(row=>row.source==='slack')).toHaveLength(1);
 expect(db.select().from(s.conversations).where(eq(s.conversations.id,incoming.conversation!)).get()).toMatchObject({agent:'assistant',venue:'slack'});
 daemon.sends.queue({id:'reply',incoming:incoming.id,text:'A fictitious garden reply'});daemon.changed();await daemon.idle();
 expect(db.select().from(s.bridgeSends).get()).toMatchObject({state:'sent',postedId:'1794765600.000009'});
 await command('bridges/command',{action:'disconnect',id:'slack-example'});await daemon.idle();
 await expect(transport!.receive({},raw)).rejects.toThrow();expect(transport!.beforeConnect()).toBe(false);
 expect(closed).toHaveBeenCalledOnce();
 for(const secret of ['FICTITIOUS_BOT_TOKEN','FICTITIOUS_APP_TOKEN'])expect(db.$client.serialize().includes(Buffer.from(secret))).toBe(false);
 await command('bridges/command',{action:'connection',id:'slack-example',platform:'slack',workspace:'TWORK',botUser:'UBOT',agent:'assistant',tokenSecret:'TOKEN',appSecret:'APP',enabled:true,only:[],ignore:[]});
 // An edit coalesced with the previous reconcile is picked up on its next poll.
 await daemon.idle();clock.advance(5000);
 await expect.poll(()=>db.select().from(s.bridgeConnections).get()?.state).toBe('connected');await daemon.idle();
 expect(wire.slack).toHaveBeenCalledTimes(2);
 const stopping=app.close();expect(transport!.beforeConnect()).toBe(false);await expect(transport!.receive({},raw)).rejects.toThrow();
 await stopping;expect(closed).toHaveBeenCalledTimes(2);
});

it('keeps an explicitly configured bridge source instead of replacing it with the owned holder',async()=>{
 vi.stubEnv('LOOM_PUBLIC_URL',undefined);vi.stubEnv('LOOM_WORKER_SOCKET',undefined);
 const parent=mkdtempSync(join(tmpdir(),'loom-explicit-bridges-')),home=join(parent,'home'),webRoot=join(parent,'web');
 mkdirSync(home);mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>Fictitious home</main>');
 clean.push(()=>rmSync(parent,{recursive:true,force:true}));
 const clock=new FakeClock();await initializeSharedHome(home,clock);
 const adapter=join(home,'configured.mjs'),programPath=join(home,'program.json');
 writeFileSync(adapter,'export let observed=0; export default()=>({bridges:{source:{generation:async()=>{observed++;return "00000000-0000-4000-8000-000000000000";},read:async()=>{throw Error("No configured value");}},effectsAllowed:()=>false}});',{mode:0o600});
 const program=JSON.parse(readFileSync(programPath,'utf8'));program.adapters=adapter;writeFileSync(programPath,JSON.stringify(program),{mode:0o600});
 const app=await startSharedHome({home,webRoot,clock,port:0,stdout:()=>{}});clean.push(()=>app.close());
 const module=await import(pathToFileURL(adapter).href);expect(module.observed).toBe(1);expect(app.services.bridges.daemon).toBeDefined();expect(wire.slack).not.toHaveBeenCalled();
});
