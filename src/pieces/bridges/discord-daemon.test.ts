import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { FakeClock } from '../../core/index.js';
import { installSecrets } from '../secrets/index.js';
import { installSecretServices } from '../secrets/service.js';
import { installBridges } from './index.js';
import { venueSchema } from './model.js';
import { put } from './store.js';
import { discordInbox } from './discord-inbox.js';
import type { DiscordGatewayOptions } from './discord-gateway.js';
const cleanups: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0)) await close();vi.restoreAllMocks();});
class FakeSocket extends EventEmitter {
  readyState=1;
  send=vi.fn((_s:string,done:(error?:Error)=>void)=>done());
  ping=vi.fn();
  terminate=vi.fn(()=>{this.readyState=3;this.emit('close');});
  frame(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)),false);}
  hello(){this.frame({op:10,d:{heartbeat_interval:100000}});}
  ready(){this.frame({op:0,t:'READY',s:1,d:{user:{id:'200'},session_id:'SESSION',resume_gateway_url:'wss://gateway.discord.gg/'}});}
  message(){this.frame({op:0,t:'MESSAGE_CREATE',s:2,d:payload});}
}
const venue=venueSchema.parse({id:'discord',platform:'discord',agent:'art',workspace:'100',bot:'200',tokenSecret:'bot'});
const payload={id:'300',channel_id:'400',guild_id:'100',type:0,content:'hello <@200>',author:{id:'500'},mentions:[{id:'200'}],mention_roles:[]};
const checkpoint=(seq:number)=>({session:'SESSION',url:'wss://gateway.discord.gg/?v=10&encoding=json',seq});
async function until(fn:()=>boolean){for(let i=0;i<2000;i++){if(fn())return;await Promise.resolve();}throw Error('condition not reached');}
async function settle(){for(let i=0;i<150;i++)await Promise.resolve();}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function setup({staging=false,grant=true,pending=false,receive=vi.fn(async()=>{})}: {staging?:boolean;grant?:boolean;pending?:boolean;receive?: ReturnType<typeof vi.fn<NonNullable<Parameters<typeof startLoom>[0]['bridges']>['receive']>>}={}){
  const home=mkdtempSync(join(tmpdir(),'discord-root-'));fixture(home);
  const clock=new FakeClock();let epoch='0';
  const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue','bridges.route','bridges.link','bridges.send'],operations:[]}}});
  const sockets:FakeSocket[]=[];const buffers:Uint8Array[]=[];
  const source={read:vi.fn(async(name:string)=>{const b=Buffer.from(`PRIVATE-${name}`);buffers.push(b);return b;})};
  const request=vi.fn<typeof fetch>(async url=>{
    const path=String(url);
    if(path.endsWith('users/@me'))return Response.json({id:'200',bot:true});
    if(path.endsWith('guilds/100'))return Response.json({id:'100'});
    return Response.json({id:'400',guild_id:'100',type:0,name:'general'});
  });
  const startOptions: Parameters<typeof startLoom>[0]={home,next:true,staging,clock,sharing,stdout:()=>{},
    bridges:{source,credentialEpoch:()=>epoch,name:()=> 'Jonathan',receive,request,discordSocket:()=>{const s=new FakeSocket();sockets.push(s);return s as unknown as ReturnType<NonNullable<DiscordGatewayOptions['socket']>>;}},
    install(a){
      installSecrets(a.db,a.operations,a.live,sharing);installSecretServices(a.db,a.operations,sharing);installBridges(a,sharing);
      let n=0;for(const name of ['bot']){
        expect(a.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.describe',{name,description:name},`d${n++}`).ok).toBe(true);
        if(grant)expect(a.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.grantService',{service:'bridges',name},`g${n++}`).ok).toBe(true);
      }
      put(a.db,'venues',venue);
      if(pending){const inbox=discordInbox(a.db,clock,{venue,credentialEpoch:epoch},()=>epoch);void inbox.commit({type:'READY',seq:1,data:{user:{id:'200'},session_id:'SESSION'}},checkpoint(1));void inbox.commit({type:'MESSAGE_CREATE',seq:2,data:payload},checkpoint(2));}
    }};
  const app=await startLoom(startOptions);
  cleanups.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
  return {app,clock,sockets,source,buffers,request,receive,rotate(){epoch=String(Number(epoch)+1);},async restart(){await app.close();const restarted=await startLoom({...startOptions,install:undefined});cleanups.unshift(restarted.close);return restarted;}};
}
it('root uses real service grants, authenticates before socket startup, drains saved receipts without new input',async()=>{
  const f=await setup({pending:true});await until(()=>f.receive.mock.calls.length===1 && f.sockets.length===1);await settle();
  expect(f.request.mock.calls.slice(0,2).map(c=>String(c[0]).split('/').pop())).toEqual(['@me','100']);
  expect(f.app.db.prepare('SELECT state,event FROM bridges_discord_receipts').get()).toEqual({state:'consumed',event:null});
  expect(f.source.read.mock.calls.map(c=>c[0])).toContain('bot');expect(f.buffers.every(b=>b.every(x=>x===0))).toBe(true);
});
it('missing service grants cause no holder or network IO and recover after the owner grants',async()=>{
  const f=await setup({grant:false});await settle();expect(f.source.read).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
  for(const name of ['bot'])expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.grantService',{service:'bridges',name},`allow-${name}`).ok).toBe(true);
  f.clock.advance(5000);await until(()=>f.sockets.length===1);
});
it('staging holds authentication and dial, then releases one stable connection attempt',async()=>{
  const f=await setup({staging:true});await settle();expect(f.request).not.toHaveBeenCalled();expect(f.source.read).not.toHaveBeenCalled();
  f.clock.advance(5000);await settle();
  const rows=f.app.db.prepare("SELECT id FROM core_effects WHERE kind='bridge-send'").all() as {id:string}[];expect(rows).toHaveLength(1);
  expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:rows[0].id},'release').ok).toBe(true);
  f.clock.advance(0);await until(()=>f.sockets.length===1);expect(f.request.mock.calls.filter(c=>String(c[0]).endsWith('users/@me'))).toHaveLength(1);
});
it('Commits raw dispatches while normalization waits, and root close waits before closing SQLite',async()=>{
  const handoff=deferred<void>();const receive=vi.fn(async()=>handoff.promise);const f=await setup({receive});await until(()=>f.sockets.length===1);
  const socket=f.sockets[0];socket.hello();await until(()=>socket.send.mock.calls.length===1);socket.ready();socket.message();await until(()=>socket.send.mock.calls.length===1 && receive.mock.calls.length===1);
  let closed=false;let closing:Promise<void>|undefined;try {
  expect(f.app.db.prepare('SELECT state FROM bridges_discord_receipts').get()).toEqual({state:'pending'});
  // A blocked normalized commit must not occupy the Gateway's raw commit queue.
  socket.frame({op:0,t:'MESSAGE_CREATE',s:3,d:{...payload,id:'301'}});
  await until(()=> (f.app.db.prepare('SELECT count(*) n FROM bridges_discord_receipts').get() as {n:number}).n===2);
  expect(discordInbox(f.app.db,f.clock,{venue,credentialEpoch:'0'},()=> '0').load()?.seq).toBe(3);
  expect(receive).toHaveBeenCalledOnce();
  closing=f.app.close().then(()=>{closed=true;});
    await vi.waitFor(()=>expect(socket.terminate).toHaveBeenCalledOnce());
    expect(closed).toBe(false);expect(f.app.db.open).toBe(true);
  } finally { handoff.resolve(); await closing; }
  expect(f.app.db.open).toBe(false);
});
it('credential epochs and setup edit/restore retire old receivers and reauthenticate',async()=>{
  const f=await setup();await until(()=>f.sockets.length===1);const first=f.sockets[0];first.hello();
  f.rotate();f.clock.advance(5000);await until(()=>f.sockets.length===2);expect(first.terminate).toHaveBeenCalledOnce();
  const second=f.sockets[1];second.hello();
  put(f.app.db,'venues',{...venue,bot:'999'});f.app.live.changed([{type:'bridges.venue',id:venue.id}]);
  put(f.app.db,'venues',venue);f.app.live.changed([{type:'bridges.venue',id:venue.id}]);
  expect(second.terminate).toHaveBeenCalledOnce();second.message();
  f.clock.advance(5000);await until(()=>f.sockets.length===3);expect(second.send).not.toHaveBeenCalled();
  expect(f.request.mock.calls.filter(c=>String(c[0]).endsWith('users/@me'))).toHaveLength(3);
});
it('shutdown waits for a deferred Identify holder read before SQLite closes',async()=>{
 const f=await setup();await until(()=>f.sockets.length===1);const held=deferred<Uint8Array>();f.source.read.mockImplementationOnce(()=>held.promise);
 f.sockets[0].hello();await until(()=>f.source.read.mock.results.at(-1)?.value===held.promise);
 let done=false;const closing=f.app.close().then(()=>{done=true;});
 try {await vi.waitFor(()=>expect(f.sockets[0].terminate).toHaveBeenCalledOnce());expect(done).toBe(false);expect(f.app.db.open).toBe(true);}
 finally {held.resolve(Buffer.from('PRIVATE-bot'));await closing;}
 expect(f.sockets[0].send).not.toHaveBeenCalled();expect(f.app.db.open).toBe(false);
});
it('detects credential replacement while handoff is pending and suppresses late consumption',async()=>{
  const held=deferred<void>();const receive=vi.fn(async()=>held.promise);const f=await setup({pending:true,receive});
  await until(()=>receive.mock.calls.length===1 && f.sockets.length===1);
  f.rotate();f.clock.advance(5000);expect(f.sockets[0].terminate).toHaveBeenCalledOnce();
  held.resolve();await until(()=>f.sockets.length===2);await settle();
  // A replacement epoch cannot inherit the old raw receipt; late work cannot consume it.
  expect(receive).toHaveBeenCalledTimes(1);expect(f.app.db.prepare('SELECT state FROM bridges_discord_receipts').get()).toEqual({state:'pending'});
});
it.each(['secret.name','secret.grant','secret.policy','core.access'])('immediately retires an active session on %s',async type=>{
  const f=await setup();await until(()=>f.sockets.length===1);
  f.app.live.changed([{type,id:'changed'}]);expect(f.sockets[0].terminate).toHaveBeenCalledOnce();
  await until(()=>f.sockets.length===2);
});
it('keeps the authenticated session for traffic and status notifications',async()=>{
  const f=await setup();await until(()=>f.sockets.length===1);
  for(const type of ['bridges.venue','bridges.send'])f.app.live.changed([{type,id:'discord'}]);
  f.clock.advance(5000);await settle();expect(f.sockets).toHaveLength(1);expect(f.sockets[0].terminate).not.toHaveBeenCalled();
});
it('released staging lifetime permits reconnect and metadata, but credential replacement is held again',async()=>{
  const f=await setup({staging:true});await settle();
  const row=f.app.db.prepare("SELECT id FROM core_effects WHERE state='due'").get() as {id:string};
  f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:row.id},'release-reconnect');
  f.clock.advance(0);await until(()=>f.sockets.length===1);
  f.sockets[0].hello();await until(()=>f.sockets[0].send.mock.calls.length===1);f.sockets[0].ready();await settle();f.sockets[0].emit('close');await settle();f.clock.advance(1000);await until(()=>f.sockets.length===2);
  f.sockets[1].hello();await until(()=>f.sockets[1].send.mock.calls.length===1);f.sockets[1].frame({op:0,t:'RESUMED',s:2,d:{}});f.sockets[1].frame({op:0,t:'MESSAGE_CREATE',s:3,d:payload});await until(()=>f.receive.mock.calls.length===1);
  f.rotate();f.clock.advance(5000);await settle();expect(f.sockets).toHaveLength(2);expect(f.sockets[1].terminate).toHaveBeenCalledOnce();
  expect(f.app.db.prepare("SELECT count(*) n FROM core_effects WHERE state='due'").get()).toEqual({n:1});
});
it('startup failure awaits pending authentication before SQLite closes',async()=>{
  const home=mkdtempSync(join(tmpdir(),'discord-start-failure-'));fixture(home);const clock=new FakeClock();
  const held=deferred<Uint8Array>();const source={read:vi.fn(()=>held.promise)};
  const request=vi.fn<typeof fetch>(async()=>Response.json({ok:false}));
  let db!:Parameters<typeof installBridges>[0]['db'];
  const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue'],operations:[]}}});
  const starting=startLoom({home,next:true,host:[],clock,sharing,stdout:()=>{},bridges:{source,credentialEpoch:()=> '0',name:()=>undefined,receive:async()=>{},request},
    install(a){db=a.db;installSecrets(a.db,a.operations,a.live,sharing);installSecretServices(a.db,a.operations,sharing);installBridges(a,sharing);put(a.db,'venues',venue);
      a.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.describe',{name:'bot',description:'bot'},'describe');
      a.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.grantService',{service:'bridges',name:'bot'},'grant');
    }});
  let ended=false;const outcome=starting.then(()=> 'unexpected success',e=>{ended=true;return (e as Error).message;});
  try {
    await vi.waitFor(()=>expect(source.read).toHaveBeenCalledOnce());await new Promise<void>(r=>setImmediate(r));
    expect(ended).toBe(false);expect(db.open).toBe(true);
  } finally {held.resolve(Buffer.from('PRIVATE'));expect(await outcome).toBe('next mode needs a bind host');rmSync(home,{recursive:true,force:true});}
  expect(db.open).toBe(false);expect(request).not.toHaveBeenCalled();
});
it.each(['secret.name','secret.grant','secret.policy','core.access'])('invalidates pending authentication on %s',async type=>{
  const f=await setup();await until(()=>f.sockets.length===1);
  const held=deferred<Response>();f.request.mockImplementationOnce(()=>held.promise);
  const calls=f.request.mock.calls.length;f.app.live.changed([{type:'secret.name',id:'bot'}]);
  await until(()=>f.request.mock.calls.length>calls);
  f.app.live.changed([{type,id:'bot'}]);held.resolve(Response.json({id:'200',bot:true}));
  await until(()=>f.sockets.length===2);await settle();expect(f.sockets).toHaveLength(2);
  expect(f.request.mock.calls.filter(c=>String(c[0]).endsWith('users/@me'))).toHaveLength(3);
});
it('holds a new staged connection after a daemon restart',async()=>{
  const f=await setup({staging:true});await settle();
  const row=f.app.db.prepare("SELECT id FROM core_effects WHERE state='due'").get() as {id:string};
  f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:row.id},'before-restart');f.clock.advance(0);await until(()=>f.sockets.length===1);
  const second=await f.restart();await settle();expect(f.sockets).toHaveLength(1);
  expect(second.db.prepare("SELECT count(*) n FROM core_effects WHERE state='due'").get()).toEqual({n:1});
});
it('retries authentication after holder rotation during an outstanding authentication call',async()=>{
  const f=await setup();await until(()=>f.sockets.length===1);
  const held=deferred<Response>();f.request.mockImplementationOnce(()=>held.promise);
  const calls=f.request.mock.calls.length;f.app.live.changed([{type:'secret.name',id:'bot'}]);await until(()=>f.request.mock.calls.length>calls);
  f.rotate();f.clock.advance(5000);held.resolve(Response.json({id:'200',bot:true}));
  await until(()=>f.sockets.length===2);expect(f.request.mock.calls.filter(c=>String(c[0]).endsWith('users/@me'))).toHaveLength(3);
});
it('holds a replacement staging identity even if its setup is restored',async()=>{
  const f=await setup({staging:true});await settle();const row=f.app.db.prepare("SELECT id FROM core_effects WHERE state='due'").get() as {id:string};
  f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:row.id},'before-setup');f.clock.advance(0);await until(()=>f.sockets.length===1);
  put(f.app.db,'venues',{...venue,bot:'999'});f.app.live.changed([{type:'bridges.venue',id:'discord'}]);
  put(f.app.db,'venues',venue);f.app.live.changed([{type:'bridges.venue',id:'discord'}]);await settle();
  expect(f.sockets).toHaveLength(1);expect(f.sockets[0].terminate).toHaveBeenCalledOnce();
  expect(f.app.db.prepare("SELECT count(*) n FROM core_effects WHERE state='due'").get()).toEqual({n:1});
});
it('suppresses metadata HTTP after shutdown during holder acquisition',async()=>{
  const f=await setup();await until(()=>f.sockets.length===1);const held=deferred<Uint8Array>();
  f.sockets[0].hello();await until(()=>f.sockets[0].send.mock.calls.length===1);f.source.read.mockImplementationOnce(()=>held.promise);f.sockets[0].ready();f.sockets[0].message();await until(()=>f.source.read.mock.results.at(-1)?.value===held.promise);
  const calls=f.request.mock.calls.length;const closing=f.app.close();
  try {await vi.waitFor(()=>expect(f.sockets[0].terminate).toHaveBeenCalledOnce());expect(f.app.db.open).toBe(true);}
  finally {held.resolve(Buffer.from('PRIVATE'));await closing;}
  expect(f.request).toHaveBeenCalledTimes(calls);
});
it('retains a staging release through temporary authentication failure',async()=>{
  const f=await setup({staging:true});await settle();
  f.request.mockImplementationOnce(async()=>Response.json({error:'temporarily_unavailable'}));
  const row=f.app.db.prepare("SELECT id FROM core_effects WHERE state='due'").get() as {id:string};
  f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:row.id},'release-auth-retry');f.clock.advance(0);await settle();
  expect(f.sockets).toHaveLength(0);f.clock.advance(5000);await until(()=>f.sockets.length===1);
  expect(f.app.db.prepare("SELECT id,state FROM core_effects WHERE kind='bridge-send'").all()).toEqual([{id:row.id,state:'started'}]);
});
