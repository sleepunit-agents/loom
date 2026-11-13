import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { createSnapshot, readSnapshot } from './migration-snapshot.js';
import { prepareMigrationPlan } from './migration-plan.js';
import { runMigrationAll } from './migration-all.js';
import { verifyMigration, verifyRuntimeMigration } from './migration-verify.js';
import { fileDigest, migrationChunkBytes } from '../core/migration-files.js';

// A whole-file Buffer read would otherwise pass on a high-memory test runner.
vi.mock('node:fs',async original=>{
  const fs=await original<typeof import('node:fs')>();
  return {...fs,readFileSync:vi.fn((...args:Parameters<typeof fs.readFileSync>)=>{
    const input=args[0],size=typeof input==='number'?fs.fstatSync(input).size:fs.statSync(input).size;
    if(size>1024*1024)throw Error('Unbounded migration file read');
    return fs.readFileSync(...args);
  }),readSync:vi.fn((...args:Parameters<typeof fs.readSync>)=>{
    if(typeof args[3]==='number'&&args[3]>1024*1024)throw Error('Unbounded migration buffer read');
    return fs.readSync(...args);
  })};
});

it('streams a sparse file over 600 MiB through snapshot, plan, all, repeat and both independent verifiers',async()=>{
  const root=mkdtempSync(join(tmpdir(),'loom-large-migration-'));
  const concat=Buffer.concat,alloc=Buffer.alloc,unsafe=Buffer.allocUnsafe;
  const allocation=(size:number)=>{if(size>migrationChunkBytes)throw Error('Unbounded migration allocation');};
  vi.spyOn(Buffer,'concat').mockImplementation((list,size)=>{allocation(size??list.reduce((n,b)=>n+b.length,0));return concat(list,size);});
  vi.spyOn(Buffer,'alloc').mockImplementation((size,fill,encoding)=>{allocation(size);return alloc(size,fill,encoding);});
  vi.spyOn(Buffer,'allocUnsafe').mockImplementation(size=>{allocation(size);return unsafe(size);});
  try {
    const old=join(root,'old'),state=join(root,'state'),data=join(root,'data'),snapshot=join(root,'snapshot'),home=join(root,'new');
    mkdirSync(old);mkdirSync(state);mkdirSync(join(data,'delivery','slots'),{recursive:true});
    writeFileSync(join(old,'household.json'),JSON.stringify({v:1,agents:['art'],default:'art',owner:'jonathan'}));
    writeFileSync(join(state,'state.json'),JSON.stringify({v:1}));
    const path=join(data,'delivery','slots','opaque.age'),size=601*1024*1024+7;
    const fd=openSync(path,'wx',0o600);
    try {ftruncateSync(fd,size);writeSync(fd,Buffer.from('start'),0,5,0);writeSync(fd,Buffer.from('finish'),0,6,size-6);}finally{closeSync(fd);}
    const source=fileDigest(path);
    const manifest=await createSnapshot(old,snapshot,undefined,{runtime:state,'runtime-data':data});
    expect(manifest.files.find(f=>f.path.endsWith('opaque.age'))).toMatchObject({...source,bytes:size});
    expect(readSnapshot(snapshot)).toEqual(manifest);
    const plan=prepareMigrationPlan(snapshot).plan;
    expect(plan.importers.runtime.options).toEqual({boxes:{},jobs:{},conversations:{}});
    expect(await runMigrationAll(snapshot,home,plan)).toMatchObject({status:'complete'});
    expect(await runMigrationAll(snapshot,home,plan)).toMatchObject({status:'complete'});
    expect(await verifyMigration(snapshot,home,plan)).toMatchObject({status:'verified',differences:[]});
    expect(await verifyRuntimeMigration(snapshot,home,plan.importers.runtime.options)).toMatchObject({status:'verified'});
    const db=new Database(join(home,'loom.db'));
    expect(db.prepare('SELECT max(length(bytes)) AS n FROM runtime_import_chunks').get()).toEqual({n:migrationChunkBytes});
    // Equal-length last-chunk corruption defeats counts-only or receipt-only verification.
    db.prepare("UPDATE runtime_import_chunks SET bytes=zeroblob(length(bytes)) WHERE path='data/delivery/slots/opaque.age' AND part=(SELECT max(part) FROM runtime_import_chunks WHERE path='data/delivery/slots/opaque.age')").run();db.close();
    expect(await verifyMigration(snapshot,home,plan)).toMatchObject({status:'different',differences:[{table:'runtime_import_chunks'}]});
    expect(await verifyRuntimeMigration(snapshot,home,plan.importers.runtime.options)).toMatchObject({status:'different'});
    expect(fileDigest(path)).toEqual(source);
    // Same-size snapshot corruption is rejected by the streaming integrity reader.
    const copied=join(snapshot,'runtime-data','delivery','slots','opaque.age'),changed=openSync(copied,'r+');
    try{writeSync(changed,Buffer.from('X'),0,1,size-1);}finally{closeSync(changed);}
    expect(()=>readSnapshot(snapshot)).toThrow('integrity');
  } finally {vi.restoreAllMocks();rmSync(root,{recursive:true,force:true});}
},120000);
