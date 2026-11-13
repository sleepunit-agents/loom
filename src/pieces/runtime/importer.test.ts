import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createFoundation } from '../../core/app.js';
import { openSnapshotSqlite } from '../../cli/migration-sqlite.js';
import { readRuntimeImport, readRuntimeInventory } from './import-source.js';
import { compareRuntimeImport, importRuntime } from './importer.js';
import { runtimeImportTables } from './import-projection.js';

const cleanups: (()=>void)[] = [];
afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
const at = '2026-11-13T00:00:00.000Z', cv = 'cv-123456abcdef';
const identities = {agents:['art'],members:['jonathan','guest'],projects:['pond']};
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'runtime-import-')); cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const sources = {store:join(root,'runtime.db'),state:join(root,'state'),data:join(root,'data')};
  mkdirSync(sources.state); mkdirSync(join(sources.data,'delivery','conversations'),{recursive:true});
  mkdirSync(join(sources.data,'delivery','slots'));
  const state = {v:1,boxes:{local:{local:true,created:at},r1:{name:'Remote',owner:'jonathan',mayHost:['art'],lentTo:['guest'],facts:['os:linux'],labels:['gpu:yes'],created:at,lastSeen:at,alwaysOn:true}},
    primaries:{art:['r1','local']},agents:{art:{repo:'https://example.com/art',houseFile:'house/house.json',nested:true,secrets:{KEY:'stored-key'},scopes:{KEY:'owner'},scopeStores:{KEY:'stored-key'}}},
    houses:{'h-1':{id:'h-1',agent:'art',box:'r1',state:'running',created:at,task:'PRIVATE INPUT',tokenLabel:'OLD-CREDENTIAL'},'h-2':{id:'h-2',agent:'art',box:'r1',state:'done',created:at,exit:0,log:'PRIVATE OUTPUT'}},
    services:{'art/bridge':{want:'up'}},quotaHolds:{account:{until:2}},seq:12,accountSalt:'original-salt',futureField:{preserve:true}};
  const save = ()=>writeFileSync(join(sources.state,'state.json'),JSON.stringify(state)); save();
  writeFileSync(join(sources.data,'delivery','conversations',`${cv}.json`),JSON.stringify({conversation:cv,agent:'art',venue:'loom',place:'thread',run:'old-run',key:'OLD-RUN-KEY',actsFor:{owner:true},msgs:[{text:'PRIVATE WORDS'}]}));
  writeFileSync(join(sources.data,'delivery','slots',`${cv}.age`),Buffer.from([0,255,1,2]));
  writeFileSync(join(sources.data,'future.bin'),Buffer.from([3,0,255]));
  const old = new Database(sources.store);
  old.exec('CREATE TABLE docs(collection TEXT,key TEXT,doc TEXT,rev INTEGER,updated TEXT,by TEXT,PRIMARY KEY(collection,key)); CREATE TABLE revisions(id INTEGER PRIMARY KEY,collection TEXT,key TEXT,doc TEXT,rev INTEGER,op TEXT,at TEXT,by TEXT)');
  for (const collection of ['gates','gate-proposals','grants','policy','future-collection']) {
    const key=collection==='grants'?'household':'art';
    old.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?)').run(collection,key,JSON.stringify({collection,private:'retain'}),3,at,'owner');
    old.prepare('INSERT INTO revisions(collection,key,doc,rev,op,at,by) VALUES (?,?,?,?,?,?,?)').run(collection,key,'{"before":true}',2,'put',at,'owner');
  }
  old.prepare('INSERT INTO revisions(collection,key,doc,rev,op,at,by) VALUES (?,?,?,?,?,?,?)').run('gates','deleted',null,4,'del',at,'owner');old.close();
  const app=createFoundation({home:join(root,'new')});cleanups.push(app.close);
  const options={boxes:{local:'jonathan',r1:'jonathan'},jobs:{'h-1':{member:'guest',project:'pond'},'h-2':{}},conversations:{[cv]:{member:'jonathan'}}};
  const read=()=>readRuntimeImport(sources,options,identities,openSnapshotSqlite);
  const run=(controls={})=>importRuntime(app.db,sources,options,identities,123,openSnapshotSqlite,controls);
  return {root,sources,state,save,options,app,read,run};
}
it('imports exact source bytes, every document and revision, scoped metadata and held work without old authority',()=>{
  const f=fixture(), before=readFileSync(f.sources.store), expected=f.read();
  expect(f.run()).toMatchObject({ok:true,imported:true});
  expect(compareRuntimeImport(f.app.db,runtimeImportTables(expected,123))).toBe(true);
  const jobs=f.app.db.prepare('SELECT record FROM runtime_jobs ORDER BY id').all() as {record:string}[];
  expect(jobs.map(r=>JSON.parse(r.record))).toMatchObject([{id:'h-1',member:'guest',project:'pond',state:'uncertain'},{id:'h-2',state:'done'}]);
  expect(JSON.stringify(jobs)).not.toMatch(/PRIVATE|OLD-CREDENTIAL/);
  const binding=JSON.parse((f.app.db.prepare('SELECT record FROM runtime_bindings').get() as {record:string}).record);
  expect(binding).toEqual({id:cv,agent:'art',member:'jonathan',venue:'loom',place:'thread'});
  expect(f.app.db.prepare('SELECT count(*) AS n FROM runtime_import_documents').get()).toEqual({n:5});
  expect(f.app.db.prepare('SELECT count(*) AS n FROM runtime_import_revisions').get()).toEqual({n:6});
  expect(JSON.parse((f.app.db.prepare('SELECT record FROM runtime_provenance').get() as {record:string}).record).history.unknown).toBe(true);
  expect(f.run()).toMatchObject({ok:true,imported:false});
  expect(readFileSync(f.sources.store).equals(before)).toBe(true);
  expect(f.app.db.prepare('SELECT count(*) AS n FROM runtime_inputs').get()).toEqual({n:0});
});
it('rolls back schema, archive, metadata and receipt together after an interruption, then resumes once',()=>{
  const f=fixture();expect(()=>f.run({interrupt:()=>{throw Error('power loss');}})).toThrow('power loss');
  expect(f.app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'runtime_%'").all()).toEqual([]);
  expect(f.run()).toMatchObject({imported:true});expect(f.run()).toMatchObject({imported:false});
});
it('refuses a changed source or mapping and detects archive/metadata corruption independently of receipts',()=>{
  const f=fixture(),expected=f.read();f.run();
  f.app.db.prepare("UPDATE runtime_import_sources SET content='corrupt' WHERE path='data/future.bin'").run();
  expect(compareRuntimeImport(f.app.db,runtimeImportTables(expected,123))).toBe(false);
  f.options.jobs['h-2']={member:'guest'};expect(()=>f.run()).toThrow('different runtime source or mapping');
  f.options.jobs['h-2']={};f.state.seq++;f.save();expect(()=>f.run()).toThrow('different runtime source or mapping');
});
it('refuses missing/extra/null mappings, unknown identities and private conversation widening',()=>{
  const f=fixture();
  delete (f.options.jobs as Record<string,unknown>)['h-2'];expect(f.read).toThrow('every source id');
  (f.options.jobs as Record<string,unknown>)['h-2']=null;expect(f.read).toThrow('audience mapping required');
  f.options.jobs['h-2']={}; f.options.conversations[cv]={} as typeof f.options.conversations[typeof cv];expect(f.read).toThrow('requires a member');
  f.options.conversations[cv]={member:'stranger'};expect(f.read).toThrow('Unknown runtime audience member');
  f.options.conversations[cv]={member:'jonathan'}; f.options.boxes.r1='guest';expect(f.read).toThrow('owner differs from source');
});
it('refuses links, unknown database tables and mutation between the two source reads',()=>{
  const f=fixture();
  expect(()=>readRuntimeImport(f.sources,f.options,identities,openSnapshotSqlite,{afterSnapshot:()=>{f.state.seq++;f.save();}})).toThrow('changed during import');
  symlinkSync('future.bin',join(f.sources.data,'link'));expect(()=>readRuntimeInventory(f.sources,openSnapshotSqlite)).toThrow('symlink');rmSync(join(f.sources.data,'link'));
  const old=new Database(f.sources.store);old.exec('CREATE TABLE new_records(id TEXT)');old.close();expect(f.read).toThrow('Unknown runtime store tables');
});
