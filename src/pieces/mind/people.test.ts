import { afterEach,expect,it } from 'vitest';
import { z } from 'zod';
import { mkdtempSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTouched } from '../../core/touched/index.js';
import { startLoom } from '../../foundation.js';
import { FakeClock,operation,type Sharing,type Viewer } from '../../core/index.js';
import { ProjectsStore } from '../../backends/projects.js';
import { PeopleStore } from '../../backends/people.js';
import { createPersonHalf } from '../../backends/people-creation.js';
import { peopleReader } from './people.js';
import { installMindPeopleActions } from './people-actions.js';
import {migrateMindReceipts} from './receipt-schema.js';
const homes:string[]=[],closes:Array<()=>void|Promise<void>>=[];
const dir=()=>{const h=mkdtempSync(join(tmpdir(),'mind-people-'));homes.push(h);return h;};
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
const owner:Viewer={kind:'member',id:'owner'},partial:Viewer={kind:'member',id:'partial'};
const sharing:Sharing={members:{owner:{owner:true,agents:['art','other']},partial:{owner:false,agents:['art']}},projects:{public:{members:['partial'],agents:[]}},services:{}};
const clock=()=>new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
function source(path=join(dir(),'people.db')) {const store=new PeopleStore({dbPath:path,now:()=>Date.parse('2026-11-12T12:00:00Z')});migrateMindReceipts(store.database);closes.push(()=>store.close());return store;}
async function fixture(directory:string,art:string,other?:string,create=createPersonHalf) {
  let reader!:ReturnType<typeof peopleReader>;
  const app=await startLoom({home:dir(),clock:clock(),authenticate:req=>({viewer:req.url?.includes('partial')?partial:owner,valid:()=>true}),install(app){
    reader=peopleReader({directory,projectHref:(agent,slug)=>`/p/projects-preview/project/${encodeURIComponent(`${agent}:${slug}`)}`,agents:[{agent:'art',memories:art},...(other?[{agent:'other',memories:other}]:[])],sharing:()=>sharing,now:()=>app.operations.clock.now()});
    app.onClose(()=>reader.close());
    installTouched(app.operations,(v,c)=>v.kind==='agent'&&v.id==='art'?c:undefined);
    const actions=installMindPeopleActions(app.operations,{directory,relationship:art,agent:'art',sharing:()=>sharing,create});app.onClose(()=>actions.close());
  }});let closed=false;closes.push(async()=>{if(!closed){closed=true;await app.close();}});return {...app,reader,close:async()=>{if(!closed){closed=true;await app.close();}}};
}
it('projects directory and only each authorized agent relationship, without project escalation',async()=>{
  const d=source(),a=source(),b=source();d.write({slug:'jonathan',name:'Jonathan',where:{slack:{value:'U12345',label:'Jonathan on Slack'},github:{value:'jbarket',verified_at:'2026-11-01T00:00:00Z',stale_after_days:3}}});
  a.write({slug:'jonathan',name:'Jonathan',summary:'Art knows Jonathan'});b.write({slug:'jonathan',name:'Jonathan',summary:'Other private relationship'});
  const app=await fixture(d.database.name,a.database.name,b.database.name);
  const list=(v:Viewer)=>app.reader.list(v);
  expect(list(owner).map(p=>p.id)).toEqual(['commons:jonathan','art:jonathan','other:jonathan']);
  expect(list(partial).map(p=>p.id)).toEqual(['art:jonathan']);
  expect(list({kind:'agent',id:'other'}).map(p=>p.id)).toEqual(['other:jonathan']);
  expect(list({kind:'runner',id:'one'})).toEqual([]);
  expect(app.reader.read('other:jonathan',partial)).toBeUndefined();
  expect(list(owner)[0].fields.find(f=>f.key==='github')?.state).toBe('stale');expect(list(owner)[0].fields.find(f=>f.key==='slack')).toMatchObject({value:'U12345',label:'Jonathan on Slack'});
  expect(app.reader.read('commons:no-such-person',owner)).toBeUndefined();
});
it('does not create missing source files, including sources that appear after installation',async()=>{
  const h=dir(),d=join(h,'missing-people.db'),a=join(h,'missing-memory.db');const app=await fixture(d,a);
  expect(app.reader.list(owner)).toMatchObject([]);expect(existsSync(d)).toBe(false);expect(existsSync(a)).toBe(false);
  const store=source(d);store.write({slug:'late',name:'Late'});
  expect(app.reader.list(owner)).toMatchObject([]);
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
  for(const [title,category,person,archived,expiry] of [['active','user','friend',0,'2026-11-14T12:00:00.000Z'],['feedback','feedback','friend',0,null],['expired','user','friend',0,'2026-11-12T12:00:00Z'],['archived','user','friend',1,null],['unrelated','user','other',0,null],['project','project','friend',0,null]]) insert.run('2026-11-13T00:00:00Z',category,title,'evidence',JSON.stringify({person}),archived,expiry);
  const app=await fixture(d.database.name,a.database.name);
  expect(app.reader.read('art:friend',owner)).toMatchObject({evidence:[{title:'active'},{title:'feedback'}],newer:1});
});

it('reads merge redirects and removes archived directory contacts with their relationship projections',async()=>{
  const d=source(),a=source();d.write({slug:'current',name:'Current'});a.write({slug:'current',name:'Current',summary:'Relationship'});
  d.database.exec("CREATE TABLE IF NOT EXISTS person_merges(from_slug TEXT PRIMARY KEY,into_slug TEXT,merged_at TEXT,merged_by TEXT,counts_json TEXT); INSERT INTO person_merges VALUES('former','current','2026-11-01T00:00:00Z','owner','{}')");
  const app=await fixture(d.database.name,a.database.name);
  expect(app.reader.read('commons:former',owner)).toMatchObject({slug:'current',mergedFrom:'former'});
  expect(app.reader.read('art:former',partial)).toMatchObject({slug:'current',card:{summary:'Relationship'}});
  d.archive({slug:'current',actor:'owner',reason:'No longer active'});
  expect(app.reader.list(owner)).toMatchObject([]);
  expect(app.reader.read('art:current',partial)).toBeUndefined();
});
it('does not include memory evidence or project cards in a person-only service grant',async()=>{
  const d=source(),a=source();a.write({slug:'friend',name:'Friend',where:{private_hub:{value:'participant'}}});
  const projects=new ProjectsStore({dbPath:a.database.name});closes.push(()=>projects.close());projects.write({slug:'private-hub',name:'Private project'});
  a.database.exec("CREATE TABLE memories(created TEXT,category TEXT,title TEXT,content TEXT,metadata TEXT,archived INTEGER,expires_at TEXT); INSERT INTO memories VALUES('2026-11-13T00:00:00.000Z','user','Private memory','Secret evidence','{\"person\":\"friend\"}',0,NULL)");
  sharing.services.reader={types:['person'],operations:['mind.personRead']};
  try {
    const app=await fixture(d.database.name,a.database.name);
    expect(app.reader.read('art:friend',{kind:'service',id:'reader'})).toMatchObject({evidence:[],newer:0,projects:[]});
  } finally {delete sharing.services.reader;}
});
it('requires current authorization to complete a partial creation',async()=>{
  const d=source(),a=source();let fail=true;
  const app=await fixture(d.database.name,a.database.name,undefined,(db,input,now,half)=>{if(fail&&half==='relationship')throw Error('injected');createPersonHalf(db,input,now,half);});
  expect(app.operations.call('direct',owner,'mind.personAdd',{name:'Partial'},'partial-revoke')).toMatchObject({code:'unavailable'});
  const saved=sharing.members.owner;sharing.members.owner={owner:false,agents:[]};fail=false;
  try {expect(app.operations.call('direct',owner,'mind.personAdd',{name:'Partial'},'partial-revoke')).toMatchObject({code:'denied'});expect(a.getRow('partial')).toBeNull();}
  finally {sharing.members.owner=saved;}
});

it('projects owner roles and authorized alias-linked projects, refreshing after an outside project archive',async()=>{
  const d=source(),a=source(),b=source();d.write({slug:'owner',name:'Owner',where:{team_hub:{value:'maintainer'}}});
  const projects=new ProjectsStore({dbPath:a.database.name});closes.push(()=>projects.close());projects.write({slug:'project-one',name:'First project',links:{aliases:['team-hub']}});
  const hidden=new ProjectsStore({dbPath:b.database.name});closes.push(()=>hidden.close());hidden.write({slug:'project-two',name:'Private project',links:{aliases:['team-hub']}});
  const app=await fixture(d.database.name,a.database.name,b.database.name);
  expect(app.reader.read('commons:owner',owner)).toMatchObject({ownership:{owner:true},projects:[{slug:'project-one',name:'First project',href:'/p/projects-preview/project/art%3Aproject-one'},{slug:'project-two'}]});
  projects.archive({slug:'project-one',actor:'owner',reason:'Finished'});
  expect(app.reader.read('commons:owner',owner)?.projects).toEqual([expect.objectContaining({slug:'project-two'})]);
});
it('changes a contact field from fresh to stale at its exact deadline',async()=>{
  const d=source(),a=source();d.write({slug:'friend',name:'Friend',where:{github:{value:'friend',verified_at:'2026-11-12T12:00:00.000Z',stale_after_days:2},email:{value:'friend@example.com',verified_at:'2026-10-31T12:00:00.000Z'}}});
  const app=await fixture(d.database.name,a.database.name);
  (app.operations.clock as FakeClock).advance(86400000);
  expect(app.reader.read('commons:friend',owner)).toMatchObject({fields:[{state:'fresh'},{state:'fresh'}]});
  (app.operations.clock as FakeClock).advance(1);
  expect(app.reader.read('commons:friend',owner)?.fields.map(f=>f.state)).toEqual(['stale','stale']);
});

it('keeps the original thirty-day expiry after a partial retry and allows id reuse only after that expiry',async()=>{
  const d=source(),a=source();let fail=true;
  const app=await fixture(d.database.name,a.database.name,undefined,(db,input,now,half)=>{if(fail&&half==='relationship')throw Error('injected');createPersonHalf(db,input,now,half);});
  const clock=app.operations.clock as FakeClock,expires=clock.now()+30*86400000;
  expect(app.operations.call('direct',owner,'mind.personAdd',{name:'First'},'expiry')).toMatchObject({code:'unavailable'});
  clock.advance(86400000);fail=false;
  expect(app.operations.call('direct',owner,'mind.personAdd',{name:'First'},'expiry')).toMatchObject({ok:true});
  for(const db of [d.database,a.database])expect(db.prepare('SELECT expires FROM mind_operation_receipts WHERE id=?').get('expiry')).toEqual({expires});
  expect(app.db.prepare('SELECT expires FROM core_operations WHERE id=?').get('expiry')).toEqual({expires});
  clock.advance(29*86400000);
  expect(app.operations.call('direct',owner,'mind.personAdd',{name:'Second'},'expiry')).toMatchObject({ok:true});
});
it('reserves partial creation ids against unrelated writes across a restart',async()=>{
  const d=source(),a=source();let app=await fixture(d.database.name,a.database.name,undefined,(_db,_input,_now,half)=>{if(half==='relationship')throw Error('injected');createPersonHalf(_db,_input,_now,half);});
  expect(app.operations.call('direct',owner,'mind.personAdd',{name:'Reserved'},'global-id')).toMatchObject({code:'unavailable'});await app.close();
  app=await fixture(d.database.name,a.database.name);let writes=0;
  app.operations.register(operation({name:'unrelated.write',write:true,input:z.object({}),output:z.unknown(),may:()=>true,run:()=>{writes++;return {};}}));
  expect(app.operations.call('direct',owner,'unrelated.write',{},'global-id')).toMatchObject({code:'conflict'});expect(writes).toBe(0);
  expect(app.operations.call('direct',owner,'mind.personAdd',{name:'Reserved'},'global-id')).toMatchObject({ok:true});
});

it('preserves the old form’s normalized forty-character, letter-leading slug rules',async()=>{
  const d=source(),a=source(),app=await fixture(d.database.name,a.database.name);
  expect(app.operations.call('direct',owner,'mind.personAdd',{name:'123 Élodie'},'normalized')).toMatchObject({value:{slug:'e-lodie'}});
  const long='A'.repeat(70);
  const result=app.operations.call('direct',owner,'mind.personAdd',{name:long},'long-name');expect(result).toMatchObject({ok:true});
  if(result.ok)expect((result.value as {slug:string}).slug).toHaveLength(40);
  expect(app.operations.call('direct',owner,'mind.personAdd',{name:'123'},'no-letter')).toMatchObject({code:'invalid'});
});

it('keeps hidden malformed sources from failing authorized lists',async()=>{
 const d=source(),a=source(),b=source();a.write({slug:'friend',name:'Healthy'});
 b.database.exec('DROP TABLE people; CREATE TABLE people(broken TEXT)');
 const app=await fixture(d.database.name,a.database.name,b.database.name);
 expect(app.reader.list(partial)).toMatchObject([{id:'art:friend',name:'Healthy'}]);

});
