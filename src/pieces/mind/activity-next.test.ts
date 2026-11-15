import {expect,it} from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFoundation} from '../../core/app.js';
import {HouseholdDatabase} from '../../core/household/document.js';
import {migrateHouseholdTables} from '../../core/household/schema.js';
import {FakeClock} from '../../core/index.js';
import {startLoom} from '../../foundation.js';
import {installMindActivity,installedMindActivity} from './activity.js';
import type {Sharing} from '../../core/index.js';
import {activityQueryFields} from './activity-query.js';
import {GraphQLObjectType,GraphQLSchema,graphql} from 'graphql/index.js';
it('installs Activity in real next mode using only listed metadata paths, household timezone and GitHub owner',async()=>{
 const home=mkdtempSync(join(tmpdir(),'activity-next-')),metadata=createFoundation({home});migrateHouseholdTables(metadata.db);metadata.db.transaction(()=>new HouseholdDatabase(metadata.db).replace(home,{v:1,agents:['listed'],default:'listed',owner:'owner',tz:'Pacific/Honolulu',github:'sleepunit-agents',members:[{person:'owner',role:'owner',agents:'*'}]}))();metadata.close();
 for(const agent of ['listed','unlisted']){mkdirSync(join(home,'agents',agent),{recursive:true});const db=new BetterSqlite3(join(home,'agents',agent,'memories.db'));db.exec("CREATE TABLE memories(ref TEXT,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)");db.prepare('INSERT INTO memories VALUES(?,?,?,?,NULL,?,NULL,?,0)').run(`m-${agent}`,agent,'Shipped loom#941.','2026-11-13T08:00:00Z','{"where":"terminal"}','episode');db.close();}
 const app=await startLoom({home,next:true,clock:new FakeClock(Date.parse('2026-11-13T09:00:00Z'))});try{
  const owner={kind:'member' as const,id:'owner'};expect(app.operations.call('direct',owner,'mind.activityList',{})).toMatchObject({value:{to:'2026-11-12',entries:[{id:'e~listed~m-listed',day:'2026-11-12',hour:22}],conversations:'unavailable'}});
  expect(app.operations.call('direct',owner,'mind.activityRead',{id:'e~listed~m-listed'})).toMatchObject({value:{prs:[{href:'https://github.com/sleepunit-agents/loom/pull/941'}]}});expect(app.operations.call('direct',owner,'mind.activityRead',{id:'e~unlisted~m-unlisted'})).toMatchObject({code:'not-found'});
 }finally{await app.close();rmSync(home,{recursive:true,force:true});}
});

it('reuses a preinstalled Activity reader during next startup and releases its registry on close',async()=>{
 const home=mkdtempSync(join(tmpdir(),'activity-preinstalled-')),clock=new FakeClock(Date.parse('2026-11-13T18:00:00Z'));
 const owner={kind:'member' as const,id:'owner'};
 const sharing:Sharing={members:{owner:{owner:true,agents:[]}},projects:{},services:{}};
 mkdirSync(join(home,'fiction'),{recursive:true});
 const path=join(home,'fiction/memories.db'),db=new BetterSqlite3(path);
 db.exec("CREATE TABLE memories(ref TEXT,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)");
 db.prepare('INSERT INTO memories VALUES(?,?,?,?,NULL,?,NULL,?,0)').run('story','Fictional preinstalled source','Full fictional words','2026-11-13T17:00:00Z','{"where":"terminal"}','episode');
 db.close();
 let installed:ReturnType<typeof installMindActivity>|undefined;
 let app:Awaited<ReturnType<typeof startLoom>>|undefined;
 try{
  app=await startLoom({home,next:true,clock,sharing:()=>sharing,install(app){
   installed=installMindActivity(app.operations,app.live,{agents:[{agent:'fiction',memories:path}],sharing:()=>sharing});
   app.onClose(()=>installed!.close());
  }});
  expect(installedMindActivity(app.operations)).toBe(installed);
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:activityQueryFields(installedMindActivity(app.operations)!)})});
  expect(await graphql({schema,source:'{ memoryActivity { entries { title } } memoryActivityEntry(id:"e~fiction~story") { story } }',contextValue:{viewer:owner}})).toMatchObject({data:{memoryActivity:{entries:[{title:'Fictional preinstalled source'}]},memoryActivityEntry:{story:'Full fictional words'}}});
  await app.close();
  expect(installedMindActivity(app.operations)).toBeUndefined();
 }finally{await app?.close();rmSync(home,{recursive:true,force:true});}
});
