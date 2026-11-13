import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing, installFixture } from '../../fixture.js';
import { FakeClock, type RecordType, type Sharing, type Viewer } from '../../core/index.js';
import { DataStore, type Socket } from '../../../web/src/data/store.js';
const closes: (()=>Promise<void>)[] = [], homes: string[] = [];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
async function setup() {
  const home=mkdtempSync(join(tmpdir(),'attention-home-'));homes.push(home);fixture(home);
  let held:Sharing=fixtureSharing(); const sharing=()=>held;
  const types=new Map<string,RecordType>();
  const app=await startLoom({home,next:true,clock:new FakeClock(),sharing,authenticate:()=>({viewer:{kind:'member',id:'pollock'},valid:()=>true}),install:app=>{
    installFixture(app);
    const register=app.live.register.bind(app.live);app.live.register=type=>{types.set(type.name,type);register(type);};
  }});closes.push(app.close);
  return {app,type:types.get('attention.ownedAgent')!,setSharing:(next:Sharing)=>{held=next;app.live.changed([{type:'core.access',id:'household'}]);}};
}
it('lists owned agents even with no status, excludes project-only access, and grants no agent/service/runner roster',async()=>{
  const {type}=await setup();
  const visible=(viewer:Viewer)=>type.ids(undefined).flatMap(id=>type.read(id,viewer)??[]);
  expect(visible({kind:'member',id:'jonathan'})).toEqual([{id:'art',name:'art'},{id:'mark',name:'mark'}]);
  expect(visible({kind:'member',id:'pollock'})).toEqual([{id:'pond-bot',name:'pond-bot'}]);
  for(const viewer of [{kind:'member',id:'missing'},{kind:'agent',id:'art'},{kind:'service',id:'attention'},{kind:'runner',id:'runner'}] as Viewer[])expect(visible(viewer)).toEqual([]);
});
it('refreshes an already subscribed roster on ownership changes, deleting removed cards and adding idle ones',async()=>{
  const {app,setSharing}=await setup();
  const socket=new WebSocket(app.url.replace('http','ws')+'/live');closes.push(async()=>{socket.terminate();});
  const messages: unknown[]=[];socket.on('message',data=>messages.push(JSON.parse(String(data))));
  await once(socket,'open');socket.send(JSON.stringify({kind:'subscribe',type:'attention.ownedAgent'}));
  await expect.poll(()=>messages).toContainEqual(expect.objectContaining({kind:'set',records:[{id:'pond-bot',name:'pond-bot'}]}));
  messages.length=0;
  const sharing=fixtureSharing();sharing.members.pollock.agents=['mark'];setSharing(sharing);
  await expect.poll(()=>JSON.stringify(messages)).toContain('mark');
  expect(messages).toContainEqual(expect.objectContaining({kind:'set',records:[{id:'mark',name:'mark'}]}));
  expect(JSON.stringify(messages)).not.toContain('pond-bot');
});

it('installs only records in next mode: no scheduled Attention work, retention or outside effects',async()=>{
  const home=mkdtempSync(join(tmpdir(),'attention-home-startup-'));homes.push(home);fixture(home);
  const clock=new FakeClock(Date.parse('2026-11-13T08:00:00Z'));
  const network=vi.spyOn(globalThis,'fetch');
  try {
    const app=await startLoom({home,next:true,staging:true,clock,sharing:fixtureSharing,install:installFixture});closes.push(app.close);
    const old=app.operations.call('direct',{kind:'agent',id:'art'},'attention.recordTurn',{agent:'art',turn:{venue:'relay',place:'old',at:'2026-01-01T00:00:00Z',kind:'message',from:{kind:'person',slug:'jonathan'}}},'old-turn');
    expect(old.ok).toBe(true);
    clock.advance(2*86_400_000);
    expect(network).not.toHaveBeenCalled();
    expect(app.db.prepare('SELECT * FROM attention_turns').all()).toHaveLength(1);
    expect(app.db.prepare('SELECT * FROM attention_days').all()).toEqual([]);
    expect(app.db.prepare('SELECT * FROM core_effects').all()).toEqual([]);
  }finally{network.mockRestore();}
});

it.each([false,true])('rechecks ownership on a queued Home write retry; committed response lost=%s',async(committed)=>{
  const {app,setSharing}=await setup();
  const initial=fixtureSharing();initial.members.pollock.agents=['art'];setSharing(initial);
  const owner:Viewer={kind:'member',id:'jonathan'},viewer:Viewer={kind:'member',id:'pollock'};
  expect(app.operations.call('direct',owner,'attention.raise',{id:'shared',agent:'art',project:'pond',ask:'Proceed?',source:{kind:'piece',id:'test'}},'shared-raise').ok).toBe(true);
  const frames:string[]=[],sockets:FakeSocket[]=[],timers:(()=>void)[]=[];
  let first=true;
  class FakeSocket implements Socket {
    readyState=0;onopen:(()=>void)|null=null;onmessage:((event:{data:string})=>void)|null=null;onclose:((event:{code:number})=>void)|null=null;onerror:(()=>void)|null=null;
    send(wire:string){
      frames.push(wire);const frame=JSON.parse(wire) as {name:string;input:unknown;id:string;request:string};
      if(first&&!committed){first=false;return;}
      const result=app.operations.call('socket',viewer,frame.name,frame.input,frame.id);
      if(first){first=false;return;}
      this.onmessage?.({data:JSON.stringify({kind:'result',request:frame.request,result})});
    }
    close(){this.readyState=3;}
    open(){this.readyState=1;this.onopen?.();}
    drop(){this.readyState=3;this.onclose?.({code:1006});}
  }
  const store=new DataStore({socket:()=>{const socket=new FakeSocket();sockets.push(socket);return socket;},id:()=>'home-write',after:(_ms,fn)=>{timers.push(fn);return()=>{};}});
  try {
    const pending=store.call('attention.answer',{id:'shared',answer:{kind:'yes'},requireOwnership:true});sockets[0].open();
    expect(pending.getSnapshot().pending).toBe(true);sockets[0].drop();
    const revoked=fixtureSharing();revoked.members.pollock.agents=[];setSharing(revoked);
    expect(app.operations.call('direct',viewer,'attention.get',{id:'shared'}).ok).toBe(true); // project visibility survives
    timers.shift()!();sockets[1].open();
    const result=await pending.result;
    expect(frames).toHaveLength(2);expect(frames[1]).toBe(frames[0]);
    if(committed){
      expect(result).toMatchObject({ok:true,value:{state:'answered',answer:{kind:'yes',by:viewer}}});
      expect(app.db.prepare("SELECT * FROM core_operations WHERE id='home-write'").all()).toHaveLength(1);
    }else{
      expect(result).toMatchObject({ok:false,code:'denied'});
      expect(app.operations.call('direct',viewer,'attention.get',{id:'shared'})).toMatchObject({ok:true,value:{state:'open'}});
      // Inbox still permits this project-visible person's answer, without the Home-only restriction.
      expect(app.operations.call('direct',viewer,'attention.answer',{id:'shared',answer:{kind:'no'}},'inbox-answer')).toMatchObject({ok:true,value:{state:'answered',answer:{kind:'no'}}});
    }
  }finally{store.close();}
});
