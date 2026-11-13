import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing, installFixture } from '../../fixture.js';
import { FakeClock, type RecordType, type Sharing, type Viewer } from '../../core/index.js';
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
