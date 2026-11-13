import { mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSnapshot, inventorySnapshot } from './migration-snapshot.js';
import { readRuntimeInventory, runtimeRepositoryCacheRule } from '../pieces/runtime/import-source.js';
import { openSnapshotSqlite } from './migration-sqlite.js';
vi.mock('node:fs',async original=>{
  const fs=await original<typeof import('node:fs')>();
  return {...fs,readdirSync:vi.fn(fs.readdirSync),openSync:vi.fn(fs.openSync),readFileSync:vi.fn(fs.readFileSync)};
});
const roots:string[]=[];
afterEach(()=>{vi.clearAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'runtime-cache-'));roots.push(root);
  const home=join(root,'old'),state=join(root,'state'),data=join(root,'data');
  mkdirSync(home);mkdirSync(state);mkdirSync(data);
  writeFileSync(join(home,'household.json'),JSON.stringify({v:1,agents:['art'],default:'art',owner:'jonathan'}));
  writeFileSync(join(state,'state.json'),'{"v":1}');
  return {root,home,state,data};
}
it('names the source-owned mirror skip without enumerating/reading it, and retains delivery and house working files',async()=>{
  const f=fixture(),cache=join(f.data,'repos');mkdirSync(join(cache,'art.git','objects','pack'),{recursive:true});
  writeFileSync(join(cache,'art.git','objects','pack','fixture.pack'),'REMOTE-CACHE-NOT-READ');
  for(const name of ['delivery/slots/fixture.age','houses/fixture/repo/work.txt','nested/repos/keep.bin']){
    const path=join(f.data,name);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,'ONLY-COPY-FIXTURE');
  }
  vi.clearAllMocks();
  const roots={runtime:f.state,'runtime-data':f.data};
  const inventory=inventorySnapshot(f.home,join(f.root,'dry'),undefined,roots);
  expect(inventory.skipped).toContainEqual({path:'runtime-data/repos',rule:runtimeRepositoryCacheRule,bytes:null});
  const manifest=await createSnapshot(f.home,join(f.root,'snapshot'),undefined,roots);
  expect(manifest.skipped).toContainEqual({path:'runtime-data/repos',rule:runtimeRepositoryCacheRule,bytes:null});
  expect(manifest.files.some(file=>file.path.startsWith('runtime-data/repos/'))).toBe(false);
  const source=readRuntimeInventory({state:f.state,data:f.data},openSnapshotSqlite);
  expect(Object.keys(source.files).sort()).toEqual(['data/delivery/slots/fixture.age','data/houses/fixture/repo/work.txt','data/nested/repos/keep.bin','state/state.json']);
  for(const fn of [readdirSync,openSync,readFileSync])expect(vi.mocked(fn).mock.calls.filter(args=>String(args[0])===cache || String(args[0]).startsWith(cache+'/'))).toEqual([]);
  for(const name of ['delivery/slots/fixture.age','houses/fixture/repo/work.txt','nested/repos/keep.bin'])expect(readFileSync(join(f.root,'snapshot','runtime-data',name),'utf8')).toBe('ONLY-COPY-FIXTURE');
});
it('retains a regular data file named repos rather than treating its name as a directory cache',async()=>{
  const f=fixture();writeFileSync(join(f.data,'repos'),'PRIVATE-REGULAR-FILE');
  const manifest=await createSnapshot(f.home,join(f.root,'snapshot'),undefined,{runtime:f.state,'runtime-data':f.data});
  expect(manifest.files.some(file=>file.path==='runtime-data/repos')).toBe(true);
  expect(readRuntimeInventory({data:f.data},openSnapshotSqlite).files).toHaveProperty('data/repos');
});
