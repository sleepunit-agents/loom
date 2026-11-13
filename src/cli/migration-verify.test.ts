import * as fs from 'node:fs';
import * as foundation from '../core/app.js';
import * as core from '../core/index.js';
import * as database from '../core/db/index.js';
import * as householdSchema from '../core/household/schema.js';
import { change } from '../pieces/changes/fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createSnapshot } from './migration-snapshot.js';
import { prepareMigrationPlan } from './migration-plan.js';
import { verifyMigration } from './migration-verify.js';
import * as taskImporter from '../pieces/tasks/importer.js';
import * as attentionImporter from '../pieces/attention/importer.js';
import * as clockImporter from '../pieces/clock/importer.js';
import * as approvalsImporter from '../pieces/approvals/importer.js';
import * as changesImporter from '../pieces/changes/importer.js';
import * as householdImporter from './household-importer.js';
import { runMigrationAll } from './migration-all.js';
import { run } from './migrate.js';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createMigrationRegistry, MigrationRegistry } from './migration-registry.js';
import { digestId } from '../pieces/attention/digests.js';
import { findingId } from '../pieces/attention/retention.js';
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
  if (full) {
    const at='2026-11-12T00:00:00Z', digest='a'.repeat(64);
    const attention=new Database(join(old,'agents/art/memories.db')), cv=conversationId('art','session','fixture');
    attention.exec(`CREATE TABLE findings(id TEXT, conversation TEXT, seq INTEGER, day TEXT, measure TEXT, score REAL, text TEXT, at TEXT);`);
    attention.prepare('UPDATE conversations SET started=?, last=?, last_seq=?').run('2026-11-11T00:00:00Z',at,2);
    attention.prepare('INSERT INTO conversation_days VALUES (?,?,?,?,?)').run(cv,'2026-11-11','{"message":1}',100,'{"fixture":{"answered":1}}');
    attention.prepare('INSERT INTO conversation_turns VALUES (?,?,?,?,?,?,?)').run(cv,2,at,'{"kind":"person","slug":"jonathan"}','message',100,'legacy');
    attention.prepare('INSERT INTO conversation_digests VALUES (?,?,?,?,?,?,?,?,?,?)').run(digestId(cv,'fixture'),cv,'fixture',at,'Summary','["Authored"]','["Decided"]','["t-1"]','["pond"]','Continue?');
    attention.prepare('INSERT INTO findings VALUES (?,?,?,?,?,?,?,?)').run(findingId(cv,'2026-11-11'),cv,1,'2026-11-11','helpfulness',4,'Useful',at);attention.close();

    put('tokens.json',{v:1,tokens:[{label:'fixture',role:'owner',sha256:digest,created:at},{label:'duplicate',role:'owner',sha256:digest,created:at}]});
    put('tokens.used.json',{[digest]:at});
    put('ui-sessions.json',{v:1,sessions:{['b'.repeat(64)]:{issuedAt:1000,secret:digest}},links:{['c'.repeat(64)]:{expires:2000,secret:digest}},challenges:{['d'.repeat(64)]:{expires:2000,purpose:'login'}},passkeys:{cred:{id:'cred',publicKey:'FIXTURE',alg:-7,counter:4,label:'phone',created:900,secret:digest}},members:{jonathan:{prefs:{look:'daylight'}}},push:{subs:{endpoint:{fixture:true}}},future:['kept']});
    put('pieces/runtime/settings.json',{fixture:'settings'});
    put('clock/art/schedules.json',{night:{at:'03:47',days:'mon-fri',prompt:'Fixture'}});
    writeFileSync(join(old,'clock/art/spool.jsonl'),JSON.stringify({id:'w-fixture',at:'2026-11-12 00:00:00',created:'2026-11-12 00:00:00',prompt:'Fixture',note:'keep',fails:2})+'\n');
    put('clock/art/paused',{since:'2026-11-12 00:00:00'});
    const who={agent:'art',where:'h-fixture'}, approval={id:'a-01234567',kind:'relay',target:'art->mark',what:'Ask Mark',why:'Fixture',who,for:'?',people:['jonathan'],minutes:60,at,state:'used',decided:at,expires:'2026-11-12T01:00:00Z',used:at,by:'jonathan'};
    put('approvals/approvals.json',{v:1,approvals:{[approval.id]:approval},notices:[{at,agent:'art',kind:'merge',target:'github:acme/app',what:'Merged',for:'owner'}]});
    put('approvals/rules.json',{v:1,rules:[{kind:'merge',scope:'github:acme/*',tier:'do',by:'jonathan',at}],grants:[],standing:['s-01234567','s-01234568'].map(id=>({id,kind:'local-wake',agent:'art',target:`art:${'a'.repeat(16)}`,digest:'a'.repeat(64),who,for:'owner',from:approval.id,what:'Run fixture',at,by:'jonathan',uses:2,used:at}))});
    writeFileSync(join(old,'approvals/audit.jsonl'),JSON.stringify({at,event:'use',id:approval.id,kind:approval.kind,target:approval.target,who})+'\n');
  }
  await createSnapshot(old,root,tasks);
  return {dir,old,root,home,plan:prepareMigrationPlan(root).plan};
}
it('independently verifies all six pieces on every invocation without any importer or filesystem writes',async()=>{
  const f=await fixture(true,true);runMigrationAll(f.root,f.home,undefined,{now:()=>12345});
  const before=bytes(f.home),source=bytes(f.root);
  for(const [module,name] of [[taskImporter,'importTasks'],[attentionImporter,'importAttention'],[clockImporter,'importClock'],[approvalsImporter,'importApprovals'],[changesImporter,'importChanges'],[householdImporter,'importHousehold']] as const) vi.spyOn(module,name as never).mockImplementation(()=>{throw Error('writer called');});
  for(const _ of [1,2]) expect(verifyMigration(f.root,f.home)).toMatchObject({status:'verified',missing:[],differences:[],pieces:['household','tasks','attention','clock','approvals','changes']});
  expect(bytes(f.home)).toEqual(before);expect(bytes(f.root)).toEqual(source);
});
it('detects altered content behind unchanged coordinator and importer receipts, including repeat after all skips',async()=>{
  const f=await fixture(true,true);runMigrationAll(f.root,f.home,undefined,{now:()=>12345});
  const db=new Database(join(f.home,'loom.db'));
  db.prepare("UPDATE tasks_tasks SET record=json_set(record,'$.title','WRONG_PRIVATE_CANARY')").run();
  db.prepare("UPDATE attention_conversations SET record=json_set(record,'$.label','wrong')").run();
  db.prepare("UPDATE changes_changes SET record=json_set(record,'$.title','wrong')").run();db.close();
  expect(runMigrationAll(f.root,f.home).pieces.every(p=>p.status==='completed')).toBe(true);
  for(const _ of [1,2]) {
    const r=verifyMigration(f.root,f.home);expect(r.status).toBe('different');expect(r.differences.map(d=>d.table)).toEqual(expect.arrayContaining(['tasks_tasks','attention_conversations','changes_changes']));expect(JSON.stringify(r)).not.toContain('WRONG_PRIVATE_CANARY');
  }
});
it('detects missing rows, hidden household rows, altered physical IDs, timestamps, cookie bytes and absent tables',async()=>{
  const f=await fixture(true);runMigrationAll(f.root,f.home,undefined,{now:()=>12345});
  const db=new Database(join(f.home,'loom.db'));db.exec("DELETE FROM tasks_tasks; INSERT INTO household_sessions VALUES ('hidden','{}'); UPDATE household_agents SET id='hidden'; DROP TABLE clock_wakes; INSERT INTO approvals_audit VALUES (77,'{}')");db.close();
  writeFileSync(join(f.home,'ui-cookie.key'),Buffer.alloc(32,7));
  const r=verifyMigration(f.root,f.home);expect(r.status).toBe('different');expect(r.differences.map(d=>d.table)).toEqual(expect.arrayContaining(['tasks_tasks','household_sessions','household_agents','clock_wakes','approvals_audit','cookie-key']));
});
it('detects uncompleted migration after both transaction rollback and commit-before-marker interruption, then verifies resumed data',async()=>{
  for(const committed of [false,true]) {
    const f=await fixture(true);const registry=createMigrationRegistry();
    if(committed) expect(()=>runMigrationAll(f.root,f.home,undefined,{now:()=>12345,afterPiece:name=>{if(name==='tasks')throw Error('death');}})).toThrow();
    else {
      const failing=new MigrationRegistry();for(const entry of registry.order().importers)failing.register(entry.name==='tasks'?{...entry,run:()=>{throw Error('death');}}:entry);
      expect(()=>runMigrationAll(f.root,f.home,undefined,{registry:failing,now:()=>12345})).toThrow();
    }
    expect(verifyMigration(f.root,f.home).status).toBe('different');runMigrationAll(f.root,f.home);expect(verifyMigration(f.root,f.home).status).toBe('verified');
  }
});
it('refuses a held daemon lock without changes, rejects uncheckpointed WAL, and never creates a missing home',async()=>{
  const f=await fixture();runMigrationAll(f.root,f.home);const unlock=acquireHttpLock(f.home);
  try {const before=bytes(f.home);expect(()=>verifyMigration(f.root,f.home)).toThrow();expect(bytes(f.home)).toEqual(before);}finally{unlock();}
  const db=new Database(join(f.home,'loom.db'));db.pragma('journal_mode = WAL');db.exec("INSERT INTO household_sessions VALUES ('pending','{}')");
  try {const before=bytes(f.home);expect(()=>verifyMigration(f.root,f.home)).toThrow('checkpointed');expect(bytes(f.home)).toEqual(before);}finally{db.close();}
  expect(()=>verifyMigration(f.root,join(f.dir,'absent'))).toThrow();expect(fs.existsSync(join(f.dir,'absent'))).toBe(false);
});
it('reports unknown registrations as incomplete; CLI has safe exit statuses and exactly one report',async()=>{
  const f=await fixture();f.plan.importers.future={paths:['home'],options:{}};runMigrationAll(f.root,f.home,f.plan);
  const path=join(f.dir,'plan.json');writeFileSync(path,JSON.stringify(f.plan));
  const io={stdout:vi.fn(),stderr:vi.fn(),stdin:Readable.from([]),stdinIsTTY:false,env:{}};
  expect(await run(['verify','--snapshot',f.root,'--home',f.home,'--plan',path],io)).toBe(3);expect(io.stdout).toHaveBeenCalledOnce();expect(JSON.parse(io.stdout.mock.calls[0][0])).toMatchObject({status:'incomplete',missing:['future']});
  const other=await fixture();runMigrationAll(other.root,other.home);io.stdout.mockClear();expect(await run(['verify','--snapshot',other.root,'--home',other.home],io)).toBe(0);expect(io.stdout).toHaveBeenCalledOnce();
  writeFileSync(path,'PRIVATE_CREDENTIAL_CANARY');expect(await run(['verify','--snapshot',f.root,'--home',f.home,'--plan',path],io)).toBe(1);expect(await run(['verify','--PRIVATE_CREDENTIAL_CANARY'],io)).toBe(2);expect(io.stderr.mock.calls.flat().join('')).not.toContain('PRIVATE_CREDENTIAL_CANARY');
});
it('rejects plan/snapshot tampering, aliases and overlaps without modifying either tree',async()=>{
  const f=await fixture();runMigrationAll(f.root,f.home);const before=bytes(f.home);
  const plan=structuredClone(f.plan);plan.importers.future={paths:['home'],options:{}};expect(()=>verifyMigration(f.root,f.home,plan)).toThrow();
  const alias=join(f.dir,'alias');symlinkSync(f.home,alias);expect(()=>verifyMigration(f.root,alias)).toThrow();expect(()=>verifyMigration(f.root,f.root)).toThrow();
  writeFileSync(join(f.root,'home/ui-cookie.key'),Buffer.alloc(32,44));expect(()=>verifyMigration(f.root,f.home)).toThrow();expect(bytes(f.home)).toEqual(before);
});
it('holds the daemon gate throughout source projection and releases it on projection failure',async()=>{
  const f=await fixture(true);runMigrationAll(f.root,f.home);
  const original=taskImporter.readTasksImport;
  vi.spyOn(taskImporter,'readTasksImport').mockImplementation((...args)=>{expect(()=>acquireHttpLock(f.home)).toThrow('already running');return original(...args);});
  expect(verifyMigration(f.root,f.home).status).toBe('verified');
  vi.mocked(taskImporter.readTasksImport).mockImplementation(()=>{throw Error('projection failure');});
  expect(()=>verifyMigration(f.root,f.home)).toThrow('projection failure');const release=acquireHttpLock(f.home);release();
});
it('detects same-count content changes in clock and approvals and extra token records hidden by their envelope',async()=>{
  const f=await fixture(true);runMigrationAll(f.root,f.home,undefined,{now:()=>12345});
  expect(verifyMigration(f.root,f.home).status).toBe('verified');
  const db=new Database(join(f.home,'loom.db'));db.exec("UPDATE clock_wakes SET record=json_set(record,'$.prompt','changed'); UPDATE approvals_approvals SET record=json_set(record,'$.what','changed'); UPDATE household_tokens SET body=json_insert(body,'$[#]',json('{\"hidden\":true}'))");db.close();
  expect(verifyMigration(f.root,f.home).differences.map(d=>d.table)).toEqual(expect.arrayContaining(['clock_wakes','approvals_approvals','household_tokens']));
});
it('verifies explicit audiences and attribution and detects changed indexes independently of record JSON',async()=>{
  const f=await fixture(true,true),id=conversationId('art','session','fixture');
  f.plan.importers.attention.options={[id]:{project:'pond',member:'jonathan'}};
  f.plan.importers.approvals.options={projects:{'a-01234567':'pond'}};
  f.plan.importers.changes.options={attribution:{agents:{art:{logins:['alice'],branches:[]}},ownerLogins:[]}};
  runMigrationAll(f.root,f.home,f.plan,{now:()=>12345});expect(verifyMigration(f.root,f.home,f.plan).status).toBe('verified');
  const db=new Database(join(f.home,'loom.db'));db.exec("UPDATE attention_turns SET seq=99; UPDATE changes_changes SET repo='wrong/repo'; UPDATE clock_wakes SET changed_at=999; UPDATE tasks_tasks SET ord=99");db.close();
  expect(verifyMigration(f.root,f.home,f.plan).differences.map(d=>d.table)).toEqual(expect.arrayContaining(['attention_turns','changes_changes','clock_wakes','tasks_tasks']));
});
it('never opens a WAL-mode daemon gate that could create coordination files',async()=>{
  const f=await fixture();runMigrationAll(f.root,f.home);const path=join(f.home,'http-daemon-lock.db');
  const db=new Database(path);db.pragma('journal_mode = WAL');db.exec('CREATE TABLE fixture(id INTEGER)');db.close();
  const before=bytes(f.home);expect(()=>verifyMigration(f.root,f.home)).toThrow('Unsafe daemon gate');expect(bytes(f.home)).toEqual(before);
});
it('refuses a nonempty rollback journal without opening or changing its data',async()=>{
  const f=await fixture();runMigrationAll(f.root,f.home);
  writeFileSync(join(f.home,'loom.db-journal'),Buffer.from('uncheckpointed fixture'));
  const before=bytes(f.home),source=bytes(f.root);
  expect(()=>verifyMigration(f.root,f.home)).toThrow('checkpointed');expect(bytes(f.home)).toEqual(before);expect(bytes(f.root)).toEqual(source);
});
it('never opens a foundation or writable database or migrates schema, including an absent destination table',async()=>{
  const f=await fixture(true);runMigrationAll(f.root,f.home);
  const db=new Database(join(f.home,'loom.db'));db.exec('DROP TABLE tasks_tasks');db.close();
  const forbidden=()=>{throw Error('forbidden writer');};
  const spies=[vi.spyOn(foundation,'createFoundation').mockImplementation(forbidden),vi.spyOn(database,'openDb').mockImplementation(forbidden),vi.spyOn(core,'migrate').mockImplementation(forbidden),vi.spyOn(database,'migrate').mockImplementation(forbidden),vi.spyOn(householdSchema,'migrateHouseholdTables').mockImplementation(forbidden)];
  const before=bytes(f.home);
  expect(verifyMigration(f.root,f.home)).toMatchObject({status:'different',differences:expect.arrayContaining([{piece:'tasks',table:'tasks_tasks',expected:1,actual:null}])});
  for(const spy of spies)expect(spy).not.toHaveBeenCalled();expect(bytes(f.home)).toEqual(before);
});
it('returns CLI exit 3 for content differences with equal row counts and never echoes changed values',async()=>{
  const f=await fixture(true);runMigrationAll(f.root,f.home);
  const db=new Database(join(f.home,'loom.db'));db.exec("UPDATE tasks_tasks SET record=json_set(record,'$.title','PRIVATE_DIFFERENCE_CANARY')");db.close();
  const io={stdout:vi.fn(),stderr:vi.fn(),stdin:Readable.from([]),stdinIsTTY:false,env:{}};
  expect(await run(['verify','--snapshot',f.root,'--home',f.home],io)).toBe(3);expect(io.stdout).toHaveBeenCalledOnce();
  expect(JSON.parse(io.stdout.mock.calls[0][0])).toMatchObject({status:'different',differences:[{piece:'tasks',table:'tasks_tasks',expected:1,actual:1}]});
  expect(io.stdout.mock.calls.flat().join('')).not.toContain('PRIVATE_DIFFERENCE_CANARY');expect(io.stderr).not.toHaveBeenCalled();
});
it('detects changes solely to approval or rule SQLite row ordering',async()=>{
  const f=await fixture(true);runMigrationAll(f.root,f.home);
  const db=new Database(join(f.home,'loom.db'));
  db.exec("UPDATE approvals_approvals SET rowid=100; UPDATE approvals_rules SET rowid=-rowid; UPDATE approvals_rules SET rowid=4+rowid");db.close();
  expect(verifyMigration(f.root,f.home).differences.map(d=>d.table)).toEqual(expect.arrayContaining(['approvals_approvals','approvals_rules']));
});
it.each(['wal','journal'])('refuses a direct writer creating a nonempty %s during source projection',async kind=>{
  const f=await fixture(true);runMigrationAll(f.root,f.home);
  const original=taskImporter.readTasksImport;let writer:Database.Database|undefined;
  vi.spyOn(taskImporter,'readTasksImport').mockImplementation((...args)=>{
    writer=new Database(join(f.home,'loom.db'));
    writer.pragma(kind==='wal'?'journal_mode = WAL':'journal_mode = DELETE');
    if(kind==='journal')writer.exec('BEGIN IMMEDIATE');
    writer.exec("UPDATE tasks_tasks SET record=json_set(record,'$.title','concurrent difference')");
    return original(...args);
  });
  try {expect(()=>verifyMigration(f.root,f.home)).toThrow('checkpointed');}finally{writer?.close();}
});
it('compares every credential/settings concern on changed same-count content and redacts all values',async()=>{
  const f=await fixture(true);runMigrationAll(f.root,f.home);
  const tables=['settings','sessions','links','challenges','passkeys','push','readers','piece_settings','token_use','tokens'].map(name=>`household_${name}`);
  const db=new Database(join(f.home,'loom.db'));
  for(const table of tables) db.prepare(`UPDATE ${table} SET body=?`).run(JSON.stringify({credential:'PRIVATE_CREDENTIAL_CONTENT_CANARY'}));
  db.prepare('INSERT INTO household_members VALUES (?,?)').run('hidden',JSON.stringify({person:'hidden',private:'PRIVATE_CREDENTIAL_CONTENT_CANARY'}));db.close();
  const before=bytes(f.home),r=verifyMigration(f.root,f.home);
  expect(r.status).toBe('different');expect(r.differences.map(d=>d.table)).toEqual(expect.arrayContaining([...tables,'household_members']));
  for(const table of tables) {const d=r.differences.find(d=>d.table===table)!;expect(d.actual).toBe(d.expected);expect(d.expected).toBeGreaterThan(0);}
  const io={stdout:vi.fn(),stderr:vi.fn(),stdin:Readable.from([]),stdinIsTTY:false,env:{}};
  expect(await run(['verify','--snapshot',f.root,'--home',f.home],io)).toBe(3);
  expect(JSON.stringify(r)+io.stdout.mock.calls.flat().join('')+io.stderr.mock.calls.flat().join('')).not.toContain('PRIVATE_CREDENTIAL_CONTENT_CANARY');expect(bytes(f.home)).toEqual(before);
});
