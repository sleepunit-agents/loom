import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { startLoom } from '../../foundation.js';
import { fixture as fixtureHome, installFixture } from '../../fixture.js';
import { FakeClock } from '../clock.js';
import { encryptRegisteredHouseholdBundle } from './backup-source.js';
import { validateHouseholdBundle, withHouseholdRestore } from './backup-restore.js';
import { HouseholdDatabase } from './document.js';

const databaseGuard = vi.hoisted(() => ({ check: undefined as undefined | ((path: unknown) => void) }));
vi.mock('better-sqlite3', async original => {
  const actual = await original<typeof import('better-sqlite3')>();
  return { ...actual, default: new Proxy(actual.default, {
    construct(target, args) { databaseGuard.check?.(args[0]); return Reflect.construct(target, args); },
  }) };
});
vi.mock('node:fs', async original => ({ ...await original<typeof fs>() }));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { databaseGuard.check = undefined; vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
const failure = /^Household restore validation failed$/;
const magic = Buffer.from('loom-next-household\0\x01');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Manifest = { format: string; version: number; files: { path: string; bytes: number; sha256: string }[]; absent: string[] };
function pack(files: Map<string, Buffer>, absent: readonly string[], change?: (m: Manifest) => void) {
  const manifest: Manifest = { format: 'loom-next-household', version: 1,
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })), absent: [...absent] };
  change?.(manifest);
  const header = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  return Buffer.concat([magic, length, header, ...files.values()]);
}
async function fixture(cookie: 'present' | 'absent' = 'absent') {
  const home = mkdtempSync(join(tmpdir(), 'loom-restore-')); cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  fixtureHome(home);
  const app = await startLoom({ home, next: true, clock: new FakeClock(), install: installFixture, stdout: () => {} });
  cleanups.push(() => app.close());
  const agents = ['art', 'mark', 'pond-bot'];
  for (const agent of agents) {
    mkdirSync(join(home, 'agents', agent, 'roles'), { recursive: true });
    writeFileSync(join(home, 'agents', agent, 'IDENTITY.md'), `CREED_${agent}`);
    writeFileSync(join(home, 'agents', agent, 'roles', 'keeper.md'), `ROLE_${agent}`);
  }
  const notes = new Database(':memory:'); cleanups.push(() => notes.close());
  notes.exec('CREATE TABLE notes(path TEXT); CREATE TABLE note_files(sha256 TEXT,bytes INTEGER)');
  const attachment = Buffer.from('ATTACHMENT'), digest = hash(attachment);
  notes.prepare('INSERT INTO note_files VALUES (?,?)').run(digest, attachment.length);
  const attachmentPath = `agents/art/note-files/${digest.slice(0, 2)}/${digest}`;
  mkdirSync(join(home, 'agents/art/note-files', digest.slice(0, 2)), { recursive: true });
  writeFileSync(join(home, attachmentPath), attachment);
  if (cookie === 'present') writeFileSync(join(home, 'ui-cookie.key'), Buffer.alloc(32, 8));
  const owner = await generateX25519Identity();
  const result = await encryptRegisteredHouseholdBundle({ db: app.db, home,
    continuity: { agents: agents.map(agent => ({ agent, memories: null, notes: agent === 'art' ? notes : null })), knowledge: null, people: null },
    importedCookieFile: cookie, recipients: [await identityToRecipient(owner)], drillIdentity: await generateX25519Identity(),
    secrets: { export: async () => Buffer.from('OPAQUE_OWNER_RECOVERY'), verifyRestore: async () => {} } });
  const decrypt = new Decrypter(); decrypt.addIdentity(owner); const opened = await decrypt.decrypt(result.bytes);
  const plain = Buffer.from(opened.buffer, opened.byteOffset, opened.byteLength); cleanups.push(() => { plain.fill(0); });
  return { ...validateHouseholdBundle(plain), plain, ciphertext: result.bytes, owner, app, home, attachmentPath };
}
it.each(['present', 'absent'] as const)('validates a real registered next envelope with cookie %s without destination IO', async cookie => {
  const f = await fixture(cookie), before = Buffer.from(f.plain);
  for (const name of ['openSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'readdirSync', 'statSync', 'lstatSync', 'renameSync', 'rmSync'] as const)
    vi.spyOn(fs, name).mockImplementation(() => { throw Error('No filesystem access'); });
  const opened: unknown[] = [];
  databaseGuard.check = path => { opened.push(path); if (!Buffer.isBuffer(path)) throw Error('No pathname DB opens'); };
  const validated = validateHouseholdBundle(f.plain);
  expect(opened.length).toBeGreaterThan(0);
  expect(opened.every(Buffer.isBuffer)).toBe(true);
  expect(validated.agents).toEqual(['art', 'mark', 'pond-bot']);
  expect(validated.files.get('agents/art/IDENTITY.md')?.toString()).toBe('CREED_art');
  expect(validated.files.get(f.attachmentPath)?.toString()).toBe('ATTACHMENT');
  expect(validated.absent.includes('ui-cookie.key')).toBe(cookie === 'absent');
  expect(f.plain).toEqual(before);
  expect([...validated.files].every(([path, bytes]) => bytes.buffer === f.plain.buffer && bytes.equals(f.files.get(path)!))).toBe(true);
});
it.each(['../escape', '/absolute', 'agents/art/../escape', 'agents/art//IDENTITY.md', 'agents/art/roles/../x.md', 'agents/art/roles/x\\y.md',
  'agents/art/roles/x\0.md', 'agents/stranger/IDENTITY.md', 'agents/art/drill.key', 'backup/armed', 'household.json', 'secrets/holder.key', 'ui-cookie.key/extra'])('rejects path %j even with valid hashes', async path => {
  const f = await fixture(); const files = new Map(f.files); files.set(path, Buffer.from('BAD'));
  expect(() => validateHouseholdBundle(pack(files, f.absent))).toThrow(failure);
});
it.each(['duplicate-file', 'duplicate-absence', 'contradiction', 'unlisted-store', 'missing-creed', 'missing-app', 'missing-recovery', 'empty-recovery', 'bad-cookie', 'extra-absence', 'missing-attachment', 'unreferenced-attachment', 'wrong-shard', 'changed-attachment'] as const)('rejects %s with internally correct envelope hashes', async kind => {
  const f = await fixture(); const files = new Map(f.files), absent = [...f.absent];
  if (kind === 'contradiction') absent.push('loom.db');
  if (kind === 'unlisted-store') absent.splice(absent.indexOf('commons/people.db'), 1);
  if (kind === 'missing-creed') files.delete('agents/mark/IDENTITY.md');
  if (kind === 'missing-app') files.delete('loom.db');
  if (kind === 'missing-recovery') files.delete('secrets/recovery.age');
  if (kind === 'empty-recovery') files.set('secrets/recovery.age', Buffer.alloc(0));
  if (kind === 'bad-cookie') { absent.splice(absent.indexOf('ui-cookie.key'), 1); files.set('ui-cookie.key', Buffer.alloc(31)); }
  if (kind === 'extra-absence') absent.push('backup/drill.key');
  if (kind === 'missing-attachment') files.delete(f.attachmentPath);
  if (kind === 'unreferenced-attachment') files.set(`agents/mark/note-files/${hash(Buffer.from('x')).slice(0,2)}/${hash(Buffer.from('x'))}`, Buffer.from('x'));
  if (kind === 'wrong-shard') { files.set(f.attachmentPath.replace(/note-files\/../, 'note-files/ff'), files.get(f.attachmentPath)!); files.delete(f.attachmentPath); }
  if (kind === 'changed-attachment') files.set(f.attachmentPath, Buffer.from('DIFFERENT!'));
  let bytes = pack(files, absent, m => {
    if (kind === 'duplicate-file') m.files.push(m.files[0]);
    if (kind === 'duplicate-absence') m.absent.push(m.absent[0]);
  });
  if (kind === 'duplicate-file') bytes = Buffer.concat([bytes, files.values().next().value!]);
  expect(() => validateHouseholdBundle(bytes)).toThrow(failure);
});
it.each(['magic', 'version', 'format', 'hash', 'negative', 'fraction', 'too-large', 'truncated', 'trailing', 'header-length', 'extra-field', 'bad-utf8', 'duplicate-json-key'] as const)('rejects malformed %s', async kind => {
  const f = await fixture(); let bytes = pack(new Map(f.files), f.absent, m => {
    if (kind === 'version') m.version++;
    if (kind === 'format') m.format = 'wrong';
    if (kind === 'hash') m.files[0].sha256 = '0'.repeat(64);
    if (kind === 'negative') m.files[0].bytes = -1;
    if (kind === 'fraction') m.files[0].bytes = 1.5;
    if (kind === 'too-large') m.files[0].bytes = 256 * 1024 * 1024 + 1;
    if (kind === 'extra-field') Object.assign(m.files[0], { mode: 'symlink' });
  });
  if (kind === 'magic') bytes[0] ^= 1;
  if (kind === 'truncated') bytes = bytes.subarray(0, -1);
  if (kind === 'trailing') bytes = Buffer.concat([bytes, Buffer.from('x')]);
  if (kind === 'header-length') bytes.writeUInt32BE(0xffffffff, magic.length);
  if (kind === 'bad-utf8') {
    // JSON syntax remains valid under permissive decoding; the malformed byte
    // is inside a string value rather than replacing a structural quote.
    const value = bytes.indexOf(Buffer.from('loom-next-household'), magic.length + 4);
    bytes[value] = 0xff;
  }
  if (kind === 'duplicate-json-key') {
    const end = magic.length + 4 + bytes.readUInt32BE(magic.length);
    const header = Buffer.from('{"version":0,' + bytes.toString('utf8', magic.length + 5, end));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    bytes = Buffer.concat([magic, length, header, bytes.subarray(end)]);
  }
  expect(() => validateHouseholdBundle(bytes)).toThrow(failure);
});
it('checks actual captured registration and SQLite integrity, including rehashed database corruption', async () => {
  const f = await fixture(); const files = new Map(f.files);
  const app = new Database(files.get('loom.db')!);
  try {
    new HouseholdDatabase(app).change(f.home, raw => { raw.agents = ['art', 'mark']; raw.members = [{ person: 'owner', role: 'owner', agents: '*' }]; });
    files.set('loom.db', app.serialize());
  } finally { app.close(); }
  expect(() => validateHouseholdBundle(pack(files, f.absent))).toThrow(failure);
  files.set('loom.db', Buffer.alloc(100));
  expect(() => validateHouseholdBundle(pack(files, f.absent))).toThrow(failure);
  files.set('loom.db', f.files.get('loom.db')!);
  const broken = Buffer.from(f.files.get('agents/art/notes.db')!); broken[100] = 0xff;
  files.set('agents/art/notes.db', broken);
  expect(() => validateHouseholdBundle(pack(files, f.absent))).toThrow(failure);
});
it('enforces lower-only envelope and header budgets before database consumption', async () => {
  const f = await fixture();
  const defaults = { bundleBytes: 896 * 1024 * 1024, headerBytes: 4 * 1024 * 1024 };
  for (const budget of [{ ...defaults, bundleBytes: 1 }, { ...defaults, headerBytes: 1 }, { ...defaults, bundleBytes: defaults.bundleBytes + 1 },
    { ...defaults, headerBytes: NaN }, { ...defaults, bundleBytes: 0 }]) expect(() => validateHouseholdBundle(f.plain, budget)).toThrow(failure);
});
it.each(['success', 'consumer-throws', 'consumer-rejects', 'validation'] as const)('wipes actual decrypted bytes after %s', async mode => {
  const f = await fixture(); let observed: Uint8Array | undefined, borrowed: Buffer | undefined;
  const decrypt = Decrypter.prototype.decrypt;
  vi.spyOn(Decrypter.prototype, 'decrypt').mockImplementation(async function(this: Decrypter, bytes) {
    observed = await decrypt.call(this, bytes); if (mode === 'validation') observed[0] ^= 1; return observed;
  });
  const consume = vi.fn(bundle => {
    borrowed = bundle.files.get('loom.db');
    if (mode === 'consumer-throws') throw Error('PRIVATE_PATH_AND_KEY');
    if (mode === 'consumer-rejects') return Promise.reject(Error('PRIVATE_PATH_AND_KEY'));
    return 'consumed';
  });
  const result = withHouseholdRestore(f.ciphertext, f.owner, consume);
  if (mode === 'success') await expect(result).resolves.toBe('consumed');
  else await expect(result).rejects.toThrow(failure);
  expect(observed?.length).toBeGreaterThan(0); expect(observed?.every(b => b === 0)).toBe(true);
  if (mode === 'validation') expect(consume).not.toHaveBeenCalled();
  else expect(borrowed?.every(b => b === 0)).toBe(true);
  expect(f.plain.some(b => b !== 0)).toBe(true);
});
it('refuses wrong identity, corrupt ciphertext and invalid budget without invoking consumer', async () => {
  const f = await fixture(), consume = vi.fn();
  await expect(withHouseholdRestore(f.ciphertext, await generateX25519Identity(), consume)).rejects.toThrow(failure);
  const corrupt = Buffer.from(f.ciphertext); corrupt[corrupt.length - 1] ^= 1;
  await expect(withHouseholdRestore(corrupt, f.owner, consume)).rejects.toThrow(failure);
  await expect(withHouseholdRestore(f.ciphertext, f.owner, consume, { bundleBytes: 1, headerBytes: 1 })).rejects.toThrow(failure);
  expect(consume).not.toHaveBeenCalled();
});

it.each(['foreign-key', 'missing-notes-schema', 'attachment-size', 'missing-registration', 'app-view'] as const)('rejects rehashed SQLite %s', async kind => {
  const f = await fixture(), files = new Map(f.files);
  const path = kind === 'missing-registration' || kind === 'app-view' ? 'loom.db' : 'agents/art/notes.db';
  const db = new Database(files.get(path)!);
  try {
    if (kind === 'foreign-key') db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(p INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(1)');
    if (kind === 'missing-notes-schema') db.exec('DROP TABLE note_files');
    if (kind === 'attachment-size') db.exec('UPDATE note_files SET bytes=bytes+1');
    if (kind === 'missing-registration') db.exec("DELETE FROM household_settings WHERE id='household-envelope'");
    if (kind === 'app-view') db.exec('CREATE VIEW unsupported AS SELECT 1');
    files.set(path, db.serialize());
  } finally { db.close(); }
  expect(() => validateHouseholdBundle(pack(files, f.absent))).toThrow(failure);
});

it('rejects every otherwise-valid payload at lowered individual and aggregate limits', async () => {
  const f = await fixture();
  const documents = [...f.files].filter(([p]) => p.startsWith('agents/') && !p.endsWith('.db'));
  const sizes = documents.map(([, bytes]) => bytes.length);
  const cases = [
    { databaseImageBytes: f.files.get('loom.db')!.length - 1 },
    { secretsBytes: f.files.get('secrets/recovery.age')!.length - 1 },
    { databaseBytes: f.files.get('agents/art/notes.db')!.length - 1 },
    { documentBytes: sizes.reduce((sum, n) => sum + n, 0) - 1 },
    { fileBytes: Math.max(...sizes) - 1 },
    { documentCount: documents.length - 1 },
    { entryCount: f.files.size - 1 },
  ];
  expect(() => validateHouseholdBundle(f.plain)).not.toThrow();
  for (const budget of cases) expect(() => validateHouseholdBundle(f.plain, budget), JSON.stringify(budget)).toThrow(failure);
  for (const [key, value] of Object.entries({ databaseImageBytes: 256*1024*1024, secretsBytes: 256*1024*1024,
    databaseBytes: 512*1024*1024, documentBytes: 64*1024*1024, fileBytes: 10*1024*1024, documentCount: 4096, entryCount: 16384 }))
    expect(() => validateHouseholdBundle(f.plain, { [key]: value + 1 })).toThrow(failure);
});
it('bounds ciphertext before decryption, even if decryption would produce a valid small envelope', async () => {
  const f = await fixture(), consume = vi.fn();
  const decrypt = vi.spyOn(Decrypter.prototype, 'decrypt').mockResolvedValue(f.plain);
  // A tiny caller ceiling makes a genuinely oversized ciphertext inexpensive.
  await expect(withHouseholdRestore(Buffer.alloc(1024*1024 + 2), f.owner, consume, { bundleBytes: 1 })).rejects.toThrow(failure);
  expect(decrypt).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
});
it('bounds continuity image size independently of app and aggregate ceilings, and absence entry count independently of files', async () => {
  const f = await fixture(), files = new Map(f.files);
  const notes = new Database(files.get('agents/art/notes.db')!);
  try {
    notes.exec('CREATE TABLE padding(value BLOB)');
    notes.prepare('INSERT INTO padding VALUES (zeroblob(?))').run(files.get('loom.db')!.length + 4096);
    files.set('agents/art/notes.db', notes.serialize());
  } finally { notes.close(); }
  const packed = pack(files, f.absent);
  const ceiling = files.get('agents/art/notes.db')!.length - 1;
  expect(ceiling).toBeGreaterThan(files.get('loom.db')!.length);
  expect(() => validateHouseholdBundle(packed)).not.toThrow();
  expect(() => validateHouseholdBundle(packed, { databaseImageBytes: ceiling })).toThrow(failure);
  for (const path of files.keys()) if (path.includes('/roles/')) files.delete(path);
  expect(f.absent.length).toBeGreaterThan(files.size);
  const compact = pack(files, f.absent);
  expect(() => validateHouseholdBundle(compact)).not.toThrow();
  expect(() => validateHouseholdBundle(compact, { entryCount: files.size })).toThrow(failure);
});
