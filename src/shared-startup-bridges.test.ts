import Database from 'better-sqlite3';
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
// The household's first owner: who it is is in the household database, not in program.json.
const ownerOf=(database:string)=>{const db=new Database(database,{readonly:true});try{return (db.prepare("SELECT id FROM members WHERE role='owner'").get() as {id:string}).id;}finally{db.close();}};
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
  // Bridge settings have no outside command: installed code sets them, anyone else proposes.
  if(path==='bridges/command'&&(input as {action?:string}).action!=='review'){app.writes.run(()=>app.services.setup.bridge(input as never));return;}
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
  if(url.origin==='https://files.slack.com'){
   expect(url.pathname).toBe('/files-pri/TWORK-FGARDEN/garden');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+botToken);
   return new Response('FICTITIOUS_ATTACHMENT',{headers:{'content-type':'application/octet-stream'}});
  }
  expect(url.origin).toBe('https://slack.com');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+botToken);
  if(url.pathname==='/api/auth.test')return Response.json({ok:true,user_id:'UBOT',team_id:'TWORK',bot_id:'BBOT'});
  if(url.pathname==='/api/bots.info')return Response.json({ok:true,bot:{id:'BBOT',user_id:'UBOT',app_id:'AAPP',deleted:false}});
  if(url.pathname==='/api/conversations.info')return Response.json({ok:true,channel:{id:'CROOM',context_team_id:'TWORK',is_channel:true}});
  if(url.pathname==='/api/chat.postMessage'){
   expect(JSON.parse(String(init?.body))).toMatchObject({channel:'CROOM',thread_ts:'1794765600.000001'});
   if(loseReply)throw Error('Fictitious lost receipt');return Response.json({ok:true,channel:'CROOM',ts:'1794765600.000009'});
  }
  throw Error('Unexpected platform endpoint');
 });
 vi.stubGlobal('fetch',platform);
 const app=await startSharedHome({home,webRoot,clock,port:0,stdout:()=>{}});link=app.signinLink();clean.push(()=>app.close());
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
 await command('bridges/command',{action:'person',platform:'slack',workspace:'TWORK',user:'UUSER',member:ownerOf(program.database)});
 const config={action:'connection',id:'slack-example',platform:'slack',workspace:'TWORK',botUser:'UBOT',agent:'assistant',tokenSecret:'TOKEN',appSecret:'APP',enabled:true,only:[],ignore:[]};
 await command('bridges/command',config);await connected(1);expect(transport!.beforeConnect()).toBe(true);
 await transport!.secrets.withValue('APP',async value=>{expect(value).toBe('FICTITIOUS_APP_TOKEN');});
 const raw=Buffer.from(JSON.stringify({type:'events_api',envelope_id:'ack',payload:{type:'event_callback',event_id:'incoming',team_id:'TWORK',event:{type:'message',channel:'CROOM',user:'UUSER',text:'A fictitious garden question',ts:'1794765600.000001',files:[{id:'FGARDEN',name:'garden',size:20,url_private:'https://files.slack.com/files-pri/TWORK-FGARDEN/garden'}]}}}));
 await transport!.receive({},raw);clock.advance(0);await daemon.idle();
 const incoming=db.select().from(s.bridgeIncoming).get()!;
 expect(incoming).toMatchObject({state:'delivered',member:ownerOf(program.database),connection:'slack-example'});
 expect(db.select().from(s.inbox).all().filter(row=>row.source==='slack')).toHaveLength(1);
 expect(db.select().from(s.conversations).where(eq(s.conversations.id,incoming.conversation!)).get()).toMatchObject({agent:'assistant',venue:'slack'});
 expect(incoming.thread).toBe('1794765600.000001');
 const followup=JSON.parse(raw.toString('utf8'));followup.payload.event_id='thread-followup';followup.payload.event.ts='1794765600.000002';followup.payload.event.thread_ts='1794765600.000001';delete followup.payload.event.files;
 await transport!.receive({},Buffer.from(JSON.stringify(followup)));clock.advance(0);await daemon.idle();
 expect(db.select().from(s.bridgeIncoming).all()).toHaveLength(2);expect(new Set(db.select().from(s.bridgeIncoming).all().map(row=>row.conversation))).toEqual(new Set([incoming.conversation]));
 const attachment=db.select().from(s.bridgeFiles).get()!;expect(attachment).toMatchObject({connection:'slack-example',file:'FGARDEN',contents:Buffer.from('FICTITIOUS_ATTACHMENT')});
 daemon.sends.queue({id:'reply',incoming:incoming.id,text:'A fictitious garden reply'});daemon.changed();await daemon.idle();
 expect(db.select().from(s.bridgeSends).where(eq(s.bridgeSends.id,'reply')).get()).toMatchObject({state:'sent'});expect(db.select().from(s.bridgeSendParts).where(eq(s.bridgeSendParts.send,'reply')).all()).toMatchObject([{part:0,postedId:'1794765600.000009'}]);
 const old=transport!;botToken='FICTITIOUS_REPLACEMENT_TOKEN';
 await command('secrets/set',{id:randomUUID(),name:'TOKEN',value:botToken,mode:'replace'});
 expect(old.beforeConnect()).toBe(false);await expect(old.receive({},raw)).rejects.toThrow();await connected(2);
 // The holder has one generation for every secret, so it moves whenever any secret is written. A move with
 // no recorded change to this connection's own secrets, and the same bytes, must not end the connection.
 const before=await owner.source.generation(),older=transport!;
 await owner.holder.set({member:ownerOf(program.database),writeId:randomUUID()},'TOKEN',Buffer.from(botToken),'replace');
 expect(await owner.source.generation()).not.toBe(before);daemon.changed();await daemon.idle();
 expect(older.beforeConnect()).toBe(true);expect(transport).toBe(older);
 loseReply=true;daemon.sends.queue({id:'uncertain',incoming:incoming.id,text:'A fictitious unconfirmed reply'});daemon.changed();await daemon.idle();
 expect(db.select().from(s.bridgeSends).where(eq(s.bridgeSends.id,'uncertain')).get()?.state).toBe('uncertain');loseReply=false;
 await connected(3);
 await command('bridges/command',{action:'disconnect',id:'slack-example'});await daemon.idle();
 await expect(transport!.receive({},raw)).rejects.toThrow();expect(transport!.beforeConnect()).toBe(false);expect(closed).toHaveBeenCalledTimes(3);
 await command('bridges/command',config);await connected(4);
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
 release();await stopping;expect(db.$client.open).toBe(false);expect(closed).toHaveBeenCalledTimes(4);
 // Restart owns the persisted file deadline without simulating fourteen days
 // of unrelated periodic work on the stopped app.
 const expiry=new FakeClock(Date.parse(attachment.fetchedAt)+14*86400000-1);
 const restarted=await startSharedHome({home,webRoot,clock:expiry,port:0,stdout:()=>{}});clean.push(()=>restarted.close());const fresh=restarted.services.comms!.db;
 expect(fresh.select().from(s.bridgeFiles).get()?.contents).toEqual(Buffer.from('FICTITIOUS_ATTACHMENT'));
 expiry.advance(1);expect(fresh.select().from(s.bridgeFiles).all()).toEqual([]);expect(fresh.select().from(s.bridgeIncoming).where(eq(s.bridgeIncoming.id,incoming.id)).get()).toBeDefined();
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
it('delivers Discord through normal startup and records confirmed, uncertain and owner-reviewed replies',async()=>{
 const {home,webRoot,clock}=files();let link='',loseReply=false,posts=0;
 const closed=vi.fn(async()=>{});wire.discord.mockImplementation(options=>{options.state?.('connected');return{close:closed};});
 const realFetch=globalThis.fetch;vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));if(url.hostname==='127.0.0.1')return realFetch(input,init);
  expect(url.origin).toBe('https://discord.com');expect(new Headers(init?.headers).get('authorization')).toBe('Bot FICTITIOUS_DISCORD_TOKEN');
  if(url.pathname==='/api/v10/users/@me')return Response.json({id:'123456789012345678',bot:true});
  if(url.pathname==='/api/v10/guilds/223456789012345678')return Response.json({id:'223456789012345678',unavailable:false});
  if(url.pathname==='/api/v10/channels/323456789012345678')return Response.json({id:'323456789012345678',guild_id:'223456789012345678',type:0,name:'garden'});
  if(url.pathname==='/api/v10/channels/323456789012345678/messages'){
   posts++;expect(init?.method).toBe('POST');expect(JSON.parse(String(init?.body))).toMatchObject({allowed_mentions:{parse:[],replied_user:false}});
   if(loseReply)throw Error('Fictitious lost Discord receipt');return Response.json({id:'623456789012345678',channel_id:'323456789012345678'});
  }
  throw Error('Unexpected platform endpoint');
 }));
 const app=await startSharedHome({home,webRoot,clock,port:0,stdout:()=>{}});link=app.signinLink();clean.push(()=>app.close());
 expect(JSON.parse(readFileSync(join(home,'program.json'),'utf8')).adapters).toBeUndefined();
 const command=await commands(app,link),daemon=app.services.bridges.daemon!,owner=wire.owners[0],db=app.services.comms!.db,program=JSON.parse(readFileSync(join(home,'program.json'),'utf8'));
 await command('secrets/set',{id:randomUUID(),name:'TOKEN',value:'FICTITIOUS_DISCORD_TOKEN',mode:'add'});
 await command('bridges/command',{action:'channel',platform:'discord',workspace:'223456789012345678',channel:'323456789012345678',answers:'assistant',botsMayTalk:false});
 await command('bridges/command',{action:'person',platform:'discord',workspace:'223456789012345678',user:'423456789012345678',member:ownerOf(program.database)});
 await command('bridges/command',{action:'connection',id:'discord-example',platform:'discord',workspace:'223456789012345678',botUser:'123456789012345678',agent:'assistant',tokenSecret:'TOKEN',appSecret:null,enabled:true,only:[],ignore:[]});
 await daemon.idle();clock.advance(5000);await owner.source.generation();await daemon.idle();clock.advance(5000);
 await expect.poll(()=>wire.discord.mock.calls.length).toBe(1);await daemon.idle();
 const options=wire.discord.mock.calls[0][0];expect(options.bot).toBe('123456789012345678');expect(options.beforeConnect()).toBe(true);
 expect(app.services.comms!.db.select().from(s.bridgeConnections).get()?.state).toBe('connected');expect(wire.slack).not.toHaveBeenCalled();
 const data={id:'523456789012345678',channel_id:'323456789012345678',guild_id:'223456789012345678',type:0,timestamp:new Date(clock.now()).toISOString(),content:'A fictitious Discord garden question',author:{id:'423456789012345678',bot:false},mentions:[],mention_roles:[]};
 const raw=Buffer.from(JSON.stringify({op:0,t:'MESSAGE_CREATE',s:1,d:data})),checkpoint={session:'fictitious-session',seq:1,url:'wss://gateway.discord.gg'};
 await options.commit({type:'MESSAGE_CREATE',seq:1,data},checkpoint,raw);clock.advance(0);await daemon.idle();
 const incoming=db.select().from(s.bridgeIncoming).get()!;expect(incoming).toMatchObject({state:'delivered',member:ownerOf(program.database),connection:'discord-example'});
 expect(db.select().from(s.inbox).all().filter(row=>row.source==='discord')).toHaveLength(1);expect(db.select().from(s.conversations).where(eq(s.conversations.id,incoming.conversation!)).get()).toMatchObject({agent:'assistant',venue:'discord'});
 await options.commit({type:'MESSAGE_CREATE',seq:1,data},checkpoint,raw);clock.advance(0);await daemon.idle();expect(db.select().from(s.bridgeIncoming).all()).toHaveLength(1);
 // A fresh transport sequence must also deduplicate the platform message,
 // beyond the raw receipt's identical session/sequence key.
 const repeated=Buffer.from(JSON.stringify({op:0,t:'MESSAGE_CREATE',s:2,d:data}));
 await options.commit({type:'MESSAGE_CREATE',seq:2,data},{...checkpoint,seq:2},repeated);clock.advance(0);await daemon.idle();
 expect(db.select().from(s.bridgeIncoming).all()).toHaveLength(1);expect(db.select().from(s.inbox).all().filter(row=>row.source==='discord')).toHaveLength(1);expect(db.select().from(s.conversations).where(eq(s.conversations.venue,'discord')).all()).toHaveLength(1);
 daemon.sends.queue({id:'discord-confirmed',incoming:incoming.id,text:'A fictitious Discord reply'});daemon.changed();await daemon.idle();expect(db.select().from(s.bridgeSends).where(eq(s.bridgeSends.id,'discord-confirmed')).get()).toMatchObject({state:'sent'});expect(db.select().from(s.bridgeSendParts).where(eq(s.bridgeSendParts.send,'discord-confirmed')).all()).toMatchObject([{part:0,postedId:'623456789012345678'}]);
 loseReply=true;daemon.sends.queue({id:'discord-uncertain',incoming:incoming.id,text:'A fictitious uncertain reply'});daemon.changed();await daemon.idle();expect(db.select().from(s.bridgeSends).where(eq(s.bridgeSends.id,'discord-uncertain')).get()?.state).toBe('uncertain');loseReply=false;
 daemon.changed();await daemon.idle();expect(posts).toBe(2);
 // A failed private credential use retires its lifetime; reconnect before
 // proving uncertainty is still not resent on an active connection.
 await expect(options.commit({type:'MESSAGE_CREATE',seq:2,data},{...checkpoint,seq:2},repeated)).rejects.toThrow();
 expect(options.beforeConnect()).toBe(false);await daemon.idle();clock.advance(5000);await owner.source.generation();await daemon.idle();clock.advance(5000);
 await expect.poll(()=>wire.discord.mock.calls.length).toBe(2);await daemon.idle();const resumed=wire.discord.mock.calls[1][0];expect(resumed.beforeConnect()).toBe(true);
 expect(posts).toBe(2);
 await command('bridges/command',{action:'review',id:'discord-uncertain',decision:'dismiss'});expect(db.select().from(s.bridgeSends).where(eq(s.bridgeSends.id,'discord-uncertain')).get()?.state).toBe('dismissed');
 daemon.sends.queue({id:'discord-held',incoming:incoming.id,text:'A fictitious held reply',held:true});daemon.changed();await daemon.idle();expect(posts).toBe(2);
 await command('bridges/command',{action:'review',id:'discord-held',decision:'release'});await daemon.idle();expect(db.select().from(s.bridgeSends).where(eq(s.bridgeSends.id,'discord-held')).get()?.state).toBe('sent');expect(posts).toBe(3);
 expect(db.$client.serialize().includes(Buffer.from('FICTITIOUS_DISCORD_TOKEN'))).toBe(false);
 await app.close();expect(resumed.beforeConnect()).toBe(false);expect(closed).toHaveBeenCalledTimes(2);
 await expect(resumed.commit({type:'MESSAGE_CREATE',seq:1,data},checkpoint,raw)).rejects.toThrow();expect(posts).toBe(3);
});
