import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SharingDatabase } from '../core/household/sharing.js';
import { change } from '../pieces/changes/fixture.js';
import { loadChanges } from '../pieces/changes/store.js';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createSnapshot } from './migration-snapshot.js';
import { prepareMigrationPlan } from './migration-plan.js';
import { runMigrationAll } from './migration-all.js';
import { run } from './migrate.js';
import { acquireHttpLock } from '../transport/http-lock.js';
import { importHousehold } from './household-importer.js';
import { importTasks } from '../pieces/tasks/importer.js';
import { openSnapshotSqlite } from './migration-sqlite.js';
import { createMigrationRegistry, MigrationRegistry } from './migration-registry.js';
import { conversationId } from '../pieces/attention/conversations.js';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const bytes = (path: string): unknown => Object.fromEntries(readdirSync(path).sort().map(name => {
  const p = join(path, name); try { return [name, readFileSync(p).toString('base64')]; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EISDIR') throw e; return [name, bytes(p)]; }
}));
async function fixture(full = false, matchingChange = false) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-all-')); dirs.push(dir);
  const old = join(dir, 'old'), root = join(dir, 'snapshot'), home = join(dir, 'new'); mkdirSync(old);
  const put = (p: string, v: unknown) => { mkdirSync(join(old,p,'..'), { recursive: true }); writeFileSync(join(old,p), JSON.stringify(v)); };
  put('household.json', { v: 1, agents: ['art'], default: 'art', owner: 'jonathan' });
  writeFileSync(join(old,'ui-cookie.key'), Buffer.alloc(32, 17));
  let tasks: string | undefined;
  if (full) {
    put('clock/art/schedules.json', {}); writeFileSync(join(old,'clock/art/spool.jsonl'), '');
    put('approvals/approvals.json', { v: 1, approvals: {} }); put('changes/snapshot.json', { v: 1, changes: matchingChange ? [change({project:'forged'})] : [] });
    tasks = join(dir,'tasks.db'); const t = new Database(tasks); t.pragma('journal_mode = WAL');
    t.exec("CREATE TABLE tasks(ord INTEGER, record TEXT); CREATE TABLE links(ord INTEGER, record TEXT); CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES ('seq','1')");
    t.prepare('INSERT INTO tasks VALUES (?,?)').run(1, JSON.stringify({id:'t-1',type:'task',title:'Migrate',status:'open',priority:1,createdAt:'2026-11-12T00:00:00Z',createdBy:'art',comments:[]})); t.close();
    const a = join(old,'agents/art'); mkdirSync(a,{recursive:true}); const db = new Database(join(a,'memories.db')); db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE conversations(id TEXT, agent TEXT, venue TEXT, place TEXT, label TEXT, people_json TEXT, agents_json TEXT, started TEXT, last TEXT, last_seq INTEGER);
    CREATE TABLE conversation_turns(conversation TEXT, seq INTEGER, at TEXT, from_json TEXT, kind TEXT, latency_ms INTEGER, writer TEXT);
    CREATE TABLE conversation_days(conversation TEXT, day TEXT, counts_json TEXT, median_latency_ms INTEGER, outcomes_json TEXT);
    CREATE TABLE conversation_digests(id TEXT, conversation TEXT, run TEXT, at TEXT, summary TEXT, asks_json TEXT, decisions_json TEXT, tasks_json TEXT, projects_json TEXT, needs_owner TEXT);`);
    db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)').run(conversationId('art','session','fixture'),'art','session','fixture',null,'[]','[]','2026-11-12T00:00:00Z','2026-11-12T00:00:00Z',0); db.close();
  }
  await createSnapshot(old,root,tasks);
  return {dir,old,root,home,plan:prepareMigrationPlan(root).plan};
}
it('imports all six pieces in dependency order, repeats without import writes, and never changes snapshot bytes or entries', async () => {
  const f = await fixture(true), before = bytes(f.root);
  const first = runMigrationAll(f.root,f.home,undefined,{now:()=>12345});
  expect(first).toMatchObject({status:'complete',missing:[],blocked:[]});
  expect(first.pieces.map(p=>p.name)).toEqual(['household','tasks','attention','clock','approvals','changes']);
  const db = new Database(join(f.home,'loom.db'),{readonly:true});
  expect(db.prepare('SELECT count(*) AS n FROM tasks_tasks').get()).toEqual({n:1}); db.close();
  const receipt = readFileSync(join(f.home,'.migration-all.json'),'utf8');
  const destinationBefore = bytes(f.home);
  const again = runMigrationAll(f.root,f.home,undefined,{now:()=>99999});
  expect(again.pieces.every(p=>p.status==='completed')).toBe(true);
  expect(readFileSync(join(f.home,'.migration-all.json'),'utf8')).toBe(receipt);
  expect(bytes(f.home)).toEqual(destinationBefore);
  expect(bytes(f.root)).toEqual(before);
  expect(readFileSync(join(f.home,'ui-cookie.key'))).toEqual(Buffer.alloc(32,17));
});
it('resumes the crash window after importer commit with stable time and keeps earlier completion markers', async () => {
  const f = await fixture(true);
  expect(()=>runMigrationAll(f.root,f.home,undefined,{now:()=>12345,afterPiece:name=>{if(name==='tasks')throw Error('power loss');}})).toThrow('power loss');
  expect(JSON.parse(readFileSync(join(f.home,'.migration-all.json'),'utf8'))).toMatchObject({now:12345,completed:['household']});
  const report = runMigrationAll(f.root,f.home,undefined,{now:()=>99999});
  expect(report.pieces[0]).toEqual({name:'household',status:'completed'});
  expect(report.status).toBe('complete');
  expect(JSON.parse(readFileSync(join(f.home,'.migration-all.json'),'utf8')).now).toBe(12345);
});
it('rejects different plan, including Changes attribution, and different snapshots before destination changes', async () => {
  const f = await fixture(true); runMigrationAll(f.root,f.home); const before = bytes(f.home);
  const plan = structuredClone(f.plan); (plan.importers.changes.options as { attribution: { ownerLogins: string[] } }).attribution.ownerLogins.push('another');
  expect(()=>runMigrationAll(f.root,f.home,plan)).toThrow('another migration');
  const other = await fixture(); expect(()=>runMigrationAll(other.root,f.home)).toThrow('another migration');
  expect(bytes(f.home)).toEqual(before);
});
it('refuses arbitrary populated destinations and overlap in either direction before creating lock or database', async () => {
  const f = await fixture(); mkdirSync(f.home); writeFileSync(join(f.home,'keep'),'safe');
  for(const dest of [f.home, f.root, join(f.root,'child'), f.dir]) expect(()=>runMigrationAll(f.root,dest)).toThrow();
  expect(readdirSync(f.home)).toEqual(['keep']); expect(readdirSync(f.root)).toEqual(['home','manifest.json']);
  const alias=join(f.dir,'alias');symlinkSync(f.root,alias);expect(()=>runMigrationAll(f.root,join(alias,'child'))).toThrow();
  const linked=join(f.dir,'linked');mkdirSync(linked);linkSync(join(f.root,'home/ui-cookie.key'),join(linked,'ui-cookie.key'));
  expect(()=>runMigrationAll(f.root,linked)).toThrow('Hard-linked'); expect(readdirSync(linked)).toEqual(['ui-cookie.key']);
});
it('refuses a held daemon lock and releases ownership after importer failure', async () => {
  const f=await fixture(); const release=acquireHttpLock(f.home);
  const before=bytes(f.home);
  try {expect(()=>runMigrationAll(f.root,f.home)).toThrow('already running'); expect(bytes(f.home)).toEqual(before);} finally {release();}
  expect(()=>runMigrationAll(f.root,f.home,undefined,{afterPiece:()=>{throw Error('interrupted');}})).toThrow();
  const unlock=acquireHttpLock(f.home);unlock();expect(runMigrationAll(f.root,f.home).status).toBe('complete');
});
it('reports missing pieces as incomplete, then runs a newly available supported registration despite an existing receipt', async () => {
  const f=await fixture(true), registry=new MigrationRegistry();
  for(const entry of createMigrationRegistry().order().importers)if(entry.name!=='tasks')registry.register(entry);
  const first=runMigrationAll(f.root,f.home,undefined,{registry}); expect(first).toMatchObject({status:'incomplete',missing:['tasks']});
  const second=runMigrationAll(f.root,f.home);expect(second.status).toBe('complete');expect(second.pieces.find(p=>p.name==='tasks')?.status).toBe('imported');
});
it('never executes a registered name without a discovery/schema contract and blocks its dependents', async()=>{
  const f=await fixture(); const plan=structuredClone(f.plan);plan.importers.future={paths:['home'],options:{secret:'private'}};
  const registry=new MigrationRegistry(), unexpected=vi.fn();
  registry.register({name:'future',dependencies:[],reads:[],run:unexpected});
  registry.register({name:'household',dependencies:['future'],reads:[],run:unexpected});
  expect(runMigrationAll(f.root,f.home,plan,{registry})).toMatchObject({status:'incomplete',missing:['future'],blocked:['household'],pieces:[]}); expect(unexpected).not.toHaveBeenCalled();
});
it('exposes a raw editable plan and one safe CLI report; refusals never echo arguments or source credentials', async()=>{
  const f=await fixture(), io={stdout:vi.fn(),stderr:vi.fn(),stdin:Readable.from([]),stdinIsTTY:false,env:{}};
  expect(await run(['plan','--snapshot',f.root],io)).toBe(0);expect(JSON.parse(io.stdout.mock.calls[0][0])).toEqual(f.plan);
  const path=join(f.dir,'plan.json');writeFileSync(path,io.stdout.mock.calls[0][0]);io.stdout.mockClear();
  expect(await run(['all','--snapshot',f.root,'--home',f.home,'--plan',path],io)).toBe(0);expect(io.stdout).toHaveBeenCalledOnce();
  const secret='PRIVATE_CREDENTIAL_CANARY';writeFileSync(path,secret);expect(await run(['all','--snapshot',f.root,'--home',f.home,'--plan',path],io)).toBe(1);
  expect(await run(['all',`--${secret}`],io)).toBe(2);expect(io.stderr.mock.calls.flat().join('')).not.toContain(secret);
});

it('rolls back an interrupted importer transaction while preserving completed pieces for retry', async()=>{
  const f=await fixture(true), registry=new MigrationRegistry();
  for(const entry of createMigrationRegistry().order().importers) registry.register(entry.name==='tasks'?{...entry,run:(context,input)=>importTasks(context.db,join(context.snapshot.root,input.paths[0]),context.now,{...(input.options as object),interrupt:()=>{throw Error('transaction interrupted');}},openSnapshotSqlite)}:entry);
  expect(()=>runMigrationAll(f.root,f.home,undefined,{registry})).toThrow('transaction interrupted');
  const db=new Database(join(f.home,'loom.db'),{readonly:true});
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='tasks_tasks'").get()).toBeUndefined();db.close();
  expect(JSON.parse(readFileSync(join(f.home,'.migration-all.json'),'utf8')).completed).toEqual(['household']);
  expect(runMigrationAll(f.root,f.home).status).toBe('complete');
});
it('rejects tampered snapshots before touching an existing destination, even on completed repeat',async()=>{
  const f=await fixture();runMigrationAll(f.root,f.home);const before=bytes(f.home);
  writeFileSync(join(f.root,'home/ui-cookie.key'),Buffer.alloc(32,19));
  expect(()=>runMigrationAll(f.root,f.home)).toThrow();expect(bytes(f.home)).toEqual(before);
});

it('recovers an unpublished receipt without widening home or receipt permissions',async()=>{
  const f=await fixture();mkdirSync(f.home,{mode:0o755});writeFileSync(join(f.home,'.migration-all.pending'),'partial',{mode:0o644});
  expect(runMigrationAll(f.root,f.home).status).toBe('complete');
  expect(statSync(f.home).mode&0o777).toBe(0o700);
  expect(statSync(join(f.home,'.migration-all.json')).mode&0o777).toBe(0o600);
});

it('recovers exactly the household key publication hardlink pair after process death',async()=>{
  const f=await fixture();
  const registry=new MigrationRegistry();registry.register({name:'household',dependencies:[],reads:[],run:()=>{throw Error('death');}});
  expect(()=>runMigrationAll(f.root,f.home,undefined,{registry})).toThrow();
  // Reproduce death after key link publication but before household transaction commit.
  writeFileSync(join(f.home,'ui-cookie.key'),readFileSync(join(f.root,'home/ui-cookie.key')),{mode:0o600});
  const temp=join(f.home,`.ui-cookie.key-import-${randomUUID()}`);linkSync(join(f.home,'ui-cookie.key'),temp);
  expect(runMigrationAll(f.root,f.home).status).toBe('complete');expect(readdirSync(f.home)).not.toContain(temp.split('/').at(-1));
  expect(statSync(join(f.home,'ui-cookie.key')).nlink).toBe(1);
});
it('refuses a key publication pair with another external alias, wrong bytes, or no matching receipt',async()=>{
  for(const kind of ['external','bytes','receipt']) {
    const f=await fixture();runMigrationAll(f.root,f.home);const temp=join(f.home,`.ui-cookie.key-import-${randomUUID()}`);linkSync(join(f.home,'ui-cookie.key'),temp);
    if(kind==='external')linkSync(temp,join(f.dir,'outside'));
    if(kind==='bytes')writeFileSync(temp,Buffer.alloc(32,18));
    if(kind==='receipt')rmSync(join(f.home,'.migration-all.json'));
    const before=bytes(f.home);expect(()=>runMigrationAll(f.root,f.home)).toThrow();expect(bytes(f.home)).toEqual(before);
  }
});
it('refuses symlink homes and symlink parent components unrelated to the source',async()=>{
  const f=await fixture();mkdirSync(f.home);const alias=join(f.dir,'alias');symlinkSync(f.home,alias);
  expect(()=>runMigrationAll(f.root,alias)).toThrow('Symlink');expect(()=>runMigrationAll(f.root,join(alias,'child'))).toThrow('Symlink');expect(readdirSync(f.home)).toEqual([]);
});
it('derives Changes projects from sharing and holds the daemon lock through import, receipt fsync and close',async()=>{
  const f=await fixture(true,true), registry=new MigrationRegistry();
  const steps:string[]=[];
  const publication={sync:(fd:number)=>{expect(()=>acquireHttpLock(f.home)).toThrow('already running');steps.push(fs.fstatSync(fd).isDirectory()?'directory':'file');fs.fsyncSync(fd);},rename:(from:fs.PathLike,to:fs.PathLike)=>{steps.push('rename');fs.renameSync(from,to);}};
  for(const entry of createMigrationRegistry().order().importers) registry.register(entry.name==='household'?{...entry,run:(context,input)=>{
    expect(()=>acquireHttpLock(f.home)).toThrow('already running');
    const close=context.db.close.bind(context.db);vi.spyOn(context.db,'close').mockImplementation(()=>{expect(()=>acquireHttpLock(f.home)).toThrow('already running');return close();});
    importHousehold(context.db,context.home,join(context.snapshot.root,input.paths[0]),context.now);
    context.db.transaction(()=>new SharingDatabase(context.db,context.home).create({slug:'pond',name:'Pond',repositories:['acme/app'],members:[],agents:['art']}))();
  }}:entry.name==='changes'?{...entry,run:(context,input)=>{
    expect((input.options as ()=>{projects:unknown[]})().projects).toEqual([{slug:'pond',name:'Pond',repos:['acme/app']}]);
    return entry.run(context,input);
  }}:entry);
  expect(runMigrationAll(f.root,f.home,undefined,{registry,publication}).status).toBe('complete');expect(steps).toEqual(Array.from({length:7},()=>['file','rename','directory']).flat());
  const db=new Database(join(f.home,'loom.db'),{readonly:true});try{expect(loadChanges(db)).toMatchObject([{project:'pond'}]);}finally{db.close();}
});
it('retries safely when receipt publication fails before rename or directory fsync',async()=>{
  for(const stage of ['file','rename','directory']) {
    const f=await fixture();let sync=0;const actual=fs.fsyncSync;
    const publication={sync:(fd:number)=>{sync++;if(stage!=='rename'&&sync===(stage==='file'?1:2))throw Error('power loss');actual(fd);},rename:(from:fs.PathLike,to:fs.PathLike)=>{if(stage==='rename')throw Error('power loss');fs.renameSync(from,to);}};
    expect(()=>runMigrationAll(f.root,f.home,undefined,{publication})).toThrow('power loss');
    expect(runMigrationAll(f.root,f.home).status).toBe('complete');
  }
});

it('returns exit 3 and one incomplete report for a missing CLI registration, including repeat',async()=>{
  const f=await fixture();f.plan.importers.future={paths:['home'],options:{}};const path=join(f.dir,'plan.json');writeFileSync(path,JSON.stringify(f.plan));
  const io={stdout:vi.fn(),stderr:vi.fn(),stdin:Readable.from([]),stdinIsTTY:false,env:{}};
  for(const repeat of [false,true]) {
    io.stdout.mockClear();expect(await run(['all','--snapshot',f.root,'--home',f.home,'--plan',path],io)).toBe(3);
    expect(io.stdout).toHaveBeenCalledOnce();expect(JSON.parse(io.stdout.mock.calls[0][0])).toMatchObject({status:'incomplete',missing:['future'],pieces:[{name:'household',status:repeat?'completed':'imported'}]});
  }
  expect(io.stderr).not.toHaveBeenCalled();
});
it('refuses dangling symlink destinations and parents before creating their missing targets',async()=>{
  const f=await fixture();const target=join(f.dir,'absent'),alias=join(f.dir,'alias');symlinkSync(target,alias);
  expect(()=>runMigrationAll(f.root,alias)).toThrow('Symlink');expect(()=>runMigrationAll(f.root,join(alias,'child'))).toThrow('Symlink');expect(fs.existsSync(target)).toBe(false);
});

it('snapshots the real-home layout with 28 aliases, installed programs and a live socket, then runs all importers', async () => {
  const f = await fixture(true);
  const { createServer } = await import('node:net');
  const server = createServer();
  mkdirSync(join(f.old, 'pieces/runtime/run'), {recursive:true});
  await new Promise<void>(resolve => server.listen(join(f.old, 'pieces/runtime/run/ui.sock'), resolve));
  try {
    symlinkSync('agents/art', join(f.old, 'art'));
    symlinkSync('/home/jbarket/.config/loom/art', join(f.old, 'default'));
    mkdirSync(join(f.old, 'pieces/bin'), {recursive:true});
    for (let i=0; i<13; i++) {
      const piece = `program-${i}`;
      mkdirSync(join(f.old, `pieces/${piece}/versions/one/node_modules/.bin`), {recursive:true});
      writeFileSync(join(f.old, `pieces/${piece}/versions/one/node_modules/unused`), 'program bytes');
      symlinkSync('versions/one', join(f.old, `pieces/${piece}/current`));
      symlinkSync(`../${piece}/current/node_modules/.bin/tool`, join(f.old, `pieces/bin/tool-${i}`));
    }
    // A declared-looking filename in an installed tree must never be visited or copied.
    mkdirSync(join(f.old, 'pieces/runtime/current'), {recursive:true});
    writeFileSync(join(f.old, 'pieces/runtime/current/memories.db'), 'invalid database');
    const snapshot = join(f.dir, 'real-shape');
    const manifest = await createSnapshot(f.old, snapshot, join(f.dir,'tasks.db'));
    expect(manifest.followed).toContainEqual({path:'art',realPath:'agents/art'});
    expect(manifest.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({path:'default',rule:'dangling or unresolved symlink'}),
      expect.objectContaining({path:'pieces/bin'}), expect.objectContaining({path:'pieces/runtime/run'}),
      expect.objectContaining({path:'pieces/program-0/current'}),
    ]));
    expect(manifest.files.filter(file=>file.path.endsWith('memories.db')).map(file=>file.path)).toEqual(['home/agents/art/memories.db']);
    const report = runMigrationAll(snapshot, join(f.dir, 'real-shape-new'));
    expect(report.status).toBe('complete');
    expect(report.pieces.map(p=>p.name)).toEqual(['household','tasks','attention','clock','approvals','changes']);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
