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
/** Only transport shape is needed; expectations narrow individual payloads. */
interface Frame {kind:string;[key:string]:unknown}
async function cardWindow(url:string,scope?:string){
 const ws=new WebSocket(url.replace('http:','ws:')+'/live',{headers:{'x-member':'jonathan'}});
 const queue:Frame[]=[],waiters:((v:Frame)=>void)[]=[];
 ws.on('message',raw=>{const v=JSON.parse(raw.toString()) as Frame,next=waiters.shift();if(next)next(v);else queue.push(v);});
 const next=()=>queue.length?Promise.resolve(queue.shift()!):new Promise<Frame>(r=>waiters.push(r));
 await once(ws,'open');cleanup.push(async()=>{if(ws.readyState===WebSocket.CLOSED)return;const done=once(ws,'close');ws.terminate();await done;});
 ws.send(JSON.stringify({kind:'subscribe',type:'comms.refCards',...(scope?{scope}:{})}));return {next};
}

async function setup() {
 const home=mkdtempSync(join(tmpdir(),'comms-ref-cards-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 const key=await loadKey(home), clock=new FakeClock();
 const sharing:Sharing={members:{jonathan:{owner:false,agents:['art']},other:{owner:true,agents:['art']}},projects:{pond:{members:['jonathan'],agents:['art']},hidden:{members:['other'],agents:[]}},services:{}};
 let comms!:ReturnType<typeof installComms>;
 const app=await startLoom({home,clock,authenticate:req=>({viewer:{kind:'member',id:String(req.headers['x-member']??'jonathan')},window:req.headers['x-window']!=='no',valid:()=>true}),install:app=>{
  installTasks(app.db,app.operations,app.live,()=>sharing);
  installChanges(app.db,app.operations,app.live,()=>sharing,{attribution:()=>({agents:{art:{logins:['art-bot'],branches:[]}},ownerLogins:[]})});
  comms=installComms({...app,clock,key,sharing:()=>sharing,runtime:{async deliver(){},async end(){}},hold:run=>run(),attention:{answer:()=>({ok:true,value:{}})}});
  cleanup.push(comms.close);
 }});cleanup.push(app.close);
 let seq=0;const member:Viewer={kind:'member',id:'jonathan'};
 const call=(name:string,input:unknown,viewer:Viewer=member,window=true)=>app.operations.callAsync('socket',viewer,`comms.${name}`,input,`op-${++seq}`,window);
 const opened=await call('open',{agent:'art',id:'aaaaaaaaaaaaaaaa',text:'Private words'});
 if(!opened.ok)throw new Error('fixture open failed');
 const thread=(opened.value as {thread:string}).thread;
 // The operation acknowledgement precedes asynchronous delivery settlement.
 // Start socket proofs only after that initial lifecycle has fully settled.
 await comms.deliver('art',thread,1);
 const row=app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(thread) as {record:string};
 const conversation=(JSON.parse(row.record) as {conversation:string}).conversation;
 const task=(id:string,source=conversation,project='pond',status='open',description?:string,createdAt='2026-11-01T00:00:00Z')=>{
  const record=({id,description,title:`Work ${id}`,type:'task',status,priority:1,createdAt,createdBy:'other',comments:[],source:`conversation:${source}`,project});
  const result=app.operations.call('direct',{kind:'member',id:'other'},'tasks.import',{tasks:[record],links:[],actor:'other',at:'2026-11-01T00:00:00Z'},`task-${++seq}`);
  expect(result).toMatchObject({ok:true,value:{result:{ok:true}}});
 };
 return {app,clock,call,thread,conversation,task,sharing,comms,key};
}
it('reads tasks by the original viewer, including non-cited work, without message decryption',async()=>{
 const s=await setup();s.task('t-1','cv-other');s.task('t-2',s.conversation,'hidden');
 await s.comms.referencesReady;const opened=vi.spyOn(s.key,'open');
 const result=await s.call('refCards',{thread:s.thread,refs:['t-1','t-2','t-999','note:private','agent:art']});
 expect(result).toMatchObject({ok:true,value:{thread:s.thread,cards:{'t-1':{kind:'task',title:'Work t-1',status:'Open',url:'/p/tasks-preview/task/t-1'},'t-2':null,'t-999':null,'note:private':null,'agent:art':null}}});
 expect(opened).not.toHaveBeenCalled();
 expect(JSON.stringify(result)).not.toContain('Private words');
 expect(s.app.operations.call('direct',{kind:'member',id:'other'},'tasks.close',{id:'t-1',actor:'art',at:new Date(s.clock.now()).toISOString()},'close-task')).toMatchObject({ok:true});
 expect(await s.call('refCards',{thread:s.thread,refs:['t-1']})).toMatchObject({ok:true,value:{cards:{'t-1':{status:'Done',tone:'ok'}}}});
});
it('rejects other owners, non-window callers, removed ownership and oversized input',async()=>{
 const s=await setup(),input={thread:s.thread,refs:['t-1']};
 for(const viewer of [{kind:'member',id:'other'},{kind:'agent',id:'art'},{kind:'service',id:'runtime'}] as Viewer[])
  expect(await s.call('refCards',input,viewer)).toMatchObject({ok:false,code:'denied'});
 expect(await s.call('refCards',input,undefined,false)).toMatchObject({ok:false,code:'denied'});
 expect(await s.call('refCards',{thread:s.thread,refs:Array(61).fill('t-1')})).toMatchObject({ok:false});
 s.sharing.members.jonathan.agents=[];expect(await s.call('refCards',input)).toMatchObject({ok:false,code:'denied'});
});
it('uses owning Changes metadata and its explicit not-found, never a hidden-record fallback',async()=>{
 const s=await setup();replaceChanges(s.app.db,[change({project:'pond',agent:'art'}),change({id:'github:secret/app#4',repo:'github:secret/app',number:4,page:'c/github/secret/app/4',project:'hidden',agent:'mark'})]);
 const result=await s.call('refCards',{thread:s.thread,refs:['github:acme/app#3','github:secret/app#4','github:unknown/app#5','github:../app#1','bare#1','github:acme/app#0']});
 expect(result).toMatchObject({ok:true,value:{cards:{'github:acme/app#3':{kind:'pr',url:'/p/changes-preview/change/github%3Aacme%2Fapp%233'},'github:secret/app#4':null,'github:unknown/app#5':{status:'Not tracked',url:'https://github.com/unknown/app/issues/5'},'github:../app#1':null,'bare#1':null,'github:acme/app#0':null}}});
});
it('deduplicates 60 refs and refuses mismatched owning ids or arbitrary navigation',async()=>{
 const s=await setup(),original=s.app.operations.call.bind(s.app.operations);
 const calls:string[]=[];
 const spy=vi.spyOn(s.app.operations,'call').mockImplementation((door,viewer,name,input,id,window)=>{
  if(name==='tasks.show'){calls.push(viewer.id);return {ok:true,value:{result:{ok:true,task:{id:'t-2',title:'Wrong task',status:'open'}}}};}
  if(name==='changes.show')return {ok:true,value:{id:'github:acme/app#3',title:'Unsafe',status:'Open',state:'open',page:'https://evil.example'}};
  return original(door,viewer,name,input,id,window);
 });
 try{expect(await s.call('refCards',{thread:s.thread,refs:[...Array(59).fill('t-1'),'github:acme/app#3']})).toMatchObject({ok:true,value:{cards:{'t-1':null,'github:acme/app#3':null}}});expect(calls).toEqual(['jonathan']);}finally{spy.mockRestore();}
});
it('updates two exact-scope windows and clears on access loss, regrant and deletion',async()=>{
 const s=await setup();s.task('t-1');
 const scope=JSON.stringify({thread:s.thread,refs:['t-1',s.conversation]});
 const window=(scope?:string)=>cardWindow(s.app.url,scope);
 expect(await (await window()).next()).toMatchObject({kind:'set',records:[]});
 const a=await window(scope),b=await window(scope);
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'set',records:[{cards:{'t-1':{status:'Open'}}}]});
 expect(await s.call('change',{thread:s.thread,action:'title',title:'Live conversation title'})).toMatchObject({ok:true});
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'put',record:{cards:{[s.conversation]:{kind:'conversation',title:'Live conversation title'}}}});
 s.app.operations.call('direct',{kind:'member',id:'other'},'tasks.close',{id:'t-1',actor:'art',at:new Date(s.clock.now()).toISOString()},'close');
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'put',record:{cards:{'t-1':{status:'Done'}}}});
 s.sharing.members.jonathan.agents=[];s.app.live.refreshAccess();
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'set',records:[]});
 s.sharing.members.jonathan.agents=['art'];s.app.live.refreshAccess();
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'set',records:[{cards:{'t-1':{status:'Done'}}}]});
 await s.call('change',{thread:s.thread,action:'delete'});
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'del',id:scope});
});
it('answers all 60 distinct references and treats hostile dictionary keys as plain unknown refs',async()=>{
 const s=await setup(),original=s.app.operations.call.bind(s.app.operations),refs=Array.from({length:60},(_,i)=>`t-${i+1}`);
 const seen:string[]=[];
 const spy=vi.spyOn(s.app.operations,'call').mockImplementation((door,viewer,name,input,id,window)=>{
  if(name==='tasks.show'){const key=(input as {id:string}).id;seen.push(key);return {ok:true,value:{result:{ok:true,task:{id:key,title:key,status:'open'}}}};}
  return original(door,viewer,name,input,id,window);
 });
 try{
  const result=await s.call('refCards',{thread:s.thread,refs});expect(result.ok).toBe(true);
  if(result.ok)expect(Object.keys((result.value as {cards:object}).cards)).toEqual(refs);
  expect(seen).toEqual(refs);
  const unknown=await s.call('refCards',{thread:s.thread,refs:['__proto__','constructor','prototype']});
  expect(unknown.ok).toBe(true);if(unknown.ok)expect(JSON.stringify(unknown.value)).toContain('"__proto__":null');
 }finally{spy.mockRestore();}
});

it('conversation cards expose only consistent original-member metadata without decrypting',async()=>{
 const s=await setup();await s.comms.referencesReady;
 const other=await s.call('open',{agent:'art',id:'bbbbbbbbbbbbbbbb',text:'Other member words'},{kind:'member',id:'other'});
 if(!other.ok)throw new Error('other open');
 await s.comms.deliver('art',(other.value as {thread:string}).thread,1);
 const opened=vi.spyOn(s.key,'open');
 const result=()=>s.call('refCards',{thread:s.thread,refs:[s.conversation,'cv-000000000000']});
 expect(await result()).toMatchObject({ok:true,value:{cards:{[s.conversation]:{kind:'conversation',title:'New thread with art',status:'Open',url:`/p/comms-preview/thread/${s.thread.slice(3)}`},'cv-000000000000':null}}});
 expect(await s.call('change',{thread:s.thread,action:'title',title:'PRIVATE current title'})).toMatchObject({ok:true});
 expect(await s.call('change',{thread:s.thread,action:'archive'})).toMatchObject({ok:true});
 expect(await result()).toMatchObject({ok:true,value:{cards:{[s.conversation]:{title:'PRIVATE current title',status:'Archived'}}}});
 // Another owner can use their own thread but cannot resolve this one's title.
 expect(await s.call('refCards',{thread:(other.value as {thread:string}).thread,refs:[s.conversation]},{kind:'member',id:'other'})).toMatchObject({ok:true,value:{cards:{[s.conversation]:null}}});
 expect(opened).not.toHaveBeenCalled();
});
for(const damage of ['ambiguous','relational','tombstone'] as const)it(`conversation cards refuse ${damage} target routing`,async()=>{
 const s=await setup();await s.comms.referencesReady;
 const t=JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(s.thread) as {record:string}).record);
 // Keep the source valid; damage only a separate referenced target.
 const target={...t,id:'th:target',conversation:'cv-012345abcdef',title:'HIDDEN target title'};
 s.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run(target.id,target.member,target.agent,null,JSON.stringify(target));
 if(damage==='ambiguous')s.app.db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run('th:duplicate',target.member,target.agent,null,JSON.stringify({...target,id:'th:duplicate'}));
 if(damage==='relational')s.app.db.prepare('UPDATE comms_threads SET member=? WHERE id=?').run('other',target.id);
 if(damage==='tombstone')s.app.db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run(target.id,target.member,target.agent,target.conversation,0);
 const result=await s.call('refCards',{thread:s.thread,refs:[target.conversation]});
 expect(result).toMatchObject({ok:true,value:{cards:{[target.conversation]:null}}});expect(JSON.stringify(result)).not.toContain('HIDDEN');
});

it('live target lifecycle and target-only ownership changes withdraw metadata in two windows',async()=>{
 const s=await setup();await s.comms.referencesReady;
 s.sharing.members.jonathan.agents.push('mark');
 const opened=await s.call('open',{agent:'mark',id:'cccccccccccccccc',text:'Target private words'});
 if(!opened.ok)throw new Error('target open');const target=(opened.value as {thread:string}).thread;
 await s.comms.deliver('mark',target,1);
 const row=()=>JSON.parse((s.app.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(target) as {record:string}).record);
 const cv=row().conversation as string,scope=JSON.stringify({thread:s.thread,refs:[cv]});
 const window=()=>cardWindow(s.app.url,scope);
 const a=await window(),b=await window();
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'set',records:[{cards:{[cv]:{status:'Open'}}}]});
 const working=(state:boolean)=>s.comms.status('mark',target,state?'working':'done');
 working(true);for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'put',record:{cards:{[cv]:{status:'Working'}}}});
 working(false);for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'put',record:{cards:{[cv]:{status:'Open'}}}});
 expect(await s.call('change',{thread:target,action:'archive'})).toMatchObject({ok:true});
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'put',record:{cards:{[cv]:{status:'Archived'}}}});
 s.sharing.members.jonathan.agents=['art'];s.app.live.refreshAccess();
 for(const w of [a,b]){const result=await w.next();expect(result).toMatchObject({kind:'set',records:[{cards:{[cv]:null}}]});expect(JSON.stringify(result)).not.toContain(target);expect(JSON.stringify(result)).not.toContain('New thread with mark');}
 s.sharing.members.jonathan.agents.push('mark');s.app.live.refreshAccess();
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'set',records:[{cards:{[cv]:{status:'Archived'}}}]});
 expect(await s.call('change',{thread:target,action:'delete'})).toMatchObject({ok:true});
 for(const w of [a,b])expect(await w.next()).toMatchObject({kind:'put',record:{cards:{[cv]:null}}});
});
