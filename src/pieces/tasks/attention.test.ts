import Database from 'better-sqlite3';
import { importTasks } from './importer.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { z } from 'zod';
import { createFoundation } from '../../core/app.js';
import { FakeClock, operation, type RecordType, type Viewer } from '../../core/index.js';
import { taskAskId } from '../attention/role.js';
import { installTasks } from './index.js';
import { PeopleStore } from '../../backends/people.js';
import { SharingDatabase } from '../../core/household/sharing.js';
const homes:string[]=[], closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
const owner:Viewer={kind:'member',id:'jonathan'}, member:Viewer={kind:'member',id:'pollock'};
async function setup(home?:string, old=false, denyTasks=false) {
  let coreDb: import('../../core/index.js').Db;
  if(!home){home=mkdtempSync(join(tmpdir(),'task-attention-'));homes.push(home);fixture(home);
    mkdirSync(join(home,'commons'),{recursive:true});const people=new PeopleStore({dbPath:join(home,'commons','people.db')});people.write({slug:'pollock',name:'Pollock'});people.close();}
  const types=new Map<string,RecordType>();
  const app=await startLoom({home,next:true,staging:true,clock:new FakeClock(1_800_000_000_000),stdout:()=>{},sharing:denyTasks?()=>{const held=new SharingDatabase(coreDb,home!).sharing();return held.services.tasks?{...held,services:{...held.services,tasks:{...held.services.tasks,operations:[]}}}:held;}:undefined,install:a=>{
    coreDb=a.db;
    const register=a.live.register.bind(a.live);a.live.register=t=>{types.set(t.name,t);register(t);};
    if(old)installTasks(a.db,a.operations,a.live,()=>new SharingDatabase(a.db,home!).sharing());
  }});closes.push(app.close);
  const call=(name:string,input:unknown,viewer=owner,id=randomUUID())=>app.operations.call('direct',viewer,name,input,id);
  const create=(extra:object={})=>{
    const r=call('tasks.create',{title:'Review the plan',actor:'art',at:'2026-11-13T00:00:00Z',assignee:'jonathan',ask:'Ship the plan?',why:'It is ready',ifYes:'I ship it',ifNo:'I hold it',answers:'yes-no',...extra});
    expect(r).toMatchObject({ok:true,value:{result:{ok:true}}});const id=(r as {value:{result:{id:string}}}).value.result.id;
    const {project: _project,agent: _agent,...set} = {assignee:'jonathan',ask:'Ship the plan?',why:'It is ready',ifYes:'I ship it',ifNo:'I hold it',answers:'yes-no',...extra} as Record<string,unknown>;
    expect(call('tasks.update',{id,set,actor:'art',at:'2026-11-13T00:00:00Z'})).toMatchObject({ok:true,value:{result:{ok:true}}});return id;
  };
  const ask=(id:string,v=owner)=>call('attention.get',{id:taskAskId(id)},v);
  return {app,call,create,ask,home,types};
}
it('files current owner tasks with exact scope and owning navigation; central writes never decide them',async()=>{
  const s=await setup(), id=s.create({project:'pond',agent:'art'});
  expect(s.ask(id)).toMatchObject({ok:true,value:{id:taskAskId(id),source:{kind:'task',id},sourceManaged:true,state:'open',ask:'Ship the plan?',why:'It is ready',if_yes:'I ship it',if_no:'I hold it',project:'pond',agent:'art'}});
  expect(s.ask(id,member).ok).toBe(true);
  for(const [verb,input] of [['answer',{answer:{kind:'yes'}}],['resolve',{reason:'Bypass'}],['raise',{ask:'Bypass',source:{kind:'task',id}}]] as const)
    expect(s.call(`attention.${verb}`,{id:taskAskId(id),...input})).toMatchObject({ok:false,code:'denied'});
  expect(s.call('tasks.show',{id})).toMatchObject({ok:true,value:{result:{task:{status:'open',assignee:'jonathan'}}}});
  expect(s.call('attention.raise',{id:'forged-task',ask:'Spoof',source:{kind:'task',id}})).toMatchObject({ok:false,code:'denied'});
  const other=s.create({assignee:'art'});expect(s.ask(other).ok).toBe(false);
});
it('replaces wording and audience atomically on a task move, without leaving an old-audience copy',async()=>{
  const s=await setup(), id=s.create({project:'pond',agent:'art'});
  expect(s.call('attention.markRead',{id:taskAskId(id)},member).ok).toBe(true);
  const changes:unknown[]=[];s.app.live.observe(c=>changes.push(c));
  expect(s.call('tasks.update',{id,set:{project:'other',ask:'Hold the plan?'},actor:'art',at:'2026-11-13T00:01:00Z'})).toMatchObject({ok:true,value:{result:{ok:true}}});
  expect(s.ask(id,member)).toMatchObject({ok:false,code:'denied'});
  expect(s.types.get('attention.ask')!.read(taskAskId(id),member)).toBeUndefined();
  const mark=s.app.db.prepare('SELECT id FROM attention_read_marks WHERE ask=?').get(taskAskId(id)) as {id:string};
  expect(s.types.get('attention.readMark')!.read(mark.id,member)).toBeUndefined();
  expect(s.ask(id)).toMatchObject({ok:true,value:{project:'other',agent:'art',ask:'Hold the plan?'}});
  expect(changes).toContainEqual(expect.arrayContaining([{type:'task',id},{type:'attention.ask',id:taskAskId(id)} ]));
  expect(s.app.db.prepare('SELECT record FROM attention_asks WHERE id=?').all(taskAskId(id))).toHaveLength(1);
  expect(s.app.db.prepare('SELECT record FROM attention_asks WHERE id=?').get(taskAskId(id))).not.toEqual(expect.objectContaining({record:expect.stringContaining('Ship the plan?')}));
});
it('withdraws on reassignment, closure and deletion, and lets the source reopen without a human answer',async()=>{
  const s=await setup(),id=s.create();
  for(const set of [{assignee:'art'},{status:'closed'}]) {
    if('status' in set)expect(s.call('tasks.close',{id,actor:'art',at:'2026-11-13T00:02:00Z'}).ok).toBe(true);
    else expect(s.call('tasks.update',{id,set,actor:'art',at:'2026-11-13T00:01:00Z'}).ok).toBe(true);
    expect(s.ask(id)).toMatchObject({ok:true,value:{state:'resolved',ask:'Task no longer needs you'}});
    expect(s.ask(id)).not.toHaveProperty('value.answer');
    expect(s.call('tasks.reopen',{id,actor:'art',at:'2026-11-13T00:03:00Z'}).ok).toBe(true);
    expect(s.call('tasks.update',{id,set:{assignee:'jonathan'},actor:'art',at:'2026-11-13T00:04:00Z'}).ok).toBe(true);
    expect(s.ask(id)).toMatchObject({ok:true,value:{state:'open',ask:'Ship the plan?'}});
  }
  expect(s.call('tasks.delete',{id,actor:'art',at:'2026-11-13T00:05:00Z'}).ok).toBe(true);
  expect(s.ask(id)).toMatchObject({ok:true,value:{state:'resolved',ask:'Task no longer needs you'}});
  expect(s.ask(id)).not.toHaveProperty('value.why');
});
it('rolls both stores and live publication back on filing refusal; same receipt retries once',async()=>{
  const s=await setup(),id=s.create(),receipt=randomUUID(),input={id,set:{ask:'Change the plan?'},actor:'art',at:'2026-11-13T00:01:00Z'};
  const before=s.ask(id),changes:unknown[]=[];s.app.live.observe(c=>{if(c.length)changes.push(c);});
  s.app.db.exec("CREATE TRIGGER fail_task_filing BEFORE UPDATE ON attention_asks BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(s.call('tasks.update',input,owner,receipt).ok).toBe(false);
  expect(s.ask(id)).toEqual(before);expect(changes).toEqual([]);
  expect(s.call('tasks.show',{id})).toMatchObject({ok:true,value:{result:{task:{ask:'Ship the plan?'}}}});
  s.app.db.exec('DROP TRIGGER fail_task_filing');
  const result=s.call('tasks.update',input,owner,receipt);expect(result.ok).toBe(true);
  expect(s.call('tasks.update',input,owner,receipt)).toEqual(result);
  expect(changes).toHaveLength(1);expect(s.ask(id)).toMatchObject({ok:true,value:{ask:'Change the plan?'}});
});
it('reconciles existing next-side tasks at startup and preserves read marks across reopen',async()=>{
  const home=mkdtempSync(join(tmpdir(),'existing-task-attention-'));homes.push(home);fixture(home);
  const seed=createFoundation({home});installTasks(seed.db,seed.operations,seed.live,()=>new SharingDatabase(seed.db,home).sharing());
  const id='t-1';expect(seed.operations.call('direct',owner,'tasks.update',{id,set:{assignee:'jonathan',ask:'Ship the plan?'},actor:'art',at:'2026-11-13T00:00:00Z'},randomUUID()).ok).toBe(true);seed.close();
  const s=await setup(home);expect(s.ask(id)).toMatchObject({ok:true,value:{state:'open'}});
  expect(s.call('attention.markRead',{id:taskAskId(id)}).ok).toBe(true);
  const before=s.ask(id);await s.app.close();closes.pop();
  const again=await setup(home);expect(again.ask(id)).toEqual(before);
  expect(again.app.db.prepare('SELECT id FROM attention_read_marks WHERE ask=?').all(taskAskId(id))).toHaveLength(1);
});
it('does not expose reconciliation as a member or agent operation',async()=>{
  const s=await setup();
  for(const name of ['tasks.reconcileAttention','tasks.attentionPending']) {
    for(const v of [owner,member,{kind:'agent',id:'art'} as Viewer,{kind:'service',id:'attention'} as Viewer])
      expect(s.call(name,{},v)).toMatchObject({ok:false,code:'denied'});
    expect(s.app.operations.call('http',{kind:'service',id:'tasks'},name,{},randomUUID()).ok).toBe(false);
  }
});

it('reconciles owner membership changes without a task mutation and revokes old-project visibility',async()=>{
  const s=await setup(),id=s.create({assignee:'pollock',project:'pond',agent:'pond-bot'});
  expect(s.ask(id).ok).toBe(false);
  expect(s.call('household.setMember',{person:'pollock',agents:'*'})).toMatchObject({ok:true});
  expect(s.ask(id,member)).toMatchObject({ok:true,value:{state:'open',project:'pond',agent:'pond-bot'}});
  expect(s.call('household.removeMember',{person:'pollock'})).toMatchObject({ok:true});
  expect(s.ask(id)).toMatchObject({ok:true,value:{state:'resolved',ask:'Task no longer needs you'}});
});
it('files valid long imported task identities without narrowing the Tasks import contract',async()=>{
  const s=await setup(),id='imported-'+ 'x'.repeat(300);
  const result=s.call('tasks.import',{actor:'art',at:'2026-11-13T00:00:00Z',tasks:[{id,title:'Imported plan',type:'task',status:'open',priority:1,assignee:'jonathan',createdAt:'2026-11-13T00:00:00Z',createdBy:'art',comments:[]}]});
  expect(result).toMatchObject({ok:true,value:{result:{ok:true}}});
  expect(s.ask(id)).toMatchObject({ok:true,value:{id:taskAskId(id),source:{kind:'task',id},ask:'Imported plan'}});
  expect(s.call('attention.markRead',{id:taskAskId(id)}).ok).toBe(true);
});

it('connects an already installed owning Tasks registry before the first task write',async()=>{const s=await setup(undefined,true),id=s.create();expect(s.ask(id)).toMatchObject({ok:true,value:{state:'open'}});});

it('keeps a withdrawn projection on the source current audience after later moves',async()=>{
  const s=await setup(),id=s.create({project:'pond',agent:'art'});
  expect(s.call('tasks.close',{id,actor:'art',at:'2026-11-13T00:01:00Z'})).toMatchObject({ok:true,value:{result:{ok:true}}});
  expect(s.ask(id,member).ok).toBe(true);
  expect(s.call('tasks.update',{id,set:{project:'other',agent:'pond-bot'},actor:'art',at:'2026-11-13T00:02:00Z'})).toMatchObject({ok:true,value:{result:{ok:true}}});
  expect(s.ask(id,member)).toMatchObject({ok:false,code:'denied'});
  expect(s.ask(id)).toMatchObject({ok:true,value:{state:'resolved',project:'other',agent:'pond-bot',ask:'Task no longer needs you'}});
  expect(s.types.get('attention.ask')!.read(taskAskId(id),member)).toBeUndefined();
});
it('does not narrow valid empty or unrestricted legacy task fields through filing validation',async()=>{
  const s=await setup(),project='p'.repeat(201),agent='a'.repeat(201);
  expect(s.call('tasks.import',{actor:'art',at:'2026-11-13T00:00:00Z',tasks:[{id:'',title:'',type:'task',status:'open',priority:1,assignee:'jonathan',createdAt:'2026-11-13T00:00:00Z',createdBy:'art',comments:[],project,agent}]})).toMatchObject({ok:true,value:{result:{ok:true}}});
  expect(s.ask('')).toMatchObject({ok:true,value:{source:{kind:'task',id:''},ask:'Task needs you',project,agent}});
  expect(s.call('tasks.import',{actor:'art',at:'2026-11-13T00:00:00Z',tasks:[{id:'empty-scopes',title:'',type:'task',status:'open',priority:1,assignee:'jonathan',createdAt:'2026-11-13T00:00:00Z',createdBy:'art',comments:[],project:'',agent:''}]})).toMatchObject({ok:true,value:{result:{ok:true}}});
  expect(s.ask('empty-scopes')).toMatchObject({ok:true,value:{project:'',agent:''}});
});
it('reserves task filing identities against every public source label before assignment',async()=>{
  const s=await setup(),id=s.create({assignee:'art'});
  for(const kind of ['conversation','piece','approval','task'])expect(s.call('attention.raise',{id:taskAskId(id),agent:'art',ask:'Occupy a future source',source:{kind,id:'spoof'}})).toMatchObject({ok:false,code:'denied'});
  expect(s.call('tasks.update',{id,set:{assignee:'jonathan'},actor:'art',at:'2026-11-13T00:01:00Z'})).toMatchObject({ok:true,value:{result:{ok:true}}});
  expect(s.ask(id)).toMatchObject({ok:true,value:{state:'open',ask:'Ship the plan?'}});
});
it('keeps an in-progress task assigned to an owner in the central open source projection',async()=>{
  const s=await setup(),id=s.create();
  expect(s.call('tasks.claim',{id,actor:'jonathan',at:'2026-11-13T00:01:00Z'})).toMatchObject({ok:true,value:{result:{ok:true}}});
  expect(s.call('tasks.show',{id})).toMatchObject({ok:true,value:{result:{task:{status:'in_progress',assignee:'jonathan'}}}});
  expect(s.ask(id)).toMatchObject({ok:true,value:{state:'open',ask:'Ship the plan?'}});
});

it('preserves an existing conflicting source and rolls the enclosing task write back',async()=>{
  const s=await setup(),id=s.create({assignee:'art'}),key=taskAskId(id);
  s.app.operations.register(operation({name:'fixture.seedCollision',write:true,input:z.object({}),output:z.null(),may:()=>true,run(ctx){
    ctx.db.prepare('INSERT INTO attention_asks VALUES (?,?)').run(key,JSON.stringify({id:key,agent:'art',ask:'Original unrelated source',source:{kind:'conversation',id:'original'},state:'open',createdAt:ctx.now,changedAt:ctx.now}));return null;
  }}));
  expect(s.call('fixture.seedCollision',{}).ok).toBe(true);
  const before=s.ask(id);
  expect(s.call('tasks.update',{id,set:{assignee:'jonathan'},actor:'art',at:'2026-11-13T00:01:00Z'})).toMatchObject({ok:false,code:'conflict'});
  expect(s.ask(id)).toEqual(before);
  expect(s.call('tasks.show',{id})).toMatchObject({ok:true,value:{result:{task:{assignee:'art'}}}});
});
it('preserves distinct valid malformed UTF-16 ids without URI errors or lossy hash collisions',async()=>{
  const s=await setup(),ids=['\ud800','\ud801','\ufffd'];
  expect(new Set(ids.map(taskAskId)).size).toBe(3);
  expect(s.call('tasks.import',{actor:'art',at:'2026-11-13T00:00:00Z',tasks:ids.map(id=>({id,title:'Legacy task',type:'task',status:'open',priority:1,assignee:'jonathan',createdAt:'2026-11-13T00:00:00Z',createdBy:'art',comments:[]}))})).toMatchObject({ok:true,value:{result:{ok:true}}});
  for(const id of ids)expect(s.ask(id)).toMatchObject({ok:true,value:{source:{kind:'task',id},state:'open'}});
});

it('holds startup and membership reconciliation on actual service denial, reports only a code, and keeps authorized Tasks writes working',async()=>{
  const first=await setup(),id=first.create({why:'Sensitive source wording'}),before=first.ask(id);
  await first.app.close();closes.pop();
  const warnings=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {
    const s=await setup(first.home,false,true);
    expect(s.ask(id)).toEqual(before);
    expect(warnings.mock.calls).toEqual([['Task filing failed (denied)']]);
    const other=s.create({assignee:'pollock'});expect(s.ask(other).ok).toBe(false);
    expect(s.call('household.setMember',{person:'pollock',agents:'*'})).toMatchObject({ok:true});
    expect(s.ask(other).ok).toBe(false);expect(s.ask(id)).toEqual(before);
    expect(warnings.mock.calls).toEqual([['Task filing failed (denied)'],['Task filing failed (denied)']]);
    expect(s.call('tasks.update',{id:other,set:{why:'Changed through owning authorization'},actor:'art',at:'2026-11-13T00:01:00Z'})).toMatchObject({ok:true,value:{result:{ok:true}}});
    expect(s.ask(other)).toMatchObject({ok:true,value:{state:'open',why:'Changed through owning authorization'}});
  } finally {warnings.mockRestore();}
});
it('keeps stopped offline import verification unchanged and files the copied owner task at next startup',async()=>{
  const home=mkdtempSync(join(tmpdir(),'offline-task-filing-'));homes.push(home);fixture(home);
  const sourcePath=join(home,'copied-old-tasks.db'),source=new Database(sourcePath);
  source.exec('CREATE TABLE tasks(ord INTEGER,record TEXT);CREATE TABLE links(ord INTEGER,record TEXT);CREATE TABLE meta(key TEXT,value TEXT)');
  source.prepare('INSERT INTO tasks VALUES (?,?)').run(0,JSON.stringify({id:'t-9',title:'Imported owner task',type:'epic',status:'open',priority:1,assignee:'jonathan',project:'pond',ask:'Ship the copied task?',createdAt:'2026-11-13T00:00:00Z',createdBy:'art',comments:[]}));
  source.prepare('INSERT INTO meta VALUES (?,?)').run('seq','9');source.close();
  const seed=createFoundation({home});installTasks(seed.db,seed.operations,seed.live,()=>new SharingDatabase(seed.db,home).sharing());
  for(const id of ['t-1','t-2','t-3','t-4'])expect(seed.operations.call('direct',owner,'tasks.delete',{id,actor:'fixture',at:'2026-11-13T00:00:00Z'},randomUUID())).toMatchObject({ok:true,value:{result:{ok:true}}});
  expect(importTasks(seed.db,sourcePath,1_800_000_000_000)).toMatchObject({ok:true,imported:true,tasks:1});
  expect(importTasks(seed.db,sourcePath,1_800_000_000_000)).toMatchObject({ok:true,imported:false,tasks:1});
  expect(seed.db.prepare("SELECT name FROM sqlite_master WHERE name='attention_asks'").get()).toBeUndefined();seed.close();
  const s=await setup(home);expect(s.ask('t-9')).toMatchObject({ok:true,value:{state:'open',ask:'Ship the copied task?',project:'pond'}});
});

it('compares already current filing without writes or receipts during access refresh',async()=>{
  const s=await setup();s.create();const before=s.app.db.prepare('SELECT * FROM core_operations').all();
  const asks=s.app.db.prepare('SELECT * FROM attention_asks').all(),changes:unknown[]=[];s.app.live.observe(c=>{if(c.some(x=>x.type==='attention.ask'))changes.push(c);});
  expect(s.app.operations.call('direct',{kind:'service',id:'tasks'},'tasks.attentionPending',{})).toEqual({ok:true,value:false});
  s.app.live.changed([{type:'core.access',id:'fixture'}]);
  expect(s.app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
  expect(s.app.db.prepare('SELECT * FROM attention_asks').all()).toEqual(asks);expect(changes).toEqual([]);
});
