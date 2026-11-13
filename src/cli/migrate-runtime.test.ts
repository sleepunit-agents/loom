import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createSnapshot, inventorySnapshot } from './migration-snapshot.js';
import { prepareMigrationPlan } from './migration-plan.js';
import { runMigrationAll } from './migration-all.js';
import { verifyMigration } from './migration-verify.js';
import { run } from './migrate.js';
import { createFoundation } from '../core/app.js';
import { importHousehold } from './household-importer.js';
import type { IOStreams } from './io.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const bytes=(root:string):unknown=>Object.fromEntries(readdirSync(root).sort().map(name=>{
  try{return[name,readFileSync(join(root,name)).toString('base64')];}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EISDIR')throw e;return[name,bytes(join(root,name))];}
}));
async function fixture() {
  const root=mkdtempSync(join(tmpdir(),'migration-runtime-'));roots.push(root);
  const old=join(root,'old'),state=join(root,'state'),data=join(root,'data'),snapshot=join(root,'snapshot'),home=join(root,'new');
  mkdirSync(join(old,'commons','stores'),{recursive:true});mkdirSync(state);mkdirSync(join(data,'delivery','conversations'),{recursive:true});mkdirSync(join(data,'runs'));
  writeFileSync(join(old,'household.json'),JSON.stringify({v:1,agents:['art'],default:'art',owner:'jonathan'}));
  writeFileSync(join(old,'ui-cookie.key'),Buffer.alloc(32,17));
  writeFileSync(join(state,'state.json'),JSON.stringify({v:1,boxes:{r1:{created:'2026-11-13T00:00:00Z',owner:'jonathan'}},houses:{'h-1':{id:'h-1',agent:'art',box:'r1',state:'running',created:'2026-11-13T00:00:00Z',task:'PRIVATE'}},primaries:{},agents:{},seq:1}));
  writeFileSync(join(data,'delivery','conversations','cv-abcdef123456.json'),JSON.stringify({conversation:'cv-abcdef123456',agent:'art',venue:'session',place:'fixture',actsFor:{owner:true}}));
  writeFileSync(join(data,'runs','retained.json'),'{}');
  mkdirSync(join(data,'logins','codex'),{recursive:true});writeFileSync(join(data,'logins','codex','auth.json'),'FIXTURE-LOGIN-MUST-STAY-ON-RUNNER');
  const store=new Database(join(old,'commons','stores','runtime.db'));store.pragma('journal_mode=WAL');
  store.exec('CREATE TABLE docs(collection TEXT,key TEXT,doc TEXT,rev INTEGER,updated TEXT,by TEXT);CREATE TABLE revisions(id INTEGER PRIMARY KEY,collection TEXT,key TEXT,doc TEXT,rev INTEGER,op TEXT,at TEXT,by TEXT)');
  for(const collection of ['gates','grants','policy','gate-proposals'])store.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?)').run(collection,'art','{"private":true}',1,'2026-11-13T00:00:00Z','owner');
  // Snapshot must include WAL-only source records.
  await createSnapshot(old,snapshot,undefined,{runtime:state,'runtime-data':data});store.close();
  const plan=prepareMigrationPlan(snapshot).plan;
  const options={boxes:{r1:'jonathan'},jobs:{'h-1':{member:'jonathan'}},conversations:{'cv-abcdef123456':{member:'jonathan'}}};
  return{root,old,state,data,snapshot,home,plan,options};
}
it('discovers every runtime root, requires explicit maps and independently verifies all imported content',async()=>{
  const f=await fixture(),before=bytes(f.snapshot);
  expect(f.plan.importers.runtime.paths).toEqual(['home/commons/stores/runtime.db','runtime','runtime-data']);
  expect(readFileSync(join(f.snapshot,'manifest.json'),'utf8')).toContain('runner-owned CLI login material');
  expect(JSON.stringify(before)).not.toContain(Buffer.from('FIXTURE-LOGIN-MUST-STAY-ON-RUNNER').toString('base64'));
  expect(f.plan.importers.runtime.options).toMatchObject({boxes:{r1:null},jobs:{'h-1':null},conversations:{'cv-abcdef123456':null}});
  await expect(runMigrationAll(f.snapshot,f.home,f.plan)).rejects.toThrow('mapping required');
  // The all-runner already owns the failed plan. A different mapped plan uses a fresh destination.
  const home=join(f.root,'mapped');f.plan.importers.runtime.options=f.options;
  expect(await runMigrationAll(f.snapshot,home,f.plan,{now:()=>123})).toMatchObject({status:'complete',pieces:[{name:'household'},{name:'runtime'}]});
  expect(await verifyMigration(f.snapshot,home,f.plan)).toMatchObject({status:'verified',missing:[],differences:[]});
  expect(bytes(f.snapshot)).toEqual(before);
  const db=new Database(join(home,'loom.db'));
  expect(db.prepare('SELECT count(*) AS n FROM runtime_import_documents').get()).toEqual({n:4});
  expect(db.prepare("SELECT path FROM runtime_import_sources WHERE path='data/runs/retained.json'").get()).toBeTruthy();
  db.prepare("UPDATE runtime_jobs SET record=json_set(record,'$.agent','other')").run();db.close();
  expect(await runMigrationAll(f.snapshot,home,f.plan)).toMatchObject({status:'complete'});
  expect(await verifyMigration(f.snapshot,home,f.plan)).toMatchObject({status:'different',differences:[{piece:'runtime',table:'runtime_jobs',expected:1,actual:1}]});
});
it('resumes death after runtime commit before coordinator receipt and detects archived content corruption',async()=>{
  const f=await fixture();f.plan.importers.runtime.options=f.options;
  await expect(runMigrationAll(f.snapshot,f.home,f.plan,{now:()=>123,afterPiece:name=>{if(name==='runtime')throw Error('death');}})).rejects.toThrow('death');
  expect(await runMigrationAll(f.snapshot,f.home,f.plan,{now:()=>999})).toMatchObject({status:'complete'});
  expect(await verifyMigration(f.snapshot,f.home,f.plan)).toMatchObject({status:'verified'});
  const db=new Database(join(f.home,'loom.db'));db.prepare("UPDATE runtime_import_sources SET content='tampered' WHERE path='data/runs/retained.json'").run();db.close();
  expect(await verifyMigration(f.snapshot,f.home,f.plan)).toMatchObject({status:'different',differences:[{piece:'runtime',table:'runtime_import_sources'}]});
});
it('refuses omission of a discovered root and supports the standalone CLI with private acknowledgements',async()=>{
  const f=await fixture(),bad=structuredClone(f.plan);bad.importers.runtime.paths.pop();expect(()=>prepareMigrationPlan(f.snapshot,bad)).toThrow('every discovered source');
  const app=createFoundation({home:f.home});importHousehold(app.db,f.home,join(f.snapshot,'home'),123);app.close();
  const mapping=join(f.root,'mapping.json');writeFileSync(mapping,JSON.stringify(f.options));
  let stdout='',stderr='';const io:IOStreams={stdin:Readable.from([]),stdout:s=>stdout+=s,stderr:s=>stderr+=s,env:{}};
  const args=['runtime','--home',f.home,'--from',f.snapshot,'--mapping',mapping];
  expect(await run(args,io)).toBe(0);expect(JSON.parse(stdout)).toMatchObject({ok:true,imported:true});expect(stdout).not.toMatch(/PRIVATE|private|jonathan/);expect(stderr).toBe('');
  stdout='';expect(await run(args,io)).toBe(0);expect(JSON.parse(stdout)).toMatchObject({imported:false});
  expect(await run(['runtime'],io)).toBe(2);
});
it('never probes omitted runtime defaults and refuses supplied empty roots',async()=>{
  const f=await fixture(),target=join(f.root,'inventory-only');
  const inventory=inventorySnapshot(f.old,target);
  expect(inventory.copies.some(file=>file.path.startsWith('runtime/'))).toBe(false);
  for(const name of ['runtime','runtime-data'])expect(()=>inventorySnapshot(f.old,target,undefined,{[name]:''})).toThrow('must not be empty');
  const incomplete=join(f.root,'incomplete');await createSnapshot(f.old,incomplete);
  expect(()=>prepareMigrationPlan(incomplete)).toThrow('explicit --runtime and --runtime-data');
  const empty=join(f.root,'empty-data');mkdirSync(empty);
  const emptySnapshot=join(f.root,'empty-snapshot');await createSnapshot(f.old,emptySnapshot,undefined,{runtime:f.state,'runtime-data':empty});
  expect(prepareMigrationPlan(emptySnapshot).plan.importers.runtime.paths).toContain('runtime-data');
});
