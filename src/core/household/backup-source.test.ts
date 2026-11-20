import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { encryptRegisteredHouseholdBundle, type RegisteredHouseholdBackupInput } from './backup-source.js';
import { selectRegisteredContinuity } from './backup-selection.js';
import { captureImportedCookieKey } from './backup-files.js';
import { HouseholdDatabase } from './document.js';
import { migrateHouseholdTables } from './schema.js';
import { startLoom } from '../../foundation.js';
import { fixture as fixtureHome, installFixture } from '../../fixture.js';
import { FakeClock } from '../clock.js';
import { registerExportFilter } from '../db/export.js';
const databaseGuard = vi.hoisted(() => ({ check: undefined as undefined | ((path: unknown) => void) }));
vi.mock('better-sqlite3', async original => {
  const actual = await original<typeof import('better-sqlite3')>();
  return { ...actual, default: new Proxy(actual.default, {
    construct(target, args) { databaseGuard.check?.(args[0]); return Reflect.construct(target, args); },
    apply(target, self, args) { databaseGuard.check?.(args[0]); return Reflect.apply(target, self, args); },
  }) };
});
vi.mock('node:fs', async original => ({ ...await original<typeof fs>() }));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { databaseGuard.check = undefined; vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
function home() {
  const home = mkdtempSync(join(tmpdir(), 'loom-sources-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true })); return home;
}
function database() { const db = new Database(':memory:'); cleanups.push(() => db.close()); return db; }
async function fixture() {
  const dir = home(); fixtureHome(dir);
  const app = await startLoom({ home: dir, next: true, clock: new FakeClock(), install: installFixture, stdout: () => {} });
  cleanups.push(() => app.close());
  const agents = ['art', 'mark', 'pond-bot'];
  for (const agent of agents) { mkdirSync(join(dir, 'agents', agent), { recursive: true }); writeFileSync(join(dir, 'agents', agent, 'IDENTITY.md'), `CREED_${agent}`); }
  // Contradictory old data must never select sources.
  writeFileSync(join(dir, 'household.json'), '{"agents":["unregistered"]}');
  const owner = await generateX25519Identity();
  const input: RegisteredHouseholdBackupInput = { home: dir, db: app.db,
    continuity: { agents: agents.map(agent => ({ agent, memories: null, notes: null })), knowledge: null, people: null },
    importedCookieFile: 'absent', recipients: [await identityToRecipient(owner)], drillIdentity: await generateX25519Identity(),
    secrets: { export: vi.fn(async () => Buffer.from('OPAQUE_FIXTURE')), verifyRestore: vi.fn(async () => {}) } };
  return { input, owner };
}
function unpack(bytes: Uint8Array) {
  const plain = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), start = Buffer.from('loom-next-household\0\x01').length + 4;
  const end = start + plain.readUInt32BE(start - 4);
  const manifest = JSON.parse(plain.toString('utf8', start, end)) as { files: {path: string; bytes: number}[]; absent: string[] };
  let offset = end;
  const files = new Map(manifest.files.map(item => { const bytes = plain.subarray(offset, offset + item.bytes); offset += item.bytes; return [item.path, bytes] as const; }));
  return { manifest, files };
}
it.each(['absent', 'present'] as const)('composes registered real next sources with explicit imported key %s and exact active CSRF row', async importedCookieFile => {
  const { input, owner } = await fixture(); input.importedCookieFile = importedCookieFile;
  const key = Buffer.alloc(32, 97); writeFileSync(join(input.home, 'ui-cookie.key'), key);
  const original = input.db.serialize(); const result = await encryptRegisteredHouseholdBundle(input);
  const decrypt = new Decrypter(); decrypt.addIdentity(owner); const plain = await decrypt.decrypt(result.bytes);
  try {
    const { files, manifest } = unpack(plain);
    expect([...files.keys()].filter(p => p.endsWith('IDENTITY.md')).sort()).toEqual(['agents/art/IDENTITY.md', 'agents/mark/IDENTITY.md', 'agents/pond-bot/IDENTITY.md']);
    expect(manifest.absent.includes('ui-cookie.key')).toBe(importedCookieFile === 'absent');
    expect(files.get('ui-cookie.key')).toEqual(importedCookieFile === 'present' ? key : undefined);
    const restored = new Database(files.get('loom.db')!);
    try { expect(restored.prepare("SELECT body FROM household_settings WHERE id='signin-csrf-key'").get()).toEqual(input.db.prepare("SELECT body FROM household_settings WHERE id='signin-csrf-key'").get()); }
    finally { restored.close(); }
  } finally { plain.fill(0); }
  expect(input.db.serialize()).toEqual(original); expect(readFileSync(join(input.home, 'ui-cookie.key'))).toEqual(key);
});
it.each(['missing', 'extra', 'duplicate'] as const)('refuses %s explicit agent selection before Secrets export', async kind => {
  const { input } = await fixture(); const agents = input.continuity.agents;
  input.continuity = { ...input.continuity, agents: kind === 'missing' ? agents.slice(1) : [...agents, kind === 'extra' ? { agent: 'stranger', memories: null, notes: null } : agents[0]] };
  await expect(encryptRegisteredHouseholdBundle(input)).rejects.toThrow(/^Registered household backup capture failed$/);
  expect(input.secrets.export).not.toHaveBeenCalled();
});
it('checks registration in the captured image after async setup and pins caller source selection before awaiting', async () => {
  const { input } = await fixture(); const next = [...input.continuity.agents];
  const running = encryptRegisteredHouseholdBundle(input);
  input.continuity.agents = []; // pinning avoids mutation to caller-owned arrays
  await expect(running).resolves.toHaveProperty('bytes');
  input.continuity.agents = next;
  const changed = encryptRegisteredHouseholdBundle(input);
  new HouseholdDatabase(input.db).change(input.home, raw => { raw.agents = ['art', 'mark', 'pond-bot', 'new-agent']; });
  await expect(changed).rejects.toThrow(/^Registered household backup capture failed$/);
});
it('rejects absent metadata, undefined/closed/transactional handles; deduplicates valid repeated registrations', () => {
  const db = database(); db.exec('CREATE TABLE core_migrations(piece TEXT, number INTEGER, sql TEXT, PRIMARY KEY(piece,number))'); migrateHouseholdTables(db);
  const sources = { agents: [{ agent: 'art', memories: null, notes: null }], knowledge: null, people: null };
  expect(() => selectRegisteredContinuity(db, '/unused', sources)).toThrow();
  db.transaction(() => new HouseholdDatabase(db).replace('/unused', { v: 1, agents: ['art', 'art'], owner: 'Jonathan' }))();
  expect(selectRegisteredContinuity(db, '/unused', sources).agents).toHaveLength(1);
  const borrowed = database(); borrowed.close();
  cleanups.pop(); // already closed
  for (const invalid of [undefined, borrowed]) expect(() => selectRegisteredContinuity(db, '/unused', { ...sources, knowledge: invalid as never })).toThrow();
  const active = database(); active.exec('BEGIN');
  expect(() => selectRegisteredContinuity(db, '/unused', { ...sources, people: active })).toThrow(); active.exec('ROLLBACK');
});
it.each(['missing', 'symlink', 'hardlink', 'directory', 'short', 'long', 'ancestor'] as const)('present cookie refuses %s without fallback', kind => {
  const dir = home(), key = join(dir, 'ui-cookie.key'), bytes = Buffer.alloc(32, 7);
  if (kind === 'directory') mkdirSync(key);
  else if (kind === 'short' || kind === 'long') writeFileSync(key, Buffer.alloc(kind === 'short' ? 31 : 33));
  else if (kind !== 'missing') {
    writeFileSync(join(dir, 'original'), bytes);
    if (kind === 'symlink') symlinkSync('original', key);
    else if (kind === 'hardlink') linkSync(join(dir, 'original'), key);
    else { writeFileSync(key, bytes); symlinkSync(dir, join(dir, 'alias')); }
  }
  expect(() => captureImportedCookieKey(kind === 'ancestor' ? join(dir, 'alias') : dir)).toThrow(/^Portable household file capture failed$/);
});
it('clears captured key after encryption success and late failure, and all allocated key bytes on read/close failure', async () => {
  const { input } = await fixture(); input.importedCookieFile = 'present'; writeFileSync(join(input.home, 'ui-cookie.key'), Buffer.alloc(32, 8));
  const reads: Buffer[] = [], read = fs.readSync;
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, bytes: Buffer, ...args: never[]) => { reads.push(bytes); return (read as Function)(fd, bytes, ...args); }) as typeof fs.readSync);
  await encryptRegisteredHouseholdBundle(input); expect(reads[0].every(b => b === 0)).toBe(true);
  vi.spyOn(Encrypter.prototype, 'encrypt').mockRejectedValueOnce(Error('PRIVATE_DIAGNOSTIC'));
  await expect(encryptRegisteredHouseholdBundle(input)).rejects.toThrow(/^Registered household backup capture failed$/);
  expect(reads.filter(b => b.length === 32).every(b => b.every(v => v === 0))).toBe(true);
  vi.spyOn(fs, 'readSync').mockImplementationOnce(((fd: number, bytes: Buffer) => { reads.push(bytes); bytes.fill(9); throw Error('PRIVATE'); }) as typeof fs.readSync);
  expect(() => captureImportedCookieKey(input.home)).toThrow(); expect(reads.at(-1)!.every(b => b === 0)).toBe(true);
  const close = fs.closeSync;
  vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => { close(fd); throw Error('PRIVATE'); });
  expect(() => captureImportedCookieKey(input.home)).toThrow(); expect(reads.at(-1)!.every(b => b === 0)).toBe(true);
});
it('refuses a missing owning Secrets role before imported key IO', async () => {
  const { input } = await fixture(); input.importedCookieFile = 'present'; input.secrets = undefined as never;
  const open = vi.spyOn(fs, 'openSync');
  await expect(encryptRegisteredHouseholdBundle(input)).rejects.toThrow(/^Registered household backup capture failed$/);
  expect(open).not.toHaveBeenCalled();
});

it('performs no cookie lookup for explicit absence and no old-source reads or pathname database opens', async () => {
  const { input } = await fixture();
  const lookedUp: string[] = [], databasePaths: unknown[] = [];
  const forbidden = /ui-cookie\.key|household\.json|\.db(?:$|-)|\/programs\/|\/pieces\//;
  const guard = (path: unknown) => { const value = String(path); lookedUp.push(value); if (forbidden.test(value)) throw Error('Forbidden source lookup'); };
  // Cover content reads, metadata probes, directory discovery and file opens.
  for (const method of ['readFileSync', 'readFile', 'openSync', 'open', 'statSync', 'lstatSync', 'accessSync', 'existsSync', 'realpathSync', 'readdirSync'] as const) {
    const original = fs[method] as Function;
    vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => { guard(args[0]); return Reflect.apply(original, fs, args); }) as never);
  }
  databaseGuard.check = path => {
    databasePaths.push(path);
    if (path !== ':memory:' && !Buffer.isBuffer(path)) throw Error('No source database opens');
  };
  await expect(encryptRegisteredHouseholdBundle(input)).resolves.toHaveProperty('bytes');
  expect(lookedUp.length).toBeGreaterThan(0);
  expect(lookedUp.filter(path => forbidden.test(path))).toEqual([]);
  expect(databasePaths.length).toBeGreaterThan(0);
  expect(databasePaths.every(path => path === ':memory:' || Buffer.isBuffer(path))).toBe(true);
});

it('refuses registration removed by an owning export filter even while live registration remains valid', async () => {
  const { input } = await fixture();
  expect(new HouseholdDatabase(input.db).household(input.home)?.agents).toContain('pond-bot');
  registerExportFilter(input.db, 'source-filter-fixture', (table, row) => table !== 'household_agents' || row.id !== 'pond-bot');
  await expect(encryptRegisteredHouseholdBundle(input)).rejects.toThrow(/^Registered household backup capture failed$/);
  expect(input.secrets.export).not.toHaveBeenCalled();
  expect(new HouseholdDatabase(input.db).household(input.home)?.agents).toContain('pond-bot');
});

it('publishes the actual registered encrypted/drilled bundle and validates its restored app and Secrets part', async () => {
  const { input, owner } = await fixture(), target = home(); fs.chmodSync(target, 0o700);
  const { publishHouseholdPathBundle } = await import('./backup-path.js');
  const { withHouseholdRestore } = await import('./backup-restore.js');
  const out = await publishHouseholdPathBundle(input.home, target, '20261114-0317', () => encryptRegisteredHouseholdBundle(input));
  const ciphertext = readFileSync(join(target, out.name));
  expect(ciphertext.length).toBe(out.bytes);
  expect(input.secrets.verifyRestore).toHaveBeenCalledOnce();
  await withHouseholdRestore(ciphertext, owner, bundle => {
    expect(bundle.files.get('secrets/recovery.age')).toEqual(Buffer.from('OPAQUE_FIXTURE'));
    for (const agent of ['art', 'mark', 'pond-bot']) expect(bundle.files.get(`agents/${agent}/IDENTITY.md`)?.toString()).toBe(`CREED_${agent}`);
    const app = new Database(bundle.files.get('loom.db')!);
    try { expect(new HouseholdDatabase(app).document()?.agents).toEqual(['art', 'mark', 'pond-bot']); }
    finally { app.close(); }
  });
  expect(readFileSync(join(input.home, 'household.json'), 'utf8')).toBe('{"agents":["unregistered"]}');
});

it('rejoins actual registered encrypted git parts before bounded owner-key validation', async () => {
  const { input, owner } = await fixture();
  const { prepareHouseholdGitPayload, verifyHouseholdGitPayload } = await import('./backup-git-parts.js');
  const { withHouseholdRestore } = await import('./backup-restore.js');
  const encrypted = await encryptRegisteredHouseholdBundle(input);
  const partBytes = Math.ceil(encrypted.bytes.length / 3);
  const payload = prepareHouseholdGitPayload('20261114-0321', encrypted, partBytes);
  expect(payload.parts).toHaveLength(3);
  verifyHouseholdGitPayload(payload, encrypted.bytes);
  const rejoined = Buffer.concat([...payload.parts].sort((a, b) => a.path.localeCompare(b.path)).map(part => part.bytes));
  expect(rejoined).toEqual(encrypted.bytes);
  expect(input.secrets.verifyRestore).toHaveBeenCalledOnce();
  await withHouseholdRestore(rejoined, owner, bundle => {
    expect(bundle.files.get('secrets/recovery.age')).toEqual(Buffer.from('OPAQUE_FIXTURE'));
    for (const agent of ['art', 'mark', 'pond-bot']) expect(bundle.files.get(`agents/${agent}/IDENTITY.md`)?.toString()).toBe(`CREED_${agent}`);
    const app = new Database(bundle.files.get('loom.db')!);
    try { expect(new HouseholdDatabase(app).document()?.agents).toEqual(['art', 'mark', 'pond-bot']); }
    finally { app.close(); }
  });
});
