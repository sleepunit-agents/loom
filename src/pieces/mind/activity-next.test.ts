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
it('installs Activity in real next mode using only listed metadata paths, household timezone and GitHub owner',async()=>{
 const home=mkdtempSync(join(tmpdir(),'activity-next-')),metadata=createFoundation({home});migrateHouseholdTables(metadata.db);metadata.db.transaction(()=>new HouseholdDatabase(metadata.db).replace(home,{v:1,agents:['listed'],default:'listed',owner:'owner',tz:'Pacific/Honolulu',github:'sleepunit-agents',members:[{person:'owner',role:'owner',agents:'*'}]}))();metadata.close();
 for(const agent of ['listed','unlisted']){mkdirSync(join(home,'agents',agent),{recursive:true});const db=new BetterSqlite3(join(home,'agents',agent,'memories.db'));db.exec("CREATE TABLE memories(ref TEXT,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)");db.prepare('INSERT INTO memories VALUES(?,?,?,?,NULL,?,NULL,?,0)').run(`m-${agent}`,agent,'Shipped loom#941.','2026-11-13T08:00:00Z','{"where":"terminal"}','episode');db.close();}
 const app=await startLoom({home,next:true,clock:new FakeClock(Date.parse('2026-11-13T09:00:00Z'))});try{
  const owner={kind:'member' as const,id:'owner'};expect(app.operations.call('direct',owner,'mind.activityList',{})).toMatchObject({value:{to:'2026-11-12',entries:[{id:'e~listed~m-listed',day:'2026-11-12',hour:22}],conversations:'unavailable'}});
  expect(app.operations.call('direct',owner,'mind.activityRead',{id:'e~listed~m-listed'})).toMatchObject({value:{prs:[{href:'https://github.com/sleepunit-agents/loom/pull/941'}]}});expect(app.operations.call('direct',owner,'mind.activityRead',{id:'e~unlisted~m-unlisted'})).toMatchObject({code:'not-found'});
 }finally{await app.close();rmSync(home,{recursive:true,force:true});}
});
