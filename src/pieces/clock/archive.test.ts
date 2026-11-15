/** Archived records stay readable and private without installing a scheduler. */
import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {migrate,exportDatabaseImage} from '../../core/index.js';
import {schema} from './schema/001.js';
import {installPrivateExport,wakes,schedules,type Wake,type Schedule} from './store.js';

it.each([false,true])('exports public Clock archives without private rows or receipt copies, cleared scope=%s',cleared=>{
 const db=new Database(':memory:');let restored:Database.Database|undefined,reopened:Database.Database|undefined;
 try {
  db.exec('CREATE TABLE core_migrations(piece TEXT NOT NULL,number INTEGER NOT NULL,sql TEXT NOT NULL,PRIMARY KEY(piece,number)); CREATE TABLE core_operations(id TEXT PRIMARY KEY,name TEXT,result TEXT)');
  migrate(db,'clock',schema);
  const attributed={origin:'art',principal:{for:'owner',people:['alice']}};
  const publicWake:Wake={id:'public-wake',agent:'art',note:'Public archive',prompt:'PUBLIC_CLOCK_WORDS',due:1,state:'pending',by:{kind:'member',id:'alice'},createdAt:1,changedAt:1,failures:0,authorship:attributed};
  const privateWake:Wake={...publicWake,id:'private-wake',prompt:'PRIVATE_CLOCK_WORDS',...(!cleared?{member:'alice'}:{})};
  const publicLane:Schedule={id:'public-lane',agent:'art',note:'Public lane',prompt:'PUBLIC_LANE_WORDS',at:['22:00'],days:'*',by:publicWake.by,changedAt:1,enabled:true,authorship:attributed};
  const privateLane:Schedule={...publicLane,id:'private-lane',prompt:'PRIVATE_LANE_WORDS',...(!cleared?{member:'alice'}:{})};
  for(const row of [publicWake,privateWake])db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(row.id,JSON.stringify(row),1);
  for(const row of [publicLane,privateLane])db.prepare('INSERT INTO clock_schedules VALUES (?,?,?)').run(row.id,JSON.stringify(row),1);
  if(cleared)for(const id of [privateWake.id,privateLane.id])db.prepare('INSERT INTO clock_meta VALUES (?,?)').run('private-id:'+id,JSON.stringify({member:'alice'}));
  for(const row of [publicWake,privateWake])db.prepare('INSERT INTO clock_events(wake,record) VALUES (?,?)').run(row.id,JSON.stringify({note:row.prompt}));
  for(const row of [publicLane,privateLane])db.prepare('INSERT INTO core_operations VALUES (?,?,?)').run('receipt:'+row.id,'clock.selfRearm',JSON.stringify({ok:true,value:{schedule:row.id}}));
  installPrivateExport(db);
  expect(wakes(db)).toEqual([privateWake,publicWake]);expect(schedules(db)).toEqual([privateLane,publicLane]);
  const before=db.serialize(),image=exportDatabaseImage(db);
  expect(db.serialize()).toEqual(before);
  for(const word of ['PRIVATE_CLOCK_WORDS','PRIVATE_LANE_WORDS','private-wake','private-lane'])expect(image.bytes.includes(Buffer.from(word))).toBe(false);
  restored=new Database(image.bytes);
  expect(wakes(restored)).toEqual([publicWake]);expect(schedules(restored)).toEqual([publicLane]);
  expect(restored.prepare('SELECT wake FROM clock_events').all()).toEqual([{wake:publicWake.id}]);
  expect(restored.prepare('SELECT id FROM core_operations').all()).toEqual([{id:'receipt:'+publicLane.id}]);
  // Reopening the original archive must fail closed until its owning filter is installed.
  reopened=new Database(before);
  expect(()=>exportDatabaseImage(reopened!)).toThrow('installed privacy filter');
 }finally{restored?.close();reopened?.close();db.close();}
});
