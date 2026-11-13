import { once } from 'node:events';
import { WebSocket } from 'ws';
import { change } from '../changes/fixture.js';
import { replaceChanges } from '../changes/store.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing, type Viewer } from '../../core/index.js';
import { installTasks } from '../tasks/index.js';
import { installChanges } from '../changes/index.js';
import { installComms } from './index.js';
import { loadKey } from './crypto.js';
const cleanup: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup() {
 const home=mkdtempSync(join(tmpdir(),'comms-work-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const key=await loadKey(home), clock=new FakeClock();
 const sharing:Sharing={members:{jonathan:{owner:false,agents:['art']},other:{owner:true,agents:['art']}},projects:{pond:{members:['jonathan'],agents:['art']},hidden:{members:['other'],agents:[]}},services:{}};
 const app=await startLoom({home,clock,authenticate:req=>({viewer:{kind:'member',id:String(req.headers['x-member']??'jonathan')},window:req.headers['x-window']!=='no',valid:()=>true}),install:app=>{
  installTasks(app.db,app.operations,app.live,()=>sharing);
  installChanges(app.db,app.operations,app.live,()=>sharing,{attribution:()=>({agents:{art:{logins:['art-bot'],branches:[]}},ownerLogins:[]})});
  const comms=installComms({...app,clock,key,sharing:()=>sharing,runtime:{async deliver(){},async end(){}},hold:run=>run(),attention:{answer:()=>({ok:true,value:{}})}});
  cleanup.push(comms.close);
 }});cleanup.push(app.close);
 let seq=0;const member:Viewer={kind:'member',id:'jonathan'};
 const call=(name:string,input:unknown,viewer:Viewer=member,window=true)=>app.operations.callAsync('socket',viewer,`comms.${name}`,input,`op-${++seq}`,window);
 const opened=await call('open',{agent:'art',id:'aaaaaaaaaaaaaaaa',text:'Private words'});
 if(!opened.ok)throw new Error('fixture open failed');
 const thread=(opened.value as {thread:string}).thread;
 const row=app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string};
 const conversation=(JSON.parse(row.record) as {conversation:string}).conversation;
 const task=(id:string,source=conversation,project='pond',status='open',description?:string)=>{
  const record=({id,description,title:`Work ${id}`,type:'task',status,priority:1,createdAt:'2026-11-01T00:00:00Z',createdBy:'other',comments:[],source:`conversation:${source}`,project});
  const result=app.operations.call('direct',{kind:'member',id:'other'},'tasks.import',{tasks:[record],links:[],actor:'other',at:'2026-11-01T00:00:00Z'},`task-${++seq}`);
  expect(result).toMatchObject({ok:true,value:{result:{ok:true}}});
 };
 return {app,clock,call,thread,conversation,task,sharing};
}
it('returns made-here visible tasks and live status without private words or retry receipts',async()=>{
 const s=await setup();s.task('t-1');s.task('t-2',s.conversation,'hidden');s.task('t-3','cv-000000000000');
 const result=await s.call('work',{thread:s.thread});
 expect(result).toMatchObject({ok:true,value:{items:[{ref:'t-1',title:'Work t-1',status:'Open',made:true,from:'tasks',url:'/p/tasks-preview/task/t-1'}],failed:[]}});
 expect(JSON.stringify(result)).not.toMatch(/Private words|Work t-2|Work t-3/);
 expect(s.app.db.prepare("SELECT * FROM core_operations WHERE name='comms.work'").all()).toEqual([]);
});
it('denies other owners, agents, runners, services, bearer callers and removed ownership',async()=>{
 const s=await setup();s.task('t-1');
 for(const viewer of [{kind:'member',id:'other'},{kind:'agent',id:'art'},{kind:'runner',id:'box'},{kind:'service',id:'runtime'}] as Viewer[])
  expect(await s.call('work',{thread:s.thread},viewer)).toMatchObject({ok:false,code:'denied'});
 expect(await s.call('work',{thread:s.thread},undefined,false)).toMatchObject({ok:false,code:'denied'});
 s.sharing.members.jonathan.agents=[];
 expect(await s.call('work',{thread:s.thread})).toMatchObject({ok:false,code:'denied'});
});
async function socket(s:Awaited<ReturnType<typeof setup>>,member='jonathan',window=true) {
 const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:{'x-member':member,'x-window':window?'yes':'no'}});
 type Frame={kind?:string;code?:string;records?:{items:unknown[]}[];record?:{items:{ref:string;status:string}[]};id?:string};
 const queue:Frame[]=[],waiting:((frame:Frame)=>void)[]=[];
 ws.on('message',raw=>{const frame=JSON.parse(raw.toString()) as Frame;const receive=waiting.shift();if(receive)receive(frame);else queue.push(frame);});
 const next=()=>queue.length?Promise.resolve(queue.shift()!):new Promise<Frame>(resolve=>waiting.push(resolve));
 await once(ws,'open');cleanup.push(async()=>{if(ws.readyState===WebSocket.CLOSED)return;const closed=once(ws,'close');ws.terminate();await closed;});
 ws.send(JSON.stringify({kind:'subscribe',type:'threadWork',scope:s.thread}));
 return {next};
}
it('updates two windows on task changes and removes the work record on delete or ownership loss',async()=>{
 const s=await setup(),a=await socket(s),b=await socket(s);
 expect(await a.next()).toMatchObject({kind:'set',records:[{items:[]}]});expect(await b.next()).toMatchObject({kind:'set',records:[{items:[]}]});
 s.task('t-1');
 for(const window of [a,b])expect(await window.next()).toMatchObject({kind:'put',record:{items:[{ref:'t-1',status:'Open'}]}});
 expect(s.app.operations.call('direct',{kind:'member',id:'other'},'tasks.close',{id:'t-1',actor:'art',at:new Date(s.clock.now()).toISOString()},'close-task')).toMatchObject({ok:true,value:{result:{ok:true}}});
 for(const window of [a,b])expect(await window.next()).toMatchObject({kind:'put',record:{items:[{ref:'t-1',status:'Done'}]}});
 s.sharing.members.jonathan.agents=[];s.app.live.refreshAccess();
 for(const window of [a,b])expect(await window.next()).toMatchObject({kind:'set',records:[]});
 s.sharing.members.jonathan.agents=['art'];s.app.live.refreshAccess();
 for(const window of [a,b])expect(await window.next()).toMatchObject({kind:'set',records:[{items:[{ref:'t-1'}]}]});
 await s.call('change',{thread:s.thread,action:'delete'});
 for(const window of [a,b])expect(await window.next()).toMatchObject({kind:'del',id:s.thread});
});
it('does not publish another owner or a bearer subscription',async()=>{
 const s=await setup();s.task('t-1');
 expect(await (await socket(s,'other')).next()).toMatchObject({kind:'set',records:[]});
 expect(await (await socket(s,'jonathan',false)).next()).toMatchObject({code:'denied'});
});
it('includes authorized made-here Changes and expires closed changes at the exact owning-piece deadline',async()=>{
 const s=await setup();s.task('t-1',s.conversation,'pond','open','acme/app#3');
 replaceChanges(s.app.db,[change({id:'github:acme/app#3',repo:'github:acme/app',project:'pond',agent:'art',author:{login:'art-bot'},state:'merged',closed:new Date(s.clock.now()).toISOString()})]);
 expect(await s.call('work',{thread:s.thread})).toMatchObject({ok:true,value:{items:expect.arrayContaining([expect.objectContaining({ref:'github:acme/app#3',from:'changes',made:true,url:'/p/changes-preview/change/github%3Aacme%2Fapp%233'})]),failed:[]}});
 const a=await socket(s);expect(await a.next()).toMatchObject({kind:'set',records:[{items:expect.arrayContaining([expect.objectContaining({from:'changes'})])}]});
 s.clock.advance(7*86400_000);
 expect(await a.next()).toMatchObject({kind:'put',record:{items:[{ref:'t-1'}]}});
});
it('reports a failing piece by name without leaking its failure or discarding other work',async()=>{
 const s=await setup();s.task('t-1');
 const original=s.app.operations.call.bind(s.app.operations);
 const spy=vi.spyOn(s.app.operations,'call').mockImplementation((door,viewer,name,input,id,window)=>name==='changes.thread-feed'?{ok:false,code:'unavailable',message:'PRIVATE FAILURE'}:original(door,viewer,name,input,id,window));
 try {const result=await s.call('work',{thread:s.thread});expect(result).toMatchObject({ok:true,value:{items:[{ref:'t-1'}],failed:['Changes']}});expect(JSON.stringify(result)).not.toContain('PRIVATE FAILURE');}finally{spy.mockRestore();}
});
it('orders blocked work first and rechecks task project visibility on every read',async()=>{
 const s=await setup();s.task('t-1');s.task('t-2');
 expect(s.app.operations.call('direct',{kind:'member',id:'other'},'tasks.link',{id:'t-2',dependsOn:'t-1',type:'blocks',actor:'other',at:new Date(s.clock.now()).toISOString()},'block')).toMatchObject({ok:true,value:{result:{ok:true}}});
 expect(await s.call('work',{thread:s.thread})).toMatchObject({ok:true,value:{items:[{ref:'t-2',status:'Blocked',tone:'bad'},{ref:'t-1'}]}});
 s.sharing.projects.pond.members=[];
 expect(await s.call('work',{thread:s.thread})).toMatchObject({ok:true,value:{items:[],failed:[]}});
});
