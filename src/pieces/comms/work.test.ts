import { afterEach, expect, it } from 'vitest';
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
 const app=await startLoom({home,clock,install:app=>{
  installTasks(app.db,app.operations,app.live,()=>sharing);
  installChanges(app.db,app.operations,app.live,()=>sharing);
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
 const task=(id:string,source=conversation,project='pond',status='open')=>{
  const record=({id,title:`Work ${id}`,type:'task',status,priority:1,createdAt:'2026-11-01T00:00:00Z',createdBy:'other',comments:[],source:`conversation:${source}`,project});
  const result=app.operations.call('direct',{kind:'member',id:'other'},'tasks.import',{tasks:[record],links:[],actor:'other',at:'2026-11-01T00:00:00Z'},`task-${++seq}`);
  expect(result).toMatchObject({ok:true,value:{result:{ok:true}}});
 };
 return {app,call,thread,conversation,task,sharing};
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
