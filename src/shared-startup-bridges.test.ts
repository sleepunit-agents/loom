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
import * as serving from './shared-serve.js';
import * as s from './core/data/schema.js';
import type {bridgeSlackSocket} from './pieces/bridges/slack-socket.js';
import type {discordGateway} from './pieces/bridges/discord-gateway.js';
type InProcessHolder=Awaited<ReturnType<typeof import('../test/fixtures/shared-holder.js').inProcessSharedHolder>>;
type Home=Awaited<ReturnType<typeof startSharedHome>>;
const wire=vi.hoisted(()=>({slack:vi.fn<typeof bridgeSlackSocket>(),discord:vi.fn<typeof discordGateway>(),owners:[]as InProcessHolder[]}));
vi.mock('./shared-holder-process.js',async()=>{const {inProcessSharedHolder}=await import('../test/fixtures/shared-holder.js');return{async startSharedHolder(...args:Parameters<typeof inProcessSharedHolder>){const owner=await inProcessSharedHolder(...args);vi.spyOn(owner.source,'generation');wire.owners.push(owner);return owner;}};});
vi.mock('./pieces/bridges/slack-socket.js',async original=>({...await original<typeof import('./pieces/bridges/slack-socket.js')>(),bridgeSlackSocket:wire.slack}));
vi.mock('./pieces/bridges/discord-gateway.js',async original=>({...await original<typeof import('./pieces/bridges/discord-gateway.js')>(),discordGateway:wire.discord}));
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.unstubAllGlobals();vi.restoreAllMocks();vi.unstubAllEnvs();wire.slack.mockReset();wire.discord.mockReset();wire.owners.length=0;});
function files(){
 vi.stubEnv('LOOM_PUBLIC_URL',undefined);vi.stubEnv('LOOM_WORKER_SOCKET',undefined);
 const parent=mkdtempSync(join(tmpdir(),'loom-default-bridges-')),home=join(parent,'home'),webRoot=join(parent,'web');
 mkdirSync(home);mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>Fictitious home</main>');
 clean.push(()=>rmSync(parent,{recursive:true,force:true}));
 return{home,webRoot,clock:new FakeClock(Date.parse('2026-11-15T18:00:00Z'))};
}
async function commands(app:Home,link:string){
 const response=await fetch(link,{method:'POST',redirect:'manual'});expect(response.status).toBe(303);
 const cookie=response.headers.get('set-cookie')!.split(';')[0];
 return async(path:string,input:unknown)=>{
  const result=await fetch(app.url+'/api/'+path,{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});
  expect(result.status).toBe(200);expect(await result.json()).toMatchObject({ok:true});
 };
}
it('uses the owned holder for Slack receipt, confirmed/uncertain sends, credential/config fencing and joined shutdown',async()=>{
 const {home,webRoot,clock}=files();let link='',botToken='FICTITIOUS_BOT_TOKEN',loseReply=false;
 const closed=vi.fn(async()=>{});let transport:Parameters<typeof bridgeSlackSocket>[0]|undefined;
 wire.slack.mockImplementation(options=>{transport=options;options.state?.('connected');return{close:closed};});
 const realFetch=globalThis.fetch,platform=vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.hostname==='127.0.0.1')return realFetch(input,init);
  expect(url.origin).toBe('https://slack.com');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+botToken);
  if(url.pathname==='/api/auth.test')return Response.json({ok:true,user_id:'UBOT',team_id:'TWORK',bot_id:'BBOT'});
  if(url.pathname==='/api/bots.info')return Response.json({ok:true,bot:{id:'BBOT',user_id:'UBOT',app_id:'AAPP',deleted:false}});
  if(url.pathname==='/api/conversations.info')return Response.json({ok:true,channel:{id:'CROOM',context_team_id:'TWORK',is_channel:true}});
  if(url.pathname==='/api/chat.postMessage'){if(loseReply)throw Error('Fictitious lost receipt');return Response.json({ok:true,channel:'CROOM',ts:'1794765600.000009'});}
  throw Error('Unexpected platform endpoint');
 });
 vi.stubGlobal('fetch',platform);
 const app=await startSharedHome({home,webRoot,clock,port:0,stdout:text=>{link=text.trim();}});clean.push(()=>app.close());
 const program=JSON.parse(readFileSync(join(home,'program.json'),'utf8'));
 expect(program.adapters).toBeUndefined();expect(app.services.bridges.daemon).toBeDefined();
 const daemon=app.services.bridges.daemon!,db=app.services.comms!.db,owner=wire.owners[0],command=await commands(app,link);
 const connected=async(count:number)=>{
  // Join current IO before advancing the ordinary epoch/reconcile poll clocks.
  await daemon.idle();clock.advance(5000);await owner.source.generation();await daemon.idle();clock.advance(5000);
  await expect.poll(()=>wire.slack.mock.calls.length).toBe(count);
  await expect.poll(()=>db.select().from(s.bridgeConnections).get()?.state).toBe('connected');await daemon.idle();
 };
 for(const [name,value]of [['TOKEN',botToken],['APP','FICTITIOUS_APP_TOKEN']])await command('secrets/set',{id:randomUUID(),name,value,mode:'add'});
 await command('bridges/command',{action:'channel',platform:'slack',workspace:'TWORK',channel:'CROOM',answers:'assistant',botsMayTalk:false});
 await command('bridges/command',{action:'person',platform:'slack',workspace:'TWORK',user:'UUSER',member:program.signinMember});
 const config={action:'connection',id:'slack-example',platform:'slack',workspace:'TWORK',botUser:'UBOT',agent:'assistant',tokenSecret:'TOKEN',appSecret:'APP',enabled:true,only:[],ignore:[]};
 await command('bridges/command',config);await connected(1);expect(transport!.beforeConnect()).toBe(true);
 await transport!.secrets.withValue('APP',async value=>{expect(value).toBe('FICTITIOUS_APP_TOKEN');});
 const raw=Buffer.from(JSON.stringify({type:'events_api',envelope_id:'ack',payload:{type:'event_callback',event_id:'incoming',team_id:'TWORK',event:{type:'message',channel:'CROOM',user:'UUSER',text:'A fictitious garden question',ts:'1794765600.000001'}}}));
 await transport!.receive({},raw);clock.advance(0);await daemon.idle();
 const incoming=db.select().from(s.bridgeIncoming).get()!;
 expect(incoming).toMatchObject({state:'delivered',member:program.signinMember,connection:'slack-example'});
 expect(db.select().from(s.inbox).all().filter(row=>row.source==='slack')).toHaveLength(1);
 expect(db.select().from(s.conversations).where(eq(s.conversations.id,incoming.conversation!)).get()).toMatchObject({agent:'assistant',venue:'slack'});
 daemon.sends.queue({id:'reply',incoming:incoming.id,text:'A fictitious garden reply'});daemon.changed();await daemon.idle();
 expect(db.select().from(s.bridgeSends).where(eq(s.bridgeSends.id,'reply')).get()).toMatchObject({state:'sent',postedId:'1794765600.000009'});
 const old=transport!;botToken='FICTITIOUS_REPLACEMENT_TOKEN';
 await command('secrets/set',{id:randomUUID(),name:'TOKEN',value:botToken,mode:'replace'});
 expect(old.beforeConnect()).toBe(false);await expect(old.receive({},raw)).rejects.toThrow();await connected(2);
 // Same bytes, new holder epoch, without a Root metadata write: the poll itself
 // must retire this lifetime. A constant-generation startup source fails here.
 const before=await owner.source.generation(),older=transport!;
 await owner.holder.set({member:program.signinMember,writeId:randomUUID()},'TOKEN',Buffer.from(botToken),'replace');
 expect(await owner.source.generation()).not.toBe(before);await connected(3);
 expect(older.beforeConnect()).toBe(false);await expect(older.receive({},raw)).rejects.toThrow();
 loseReply=true;daemon.sends.queue({id:'uncertain',incoming:incoming.id,text:'A fictitious unconfirmed reply'});daemon.changed();await daemon.idle();
 expect(db.select().from(s.bridgeSends).where(eq(s.bridgeSends.id,'uncertain')).get()?.state).toBe('uncertain');loseReply=false;
 await connected(4);
 await command('bridges/command',{action:'disconnect',id:'slack-example'});await daemon.idle();
 await expect(transport!.receive({},raw)).rejects.toThrow();expect(transport!.beforeConnect()).toBe(false);expect(closed).toHaveBeenCalledTimes(4);
 await command('bridges/command',config);await connected(5);
 expect(platform.mock.calls.filter(([input])=>String(input)==='https://slack.com/api/chat.postMessage')).toHaveLength(2);
 for(const secret of ['FICTITIOUS_BOT_TOKEN',botToken,'FICTITIOUS_APP_TOKEN'])expect(db.$client.serialize().includes(Buffer.from(secret))).toBe(false);
 let release!:()=>void,began!:()=>void;
 const held=new Promise<void>(yes=>{release=yes;}),started=new Promise<void>(yes=>{began=yes;});clean.push(()=>release());
 closed.mockImplementationOnce(()=>{began();return held;});
 const holderClose=vi.spyOn(owner,'close');let settled=false;
 const stopping=app.close().then(()=>{settled=true;});expect(transport!.beforeConnect()).toBe(false);await expect(transport!.receive({},raw)).rejects.toThrow();
 await started;expect(holderClose).toHaveBeenCalledOnce();await holderClose.mock.results[0].value;
 expect(()=>daemon.sends.queue({id:'after-close',incoming:incoming.id,text:'Must not leave'})).toThrow('closed');
 expect(db.$client.open).toBe(true);expect(db.$client.prepare('select count(*) as n from bridge_connections').get()).toEqual({n:1});expect(settled).toBe(false);
 release();await stopping;expect(db.$client.open).toBe(false);expect(closed).toHaveBeenCalledTimes(5);
});
it('keeps explicit bridge ports and joins holder cleanup after the actual server has closed',async()=>{
 const {home,webRoot,clock}=files();await initializeSharedHome(home,clock);
 const adapter=join(home,'configured.mjs'),programPath=join(home,'program.json');
 writeFileSync(adapter,'export let observed=0; export default()=>({bridges:{source:{generation:async()=>{observed++;return "00000000-0000-4000-8000-000000000000";},read:async()=>{throw Error("No configured value");}},effectsAllowed:()=>true}});',{mode:0o600});
 const program=JSON.parse(readFileSync(programPath,'utf8'));program.adapters=adapter;writeFileSync(programPath,JSON.stringify(program),{mode:0o600});
 const realServe=serving.serveShared;let served:Awaited<ReturnType<typeof realServe>>|undefined,bridgeGate:(()=>boolean)|undefined;
 vi.spyOn(serving,'serveShared').mockImplementation(async options=>{bridgeGate=options.bridges?.effectsAllowed;served=await realServe(options);return served;});
 const app=await startSharedHome({home,webRoot,clock,port:0,stdout:()=>{}});clean.push(()=>app.close());
 const module=await import(pathToFileURL(adapter).href);
 expect(module.observed).toBe(1);expect(wire.owners[0].source.generation).not.toHaveBeenCalled();expect(app.services.bridges.daemon).toBeDefined();expect(wire.slack).not.toHaveBeenCalled();
 const db=app.services.comms!.db,owner=wire.owners[0],realClose=owner.close.bind(owner),serverClose=vi.spyOn(served!,'close');
 let release!:()=>void,began!:()=>void;
 const held=new Promise<void>(yes=>{release=yes;}),started=new Promise<void>(yes=>{began=yes;});clean.push(()=>release());
 vi.spyOn(owner,'close').mockImplementation(async()=>{await realClose();began();await held;});
 expect(bridgeGate!()).toBe(true);
 let settled=false;const stopping=app.close().then(()=>{settled=true;});
 expect(serverClose).not.toHaveBeenCalled();expect(bridgeGate!()).toBe(false);
 await started;expect(serverClose).toHaveBeenCalledOnce();await serverClose.mock.results[0].value;
 expect(db.$client.open).toBe(true);expect(settled).toBe(false);
 release();await stopping;expect(db.$client.open).toBe(false);
});
it('uses the native Discord gateway leaf with the owned holder and no custom adapter',async()=>{
 const {home,webRoot,clock}=files();let link='';
 const closed=vi.fn(async()=>{});wire.discord.mockImplementation(options=>{options.state?.('connected');return{close:closed};});
 const realFetch=globalThis.fetch;vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));if(url.hostname==='127.0.0.1')return realFetch(input,init);
  expect(url.origin).toBe('https://discord.com');expect(new Headers(init?.headers).get('authorization')).toBe('Bot FICTITIOUS_DISCORD_TOKEN');
  if(url.pathname==='/api/v10/users/@me')return Response.json({id:'123456789012345678',bot:true});
  if(url.pathname==='/api/v10/guilds/223456789012345678')return Response.json({id:'223456789012345678',unavailable:false});
  throw Error('Unexpected platform endpoint');
 }));
 const app=await startSharedHome({home,webRoot,clock,port:0,stdout:text=>{link=text.trim();}});clean.push(()=>app.close());
 expect(JSON.parse(readFileSync(join(home,'program.json'),'utf8')).adapters).toBeUndefined();
 const command=await commands(app,link),daemon=app.services.bridges.daemon!,owner=wire.owners[0];
 await command('secrets/set',{id:randomUUID(),name:'TOKEN',value:'FICTITIOUS_DISCORD_TOKEN',mode:'add'});
 await command('bridges/command',{action:'connection',id:'discord-example',platform:'discord',workspace:'223456789012345678',botUser:'123456789012345678',agent:'assistant',tokenSecret:'TOKEN',appSecret:null,enabled:true,only:[],ignore:[]});
 await daemon.idle();clock.advance(5000);await owner.source.generation();await daemon.idle();clock.advance(5000);
 await expect.poll(()=>wire.discord.mock.calls.length).toBe(1);await daemon.idle();
 const options=wire.discord.mock.calls[0][0];expect(options.bot).toBe('123456789012345678');expect(options.beforeConnect()).toBe(true);
 expect(app.services.comms!.db.select().from(s.bridgeConnections).get()?.state).toBe('connected');expect(wire.slack).not.toHaveBeenCalled();
 await app.close();expect(options.beforeConnect()).toBe(false);expect(closed).toHaveBeenCalledOnce();
});
