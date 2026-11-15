import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PeopleStore} from './people.js';
import {ProjectsStore} from './projects.js';
const signal=vi.hoisted(()=>vi.fn());
vi.mock('../core/touched/index.js',()=>({touched:signal}));
afterEach(()=>signal.mockClear());
it('keeps borrowed card writes and snapshots in the caller transaction without closing or publishing it',()=>{
 const home=mkdtempSync(join(tmpdir(),'borrowed-cards-')),path=join(home,'fiction.db');
 new PeopleStore({dbPath:path}).close();new ProjectsStore({dbPath:path}).close();const db=new Database(path);
 try{
  let borrowed!:PeopleStore;
  for(const Store of [PeopleStore,ProjectsStore])expect(()=>new Store({database:db})).toThrow('requires a source transaction');
  expect(()=>db.transaction(()=>{
   const people=new PeopleStore({database:db,actor:'fiction'}),projects=new ProjectsStore({database:db,actor:'fiction'});
   borrowed=people;
   people.write({slug:'friend',name:'Private friend'});people.write({slug:'friend',summary:'Private revision'});
   projects.write({slug:'pond',name:'Private pond'});projects.write({slug:'pond',summary:'Private revision'});
   people.close();projects.close();expect(db.open).toBe(true);expect(signal).not.toHaveBeenCalled();
   throw Error('roll back outer transaction');
  }).immediate()).toThrow('roll back outer transaction');
  for(const table of ['people','person_revisions','projects','project_revisions','project_names'])expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({n:0});
  expect(signal).not.toHaveBeenCalled();
  expect(()=>borrowed.write({slug:'later',name:'Later'})).toThrow('require the caller source transaction');
 }finally{db.close();rmSync(home,{recursive:true,force:true});}
});
it('does not initialize or change an unprepared borrowed source',()=>{
 const db=new Database(':memory:');
 try{db.transaction(()=>{
  for(const Store of [PeopleStore,ProjectsStore]){const store=new Store({database:db});expect(()=>store.write({slug:'fiction',name:'Fiction'})).toThrow('not migrated');store.close();}
  expect(db.open).toBe(true);expect(db.prepare('SELECT name FROM sqlite_schema').all()).toEqual([]);
 }).immediate();}finally{db.close();}
});
