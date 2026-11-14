import { compareRuntimeArchive } from './import-archive.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createFoundation } from '../../core/app.js';
import { openSnapshotSqlite } from '../../cli/migration-sqlite.js';
import { readRuntimeImport, readRuntimeInventory } from './import-source.js';
import { compareRuntimeImport, importRuntime } from './importer.js';
import { runtimeImportTables } from './import-projection.js';
import { migrate } from '../../core/index.js';
import { schema } from './schema/001.js';

const cleanups: (()=>void)[] = [];
afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
const at = '2026-11-13T00:00:00.000Z', cv = 'cv-123456abcdef';
const identities = {agents:['art'],members:['jonathan','guest'],projects:['pond']};
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'runtime-import-')); cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const sources = {store:join(root,'runtime.db'),state:join(root,'state'),data:join(root,'data'),household:join(root,'household.db')};
  mkdirSync(sources.state); mkdirSync(join(sources.data,'delivery','conversations'),{recursive:true});
  mkdirSync(join(sources.data,'delivery','slots'));
  const state = {v:1,boxes:{local:{local:true,created:at},r1:{name:'Remote',owner:'jonathan',mayHost:['art'],lentTo:['art'],facts:['os:linux'],labels:['gpu:yes'],created:at,lastSeen:at,alwaysOn:true}},
    primaries:{art:['r1','local']},agents:{art:{repo:'https://example.com/art',houseFile:'house/house.json',nested:true,secrets:{KEY:'stored-key'},scopes:{KEY:'owner'},scopeStores:{KEY:'stored-key'}}},
    houses:{'h-1':{id:'h-1',agent:'art',box:'r1',state:'running',created:at,task:'PRIVATE INPUT',tokenLabel:'OLD-CREDENTIAL'},'h-2':{id:'h-2',agent:'art',box:'r1',state:'done',created:at,exit:0,log:'PRIVATE OUTPUT'}},
    services:{'art/bridge':{want:'up'}},quotaHolds:{account:{until:2}},seq:12,accountSalt:'original-salt',futureField:{preserve:true}};
  const save = ()=>writeFileSync(join(sources.state,'state.json'),JSON.stringify(state)); save();
  writeFileSync(join(sources.data,'delivery','conversations',`${cv}.json`),JSON.stringify({conversation:cv,agent:'art',venue:'loom',place:'thread',run:'old-run',key:'OLD-RUN-KEY',actsFor:{owner:true},msgs:[{text:'PRIVATE WORDS'}]}));
  writeFileSync(join(sources.data,'delivery','slots',`${cv}.age`),Buffer.from([0,255,1,2]));
  writeFileSync(join(sources.data,'future.bin'),Buffer.from([3,0,255]));
  const comms=new Database(sources.household);comms.exec('CREATE TABLE comms_threads(id TEXT,conversation TEXT,agent TEXT,member TEXT,project TEXT)');
  comms.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run('thread',cv,'art','jonathan',null);comms.close();
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
  expect(compareRuntimeImport(f.app.db,runtimeImportTables(expected))).toBe(true);
  for(const table of ['runtime_boxes','runtime_jobs'])expect((f.app.db.prepare(`SELECT changed_at FROM ${table}`).all() as {changed_at:number}[]).map(row=>row.changed_at)).toEqual([Date.parse(at),Date.parse(at)]);
  for(const table of ['runtime_settings','runtime_bindings'])expect(f.app.db.prepare(`SELECT changed_at FROM ${table}`).all()).toEqual([{changed_at:0}]);
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
  expect(f.app.db.prepare('SELECT record FROM runtime_settings').get()).toEqual({record:JSON.stringify({id:'art',agent:'art',boxes:['r1','local']})});
});
it('rolls back schema, archive, metadata and receipt together after an interruption, then resumes once',()=>{
  const f=fixture();expect(()=>f.run({interrupt:()=>{throw Error('power loss');}})).toThrow('power loss');
  expect(f.app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'runtime_%'").all()).toEqual([]);
  expect(f.run()).toMatchObject({imported:true});expect(f.run()).toMatchObject({imported:false});
});
it('refuses a changed source or mapping and detects archive/metadata corruption independently of receipts',()=>{
  const f=fixture(),expected=f.read();f.run();
  f.app.db.prepare("UPDATE runtime_import_sources SET content='corrupt' WHERE path='data/future.bin'").run();
  expect(compareRuntimeImport(f.app.db,runtimeImportTables(expected))).toBe(false);
  f.options.jobs['h-2']={member:'guest'};expect(()=>f.run()).toThrow('different runtime source or mapping');
  f.options.jobs['h-2']={};f.state.seq++;f.save();expect(()=>f.run()).toThrow('different runtime source or mapping');
});
it('refuses missing/extra/null mappings, unknown identities and private conversation widening',()=>{
  const f=fixture();
  delete (f.options.jobs as Record<string,unknown>)['h-2'];expect(f.read).toThrow('every source id');
  (f.options.jobs as Record<string,unknown>)['h-2']=null;expect(f.read).toThrow('audience mapping required');
  f.options.jobs['h-2']={}; f.options.conversations[cv]={} as typeof f.options.conversations[typeof cv];expect(f.read).toThrow('requires a member');
  f.options.conversations[cv]={member:'stranger'};expect(f.read).toThrow('Unknown runtime audience member');
  f.options.conversations[cv]={member:'guest'};expect(f.read).toThrow('owning Comms source');
  f.options.conversations[cv]={member:'jonathan'}; f.options.boxes.r1='guest';expect(f.read).toThrow('owner differs from source');
});
it('refuses links, unknown database tables and mutation between the two source reads',()=>{
  const f=fixture();
  expect(()=>readRuntimeImport(f.sources,f.options,identities,openSnapshotSqlite,{afterSnapshot:()=>{f.state.seq++;f.save();}})).toThrow('changed during import');
  symlinkSync('future.bin',join(f.sources.data,'link'));expect(()=>readRuntimeInventory(f.sources,openSnapshotSqlite)).toThrow('symlink');rmSync(join(f.sources.data,'link'));
  const old=new Database(f.sources.store);old.exec('CREATE TABLE new_records(id TEXT)');old.close();expect(f.read).toThrow('Unknown runtime store tables');
});
it('ports an old written-off source without manufacturing a new approval and refuses direct login files',()=>{
  const f=fixture();(f.state.houses['h-1'] as unknown as Record<string,unknown>).writtenOff={at,box:'r1'};
  f.state.houses['h-1'].state='lost';f.save();f.run();
  expect(JSON.parse((f.app.db.prepare("SELECT record FROM runtime_jobs WHERE id='h-1'").get() as {record:string}).record)).toMatchObject({state:'lost',imported:{history:'discard'}});
  mkdirSync(join(f.sources.data,'logins'));writeFileSync(join(f.sources.data,'logins','auth.json'),'FIXTURE');expect(f.read).toThrow('login values');
});
it('refuses unowned occupied Runtime storage without changing existing rows or leaving an import receipt',()=>{
  const f=fixture();migrate(f.app.db,'runtime',schema);
  f.app.db.prepare('INSERT INTO runtime_import_sources VALUES (?,?)').run('occupied','private');
  expect(()=>f.run()).toThrow('destination must be empty');
  expect(f.app.db.prepare('SELECT * FROM runtime_import_sources').all()).toEqual([{path:'occupied',content:'private'}]);
  expect(f.app.db.prepare('SELECT * FROM runtime_import_meta').all()).toEqual([]);
});
it('refuses unknown host/loan agents and duplicate preferences',()=>{
  const f=fixture();f.state.boxes.r1.mayHost=['stranger'];f.save();expect(f.read).toThrow('Unknown runtime agent');
  f.state.boxes.r1.mayHost=['art'];f.state.boxes.r1.lentTo=['stranger'];f.save();expect(f.read).toThrow('Unknown runtime agent');
  f.state.boxes.r1.lentTo=['art'];f.state.primaries.art=['r1','r1'];f.save();expect(f.read).toThrow('Duplicate runtime preference');
});

it.each(['missing','extra','changed','wrong-part','empty-file'])('independently detects %s private archive corruption',kind=>{
  const f=fixture();writeFileSync(join(f.sources.data,'empty.bin'),'');const source=f.read();f.run();
  expect(compareRuntimeArchive(f.app.db,source)).toBe(true);
  if(kind==='missing')f.app.db.prepare("DELETE FROM runtime_import_chunks WHERE path='data/future.bin'").run();
  if(kind==='extra')f.app.db.prepare("INSERT INTO runtime_import_chunks VALUES ('data/future.bin',1,?)").run(Buffer.from([1]));
  if(kind==='changed')f.app.db.prepare("UPDATE runtime_import_chunks SET bytes=? WHERE path='data/future.bin'").run(Buffer.from([3,0,254]));
  if(kind==='wrong-part')f.app.db.prepare("UPDATE runtime_import_chunks SET part=1 WHERE path='data/future.bin'").run();
  if(kind==='empty-file')f.app.db.prepare("INSERT INTO runtime_import_chunks VALUES ('data/empty.bin',0,?)").run(Buffer.alloc(0));
  expect(compareRuntimeArchive(f.app.db,source)).toBe(false);
});

it('rolls back new source files added after archival and before commit',()=>{
  const f=fixture();expect(()=>f.run({interrupt:()=>writeFileSync(join(f.sources.data,'new-file.bin'),'late')})).toThrow('changed during import');
  expect(f.app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'runtime_%'").all()).toEqual([]);
  expect(f.run()).toMatchObject({imported:true});
});

it('refuses an oversized corrupt BLOB before SQLite materializes its bytes',()=>{
  const f=fixture(),source=f.read();f.run();
  f.app.db.prepare("UPDATE runtime_import_chunks SET bytes=zeroblob(2*1024*1024) WHERE path='data/future.bin'").run();
  const prepare=f.app.db.prepare.bind(f.app.db);
  const guard=vi.spyOn(f.app.db,'prepare').mockImplementation(sql=>{
    const statement=prepare(sql);
    // Observe raw-BLOB reads, including iterator-based reads, without allocating
    // the malicious value first. typeof/length metadata is safe to inspect.
    if(/^SELECT /i.test(sql)&&/\bbytes\b/.test(sql)&&!/(?:length|typeof)\(bytes\)/.test(sql)) {
      for(const method of ['get','all','iterate'] as const) {
        const original=statement[method].bind(statement);
        vi.spyOn(statement,method).mockImplementation((...args:unknown[])=>{
          const path=args[0];
          if(typeof path==='string'&&(prepare('SELECT count(*) AS n FROM runtime_import_chunks WHERE path=? AND length(bytes)>1048576').get(path) as {n:number}).n)throw Error('Unbounded archive BLOB read');
          return original(...args);
        });
      }
    }
    return statement;
  });
  try{expect(compareRuntimeArchive(f.app.db,source)).toBe(false);}finally{guard.mockRestore();}
});

it('never imports or verifies automatic start authority from old source archives',()=>{
 const f=fixture();f.run();expect(f.app.db.prepare('SELECT * FROM runtime_start_attempts').all()).toEqual([]);
 f.app.db.prepare('INSERT INTO runtime_start_attempts VALUES (?,?)').run('h-1','{}');
 expect(compareRuntimeImport(f.app.db,runtimeImportTables(f.read()))).toBe(false);
});
it('keeps owner permission adoption empty and verifies against source rather than activating archived gates',()=>{
 const f=fixture();const expected=runtimeImportTables(f.read());f.run();
 expect(f.app.db.prepare('SELECT * FROM runtime_body_policy').all()).toEqual([]);
 expect(compareRuntimeImport(f.app.db,expected)).toBe(true);
 f.app.db.prepare('INSERT INTO runtime_body_policy VALUES (?,?)').run('art','{}');
 expect(compareRuntimeImport(f.app.db,expected)).toBe(false);
});

function deletedThread(f: ReturnType<typeof fixture>, venue='loom') {
 const db=new Database(f.sources.household);
 db.exec('DELETE FROM comms_threads; CREATE TABLE comms_deleted(id TEXT,member TEXT,agent TEXT,channel INTEGER,conversation TEXT)');
 db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?,?)').run('kehvhuwzdm','jonathan','art',1,null);db.close();
 const path=join(f.sources.data,'delivery','conversations',`${cv}.json`);
 const binding={...JSON.parse(readFileSync(path,'utf8')),venue,place:'th:kehvhuwzdm'};
 writeFileSync(path,JSON.stringify(binding));return {path,binding};
}
it.each(['loom','spawn'])('retains deleted %s thread bindings only in the exact private archive and reports id-only skips on retries',venue=>{
 const f=fixture(),{path}=deletedThread(f,venue),before=readFileSync(path);
 f.options.conversations[cv]={} as typeof f.options.conversations[typeof cv];
 const skipped=[{id:cv,reason:'skipped: owning Comms thread deleted'}];
 expect(f.read()).toMatchObject({skipped,expected:{binding:[]}});
 expect(f.run()).toMatchObject({imported:true,skipped});expect(f.run()).toMatchObject({imported:false,skipped});
 expect(f.app.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
 expect(f.app.db.prepare('SELECT * FROM runtime_provenance').all()).toEqual([]);
 expect(compareRuntimeArchive(f.app.db,f.read())).toBe(true);
 expect(compareRuntimeImport(f.app.db,runtimeImportTables(f.read()))).toBe(true);
 expect(readFileSync(path)).toEqual(before);
 f.app.db.prepare('INSERT INTO runtime_bindings VALUES (?,?,?)').run(cv,JSON.stringify({id:cv}),0);
 expect(compareRuntimeImport(f.app.db,runtimeImportTables(f.read()))).toBe(false);
});
it.each(['missing','agent','conversation','member','ambiguous'])('refuses %s deleted-thread evidence rather than skipping a binding',change=>{
 const f=fixture();deletedThread(f);
 const db=new Database(f.sources.household);
 if(change==='missing')db.exec('DELETE FROM comms_deleted');
 if(change==='agent')db.exec("UPDATE comms_deleted SET agent='other'");
 if(change==='conversation')db.exec("UPDATE comms_deleted SET conversation='cv-ffffffffffff'");
 if(change==='member')f.options.conversations[cv]={member:'guest'};
 if(change==='ambiguous')db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run('th:kehvhuwzdm',cv,'art','jonathan',null);
 db.close();expect(f.read).toThrow(/owning Comms source/);
});
it('requires an explicit map entry even for a deleted binding and detects changed deletion evidence',()=>{
 const f=fixture();deletedThread(f);delete (f.options.conversations as Record<string,unknown>)[cv];
 expect(f.read).toThrow('every source id');f.options.conversations[cv]={member:'jonathan'};
 expect(()=>readRuntimeImport(f.sources,f.options,identities,openSnapshotSqlite,{afterSnapshot:()=>{
 const db=new Database(f.sources.household);db.exec('DELETE FROM comms_deleted');db.close();
 }})).toThrow('changed during import');
});
it('requires the owning private audience for spawned Comms threads too',()=>{
 const f=fixture(),path=join(f.sources.data,'delivery','conversations',`${cv}.json`);
 writeFileSync(path,JSON.stringify({conversation:cv,agent:'art',venue:'spawn',place:'th:missing'}));
 f.options.conversations[cv]={} as typeof f.options.conversations[typeof cv];
 expect(f.read).toThrow(/requires a member|owning Comms source/);
});

it.each(['loom','spawn'])('matches a live %s th place to its bare owning Comms id',venue=>{
 const f=fixture(),path=join(f.sources.data,'delivery','conversations',`${cv}.json`);
 writeFileSync(path,JSON.stringify({conversation:cv,agent:'art',venue,place:'th:live'}));
 const db=new Database(f.sources.household);db.exec("UPDATE comms_threads SET id='live'");db.close();
 expect(f.read().expected.binding).toEqual([{id:cv,agent:'art',venue,place:'th:live',member:'jonathan'}]);
});
it('supports the old tombstone schema without a conversation column without inventing a conversation',()=>{
 const f=fixture();deletedThread(f);const db=new Database(f.sources.household);
 db.exec('ALTER TABLE comms_deleted DROP COLUMN conversation');db.close();
 expect(f.read().skipped).toEqual([{id:cv,reason:'skipped: owning Comms thread deleted'}]);
});

for(const venue of ['loom','spawn'])it.each(venue==='loom'?['agent','conversation','place']:['agent','conversation'])('refuses mismatched live '+venue+' Comms %s evidence',change=>{
 const f=fixture(),path=join(f.sources.data,'delivery','conversations',`${cv}.json`);
 writeFileSync(path,JSON.stringify({conversation:cv,agent:'art',venue,place:'th:live'}));
 const db=new Database(f.sources.household);db.exec("UPDATE comms_threads SET id='live'");
 if(change==='agent')db.exec("UPDATE comms_threads SET agent='other'");
 if(change==='conversation')db.exec("UPDATE comms_threads SET conversation='cv-ffffffffffff'");
 if(change==='place')db.exec("UPDATE comms_threads SET id='elsewhere'");
 db.close();expect(f.read).toThrow('owning Comms source');
});
it('refuses a valid project on a deleted binding even with the correct owning member',()=>{
 const f=fixture();deletedThread(f);
 (f.options.conversations as Record<string,unknown>)[cv]={member:'jonathan',project:'pond'};
 expect(f.read).toThrow('owning Comms source');
});

it('refuses a live binding with a conflicting deleted conversation at a different thread id',()=>{
 const f=fixture();deletedThread(f);
 const db=new Database(f.sources.household);
 db.prepare('UPDATE comms_deleted SET id=?,conversation=?').run('other-deleted-thread',cv);
 db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run('kehvhuwzdm',cv,'art','jonathan',null);db.close();
 expect(f.read).toThrow('owning Comms source');
});
it.each([null,cv])('refuses a tombstone for another thread, with conversation %s, rather than skipping',conversation=>{
 const f=fixture();deletedThread(f);const db=new Database(f.sources.household);
 db.prepare('UPDATE comms_deleted SET id=?,conversation=?').run('unrelated',conversation);db.close();
 expect(f.read).toThrow('owning Comms source');
});

it.each(['job-h-1862','sp-0123456789abcdef01234567'])('matches spawn handle %s by conversation and preserves its exact place',place=>{
 const f=fixture(),path=join(f.sources.data,'delivery','conversations',`${cv}.json`);
 writeFileSync(path,JSON.stringify({conversation:cv,agent:'art',venue:'spawn',place}));
 const db=new Database(f.sources.household);db.exec("UPDATE comms_threads SET id='th:actual-thread'");db.close();
 expect(f.read().expected.binding).toEqual([{id:cv,agent:'art',member:'jonathan',venue:'spawn',place}]);
});
it.each(['missing','agent','member','conversation','duplicate','deleted'])('refuses %s ownership evidence for an actual spawn handle',change=>{
 const f=fixture(),path=join(f.sources.data,'delivery','conversations',`${cv}.json`);
 writeFileSync(path,JSON.stringify({conversation:cv,agent:'art',venue:'spawn',place:'job-h-1862'}));
 const db=new Database(f.sources.household);db.exec("UPDATE comms_threads SET id='th:actual-thread'");
 if(change==='missing')db.exec('DELETE FROM comms_threads');
 if(change==='agent')db.exec("UPDATE comms_threads SET agent='other'");
 if(change==='member')db.exec("UPDATE comms_threads SET member='guest'");
 if(change==='conversation')db.exec("UPDATE comms_threads SET conversation='cv-ffffffffffff'");
 if(change==='duplicate')db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run('th:another',cv,'art','jonathan',null);
 if(change==='deleted'){
  db.exec('CREATE TABLE comms_deleted(id,agent,member,conversation)');
  db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?)').run('actual-thread','art','jonathan',cv);
 }
 db.close();expect(f.read).toThrow('owning Comms source');
});
it('matches a full loom th place to its full owning Comms id',()=>{
 const f=fixture(),path=join(f.sources.data,'delivery','conversations',`${cv}.json`);
 writeFileSync(path,JSON.stringify({conversation:cv,agent:'art',venue:'loom',place:'th:actual-thread'}));
 const db=new Database(f.sources.household);db.exec("UPDATE comms_threads SET id='th:actual-thread'");db.close();
 expect(f.read().expected.binding).toEqual([{id:cv,agent:'art',member:'jonathan',venue:'loom',place:'th:actual-thread'}]);
});

it('does not mistake a spawn handle for an unrelated Comms thread id',()=>{
 const f=fixture(),path=join(f.sources.data,'delivery','conversations',`${cv}.json`);
 writeFileSync(path,JSON.stringify({conversation:cv,agent:'art',venue:'spawn',place:'job-h-1862'}));
 const db=new Database(f.sources.household);
 db.exec("UPDATE comms_threads SET id='th:actual-thread'");
 db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run('job-h-1862','cv-ffffffffffff','art','guest',null);db.close();
 expect(f.read().expected.binding).toEqual([{id:cv,agent:'art',member:'jonathan',venue:'spawn',place:'job-h-1862'}]);
});

for(const tombstoneId of ['actual-thread','th:actual-thread'])it.each([true,false])('refuses spawn live/deleted conflict at '+tombstoneId+' with conversation column %s',hasConversation=>{
 const f=fixture(),path=join(f.sources.data,'delivery','conversations',`${cv}.json`);
 writeFileSync(path,JSON.stringify({conversation:cv,agent:'art',venue:'spawn',place:'job-h-1862'}));
 const db=new Database(f.sources.household);db.exec("UPDATE comms_threads SET id='th:actual-thread'");
 db.exec('CREATE TABLE comms_deleted(id,agent,member'+(hasConversation?',conversation':'')+')');
 if(hasConversation)db.prepare('INSERT INTO comms_deleted VALUES (?,?,?,?)').run(tombstoneId,'art','jonathan',null);
 else db.prepare('INSERT INTO comms_deleted VALUES (?,?,?)').run(tombstoneId,'art','jonathan');
 db.close();expect(f.read).toThrow('owning Comms source');
});

function orphanThread(f: ReturnType<typeof fixture>, venue='loom', place='th:orphan') {
 const db=new Database(f.sources.household);db.exec('DELETE FROM comms_threads');db.close();
 const path=join(f.sources.data,'delivery','conversations',`${cv}.json`);
 writeFileSync(path,JSON.stringify({conversation:cv,agent:'art',venue,place,kind:'live',started:'2026-11-06T00:00:00Z',last:'2026-11-06T00:00:00Z',msgs:[{text:'PRIVATE ORPHAN WORDS'}]}));
 f.options.conversations[cv]={} as typeof f.options.conversations[typeof cv];return path;
}
it.each([['loom','th:orphan'],['loom','bare-orphan'],['spawn','th:orphan'],['wake','th:orphan']])('archives orphan %s %s without creating binding authority', (venue,place)=>{
 const f=fixture(),path=orphanThread(f,venue,place),before=readFileSync(path);
 const skipped=[{id:cv,reason:'skipped: owning Comms thread missing'}];
 expect(f.read()).toMatchObject({skipped,expected:{binding:[]}});
 expect(f.run()).toMatchObject({imported:true,skipped});expect(f.run()).toMatchObject({imported:false,skipped});
 expect(f.app.db.prepare('SELECT * FROM runtime_bindings').all()).toEqual([]);
 expect(f.app.db.prepare('SELECT * FROM runtime_provenance').all()).toEqual([]);
 expect(compareRuntimeArchive(f.app.db,f.read())).toBe(true);
 expect(compareRuntimeImport(f.app.db,runtimeImportTables(f.read()))).toBe(true);
 expect(readFileSync(path)).toEqual(before);
});
it.each([{member:'jonathan'},{member:'guest'},{project:'pond'},{member:'jonathan',project:'pond'}])('refuses unsupported explicit orphan audience %j',mapping=>{
 const f=fixture();orphanThread(f);(f.options.conversations as Record<string,unknown>)[cv]=mapping;
 expect(f.read).toThrow(/owning Comms source|requires a member/);
});
it.each(['absent','null'])('requires an explicit empty orphan mapping rather than %s',kind=>{
 const f=fixture();orphanThread(f);
 if(kind==='absent')delete (f.options.conversations as Record<string,unknown>)[cv];
 else (f.options.conversations as Record<string,unknown>)[cv]=null;
 expect(f.read).toThrow(/every source id|mapping required/);
});
it('does not treat a missing spawn handle owner as an orphan Comms place',()=>{
 const f=fixture();orphanThread(f,'spawn','job-h-1862');expect(f.read).toThrow('requires a member');
});
it('does not hide a mismatched place owner behind the orphan disposition',()=>{
 const f=fixture();orphanThread(f);
 const db=new Database(f.sources.household);db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?)').run('orphan','cv-ffffffffffff','art','jonathan',null);db.close();
 expect(f.read).toThrow('requires a member');
});
