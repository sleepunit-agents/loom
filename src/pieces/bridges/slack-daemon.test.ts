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
async function setup({staging=false,grant=true,pending=false,receive=vi.fn(async()=>{})}: {staging?:boolean;grant?:boolean;pending?:boolean;receive?: ReturnType<typeof vi.fn<NonNullable<Parameters<typeof startLoom>[0]['bridges']>['receive']>>}={}){
  const home=mkdtempSync(join(tmpdir(),'slack-root-'));fixture(home);
  const clock=new FakeClock();let epoch='0';
  const sharing=()=>({...fixtureSharing(),services:{bridges:{types:['bridges.venue','bridges.route','bridges.link','bridges.send'],operations:[]}}});
  const sockets:FakeSocket[]=[];const buffers:Uint8Array[]=[];
  const source={read:vi.fn(async(name:string)=>{const b=Buffer.from(`PRIVATE-${name}`);buffers.push(b);return b;})};
  const request=vi.fn<typeof fetch>(async url=>{
    const method=String(url).split('/').pop();
    if(method==='auth.test')return Response.json({ok:true,team_id:'T123',user_id:'U123',bot_id:'B123'});
    if(method==='bots.info')return Response.json({ok:true,bot:{id:'B123',user_id:'U123',deleted:false,app_id:'A123'}});
    if(method==='apps.connections.open')return Response.json({ok:true,url:'wss://wss-primary.slack.com/link?ticket=PRIVATE'});
    if(method==='conversations.info')return Response.json({ok:true,channel:{id:'D123',is_im:true,is_mpim:false,user:'U200'}});
    return Response.json({ok:true,user:{id:'U200',team_id:'T123',deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false}});
  });
  const app=await startLoom({home,next:true,staging,clock,sharing,stdout:()=>{},
    bridges:{source,credentialEpoch:()=>epoch,name:()=> 'Jonathan',receive,request,socket:()=>{const s=new FakeSocket();sockets.push(s);return s as unknown as ReturnType<NonNullable<SlackSocketOptions['socket']>>;}},
    install(a){
      installSecrets(a.db,a.operations,a.live,sharing);installSecretServices(a.db,a.operations,sharing);installBridges(a,sharing);
      let n=0;for(const name of ['bot','app']){
        expect(a.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.describe',{name,description:name},`d${n++}`).ok).toBe(true);
        if(grant)expect(a.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.grantService',{service:'bridges',name},`g${n++}`).ok).toBe(true);
      }
      put(a.db,'venues',venue);
      if(pending)void slackInbox(a.db,clock,{venue,app:'A123'}).receive(payload);
    }});
  cleanups.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
  return {app,clock,sockets,source,buffers,request,receive,rotate(){epoch=String(Number(epoch)+1);}};
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
