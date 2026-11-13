import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { FakeClock, migrate } from '../../core/index.js';
import { change } from './fixture.js';
import { importChanges } from './importer.js';
import { loadChanges, replaceChanges } from './store.js';
import { schema } from './schema.js';
const homes:string[]=[];const closers:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const c of closers.splice(0)) await c();for(const h of homes.splice(0)) rmSync(h,{recursive:true,force:true});});
it('imports ids, counts and content once; interruptions and mismatches roll back the entire migration',async()=>{
 const home=mkdtempSync(join(tmpdir(),'changes-import-'));homes.push(home);
 const app=await startLoom({home,clock:new FakeClock()});closers.push(app.close);
 const from=join(home,'snapshot.json');const original=change();delete original.agent;writeFileSync(from,JSON.stringify({v:1,changes:[original]}));
 const options={projects:[{slug:'pond',name:'Pond',repos:['acme/app']}],attribution:{agents:{art:{logins:['art-bot'],branches:[]}},ownerLogins:[]}};
 expect(()=>importChanges(app.db,from,{...options,interrupt:()=>{throw new Error('power loss');}})).toThrow('power loss');
 expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name='changes_changes'").get()).toBeUndefined();
 expect(()=>importChanges(app.db,from,{...options,interrupt:()=>{app.db.exec('DELETE FROM changes_changes');}})).toThrow('comparison failed');
 expect(importChanges(app.db,from,options)).toMatchObject({imported:true,changes:1});
 expect(loadChanges(app.db)).toEqual([{...original,project:'pond',agent:'art',mine:false}]);
 const before=loadChanges(app.db);expect(importChanges(app.db,from,options)).toMatchObject({imported:false});expect(loadChanges(app.db)).toEqual(before);
 writeFileSync(from,JSON.stringify({v:1,changes:[{...original,title:'Another'}]}));expect(()=>importChanges(app.db,from,options)).toThrow('different Changes source');
 expect(loadChanges(app.db)).toEqual(before);
});
it('refuses bad versions, identities, duplicate ids and ambiguous destination projects before writing', async () => {
 const home=mkdtempSync(join(tmpdir(),'changes-import-refuse-'));homes.push(home);
 const app=await startLoom({home,clock:new FakeClock()});closers.push(app.close);
 const from=join(home,'snapshot.json');
 const options={projects:[{slug:'pond',name:'Pond',repos:['acme/app']}],attribution:{agents:{},ownerLogins:[]}};
 for(const source of [
  {v:2,changes:[change()]}, {v:1,changes:{}},
  {v:1,changes:[change({id:'github:acme/app#4'})]},
  {v:1,changes:[change({repo:'acme/app'})]},
  {v:1,changes:[change(),change()]},
 ]) {
  writeFileSync(from,JSON.stringify(source));
  expect(()=>importChanges(app.db,from,options)).toThrow();
  expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name='changes_changes'").get()).toBeUndefined();
 }
 writeFileSync(from,JSON.stringify({v:1,changes:[change()]}));
 expect(()=>importChanges(app.db,from,{...options,projects:[...options.projects,{slug:'other',name:'Other',repos:['github:ACME/APP']}]})).toThrow('more than one');
 expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name='changes_changes'").get()).toBeUndefined();
 migrate(app.db,'changes',schema);
 const existing=change({title:'Destination must survive'});replaceChanges(app.db,[existing]);
 expect(()=>importChanges(app.db,from,options)).toThrow('destination must be empty');
 expect(loadChanges(app.db)).toEqual([existing]);
 expect(app.db.prepare("SELECT value FROM changes_meta WHERE key='source-checksum'").get()).toBeUndefined();
});
it('drops source project, agent, mine and task caches and derives only destination attribution',async()=>{
 const home=mkdtempSync(join(tmpdir(),'changes-import-authority-'));homes.push(home);
 const app=await startLoom({home,clock:new FakeClock()});closers.push(app.close);
 const from=join(home,'snapshot.json');
 const source={...change(),project:'forged',agent:'stranger',mine:true,tasks:[{id:'t-1',title:'Private cache'}],conversation:'cv-aaaaaaaaaaaa',syncError:'secret cached error'};
 writeFileSync(from,JSON.stringify({v:1,changes:[source]}));
 expect(importChanges(app.db,from,{projects:[],attribution:{agents:{},ownerLogins:[]}})).toMatchObject({imported:true});
 const expected={...change(),mine:false};delete expected.agent;
 expect(loadChanges(app.db)).toEqual([expected]);
});
