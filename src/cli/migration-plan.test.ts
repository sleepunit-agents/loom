import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { conversationId } from '../pieces/attention/conversations.js';
import { createSnapshot } from './migration-snapshot.js';
import { migrationPlanChecksum, migrationSnapshotChecksum, prepareMigrationPlan } from './migration-plan.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture(full = true) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-plan-')); dirs.push(dir);
  const old = join(dir, 'old'), root = join(dir, 'snapshot'); mkdirSync(old);
  const put = (path: string, value: unknown) => { mkdirSync(join(old, path, '..'), { recursive: true }); writeFileSync(join(old, path), JSON.stringify(value)); };
  put('household.json', { v: 1, agents: ['art','mark'], default: 'art', owner: 'jonathan' });
  const ids = ['art','mark'].map(a => conversationId(a, 'session', 'fixture'));
  if (full) {
    for (const [i, name] of ['art','mark'].entries()) {
      const path = join(old, 'agents', name); mkdirSync(path, { recursive: true });
      const db = new Database(join(path, 'memories.db'));
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE conversations(id TEXT PRIMARY KEY, agent TEXT, venue TEXT, place TEXT, label TEXT, people_json TEXT, agents_json TEXT, started TEXT, last TEXT, last_seq INTEGER);
        CREATE TABLE conversation_turns(conversation TEXT, seq INTEGER, at TEXT, from_json TEXT, kind TEXT, run TEXT, latency_ms INTEGER, model TEXT, harness TEXT, outcome TEXT, writer TEXT);
        CREATE TABLE conversation_days(conversation TEXT, day TEXT, counts_json TEXT, median_latency_ms INTEGER, outcomes_json TEXT);
        CREATE TABLE conversation_digests(id TEXT, conversation TEXT, run TEXT, at TEXT, summary TEXT, asks_json TEXT, decisions_json TEXT, tasks_json TEXT, projects_json TEXT, needs_owner TEXT, needs_owner_href TEXT, needs_owner_json TEXT);
      `);
      db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)').run(ids[i], name, 'session', 'fixture', null, '[]', '[]', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z', 0); db.close();
    }
    put('clock/art/schedules.json', {});
    writeFileSync(join(old,'clock/art/spool.jsonl'), '');
    put('approvals/approvals.json', { v: 1, approvals: {} });
    put('changes/snapshot.json', { v: 1, changes: [] });
    put('changes/settings.json', { poll: true });
  }
  const tasks = join(dir, 'store.db');
  if (full) {
    const db = new Database(tasks);
    db.exec("CREATE TABLE tasks(ord INTEGER, record TEXT); CREATE TABLE links(ord INTEGER, record TEXT); CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES ('seq','2')");
    db.prepare('INSERT INTO tasks VALUES (?,?)').run(1, JSON.stringify({ id: 't-1', type: 'epic', title: 'Build loom', status: 'open', priority: 1, createdAt: '2026-11-12T00:00:00Z', createdBy: 'art', comments: [], project: 'loom' }));
    db.prepare('INSERT INTO tasks VALUES (?,?)').run(2, JSON.stringify({ id: 't-2', type: 'task', title: 'Check migration', status: 'open', priority: 1, createdAt: '2026-11-12T00:00:00Z', createdBy: 'art', comments: [] })); db.close();
  }
  await createSnapshot(old, root, full ? tasks : undefined);
  return { dir, root, old, ids, plan: prepareMigrationPlan(root).plan };
}
function snapshotBytes(root: string): unknown {
  const walk = (path: string): unknown => Object.fromEntries(readdirSync(path).sort().map(name => {
    const target = join(path,name);
    try { return [name, readFileSync(target).toString('base64')]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error; return [name, walk(target)]; }
  }));
  return walk(root);
}
it('derives six explicit inputs and private audiences from old-format fixtures without any snapshot writes', async () => {
  const f = await fixture(), before = snapshotBytes(f.root);
  const { plan, missing, blocked } = prepareMigrationPlan(f.root);
  expect(missing).toEqual([]); expect(blocked).toEqual([]);
  expect(plan.importers).toEqual({
    household: { paths: ['home'], options: {} },
    tasks: { paths: ['tasks/store.db'], options: { projects: { 't-1': 'loom' }, agent: 'art' } },
    attention: { paths: ['home/agents/art/memories.db','home/agents/mark/memories.db'], options: { [f.ids[0]]: {}, [f.ids[1]]: {} } },
    clock: { paths: ['home/clock'], options: {} },
    approvals: { paths: ['home/approvals'], options: { projects: {} } },
    changes: { paths: ['home/changes/snapshot.json'], options: { attribution: { agents: { art: { logins: [], branches: [] }, mark: { logins: [], branches: [] } }, ownerLogins: [] } } },
  });
  expect(prepareMigrationPlan(f.root, JSON.parse(JSON.stringify(plan))).plan).toEqual(plan);
  expect(snapshotBytes(f.root)).toEqual(before); // Includes filenames: no WAL/SHM created by discovery.
  expect(readdirSync(f.dir).sort()).toEqual(['old','snapshot','store.db']);
});
it('supports a household-only snapshot and reports an unregistered piece without pretending it was imported', async () => {
  const f = await fixture(false);
  expect(Object.keys(f.plan.importers)).toEqual(['household']);
  f.plan.importers.comms = { paths: ['home/household.json'], options: { retained: { nested: [true, null, 42] } } };
  f.plan.importers.constructor = { paths: ['home'], options: {} };
  const prepared = prepareMigrationPlan(f.root, f.plan);
  expect(prepared).toMatchObject({ missing: ['comms','constructor'], blocked: [] });
  expect(prepared.plan.importers.comms).toEqual(f.plan.importers.comms);
  expect(prepared.plan.importers.constructor).toEqual(f.plan.importers.constructor);
});
it('binds a plan to full snapshot contents and hashes every plan option with object order ignored', async () => {
  const f = await fixture(), original = migrationPlanChecksum(f.plan);
  const copy = structuredClone(f.plan);
  copy.importers.changes.options = { attribution: { agents: {}, ownerLogins: ['owner'] } };
  expect(migrationPlanChecksum(copy)).not.toBe(original);
  expect(prepareMigrationPlan(f.root, copy).plan.importers.changes.options).toEqual(copy.importers.changes.options);
  expect(migrationPlanChecksum({ ...f.plan, importers: Object.fromEntries(Object.entries(f.plan.importers).reverse()) })).toBe(original);
  const manifest = JSON.parse(readFileSync(join(f.root, 'manifest.json'), 'utf8'));
  expect(migrationSnapshotChecksum({ ...manifest, files: [...manifest.files].reverse() })).toBe(f.plan.snapshot);
  f.plan.snapshot = '0'.repeat(64);
  expect(() => prepareMigrationPlan(f.root, f.plan)).toThrow('different snapshot');
});
it.each(['omit','extra-option','callback','bad-agent','missing-audience','unknown-member','partial-attention','duplicate-path','escape','absolute','unknown-epic','conflicting-project','bad-attribution','injected-projects','approval-extra','approval-value','redirect-tasks'])('refuses malformed or incomplete plans before execution: %s', async kind => {
  const f = await fixture(), p = f.plan;
  if (kind === 'omit') delete p.importers.household;
  if (kind === 'extra-option') p.importers.household.options = { ignored: true };
  if (kind === 'callback') p.importers.clock.options = { interrupt: () => {} } as never;
  if (kind === 'bad-agent') p.importers.tasks.options = { projects: {}, agent: 'stranger' };
  if (kind === 'missing-audience') p.importers.attention.options = {};
  if (kind === 'unknown-member') p.importers.attention.options = { [f.ids[0]]: { member: 'stranger' }, [f.ids[1]]: {} };
  if (kind === 'partial-attention') p.importers.attention.paths.pop();
  if (kind === 'duplicate-path') p.importers.attention.paths.push(p.importers.attention.paths[0]);
  if (kind === 'escape') p.importers.household.paths = ['../old'];
  if (kind === 'absolute') p.importers.household.paths = [f.old];
  if (kind === 'unknown-epic') p.importers.tasks.options = { projects: { 't-2': 'loom' } };
  if (kind === 'conflicting-project') p.importers.tasks.options = { projects: { 't-1': 'other' } };
  if (kind === 'bad-attribution') p.importers.changes.options = { attribution: { agents: {}, ownerLogins: [], taskOwner: 'stranger' } };
  if (kind === 'injected-projects') p.importers.changes.options = { attribution: { agents: {}, ownerLogins: [] }, projects: [] };
  if (kind === 'redirect-tasks') p.importers.tasks.paths = ['home/agents/art/memories.db'];
  if (kind === 'approval-extra') p.importers.approvals.options = { projects: {}, interrupt: 'forbidden' };
  if (kind === 'approval-value') p.importers.approvals.options = { projects: { 'a-12345678': 'INVALID' } };
  expect(() => prepareMigrationPlan(f.root, p)).toThrow();
});
it.each(['extra-file','sidecar','symlink','tamper','bad-manifest','kind'])('refuses snapshot material outside the verified inventory: %s', async kind => {
  const f = await fixture();
  if (kind === 'extra-file') writeFileSync(join(f.root,'home/unlisted'), 'extra');
  if (kind === 'sidecar') writeFileSync(join(f.root,'home/agents/art/memories.db-wal'), 'unlisted WAL');
  if (kind === 'symlink') symlinkSync(f.old, join(f.root,'home/alias'));
  if (kind === 'tamper') writeFileSync(join(f.root,'home/household.json'), '{}');
  if (kind === 'kind') {
    const manifest = JSON.parse(readFileSync(join(f.root,'manifest.json'), 'utf8'));
    manifest.files.find((r: {path:string}) => r.path === 'home/agents/art/memories.db').kind = 'file';
    writeFileSync(join(f.root,'manifest.json'), JSON.stringify(manifest));
  }
  if (kind === 'bad-manifest') {
    const manifest = JSON.parse(readFileSync(join(f.root,'manifest.json'), 'utf8')); manifest.consistency = 'unknown';
    writeFileSync(join(f.root,'manifest.json'), JSON.stringify(manifest));
  }
  expect(() => prepareMigrationPlan(f.root)).toThrow();
});
it('refuses duplicate conversations and partial attention schemas rather than dropping their data', async () => {
  const f = await fixture();
  const update = (edit: (db: Database.Database) => void) => {
    const db = new Database(join(f.root,'home/agents/mark/memories.db')); edit(db); db.close();
    const manifest = JSON.parse(readFileSync(join(f.root,'manifest.json'),'utf8'));
    const file = manifest.files.find((r: {path:string}) => r.path === 'home/agents/mark/memories.db');
    const bytes = readFileSync(join(f.root,file.path)); file.bytes = bytes.length; file.sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(f.root,'manifest.json'), JSON.stringify(manifest));
  };
  update(db => db.prepare('UPDATE conversations SET id=?').run(f.ids[0]));
  expect(() => prepareMigrationPlan(f.root)).toThrow('Duplicate conversation');
  update(db => db.exec('DROP TABLE conversation_days'));
  expect(() => prepareMigrationPlan(f.root)).toThrow('Incomplete attention');
});
it.each(['approvals','clock','changes'])('refuses ambiguous %s sources and permits an explicit non-first choice', async name => {
  const f = await fixture();
  const relative = name === 'clock' ? 'home/zzz/art/schedules.json' : name === 'changes' ? 'home/zzz/changes/snapshot.json' : 'home/zzz/approvals.json';
  mkdirSync(join(f.root, relative, '..'), { recursive: true });
  const bytes = Buffer.from(name === 'clock' ? '{}' : name === 'changes' ? '{"v":1,"changes":[]}' : '{"v":1,"approvals":{}}');
  writeFileSync(join(f.root, relative), bytes);
  const manifest = JSON.parse(readFileSync(join(f.root,'manifest.json'), 'utf8'));
  manifest.files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'file' });
  writeFileSync(join(f.root,'manifest.json'), JSON.stringify(manifest));
  expect(() => prepareMigrationPlan(f.root)).toThrow(`Multiple ${name} inputs`);
  expect(() => prepareMigrationPlan(f.root, JSON.parse('null'))).toThrow();
  f.plan.snapshot = migrationSnapshotChecksum(manifest);
  const choice = name === 'changes' ? relative : 'home/zzz';
  f.plan.importers[name].paths = [choice];
  expect(prepareMigrationPlan(f.root, f.plan).plan.importers[name].paths).toEqual([choice]);
});

it('rejects a manifest-listed live socket before the hash reader tries to consume it', async () => {
  const f = await fixture(false), path = join(f.root, 'home/live');
  const server = createServer();
  server.listen(path); await once(server, 'listening');
  try {
    const manifest = JSON.parse(readFileSync(join(f.root,'manifest.json'), 'utf8'));
    manifest.files.push({ path: 'home/live', bytes: 0, sha256: createHash('sha256').update('').digest('hex'), kind: 'file' });
    writeFileSync(join(f.root,'manifest.json'), JSON.stringify(manifest));
    expect(() => prepareMigrationPlan(f.root)).toThrow('Snapshot contains a special file');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
it.each(['conversations','conversation_turns','conversation_days','conversation_digests'])('refuses an attention database missing %s', async table => {
  const f = await fixture();
  const db = new Database(join(f.root,'home/agents/art/memories.db')); db.exec(`DROP TABLE ${table}`); db.close();
  const manifest = JSON.parse(readFileSync(join(f.root,'manifest.json'), 'utf8'));
  const file = manifest.files.find((r: {path:string}) => r.path === 'home/agents/art/memories.db');
  const bytes = readFileSync(join(f.root, file.path)); file.bytes = bytes.length; file.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(f.root,'manifest.json'), JSON.stringify(manifest));
  expect(() => prepareMigrationPlan(f.root)).toThrow('Incomplete attention');
});

it('rejects canonical manifest aliases, and changed valid content changes snapshot identity', async () => {
  const f = await fixture(false);
  const manifest = JSON.parse(readFileSync(join(f.root,'manifest.json'), 'utf8'));
  manifest.files[0].path = 'home/./household.json';
  writeFileSync(join(f.root,'manifest.json'), JSON.stringify(manifest));
  expect(() => prepareMigrationPlan(f.root)).toThrow('Noncanonical snapshot path');
  manifest.files[0].path = 'home/household.json';
  const bytes = Buffer.from(JSON.stringify({ v: 1, agents: ['art','mark'], default: 'mark', owner: 'jonathan' }));
  writeFileSync(join(f.root,'home/household.json'), bytes);
  manifest.files[0].bytes = bytes.length; manifest.files[0].sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(f.root,'manifest.json'), JSON.stringify(manifest));
  expect(migrationSnapshotChecksum(manifest)).not.toBe(f.plan.snapshot);
  expect(() => prepareMigrationPlan(f.root, f.plan)).toThrow('different snapshot');
});
it('hashes the complete canonical manifest against an independent expected digest', () => {
  const sha256 = 'a'.repeat(64);
  const expected = createHash('sha256').update('{"consistency":"per-database","files":[{"bytes":3,"kind":"file","path":"home/data","sha256":"' + sha256 + '"}],"version":1}').digest('hex');
  expect(migrationSnapshotChecksum({ version: 1, consistency: 'per-database', files: [{ path: 'home/data', bytes: 3, kind: 'file', sha256 }] })).toBe(expected);
});
it('excludes a memories database with no conversation tables', async () => {
  const f = await fixture();
  const relative = 'home/knowledge/memories.db'; mkdirSync(join(f.root, relative, '..'), { recursive: true });
  const db = new Database(join(f.root, relative)); db.exec('CREATE TABLE memories(id TEXT, body TEXT)'); db.close();
  const bytes = readFileSync(join(f.root, relative)), manifest = JSON.parse(readFileSync(join(f.root,'manifest.json'), 'utf8'));
  manifest.files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'sqlite' });
  writeFileSync(join(f.root,'manifest.json'), JSON.stringify(manifest));
  expect(prepareMigrationPlan(f.root).plan.importers.attention.paths).toEqual(f.plan.importers.attention.paths);
});
it.each(['conversations','conversation_turns','conversation_days','conversation_digests','conversation_needs_answers','findings'])('rejects missing required columns in %s', async table => {
  const f = await fixture();
  const db = new Database(join(f.root,'home/agents/art/memories.db'));
  db.exec(`DROP TABLE IF EXISTS ${table}; CREATE TABLE ${table}(id TEXT)`); db.close();
  const manifest = JSON.parse(readFileSync(join(f.root,'manifest.json'), 'utf8'));
  const file = manifest.files.find((r: {path:string}) => r.path === 'home/agents/art/memories.db');
  const bytes = readFileSync(join(f.root, file.path)); file.bytes = bytes.length; file.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(f.root,'manifest.json'), JSON.stringify(manifest));
  expect(() => prepareMigrationPlan(f.root)).toThrow('Incomplete attention source columns');
});
