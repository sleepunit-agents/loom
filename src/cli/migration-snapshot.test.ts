import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { run } from './migrate.js';
import { canonicalSnapshotPath, migrateSnapshot, createSnapshot, readSnapshot } from './migration-snapshot.js';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'loom-snapshot-')); roots.push(root);
  const home = join(root, 'old'); mkdirSync(home);
  writeFileSync(join(home, 'household.json'), '{"defaultAgent":"art"}');
  writeFileSync(join(home, 'comms.key'), 'private-key-material');
  return { root, home, to: join(root, 'snapshot') };
}
test('backs up a live WAL database while an uncommitted writer is active', async () => {
  const { home, to, root } = fixture();
  const path = join(home, 'memories.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages VALUES (1, \'committed\')');
  db.exec('BEGIN IMMEDIATE; INSERT INTO messages VALUES (2, \'uncommitted\')');
  const tasks = join(root, 'store.db');
  const taskDb = new Database(tasks); taskDb.exec('CREATE TABLE tasks (id TEXT)'); taskDb.close();
  try {
    const manifest = await createSnapshot(home, to, tasks);
    expect(manifest.files.map(f => f.path).sort()).toEqual(['home/comms.key', 'home/household.json', 'home/memories.db', 'tasks/store.db']);
    expect(statSync(to).mode & 0o777).toBe(0o700);
    expect(statSync(join(to, 'home/comms.key')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(manifest)).not.toContain('private-key-material');
    const copy = new Database(join(to, 'home/memories.db'), { readonly: true });
    try { expect(copy.prepare('SELECT * FROM messages').all()).toEqual([{ id: 1, body: 'committed' }]); }
    finally { copy.close(); }
    expect(readSnapshot(to)).toEqual(manifest);
    expect(readFileSync(join(home, 'comms.key'), 'utf8')).toBe('private-key-material');
  } finally { db.exec('ROLLBACK'); db.close(); }
});
test('refuses existing and nested destinations without altering them', async () => {
  const { home, to } = fixture();
  await expect(createSnapshot(home, join(home, 'snapshot'))).rejects.toThrow();
  await createSnapshot(home, to);
  const before = readFileSync(join(to, 'manifest.json'));
  await expect(createSnapshot(home, to)).rejects.toThrow();
  expect(readFileSync(join(to, 'manifest.json'))).toEqual(before);
});
test('removes a partial snapshot on backup failure and can retry', async () => {
  const { home, to } = fixture();
  writeFileSync(join(home, 'memories.db'), 'SQLite format 3\0broken');
  await expect(createSnapshot(home, to)).rejects.toThrow('memories.db');
  expect(existsSync(to)).toBe(false);
  rmSync(join(home, 'memories.db'));
  await createSnapshot(home, to);
  expect(readSnapshot(to).files).toHaveLength(2);
});
test('detects a changed snapshot and manifest traversal', async () => {
  const { home, to } = fixture();
  await createSnapshot(home, to);
  writeFileSync(join(to, 'home/comms.key'), 'different');
  expect(() => readSnapshot(to)).toThrow('integrity');
  writeFileSync(join(to, 'manifest.json'), JSON.stringify({ version: 1, files: [{ path: '../old/comms.key' }] }));
  expect(() => readSnapshot(to)).toThrow('path');
});

test('copies only declared importer data and keys', async () => {
  const { home, to } = fixture();
  mkdirSync(join(home, 'dist'));
  writeFileSync(join(home, 'dist/settings.json'), '{"enabled":true}');
  writeFileSync(join(home, 'credentials-journal'), 'private-journal-key');
  const manifest = await createSnapshot(home, to);
  for (const path of ['household.json', 'comms.key']) expect(readFileSync(join(to, 'home', path))).toEqual(readFileSync(join(home, path)));
  expect(manifest.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'dist/settings.json' }), expect.objectContaining({ path: 'credentials-journal' })]));
  expect(existsSync(join(to, 'home/dist'))).toBe(false);
});
test('rejects external manifest and entry symlinks and same-length corruption', async () => {
  const { home, to, root } = fixture();
  await createSnapshot(home, to);
  const key = join(to, 'home/comms.key');
  const original = readFileSync(key);
  writeFileSync(key, Buffer.alloc(original.length, 65));
  expect(() => readSnapshot(to)).toThrow('integrity');
  rmSync(key); symlinkSync(join(home, 'comms.key'), key);
  expect(() => readSnapshot(to)).toThrow('link');
  const manifest = join(to, 'manifest.json');
  const external = join(root, 'external.json');
  writeFileSync(external, '{"version":1,"files":[]}');
  rmSync(manifest); symlinkSync(external, manifest);
  expect(() => readSnapshot(to)).toThrow('manifest link');
});
test('CLI validates arguments and never forwards key material in success or failure output', async () => {
  const { home, to } = fixture();
  const output: string[] = [];
  const io = { stdout: (s: string) => output.push(s), stderr: (s: string) => output.push(s), stdin: Readable.from([]), stdinIsTTY: false, env: {} };
  expect(await migrateSnapshot([], io)).toBe(2);
  expect(await migrateSnapshot(['--from', home, '--to', to], io)).toBe(0);
  expect(await migrateSnapshot(['--from', home, '--to', to], io)).toBe(1);
  expect(output.join('')).not.toContain('private-key-material');
  expect(output.join('')).toContain('"status":"ok"');
});

 test('read-only backup permits coordination files but preserves source records and JSON/key bytes', async () => {
  const { home, to } = fixture();
  const path = join(home, 'memories.db');
  const writer = new Database(path);
  writer.pragma('journal_mode = WAL');
  writer.exec("CREATE TABLE records (id TEXT PRIMARY KEY); INSERT INTO records VALUES ('kept')");
  writer.close();
  const sourceBytes = readFileSync(path);
  const jsonBytes = readFileSync(join(home, 'household.json'));
  const keyBytes = readFileSync(join(home, 'comms.key'));
  await createSnapshot(home, to);
  expect(readFileSync(path)).toEqual(sourceBytes);
  expect(readFileSync(join(home, 'household.json'))).toEqual(jsonBytes);
  expect(readFileSync(join(home, 'comms.key'))).toEqual(keyBytes);
  const source = new Database(path, { readonly: true });
  try { expect(source.prepare('SELECT * FROM records').all()).toEqual([{ id: 'kept' }]); }
  finally { source.close(); }
});

test('canonical paths retain the first character directly beneath the filesystem root', () => {
  expect(canonicalSnapshotPath('/loom-snapshot-nonexistent-fixture')).toBe('/loom-snapshot-nonexistent-fixture');
});
test('creates the home container without copying unused empty directories', async () => {
  const { home, to } = fixture();
  rmSync(join(home, 'comms.key')); rmSync(join(home, 'household.json'));
  mkdirSync(join(home, 'empty'));
  expect((await createSnapshot(home, to)).files).toEqual([]);
  expect(statSync(join(to, 'home')).isDirectory()).toBe(true);
  expect(existsSync(join(to, 'home/empty'))).toBe(false);
  expect(readSnapshot(to).files).toEqual([]);
});
test('refuses a reserved directory with missing or interrupted completion manifest', () => {
  const { to } = fixture(); mkdirSync(to);
  expect(() => readSnapshot(to)).toThrow();
  writeFileSync(join(to, 'manifest.json'), '{"version":1,"files":[');
  expect(() => readSnapshot(to)).toThrow();
});

test('reports unregistered files as skipped through the public command', async () => {
  const { home, to } = fixture();
  mkdirSync(join(home, 'credentials'));
  writeFileSync(join(home, 'credentials-journal'), 'keep');
  const output: string[] = [];
  const io = { stdout: (s: string) => output.push(s), stderr: (s: string) => output.push(s), stdin: Readable.from([]), stdinIsTTY: false, env: {} };
  expect(await run(['snapshot', '--from', home, '--to', to], io)).toBe(0);
  expect(existsSync(join(to, 'home/credentials-journal'))).toBe(false);
  expect(readSnapshot(to).skipped).toContainEqual(expect.objectContaining({path: 'credentials-journal'}));
});

test('dry-run inventories copies and skips with sizes, follows internal data once, writes nothing', async () => {
  const {home,to,root}=fixture();
  mkdirSync(join(home,'agents/art'),{recursive:true});
  const db=new Database(join(home,'agents/art/memories.db'));db.exec('CREATE TABLE data(id)');db.close();
  symlinkSync('agents/art',join(home,'art'));
  symlinkSync(join(root,'missing'),join(home,'default'));
  const external=join(root,'external');writeFileSync(external,'external-secret');symlinkSync(external,join(home,'external.key'));
  writeFileSync(join(home,'not-data'), 'ignored');
  const before=readFileSync(join(home,'agents/art/memories.db'));
  const output:string[]=[];
  const io={stdout:(s:string)=>output.push(s),stderr:(s:string)=>output.push(s),stdin:Readable.from([]),stdinIsTTY:false,env:{}};
  expect(await migrateSnapshot(['--from',home,'--to',to,'--dry-run'],io)).toBe(0);
  const report=JSON.parse(output.join(''));
  expect(report.copies).toContainEqual({path:'home/agents/art/memories.db',bytes:before.length});
  expect(report.skipped).toContainEqual({path:'not-data',bytes:7,rule:'not declared by a registered importer or key rule'});
  expect(report.skipped).toContainEqual({path:'external.key',bytes:null,rule:'symlink outside source home'});
  expect(report.followed).toContainEqual({path:'art',realPath:'agents/art'});
  expect(output.join('')).not.toContain(external);
  expect(output.join('')).not.toContain('external-secret');
  expect(existsSync(to)).toBe(false);
  expect(existsSync(join(home,'agents/art/memories.db-wal'))).toBe(false);
  expect(readFileSync(join(home,'agents/art/memories.db'))).toEqual(before);
  const manifest=await createSnapshot(home,to);
  expect(manifest.files.map(({path,bytes})=>({path,bytes}))).toEqual(report.copies);
});

test('refuses destination symlinks with a path and rule, never contents or absolute source paths', async()=>{
  const {home,root}=fixture();const outside=join(root,'outside');mkdirSync(outside);
  const link=join(root,'linked');symlinkSync(outside,link);
  const output:string[]=[];const io={stdout:(s:string)=>output.push(s),stderr:(s:string)=>output.push(s),stdin:Readable.from([]),stdinIsTTY:false,env:{}};
  expect(await migrateSnapshot(['--from',home,'--to',join(link,'snapshot')],io)).toBe(1);
  expect(output.join('')).toContain('destination path contains a symlink');
  expect(output.join('').trim().split('\n')).toHaveLength(1);
  expect(output.join('')).not.toContain(root);
  expect(existsSync(join(outside,'snapshot'))).toBe(false);
});

test('backup failures expose one relative path and rule without library exception or data', async()=>{
  const {home,to}=fixture();writeFileSync(join(home,'memories.db'),'SQLite format 3\0PRIVATE_SQL_CANARY');
  const output:string[]=[];const io={stdout:(s:string)=>output.push(s),stderr:(s:string)=>output.push(s),stdin:Readable.from([]),stdinIsTTY:false,env:{}};
  expect(await migrateSnapshot(['--from',home,'--to',to],io)).toBe(1);
  expect(output).toEqual(['Snapshot refused: "memories.db": SQLite backup failed\n']);
  expect(existsSync(to)).toBe(false);
});

test('follows file aliases selected by their original name and includes every key rule',async()=>{
  const {home,to}=fixture();mkdirSync(join(home,'private'));mkdirSync(join(home,'keys'));
  writeFileSync(join(home,'private/material'),'secret');symlinkSync('private/material',join(home,'signing.key'));
  writeFileSync(join(home,'review.pub'),'public recipient');writeFileSync(join(home,'keys/recipient'),'key payload');
  const manifest=await createSnapshot(home,to);
  expect(manifest.followed).toContainEqual({path:'signing.key',realPath:'private/material'});
  expect(readFileSync(join(to,'home/private/material'),'utf8')).toBe('secret');
  expect(readFileSync(join(to,'home/review.pub'),'utf8')).toBe('public recipient');
  expect(readFileSync(join(to,'home/keys/recipient'),'utf8')).toBe('key payload');
});

test('refuses an ancestor swapped to a symlink during a backup before any later mkdir escapes',async()=>{
  const {home,to,root}=fixture();
  const db=new Database(join(home,'memories.db'));db.exec('CREATE TABLE records(id)');db.close();
  mkdirSync(join(home,'zzz/nested'),{recursive:true});writeFileSync(join(home,'zzz/nested/signing.key'),'key');
  const outside=join(root,'outside');mkdirSync(outside);
  const backup=Database.prototype.backup;
  vi.spyOn(Database.prototype,'backup').mockImplementation(async function(this:Database.Database,...args:Parameters<typeof backup>){
    const result=await backup.apply(this,args);
    symlinkSync(outside,join(to,'home/zzz'));
    return result;
  });
  await expect(createSnapshot(home,to)).rejects.toThrow('destination path contains a symlink');
  expect(existsSync(join(outside,'nested'))).toBe(false);
});

test('refuses a replaced reserved root and does not clean up the replacement',async()=>{
  const {home,to,root}=fixture();const db=new Database(join(home,'memories.db'));db.exec('CREATE TABLE records(id)');db.close();
  const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep'),'safe');
  const backup=Database.prototype.backup;
  vi.spyOn(Database.prototype,'backup').mockImplementation(async function(this:Database.Database,...args:Parameters<typeof backup>){
    renameSync(to,join(root,'reserved'));symlinkSync(outside,to);
    return await backup.apply(this,args);
  });
  await expect(createSnapshot(home,to)).rejects.toThrow();
  expect(readFileSync(join(outside,'keep'),'utf8')).toBe('safe');
  expect(readdirSync(outside)).toEqual(['keep']);
});

test('retains key-directory alias selection across canonical traversal and terminates internal cycles',async()=>{
  const {home,to}=fixture();mkdirSync(join(home,'aaa/material'),{recursive:true});
  writeFileSync(join(home,'aaa/material/recipient'),'key');symlinkSync('aaa/material',join(home,'keys'));
  symlinkSync('.',join(home,'cycle'));
  const manifest=await createSnapshot(home,to);
  expect(manifest.files.filter(file=>file.path==='home/aaa/material/recipient')).toHaveLength(1);
  expect(readFileSync(join(to,'home/aaa/material/recipient'),'utf8')).toBe('key');
  expect(manifest.skipped).toContainEqual({path:'cycle',rule:'cyclic directory alias',bytes:null});
});

test('skips live sockets outside runtime directories by type without reading them',async()=>{
  const {home,to}=fixture();const {createServer}=await import('node:net');const server=createServer();
  await new Promise<void>(resolve=>server.listen(join(home,'live.key'),resolve));
  try {
    const manifest=await createSnapshot(home,to);
    expect(manifest.skipped).toContainEqual({path:'live.key',rule:'special file (socket, pipe or device)',bytes:null});
    expect(existsSync(join(to,'home/live.key'))).toBe(false);
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('directory pruning and SQLite sidecar rules do not discard ordinary keys with similar names',async()=>{
  const {home,to}=fixture();mkdirSync(join(home,'keys'));
  for(const name of ['current','versions','private-journal','private-wal','private-shm'])writeFileSync(join(home,'keys',name),'keep');
  const db=new Database(join(home,'keys/source'));db.exec('CREATE TABLE data(id)');db.close();
  for(const suffix of ['-journal','-wal','-shm'])writeFileSync(join(home,'keys/source'+suffix),'');
  writeFileSync(join(home,'keys/state.lock'),'lock');
  const manifest=await createSnapshot(home,to);
  for(const name of ['current','versions','private-journal','private-wal','private-shm'])expect(readFileSync(join(to,'home/keys',name),'utf8')).toBe('keep');
  for(const suffix of ['-journal','-wal','-shm'])expect(manifest.skipped).toContainEqual(expect.objectContaining({path:'keys/source'+suffix,rule:'SQLite coordination file (backup API reads committed data)'}));
  expect(manifest.skipped).toContainEqual({path:'keys/state.lock',rule:'lock file',bytes:4});
});

test('external roots reach plan, all and independent verify without changing source or snapshot bytes', async () => {
  const { root, home, to } = fixture();
  writeFileSync(join(home, 'household.json'), JSON.stringify({v:1,agents:['art','mark'],default:'art',owner:'jonathan'}));
  const clock = join(root,'old-clock'), wake = join(root,'old-wake'), approvals = join(root,'old-approvals'), changes = join(root,'old-changes.json');
  mkdirSync(join(clock,'mark'),{recursive:true}); mkdirSync(wake); mkdirSync(approvals);
  writeFileSync(join(clock,'lanes.json'),'{}');
  writeFileSync(join(clock,'mark/schedules.json'),JSON.stringify({morning:{at:'08:31',days:'',prompt:'Mark fixture'}}));
  writeFileSync(join(wake,'schedules.json'),JSON.stringify({evening:{at:'19:31',days:'',prompt:'Art fixture'}}));
  writeFileSync(join(approvals,'approvals.json'),JSON.stringify({v:1,approvals:{}}));
  writeFileSync(join(approvals,'rules.json'),JSON.stringify({v:1,rules:[{kind:'merge',scope:'github:sleepunit-agents/*',tier:'do',by:'jonathan',at:'2026-11-12T00:00:00Z'}]}));
  const { change } = await import('../pieces/changes/fixture.js');
  writeFileSync(changes,JSON.stringify({v:1,changes:[change()]}));
  const roots = {clock,wake,approvals,changes};
  const sourceBytes = [join(clock,'lanes.json'),join(clock,'mark/schedules.json'),join(wake,'schedules.json'),join(approvals,'approvals.json'),join(approvals,'rules.json'),changes].map(p=>[p,readFileSync(p)] as const);
  const output: string[] = [];
  const dry = {io:{stdout:(s:string)=>output.push(s),stderr:(s:string)=>output.push(s),stdin:Readable.from([]),stdinIsTTY:false,env:{}},out:()=>output.join('')};
  expect(await migrateSnapshot(['--from',home,'--to',to,...Object.entries(roots).flatMap(([k,v])=>[`--${k}`,v]),'--dry-run'],dry.io)).toBe(0);
  expect(existsSync(to)).toBe(false);
  expect(JSON.parse(dry.out()).copies.map((f:{path:string})=>f.path)).toEqual(expect.arrayContaining(['clock/mark/schedules.json','clock/art/schedules.json','approvals/approvals.json','changes/changes.json']));
  await createSnapshot(home,to,undefined,roots);
  const { prepareMigrationPlan } = await import('./migration-plan.js');
  const plan = prepareMigrationPlan(to).plan;
  expect(plan.importers.clock.paths).toEqual(['clock']);
  expect(plan.importers.approvals.paths).toEqual(['approvals']);
  expect(plan.importers.changes.paths).toEqual(['changes/changes.json']);
  const before = readSnapshot(to).files.map(f=>[f.path,readFileSync(join(to,f.path))] as const);
  const { runMigrationAll } = await import('./migration-all.js');
  const { verifyMigration } = await import('./migration-verify.js');
  const destination = join(root,'new-home');
  expect((await runMigrationAll(to,destination,plan)).status).toBe('complete');
  expect((await verifyMigration(to,destination,plan))).toMatchObject({status:'verified',differences:[],pieces:expect.arrayContaining(['clock','approvals','changes'])});
  const db = new Database(join(destination,'loom.db'));
  expect(db.prepare('SELECT id FROM clock_schedules ORDER BY id').all()).toEqual([{id:'art/evening'},{id:'mark/morning'}]);
  expect(db.prepare('SELECT count(*) AS n FROM approvals_rules').get()).toEqual({n:1});
  expect(db.prepare('SELECT count(*) AS n FROM changes_changes').get()).toEqual({n:1});
  db.prepare('DELETE FROM clock_schedules').run(); db.close();
  expect((await verifyMigration(to,destination,plan))).toMatchObject({status:'different',differences:expect.arrayContaining([expect.objectContaining({piece:'clock',table:'clock_schedules'})])});
  for (const [p,bytes] of sourceBytes) expect(readFileSync(p)).toEqual(bytes);
  for (const [p,bytes] of before) expect(readFileSync(join(to,p))).toEqual(bytes);
});

test('external roots refuse overlap, missing inputs and colliding clock agents before creating destination', async () => {
  const {root,home,to} = fixture(); const clock=join(root,'clock'),wake=join(root,'wake');
  mkdirSync(join(clock,'art'),{recursive:true});mkdirSync(wake);
  writeFileSync(join(clock,'art/schedules.json'),'{}');writeFileSync(join(wake,'schedules.json'),'{}');
  for (const roots of [{clock,wake},{clock:join(root,'missing')},{clock:to},{changes:clock}]) {
    await expect(createSnapshot(home,to,undefined,roots)).rejects.toThrow();
    expect(existsSync(to)).toBe(false);
  }
  await expect(createSnapshot(home,join(clock,'snapshot'),undefined,{clock})).rejects.toThrow('separate');
});
