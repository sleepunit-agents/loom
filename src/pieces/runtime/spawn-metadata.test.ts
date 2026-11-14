import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import * as commsModule from '../comms/index.js';
import type { StepConversation } from '../comms/role.js';
import { saveThread, thread } from '../comms/store.js';
import { runtimeStore } from './store.js';
import { spawnMetadata } from './spawn-metadata.js';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.restoreAllMocks();});
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'runtime-spawn-metadata-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();let sharing:Sharing=fixtureSharing();
 const app=await startLoom({home,clock,next:true,stdout:()=>{},sharing:()=>sharing,authenticate:()=>({viewer:{kind:'member',id:'jonathan'},window:true,valid:()=>true})});cleanups.push(()=>app.close());
 const store=runtimeStore(app.db),read=spawnMetadata(app,()=>sharing);
 app.db.transaction(()=>{
  saveThread(app.db,{id:'th:owner',agent:'art',member:'jonathan',conversation:'cv-child',project:'pond',title:'Private task',titledBy:'agent',pinned:false,archived:null,opened:clock.now(),last:clock.now(),readSeq:0,nextSeq:1,stop:false,firstId:'abcdefghijklmnop',firstHash:'fixture',working:false});
  store.put('binding',{id:'cv-child',agent:'art',member:'jonathan',project:'pond',venue:'spawn',place:'job-h-1862',job:'child'},clock.now());
  store.put('job',{id:'child',agent:'art',member:'jonathan',project:'pond',conversation:'cv-child',title:'Private task',runner:'a',box:'a',state:'done',createdAt:clock.now(),imported:{history:'discard'}},clock.now());
 })();
 return {app,store,read,clock,setSharing:(value:Sharing)=>{sharing=value;}};
}
it('returns only original joined spawn metadata while preserving imported execution holds and transport',async()=>{
 const f=await setup(),before=f.store.read('binding','cv-child'),job=f.store.read('job','child');
 const metadata=f.read('cv-child');
 expect(metadata).toEqual({agent:'art',member:'jonathan',venue:'spawn',label:'Private task',version:expect.stringMatching(/^[a-f0-9]{64}$/)});
 expect(f.read('cv-child')).toEqual(metadata);
 metadata!.member='forged';expect(f.read('cv-child')!.member).toBe('jonathan');
 expect(f.store.read('binding','cv-child')).toEqual(before);expect(f.store.read('job','child')).toEqual(job);
 expect(f.app.operations.has('runtime.spawnMetadata')).toBe(false);
});
it.each(['missing-binding','missing-job','no-job','memberless','job-member','agent','conversation','project','loom','bridge','revoked','malformed','missing-thread','duplicate-thread','deleted-thread','thread-project'] as const)('refuses %s metadata without choosing a fallback owner',async drift=>{
 const f=await setup();
 f.app.db.transaction(()=>{
  const {changedAt:_,...binding}=f.store.read('binding','cv-child')!,{changedAt:__,...job}=f.store.read('job','child')!;
  if(drift==='missing-thread')f.app.db.prepare('DELETE FROM comms_threads').run();
  else if(drift==='duplicate-thread')saveThread(f.app.db,{...thread(f.app.db,'th:owner')!,id:'th:duplicate',member:'someone'});
  else if(drift==='deleted-thread')f.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('th:deleted','jonathan','art','cv-child',f.clock.now());
  else if(drift==='thread-project')saveThread(f.app.db,{...thread(f.app.db,'th:owner')!,project:undefined});
  else if(drift==='missing-binding')f.app.db.prepare('DELETE FROM runtime_bindings').run();
  else if(drift==='missing-job')f.app.db.prepare('DELETE FROM runtime_jobs').run();
  else if(drift==='malformed')f.app.db.prepare("UPDATE runtime_jobs SET record='{}'").run();
  else if(drift==='revoked')f.setSharing({members:{someone:{agents:['art']}},projects:{}});
  else if(['no-job','memberless','loom','bridge'].includes(drift))f.store.put('binding',{...binding,...(drift==='no-job'?{job:undefined}:drift==='memberless'?{member:undefined}:{venue:drift==='loom'?'loom':'bridge:discord'})},f.clock.now());
  else f.store.put('job',{...job,...(drift==='job-member'?{member:'someone'}:drift==='agent'?{agent:'mark'}:drift==='conversation'?{conversation:'cv-other'}:{project:undefined})},f.clock.now());
 })();
 expect(f.read('cv-child')).toBeUndefined();
});
it('changes version on same-clock owning record changes and refuses after close',async()=>{
 const f=await setup(),first=f.read('cv-child')!;
 f.app.db.transaction(()=>{const {changedAt:_,...job}=f.store.read('job','child')!;f.store.put('job',{...job,title:'Replacement'},f.clock.now());})();
 const second=f.read('cv-child')!;expect(second.version).not.toBe(first.version);
 f.app.db.transaction(()=>{const {changedAt:_,...binding}=f.store.read('binding','cv-child')!;f.store.put('binding',{...binding,place:'sp-independent'},f.clock.now());})();
 expect(f.read('cv-child')!.version).not.toBe(second.version);
 const beforeNotice=f.read('cv-child')!.version;
 f.app.live.changed([{type:'runtime.binding',id:'cv-child'}]);
 expect(f.read('cv-child')!.version).not.toBe(beforeNotice);
 expect(spawnMetadata(f.app,fixtureSharing)('cv-child')!.version).not.toBe(f.read('cv-child')!.version);
 await f.app.close();expect(f.read('cv-child')).toBeUndefined();
});
it('composes the owning callback into actual next Comms background classification',async()=>{
 const f=await setup();
 const created={thread:'th:owner'};
 const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live');cleanups.push(()=>ws.terminate());await once(ws,'open');
 const received=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'thread',scope:'background'}));
 expect(JSON.parse((await received)[0].toString())).toMatchObject({records:expect.arrayContaining([expect.objectContaining({id:created.thread,member:'jonathan',job:{joined:false},background:true})])});
 const removed=once(ws,'message');
 f.app.db.transaction(()=>{const {changedAt:_,...job}=f.store.read('job','child')!;f.store.put('job',{...job,member:'someone'},f.clock.now());})();
 f.app.live.changed([{type:'runtime.job',id:'child'}]);
 expect(JSON.parse((await removed)[0].toString())).toMatchObject({kind:'del',type:'thread',id:created.thread});
 expect(f.store.read('binding','cv-child')!.place).toBe('job-h-1862');
 expect(f.store.read('job','child')!.imported).toEqual({history:'discard'});
 expect(f.app.db.prepare('SELECT * FROM runtime_inputs').all()).toEqual([]);
 expect(f.app.db.prepare('SELECT * FROM runtime_deliveries').all()).toEqual([]);
});

it('keeps the original second member and treats archived threads as metadata',async()=>{
 const f=await setup();f.setSharing({members:{jonathan:{agents:['art']},second:{agents:['art']}},projects:{pond:{members:['jonathan','second'],agents:['art']}}});
 f.app.db.transaction(()=>{
  // Replace the fixture thread's immutable indexed audience consistently.
  f.app.db.prepare('DELETE FROM comms_threads').run();
  saveThread(f.app.db,{id:'th:second',agent:'art',member:'second',conversation:'cv-child',project:'pond',title:null,titledBy:null,pinned:false,archived:f.clock.now(),opened:1,last:1,readSeq:0,nextSeq:1,stop:false,firstId:'abcdefghijklmnop',firstHash:'fixture',working:false});
  const {changedAt:_,...b}=f.store.read('binding','cv-child')!,{changedAt:__,...j}=f.store.read('job','child')!;
  f.store.put('binding',{...b,member:'second'},f.clock.now());f.store.put('job',{...j,member:'second'},f.clock.now());
 })();
 expect(f.read('cv-child')).toMatchObject({member:'second',venue:'spawn'});
});

it('changes the composed reader version after an identical same-clock binding replacement',async()=>{
 const realInstall=commsModule.installComms;let composed:((id:string)=>StepConversation|undefined)|undefined;
 vi.spyOn(commsModule,'installComms').mockImplementation(options=>{composed=options.conversation;return realInstall(options);});
 const f=await setup(),before=composed!('cv-child')!;
 const {changedAt:_,...binding}=f.store.read('binding','cv-child')!;
 f.app.db.transaction(()=>{
  f.app.db.prepare('DELETE FROM runtime_bindings WHERE id=?').run(binding.id);
  f.store.put('binding',binding,f.clock.now());
 })();
 f.app.live.changed([{type:'runtime.binding',id:binding.id}]);
 expect(composed!('cv-child')).toMatchObject({member:'jonathan',agent:'art',venue:'spawn'});
 expect(composed!('cv-child')!.version).not.toBe(before.version);
});
