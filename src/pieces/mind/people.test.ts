import { afterEach,expect,it } from 'vitest';
import { mkdtempSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock,type Sharing,type Viewer } from '../../core/index.js';
import { PeopleStore } from '../../backends/people.js';
import { createPersonHalf } from '../../backends/people-creation.js';
import { installMindPeople, type PersonRecord } from './people.js';
import { installMindPeopleActions } from './people-actions.js';
const homes:string[]=[],closes:Array<()=>void|Promise<void>>=[];
const dir=()=>{const h=mkdtempSync(join(tmpdir(),'mind-people-'));homes.push(h);return h;};
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
const owner:Viewer={kind:'member',id:'owner'},partial:Viewer={kind:'member',id:'partial'};
const sharing:Sharing={members:{owner:{owner:true,agents:['art','other']},partial:{owner:false,agents:['art']}},projects:{public:{members:['partial'],agents:[]}},services:{}};
const clock=()=>new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
function source(path=join(dir(),'people.db')) {const store=new PeopleStore({dbPath:path,now:()=>Date.parse('2026-11-12T12:00:00Z')});closes.push(()=>store.close());return store;}
async function fixture(directory:string,art:string,other?:string,create=createPersonHalf) {
  const app=await startLoom({home:dir(),clock:clock(),install(app){
    const reader=installMindPeople(app.operations,app.live,{directory,agents:[{agent:'art',memories:art},...(other?[{agent:'other',memories:other}]:[])],sharing:()=>sharing,
      conversations:{list:(v,slug)=>({available:true,rows:v.id==='owner'?[{id:'cv-example',title:slug,href:'/p/comms-preview/cv-example'}]:[]})}});
    app.onClose(()=>reader.close());
    const actions=installMindPeopleActions(app.operations,{directory,relationship:art,agent:'art',sharing:()=>sharing,create});app.onClose(()=>actions.close());
  }});let closed=false;closes.push(async()=>{if(!closed){closed=true;await app.close();}});return {...app,close:async()=>{if(!closed){closed=true;await app.close();}}};
}
it('projects directory and only each authorized agent relationship, without project escalation',async()=>{
  const d=source(),a=source(),b=source();d.write({slug:'jonathan',name:'Jonathan',where:{github:{value:'jbarket',verified_at:'2026-11-01T00:00:00Z',stale_after_days:3}}});
  a.write({slug:'jonathan',name:'Jonathan',summary:'Art knows Jonathan'});b.write({slug:'jonathan',name:'Jonathan',summary:'Other private relationship'});
  const app=await fixture(d.database.name,a.database.name,b.database.name);
  function list(v:Viewer){const r=app.operations.call('direct',v,'mind.peopleList',{});if(!r.ok)throw Error(r.message);return r.value as PersonRecord[];}
  expect(list(owner).map(p=>p.id)).toEqual(['commons:jonathan','art:jonathan','other:jonathan']);
  expect(list(partial).map(p=>p.id)).toEqual(['art:jonathan']);
  expect(list({kind:'agent',id:'other'}).map(p=>p.id)).toEqual(['other:jonathan']);
  expect(list({kind:'runner',id:'one'})).toEqual([]);
  expect(app.operations.call('direct',partial,'mind.personRead',{id:'other:jonathan'})).toMatchObject({code:'denied'});
  expect(list(owner)[0].fields[0].state).toBe('stale');
  expect(app.operations.call('direct',owner,'mind.personRead',{id:'commons:no-such-person'})).toMatchObject({code:'not-found'});
});
it('does not create missing source files, including sources that appear after installation',async()=>{
  const h=dir(),d=join(h,'missing-people.db'),a=join(h,'missing-memory.db');const app=await fixture(d,a);
  expect(app.operations.call('direct',owner,'mind.peopleList',{})).toMatchObject({value:[]});expect(existsSync(d)).toBe(false);expect(existsSync(a)).toBe(false);
  const store=source(d);store.write({slug:'late',name:'Late'});
  expect(app.operations.call('direct',owner,'mind.peopleList',{})).toMatchObject({value:[]});
});
it('adds trimmed cards in their existing halves; retry and core receipt failure across restart do not duplicate',async()=>{
  const d=source(),a=source(),home=dir();let app=await fixture(d.database.name,a.database.name);
  const input={name:'  New Friend ',summary:'  Knows the box ',channel:'github',handle:' friend '};
  expect(app.operations.call('direct',partial,'mind.personAdd',input,'denied')).toMatchObject({code:'denied'});
  app.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT, 'injected'); END");
  expect(app.operations.call('direct',owner,'mind.personAdd',input,'add-one')).toMatchObject({code:'unavailable'});
  app.db.exec('DROP TRIGGER fail_receipt');
  expect(d.getRow('new-friend')?.card).toMatchObject({where:{github:{value:'friend',source:"owner on loom's page"}}});
  expect(d.getRow('new-friend')?.card.summary).toBeUndefined();expect(a.getRow('new-friend')?.card.summary).toBe('Knows the box');
  expect(app.operations.call('direct',owner,'mind.personAdd',input,'add-one')).toMatchObject({ok:true});
  expect(app.operations.call('direct',owner,'mind.personAdd',input,'different-id')).toMatchObject({code:'conflict'});
  expect(app.operations.call('direct',owner,'mind.personAdd',{...input,name:'Changed'},'add-one')).toMatchObject({code:'conflict'});
  // A new foundation has no core receipt: committed source receipts recover it.
  await app.close();app=await fixture(d.database.name,a.database.name);
  expect(app.operations.call('direct',owner,'mind.personAdd',input,'add-one')).toMatchObject({ok:true,value:{slug:'new-friend'}});
  expect(d.list()).toHaveLength(1);expect(a.list()).toHaveLength(1);expect(existsSync(join(home,'people.db'))).toBe(false);
});
it('resumes a directory-only commit after a failed relationship write, rejects id theft and rolls back each failed half',async()=>{
  const d=source(),a=source();let fail=true;
  const app=await fixture(d.database.name,a.database.name,undefined,(db,input,now,half)=>{createPersonHalf(db,input,now,half);if(half==='relationship'&&fail)throw Error('injected failure');});
  const input={name:'Resumable',summary:'A relationship'};
  expect(app.operations.call('direct',owner,'mind.personAdd',input,'resume')).toMatchObject({code:'unavailable'});
  expect(d.getRow('resumable')).toBeTruthy();expect(a.getRow('resumable')).toBeNull();
  expect(app.operations.call('direct',owner,'mind.personAdd',{name:'Other'},'resume')).toMatchObject({code:'conflict'});
  fail=false;expect(app.operations.call('direct',owner,'mind.personAdd',input,'resume')).toMatchObject({ok:true});
  expect(a.getRow('resumable')?.card.summary).toBe('A relationship');expect(d.list()).toHaveLength(1);
});
it('evidence excludes expired, archived and unrelated memories; exact deadlines remove expired evidence',async()=>{
  const d=source(),a=source();d.write({slug:'friend',name:'Friend'});a.write({slug:'friend',name:'Friend'});
  const db=a.database;
  db.exec('CREATE TABLE memories(created TEXT,category TEXT,title TEXT,content TEXT,metadata TEXT,archived INTEGER,expires_at TEXT)');
  const insert=db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?)');
  for(const [title,category,person,archived,expiry] of [['active','user','friend',0,'2026-11-14T12:00:00Z'],['feedback','feedback','friend',0,null],['expired','user','friend',0,'2026-11-12T12:00:00Z'],['archived','user','friend',1,null],['unrelated','user','other',0,null],['project','project','friend',0,null]]) insert.run('2026-11-13T00:00:00Z',category,title,'evidence',JSON.stringify({person}),archived,expiry);
  const app=await fixture(d.database.name,a.database.name);
  expect(app.operations.call('direct',owner,'mind.personRead',{id:'art:friend'})).toMatchObject({value:{evidence:[{title:'active'},{title:'feedback'}],newer:1}});
});
