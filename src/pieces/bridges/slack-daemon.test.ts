import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import { slackInbox } from './slack-inbox.js';
import type { SlackSocketOptions } from './slack-socket.js';
const cleanups: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0)) await close();vi.restoreAllMocks();});
class FakeSocket extends EventEmitter {
  readyState=1;
  send=vi.fn((_s:string,done:(error?:Error)=>void)=>done());
  ping=vi.fn();
  terminate=vi.fn(()=>{this.readyState=3;this.emit('close');});
  frame(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)),false);}
  hello(){this.emit('open');this.frame({type:'hello'});}
}
const venue=venueSchema.parse({id:'slack',platform:'slack',agent:'art',workspace:'T123',bot:'U123',tokenSecret:'bot',appSecret:'app'});
const payload={type:'event_callback',team_id:'T123',api_app_id:'A123',event_id:'Ev123',event:{type:'message',channel:'D123',user:'U200',ts:'1793828004.242749',text:'hello'}};
async function until(fn:()=>boolean){for(let i=0;i<2000;i++){if(fn())return;await Promise.resolve();}throw Error('condition not reached');}
async function settle(){for(let i=0;i<150;i++)await Promise.resolve();}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function setup({staging=false,grant=true,pending=false,generation,receive=vi.fn(async()=>{})}: {staging?:boolean;grant?:boolean;pending?:boolean;generation?:()=>Promise<string>;receive?: ReturnType<typeof vi.fn<NonNullable<Parameters<typeof startLoom>[0]['bridges']>['receive']>>}={}){
  const home=mkdtempSync(join(tmpdir(),'slack-root-'));fixture(home);
  const clock=new FakeClock();let epoch='00000000-0000-4000-8000-000000000000';
  const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue','bridges.route','bridges.link','bridges.send'],operations:[]}}});
  const sockets:FakeSocket[]=[];const buffers:Uint8Array[]=[];
  const source={generation:vi.fn(generation ?? (async()=>epoch)),read:vi.fn(async(name:string)=>{const b=Buffer.from(`PRIVATE-${name}`);buffers.push(b);return b;})};
  const request=vi.fn<typeof fetch>(async url=>{
    const method=String(url).split('/').pop();
    if(method==='auth.test')return Response.json({ok:true,team_id:'T123',user_id:'U123',bot_id:'B123'});
    if(method==='bots.info')return Response.json({ok:true,bot:{id:'B123',user_id:'U123',deleted:false,app_id:'A123'}});
    if(method==='apps.connections.open')return Response.json({ok:true,url:'wss://wss-primary.slack.com/link?ticket=PRIVATE'});
    if(method==='conversations.info')return Response.json({ok:true,channel:{id:'D123',is_im:true,is_mpim:false,user:'U200'}});
    return Response.json({ok:true,user:{id:'U200',team_id:'T123',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false}});
  });
  const startOptions: Parameters<typeof startLoom>[0]={home,next:true,staging,clock,sharing,stdout:()=>{},
    bridges:{source,name:()=> 'Jonathan',receive,request,socket:()=>{const s=new FakeSocket();sockets.push(s);return s as unknown as ReturnType<NonNullable<SlackSocketOptions['socket']>>;}},
    install(a){
      installSecrets(a.db,a.operations,a.live,sharing);installSecretServices(a.db,a.operations,sharing);installBridges(a,sharing);
      let n=0;for(const name of ['bot','app']){
        expect(a.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.describe',{name,description:name},`d${n++}`).ok).toBe(true);
        if(grant)expect(a.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.grantService',{service:'bridges',name},`g${n++}`).ok).toBe(true);
      }
      put(a.db,'venues',venue);
      if(pending)void slackInbox(a.db,clock,{venue,app:'A123'}).receive(payload);
    }};
  const app=await startLoom(startOptions);
  cleanups.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
  return {app,clock,sockets,source,buffers,request,receive,rotate(){epoch=randomUUID();},async restart(){await app.close();const restarted=await startLoom({...startOptions,install:undefined});cleanups.unshift(restarted.close);return restarted;}};
}
it('root uses real service grants, authenticates before socket startup, drains saved receipts without new input',async()=>{
  const f=await setup({pending:true});await until(()=>f.receive.mock.calls.length===1 && f.sockets.length===1);await settle();
  expect(f.request.mock.calls.slice(0,2).map(c=>String(c[0]).split('/').pop())).toEqual(['auth.test','bots.info']);
  expect(f.app.db.prepare('SELECT state,event FROM bridges_slack_receipts').get()).toEqual({state:'consumed',event:null});
  expect(f.source.read.mock.calls.map(c=>c[0])).toContain('app');expect(f.buffers.every(b=>b.every(x=>x===0))).toBe(true);
});
it('missing service grants cause no holder or network IO and recover after the owner grants',async()=>{
  const f=await setup({grant:false});await settle();expect(f.source.read).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
  for(const name of ['bot','app'])expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.grantService',{service:'bridges',name},`allow-${name}`).ok).toBe(true);
  f.clock.advance(5000);await until(()=>f.sockets.length===1);
});
it('staging holds authentication and dial, then releases one stable connection attempt',async()=>{
  const f=await setup({staging:true});await settle();expect(f.request).not.toHaveBeenCalled();expect(f.source.read).not.toHaveBeenCalled();
  f.clock.advance(5000);await settle();
  const rows=f.app.db.prepare("SELECT id FROM core_effects WHERE kind='bridge-send'").all() as {id:string}[];expect(rows).toHaveLength(1);
  expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:rows[0].id},'release').ok).toBe(true);
  f.clock.advance(0);await until(()=>f.sockets.length===1);expect(f.request.mock.calls.filter(c=>String(c[0]).endsWith('auth.test'))).toHaveLength(1);
});
it('ACKs a raw commit while normalization waits, and root close waits before closing SQLite',async()=>{
  const handoff=deferred<void>();const receive=vi.fn(async()=>handoff.promise);const f=await setup({receive});await until(()=>f.sockets.length===1);
  const socket=f.sockets[0];socket.hello();socket.frame({type:'events_api',envelope_id:'env',payload});await until(()=>socket.send.mock.calls.length===1 && receive.mock.calls.length===1);
  expect(f.app.db.prepare('SELECT state FROM bridges_slack_receipts').get()).toEqual({state:'pending'});
  let closed=false;const closing=f.app.close().then(()=>{closed=true;});try {
    await vi.waitFor(()=>expect(socket.terminate).toHaveBeenCalledOnce());
    expect(closed).toBe(false);expect(f.app.db.open).toBe(true);
  } finally { handoff.resolve(); await closing; }
  expect(f.app.db.open).toBe(false);
});
it('credential epochs and setup edit/restore retire old receivers and reauthenticate',async()=>{
  const f=await setup();await until(()=>f.sockets.length===1);const first=f.sockets[0];first.hello();
  f.rotate();f.clock.advance(5000);await until(()=>f.sockets.length===2);expect(first.terminate).toHaveBeenCalledOnce();
  const second=f.sockets[1];second.hello();
  put(f.app.db,'venues',{...venue,bot:'U999'});f.app.live.changed([{type:'bridges.venue',id:venue.id}]);
  put(f.app.db,'venues',venue);f.app.live.changed([{type:'bridges.venue',id:venue.id}]);
  expect(second.terminate).toHaveBeenCalledOnce();second.frame({type:'events_api',envelope_id:'obsolete',payload});
  f.clock.advance(5000);await until(()=>f.sockets.length===3);expect(second.send).not.toHaveBeenCalled();
  expect(f.request.mock.calls.filter(c=>String(c[0]).endsWith('auth.test'))).toHaveLength(3);
});
it('shutdown waits for a deferred app-token holder read before SQLite closes',async()=>{
  const f=await setup();await until(()=>f.sockets.length===1);
  const held=deferred<Uint8Array>();f.source.read.mockImplementationOnce(()=>held.promise);
  // Force reconnect, whose app-token acquisition now remains in the real holder role.
  f.sockets[0].emit('close');f.clock.advance(1000);await until(()=>f.source.read.mock.results.at(-1)?.value===held.promise);
  let done=false;const closing=f.app.close().then(()=>{done=true;});
  try {
    await new Promise<void>(resolve=>setImmediate(resolve));await settle();
    expect(done).toBe(false);expect(f.app.db.open).toBe(true);
  } finally {held.resolve(Buffer.from('PRIVATE-app'));await closing;}
  expect(f.app.db.open).toBe(false);expect(f.sockets).toHaveLength(1);
});
it('detects credential replacement while handoff is pending and suppresses late consumption',async()=>{
  const held=deferred<void>();const receive=vi.fn(async()=>held.promise);const f=await setup({pending:true,receive});
  await until(()=>receive.mock.calls.length===1 && f.sockets.length===1);
  f.rotate();f.clock.advance(5000);await settle();expect(f.sockets[0].terminate).toHaveBeenCalledOnce();
  held.resolve();await until(()=>f.sockets.length===2);await settle();
  // Freshly authenticated lifetime replays the same receipt; late old work did not consume it.
  expect(receive).toHaveBeenCalledTimes(2);
});
it.each(['secret.name','secret.grant','secret.policy','core.access'])('immediately retires an active session on %s',async type=>{
  const f=await setup();await until(()=>f.sockets.length===1);
  f.app.live.changed([{type,id:'changed'}]);expect(f.sockets[0].terminate).toHaveBeenCalledOnce();
  await until(()=>f.sockets.length===2);
});
it('keeps the authenticated session for traffic and status notifications',async()=>{
  const f=await setup();await until(()=>f.sockets.length===1);
  for(const type of ['bridges.venue','bridges.send'])f.app.live.changed([{type,id:'slack'}]);
  f.clock.advance(5000);await settle();expect(f.sockets).toHaveLength(1);expect(f.sockets[0].terminate).not.toHaveBeenCalled();
});
it('released staging lifetime permits reconnect and metadata, but credential replacement is held again',async()=>{
  const f=await setup({staging:true});await settle();
  const row=f.app.db.prepare("SELECT id FROM core_effects WHERE state='due'").get() as {id:string};
  f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:row.id},'release-reconnect');
  f.clock.advance(0);await until(()=>f.sockets.length===1);
  f.sockets[0].hello();f.sockets[0].emit('close');f.clock.advance(1000);await until(()=>f.sockets.length===2);
  f.sockets[1].hello();f.sockets[1].frame({type:'events_api',envelope_id:'env',payload});await until(()=>f.receive.mock.calls.length===1);
  f.rotate();f.clock.advance(5000);await settle();expect(f.sockets).toHaveLength(2);expect(f.sockets[1].terminate).toHaveBeenCalledOnce();
  expect(f.app.db.prepare("SELECT count(*) n FROM core_effects WHERE state='due'").get()).toEqual({n:1});
});
it('startup failure awaits pending authentication before SQLite closes',async()=>{
  const home=mkdtempSync(join(tmpdir(),'slack-start-failure-'));fixture(home);const clock=new FakeClock();
  const held=deferred<Uint8Array>();const source={generation:async()=>randomUUID(),read:vi.fn(()=>held.promise)};
  const request=vi.fn<typeof fetch>(async()=>Response.json({ok:false}));
  let db!:Parameters<typeof installBridges>[0]['db'];
  const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue'],operations:[]}}});
  const starting=startLoom({home,next:true,host:[],clock,sharing,stdout:()=>{},bridges:{source,name:()=>undefined,receive:async()=>{},request},
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
  f.app.live.changed([{type,id:'bot'}]);held.resolve(Response.json({ok:true,team_id:'T123',user_id:'U123',bot_id:'B123'}));
  await until(()=>f.sockets.length===2);await settle();expect(f.sockets).toHaveLength(2);
  expect(f.request.mock.calls.filter(c=>String(c[0]).endsWith('auth.test'))).toHaveLength(3);
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
  f.rotate();f.clock.advance(5000);held.resolve(Response.json({ok:true,team_id:'T123',user_id:'U123',bot_id:'B123'}));
  await until(()=>f.sockets.length===2);expect(f.request.mock.calls.filter(c=>String(c[0]).endsWith('auth.test'))).toHaveLength(3);
});
it('holds a replacement staging identity even if its setup is restored',async()=>{
  const f=await setup({staging:true});await settle();const row=f.app.db.prepare("SELECT id FROM core_effects WHERE state='due'").get() as {id:string};
  f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:row.id},'before-setup');f.clock.advance(0);await until(()=>f.sockets.length===1);
  put(f.app.db,'venues',{...venue,bot:'U999'});f.app.live.changed([{type:'bridges.venue',id:'slack'}]);
  put(f.app.db,'venues',venue);f.app.live.changed([{type:'bridges.venue',id:'slack'}]);await settle();
  expect(f.sockets).toHaveLength(1);expect(f.sockets[0].terminate).toHaveBeenCalledOnce();
  expect(f.app.db.prepare("SELECT count(*) n FROM core_effects WHERE state='due'").get()).toEqual({n:1});
});
it('suppresses metadata HTTP after shutdown during holder acquisition',async()=>{
  const f=await setup();await until(()=>f.sockets.length===1);const held=deferred<Uint8Array>();f.source.read.mockImplementationOnce(()=>held.promise);
  f.sockets[0].hello();f.sockets[0].frame({type:'events_api',envelope_id:'env',payload});await until(()=>f.source.read.mock.results.at(-1)?.value===held.promise);
  const calls=f.request.mock.calls.length;const closing=f.app.close();
  try {await vi.waitFor(()=>expect(f.sockets[0].terminate).toHaveBeenCalledOnce());expect(f.app.db.open).toBe(true);}
  finally {held.resolve(Buffer.from('PRIVATE'));await closing;}
  expect(f.request).toHaveBeenCalledTimes(calls);
});
it('retains a staging release through temporary authentication failure',async()=>{
  const f=await setup({staging:true});await settle();
  f.request.mockImplementationOnce(async()=>Response.json({ok:false,error:'temporarily_unavailable'}));
  const row=f.app.db.prepare("SELECT id FROM core_effects WHERE state='due'").get() as {id:string};
  f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:row.id},'release-auth-retry');f.clock.advance(0);await settle();
  expect(f.sockets).toHaveLength(0);f.clock.advance(5000);await until(()=>f.sockets.length===1);
  expect(f.app.db.prepare("SELECT id,state FROM core_effects WHERE kind='bridge-send'").all()).toEqual([{id:row.id,state:'started'}]);
});
it('fails closed on holder generation loss and requires a new staging release even on same-generation recovery',async()=>{
  const f=await setup({staging:true});await settle();
  const release=()=>{const row=f.app.db.prepare("SELECT id FROM core_effects WHERE state='due' AND kind='bridge-send'").get() as {id:string};expect(row).toBeDefined();expect(f.app.operations.call('direct',{kind:'member',id:'jonathan'},'core.releaseEffect',{id:row.id},`release-${row.id}`).ok).toBe(true);};
  release();f.clock.advance(0);await until(()=>f.sockets.length===1);const epoch=await f.source.generation();
  f.source.generation.mockRejectedValue(Error('PRIVATE HOLDER FAILURE'));f.clock.advance(5000);await settle();
  expect(f.sockets[0].terminate).toHaveBeenCalledOnce();const reads=f.source.read.mock.calls.length,calls=f.request.mock.calls.length;
  f.clock.advance(5000);await settle();expect(f.source.read).toHaveBeenCalledTimes(reads);expect(f.request).toHaveBeenCalledTimes(calls);
  f.source.generation.mockResolvedValue(epoch);f.clock.advance(5000);await settle();expect(f.sockets).toHaveLength(1);
  release();f.clock.advance(0);await until(()=>f.sockets.length===2);
});
it('does not acquire any credential until the initial asynchronous generation is available',async()=>{
  const held=deferred<string>(),f=await setup({generation:()=>held.promise});
  try {
    await settle();expect(f.source.read).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();expect(f.sockets).toHaveLength(0);
    held.resolve('00000000-0000-4000-8000-000000000000');await until(()=>f.sockets.length===1);
  } finally {held.resolve('00000000-0000-4000-8000-000000000000');}
});

it('root closes the shared monitor during pending generation IO and prevents late polling',async()=>{
  const f=await setup();await until(()=>f.sockets.length===1);
  const held=deferred<string>();f.source.generation.mockImplementationOnce(()=>held.promise);
  f.clock.advance(5000);await until(()=>f.source.generation.mock.results.at(-1)?.value===held.promise);
  await f.app.close();expect(f.app.db.open).toBe(false);const polls=f.source.generation.mock.calls.length;
  const reads=f.source.read.mock.calls.length,calls=f.request.mock.calls.length;
  held.resolve('00000000-0000-4000-8000-000000000001');await settle();f.clock.advance(60_000);await settle();
  expect(f.source.generation).toHaveBeenCalledTimes(polls);expect(f.source.read).toHaveBeenCalledTimes(reads);
  expect(f.request).toHaveBeenCalledTimes(calls);expect(f.sockets).toHaveLength(1);
});
