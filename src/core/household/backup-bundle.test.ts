import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { registerExportFilter } from '../db/export.js';
import { encryptHouseholdBundle, type HouseholdBundleInput } from './backup-bundle.js';

const closers: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) close(); });
const failure = /^Encrypted household bundle or restore drill failed$/;
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'loom-bundle-')); closers.push(() => rmSync(home, { recursive: true, force: true }));
  const db = new Database(':memory:'); closers.push(() => db.close());
  db.exec("CREATE TABLE core_migrations(piece TEXT, number INTEGER, sql TEXT); CREATE TABLE records(id INTEGER PRIMARY KEY, words TEXT, bytes BLOB); CREATE TABLE comms_words(words TEXT); INSERT INTO comms_words VALUES ('PRIVATE_COMMS'); INSERT INTO records VALUES (1,'RETAINED',X'00ff'),(2,'FILTERED',NULL)");
  registerExportFilter(db, 'fixture', (table, row) => table !== 'records' || row.id === 1);
  const notes = new Database(':memory:'); closers.push(() => notes.close());
  notes.exec('CREATE TABLE notes(path TEXT); CREATE TABLE note_files(sha256 TEXT,bytes INTEGER)');
  const attachment = Buffer.from('ATTACHED_NOTE'); const hash = createHash('sha256').update(attachment).digest('hex');
  notes.prepare('INSERT INTO note_files VALUES (?,?)').run(hash, attachment.length);
  mkdirSync(join(home, 'agents', 'art', 'note-files', hash.slice(0, 2)), { recursive: true });
  writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), 'CREED_SENTINEL');
  writeFileSync(join(home, 'agents', 'art', 'note-files', hash.slice(0, 2), hash), attachment);
  writeFileSync(join(home, 'agents', 'art', 'ignored.key'), 'EXCLUDED_KEY');
  const owner = await generateX25519Identity(), drillIdentity = await generateX25519Identity();
  const recovery = Buffer.from('OPAQUE_OWNER_ENCRYPTED_RECOVERY_FIXTURE');
  const verifyRestore = vi.fn(async (bytes: Buffer) => { expect(bytes.equals(Buffer.from('OPAQUE_OWNER_ENCRYPTED_RECOVERY_FIXTURE'))).toBe(true); });
  const input: HouseholdBundleInput = { db, home, continuity: { agents: [{ agent: 'art', memories: null, notes }], knowledge: null, people: null },
    cookieKey: Buffer.alloc(32, 73), secrets: { export: vi.fn(async () => recovery), verifyRestore },
    recipients: [await identityToRecipient(owner)], drillIdentity };
  return { input, owner, recovery, verifyRestore, notes };
}
function unpack(bytes: Buffer) {
  const start = Buffer.from('loom-next-household\0\x01').length + 4;
  const end = start + bytes.readUInt32BE(start - 4);
  const manifest = JSON.parse(bytes.toString('utf8', start, end)) as { files: {path: string; bytes: number; sha256: string}[]; absent: string[] };
  let offset = end;
  const files = new Map(manifest.files.map(item => {
    const part = bytes.subarray(offset, offset + item.bytes); offset += item.bytes;
    expect(createHash('sha256').update(part).digest('hex')).toBe(item.sha256);
    return [item.path, part] as const;
  }));
  expect(offset).toBe(bytes.length); return { manifest, files };
}
it('owner and drill restore the actual encrypted app, notes, exact attachments, creed, key and opaque Secrets part', async () => {
  const f = await fixture(); const original = f.input.db.serialize();
  const result = await encryptHouseholdBundle(f.input);
  expect(result).toMatchObject({ coverage: 'explicit-household-inputs', files: 6, absent: 3,
    drill: { app: true, continuity: true, files: true, cookieKey: true, secrets: true } });
  expect(f.input.db.serialize()).toEqual(original); expect(f.input.cookieKey).toEqual(Buffer.alloc(32, 73));
  expect(f.recovery.every(byte => byte === 0)).toBe(true); expect(f.verifyRestore).toHaveBeenCalledTimes(1);
  for (const word of ['RETAINED', 'CREED_SENTINEL', 'ATTACHED_NOTE', 'OPAQUE_OWNER_ENCRYPTED_RECOVERY_FIXTURE', f.owner, f.input.drillIdentity])
    expect(result.bytes.includes(Buffer.from(word))).toBe(false);
  for (const identity of [f.owner, f.input.drillIdentity]) {
    const decrypt = new Decrypter(); decrypt.addIdentity(identity);
    const plain = await decrypt.decrypt(result.bytes);
    try {
      const { files, manifest } = unpack(Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength));
      expect(manifest.absent).toEqual(['agents/art/memories.db', 'commons/knowledge.db', 'commons/people.db']);
      expect(files.get('ui-cookie.key')).toEqual(f.input.cookieKey);
      expect(files.get('agents/art/IDENTITY.md')?.toString()).toBe('CREED_SENTINEL');
      expect([...files.values()].some(bytes => bytes.includes(Buffer.from('ATTACHED_NOTE')))).toBe(true);
      for (const excluded of ['PRIVATE_COMMS', 'FILTERED', 'EXCLUDED_KEY']) expect(Buffer.from(plain).includes(Buffer.from(excluded))).toBe(false);
      const restored = new Database(files.get('loom.db')!);
      try { expect(restored.prepare('SELECT * FROM records').all()).toEqual([{ id: 1, words: 'RETAINED', bytes: Buffer.from([0, 255]) }]); } finally { restored.close(); }
      const notes = new Database(files.get('agents/art/notes.db')!);
      try { expect(notes.prepare('SELECT * FROM note_files').all()).toEqual(f.notes.prepare('SELECT * FROM note_files').all()); } finally { notes.close(); }
    } finally { plain.fill(0); }
  }
  const wrong = new Decrypter(); wrong.addIdentity(await generateX25519Identity());
  await expect(wrong.decrypt(result.bytes)).rejects.toThrow();
});
it('refuses missing Secrets recovery, invalid cookie key and unsupported/empty/drill-only recipients before export', async () => {
  const f = await fixture();
  for (const recipients of [[], ['BAD_KEY'], ['ssh-ed25519 AAAA'], [await identityToRecipient(f.input.drillIdentity)], Array(101).fill(f.input.recipients[0])])
    await expect(encryptHouseholdBundle({ ...f.input, recipients })).rejects.toThrow(failure);
  await expect(encryptHouseholdBundle({ ...f.input, cookieKey: Buffer.alloc(31) })).rejects.toThrow(failure);
  await expect(encryptHouseholdBundle({ ...f.input, secrets: undefined! })).rejects.toThrow(failure);
  await expect(encryptHouseholdBundle({ ...f.input, drillIdentity: 'PRIVATE_KEY_SENTINEL' })).rejects.toThrow(failure);
  expect(f.input.secrets.export).not.toHaveBeenCalled();
});
it.each(['export', 'verifyRestore'] as const)('refuses a failed Secrets %s without exposing diagnostics or a bundle', async method => {
  const f = await fixture(); f.input.secrets[method] = vi.fn(async () => { throw Error('HOLDER_PRIVATE_DIAGNOSTIC'); }) as never;
  await expect(encryptHouseholdBundle(f.input)).rejects.toThrow(failure);
  if (method === 'verifyRestore') expect(f.recovery.every(byte => byte === 0)).toBe(true);
});
it('wipes plaintext and decrypted buffers on success; verifier gets bytes from the decrypted envelope', async () => {
  const f = await fixture(); let plain: Uint8Array | undefined, opened: Uint8Array | undefined, verified: Buffer | undefined;
  const encrypt = Encrypter.prototype.encrypt, decrypt = Decrypter.prototype.decrypt;
  vi.spyOn(Encrypter.prototype, 'encrypt').mockImplementation(async function(this: Encrypter, bytes) { plain = bytes as Uint8Array; return encrypt.call(this, bytes); });
  vi.spyOn(Decrypter.prototype, 'decrypt').mockImplementation(async function(this: Decrypter, bytes) { opened = await decrypt.call(this, bytes); return opened; });
  f.input.secrets.verifyRestore = vi.fn(async bytes => { verified = bytes; expect(opened).toBeDefined(); expect(bytes).not.toBe(f.recovery); });
  const result = await encryptHouseholdBundle(f.input);
  for (const bytes of [plain, opened, verified, f.recovery]) { expect(bytes?.length).toBeGreaterThan(0); expect(bytes?.every(byte => byte === 0)).toBe(true); }
  expect(result.bytes.some(byte => byte !== 0)).toBe(true);
});
it.each(['encrypt', 'decrypt', 'changed', 'verify-mutates'] as const)('fails closed and clears allocations after %s failure', async mode => {
  const f = await fixture(); let plain: Uint8Array | undefined, opened: Uint8Array | undefined;
  const encrypt = Encrypter.prototype.encrypt, decrypt = Decrypter.prototype.decrypt;
  vi.spyOn(Encrypter.prototype, 'encrypt').mockImplementation(async function(this: Encrypter, bytes) { plain = bytes as Uint8Array; if (mode === 'encrypt') throw Error('PRIVATE'); return encrypt.call(this, bytes); });
  vi.spyOn(Decrypter.prototype, 'decrypt').mockImplementation(async function(this: Decrypter, bytes) {
    if (mode === 'decrypt') throw Error('PRIVATE');
    opened = await decrypt.call(this, bytes); if (mode === 'changed') opened[opened.length - 1] ^= 1; return opened;
  });
  if (mode === 'verify-mutates') f.input.secrets.verifyRestore = async bytes => { bytes[0] ^= 1; };
  await expect(encryptHouseholdBundle(f.input)).rejects.toThrow(failure);
  for (const bytes of [plain, opened, f.recovery].filter(Boolean)) expect(bytes?.every(byte => byte === 0)).toBe(true);
});
it('enforces lower-only app, Secrets and final-envelope budgets', async () => {
  const f = await fixture();
  const budget = { appBytes: 256 * 1024 * 1024, secretsBytes: 256 * 1024 * 1024, bundleBytes: 896 * 1024 * 1024 };
  for (const invalid of [{ ...budget, appBytes: 1 }, { ...budget, secretsBytes: 1 }, { ...budget, bundleBytes: 1 }, { ...budget, appBytes: budget.appBytes + 1 }, { ...budget, secretsBytes: NaN }, { ...budget, bundleBytes: 0 }]) {
    // Each successful export must transfer a fresh owned recovery buffer.
    f.input.secrets.export = async () => Buffer.from('OPAQUE_OWNER_ENCRYPTED_RECOVERY_FIXTURE');
    await expect(encryptHouseholdBundle(f.input, invalid)).rejects.toThrow(failure);
  }
});
