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
import { stageHouseholdRestore, stageHouseholdRestoreWithRecovery, type HouseholdSecretsRestore } from './backup-destination.js';
import { restorePending } from '../home-state.js';
import { openDb } from '../db/index.js';
import { prepareOperatorHome } from '../signin/operator.js';
import { readContinuityHousehold } from '../../continuity/household.js';

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
function destination() {
  const parent = mkdtempSync(join(tmpdir(), 'loom-restore-output-'));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, home: join(parent, '.loom-restore-home') };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
it.each(['success', 'reject-restore', 'reject-accept'] as const)('stateful isolated owning fake retains stopped recovery: %s', async outcome => {
  const f = await fixture(), out = destination(), holder = join(out.parent, 'isolated-holder');
  const authority = Symbol('explicit fixture authority');
  const expected = f.files.get('secrets/recovery.age')!;
  const enteredClose = gate(), finishClose = gate();
  let active = false, accepted = false, settled = false;
  const construct = (owner: symbol, target: string): HouseholdSecretsRestore => {
    expect(owner).toBe(authority); expect(fs.existsSync(target)).toBe(false);
    return { restore: async bytes => {
      fs.mkdirSync(target, { mode: 0o700 }); active = true;
      if (outcome === 'reject-restore') {
        active = false; // Rejecting restore owns its acquisitions; no session exists.
        fs.rmdirSync(target); throw Error('fixture restore failed');
      }
      const fd = fs.openSync(join(target, 'complete-state'), 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return {
        accept: async () => {
          expect(active).toBe(true);
          expect(fs.readFileSync(join(target, 'complete-state'))).toEqual(expected);
          if (outcome === 'reject-accept') throw Error('fixture acceptance failed');
          accepted = true;
        },
        close: async () => { enteredClose.release(); await finishClose.promise; active = false; },
      };
    } };
  };
  const result = stageHouseholdRestoreWithRecovery(f.ciphertext, f.owner, out.home, construct(authority, holder));
  // Attach rejection handling before yielding, including while failed acceptance cleans up.
  const observed = result.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  if (outcome !== 'reject-restore') {
    await enteredClose.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(active).toBe(true);
    finishClose.release();
  }
  const completion = await observed;
  if (outcome === 'success') expect(completion).toHaveProperty('value.state', 'awaiting-household-acceptance');
  else expect(completion).toHaveProperty('error.message', 'Household owning recovery failed');
  expect(active).toBe(false); expect(accepted).toBe(outcome === 'success');
  if (outcome === 'reject-restore') expect(fs.existsSync(holder)).toBe(false);
  else expect(fs.readFileSync(join(holder, 'complete-state'))).toEqual(expected);
  expect(() => openDb(out.home)).toThrow('Household restore is incomplete');
});
it.each(['present', 'absent'] as const)('joins original owning recovery and keeps exact candidate quarantined, cookie %s', async cookie => {
  const f = await fixture(cookie), out = destination();
  const entered = gate(), acceptance = gate(), closing = gate(), closed = gate();
  let borrowed!: Buffer, settled = false;
  const session = {
    accept: vi.fn(async function () { expect(this).toBe(session); entered.release(); await acceptance.promise; }),
    close: vi.fn(async function () { expect(this).toBe(session); closing.release(); await closed.promise; }),
  };
  const role = { restore: vi.fn(async function (bytes: Buffer) {
    expect(this).toBe(role); borrowed = bytes;
    expect(bytes).toEqual(f.files.get('secrets/recovery.age'));
    expect(fs.readFileSync(join(out.home, restorePending))).toBeTruthy();
    for (const [path, expected] of f.files) expect(fs.readFileSync(join(out.home, path))).toEqual(expected);
    return session;
  }) };
  const result = stageHouseholdRestoreWithRecovery(f.ciphertext, f.owner, out.home, role).finally(() => { settled = true; });
  // Decryption has yielded; later mutation cannot substitute the owning role.
  role.restore = vi.fn(async () => { throw Error('wrong restore'); });
  await entered.promise;
  // The original cleanup was captured before acceptance yielded.
  session.close = vi.fn(async () => { throw Error('wrong close'); });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  acceptance.release(); await closing.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(settled).toBe(false); expect(borrowed.some(byte => byte !== 0)).toBe(true);
  closed.release();
  await expect(result).resolves.toEqual({ home: out.home, state: 'awaiting-household-acceptance' });
  expect(borrowed.every(byte => byte === 0)).toBe(true);
  for (const [path, expected] of f.files) expect(fs.readFileSync(join(out.home, path))).toEqual(expected);
  for (const path of f.absent) expect(fs.existsSync(join(out.home, path))).toBe(false);
  expect(() => openDb(out.home)).toThrow('Household restore is incomplete');
  const renamed = join(out.parent, 'home'); fs.renameSync(out.home, renamed);
  expect(() => openDb(renamed)).toThrow('Household restore is incomplete');
  expect(() => readContinuityHousehold(renamed)).toThrow('Household restore is incomplete');
});
it.each(['restore', 'accept', 'close', 'accept-and-close', 'mutate-restore', 'mutate-accept', 'mutate-close', 'malformed-accept', 'accept-getter'] as const)(
  'owning recovery failure %s is generic, wiped, blocked, and joins original cleanup', async kind => {
    const f = await fixture(), out = destination(); let borrowed!: Buffer;
    const close = vi.fn(async () => {
      if (kind === 'mutate-close') borrowed[0] ^= 1;
      if (kind === 'close' || kind === 'accept-and-close') throw Error('PRIVATE_CLOSE_DETAIL');
    });
    const accept = vi.fn(async () => {
      if (kind === 'mutate-accept') borrowed[0] ^= 1;
      if (kind === 'accept' || kind === 'accept-and-close') throw Error('PRIVATE_ACCEPT_DETAIL');
    });
    const role: HouseholdSecretsRestore = { restore: async bytes => {
      borrowed = bytes;
      if (kind === 'restore') throw Error('PRIVATE_RESTORE_DETAIL');
      if (kind === 'mutate-restore') bytes[0] ^= 1;
      if (kind === 'accept-getter') return { close, get accept(): typeof accept { throw Error('PRIVATE_GETTER_DETAIL'); } };
      return { close, accept: kind === 'malformed-accept' ? undefined as unknown as typeof accept : accept };
    } };
    await expect(stageHouseholdRestoreWithRecovery(f.ciphertext, f.owner, out.home, role)).rejects.toThrow(/^Household owning recovery failed$/);
    expect(close).toHaveBeenCalledTimes(kind === 'restore' ? 0 : 1);
    expect(accept).toHaveBeenCalledTimes(['restore', 'mutate-restore', 'malformed-accept', 'accept-getter'].includes(kind) ? 0 : 1);
    expect(borrowed.every(byte => byte === 0)).toBe(true);
    expect(fs.readFileSync(join(out.home, 'secrets/recovery.age'))).toEqual(f.files.get('secrets/recovery.age'));
    expect(() => openDb(out.home)).toThrow('Household restore is incomplete');
    // No recovery retry adopts a partial/previous candidate.
    const retry = { restore: vi.fn() };
    await expect(stageHouseholdRestoreWithRecovery(f.ciphertext, f.owner, out.home, retry)).rejects.toThrow(/^Household owning recovery failed$/);
    expect(retry.restore).not.toHaveBeenCalled();
  });
it.each([undefined, {}, { accept: async () => {} }])('rejects malformed original session %j and wipes its input', async session => {
  const f = await fixture(), out = destination(); let borrowed!: Buffer;
  const role = { restore: async (bytes: Buffer) => { borrowed = bytes; return session; } } as HouseholdSecretsRestore;
  await expect(stageHouseholdRestoreWithRecovery(f.ciphertext, f.owner, out.home, role)).rejects.toThrow(/^Household owning recovery failed$/);
  expect(borrowed.every(byte => byte === 0)).toBe(true);
  expect(() => openDb(out.home)).toThrow('Household restore is incomplete');
});
it('refuses missing owning role before filesystem IO and failed staging before owning IO', async () => {
  const f = await fixture(), out = destination(), role = { restore: vi.fn() };
  const open = vi.spyOn(fs, 'openSync');
  await expect(stageHouseholdRestoreWithRecovery(f.ciphertext, f.owner, out.home, undefined as unknown as HouseholdSecretsRestore)).rejects.toThrow(/^Household owning recovery failed$/);
  expect(open).not.toHaveBeenCalled();
  await expect(stageHouseholdRestoreWithRecovery(f.ciphertext, 'bad identity', out.home, role)).rejects.toThrow(/^Household owning recovery failed$/);
  expect(open).not.toHaveBeenCalled(); expect(role.restore).not.toHaveBeenCalled();
  await expect(stageHouseholdRestoreWithRecovery(f.ciphertext, f.owner, out.home, role, { documentCount: 1 })).rejects.toThrow(/^Household owning recovery failed$/);
  expect(open).not.toHaveBeenCalled(); expect(role.restore).not.toHaveBeenCalled();
  open.mockRestore();
  fs.mkdirSync(out.home);
  await expect(stageHouseholdRestoreWithRecovery(f.ciphertext, f.owner, out.home, role)).rejects.toThrow(/^Household owning recovery failed$/);
  expect(role.restore).not.toHaveBeenCalled();
});
it.each(['present', 'absent'] as const)('materializes exact private bytes and deliberate absences, cookie %s, retaining the startup fence', async cookie => {
  const f = await fixture(cookie), out = destination();
  const before = Buffer.from(f.ciphertext);
  expect(await stageHouseholdRestore(f.ciphertext, f.owner, out.home)).toEqual({ home: out.home, state: 'awaiting-secrets-restore' });
  expect(f.ciphertext).toEqual(before);
  for (const [path, bytes] of f.files) {
    expect(fs.readFileSync(join(out.home, path))).toEqual(bytes);
    expect(fs.lstatSync(join(out.home, path)).mode & 0o7777).toBe(0o600);
  }
  for (const path of f.absent) expect(fs.existsSync(join(out.home, path))).toBe(false);
  const walk = (path: string): string[] => fs.readdirSync(path).flatMap(leaf => {
    const child = join(path, leaf), st = fs.lstatSync(child);
    if (st.isDirectory()) { expect(st.mode & 0o7777).toBe(0o700); return walk(child); }
    return [child.slice(out.home.length + 1)];
  });
  expect(fs.lstatSync(out.home).mode & 0o7777).toBe(0o700);
  expect(walk(out.home).sort()).toEqual([...f.files.keys(), restorePending].sort());
  // Moving a complete candidate out of the reserved namespace is insufficient:
  // the on-disk blocker independently prevents activation.
  const renamed = join(out.parent, 'home'); fs.renameSync(out.home, renamed);
  out.home = renamed;
  const bytes = fs.readFileSync(join(out.home, 'loom.db')), entries = fs.readdirSync(out.home).sort();
  expect(() => openDb(out.home)).toThrow('Household restore is incomplete');
  expect(() => prepareOperatorHome(out.home)).toThrow('Household restore is incomplete');
  expect(() => readContinuityHousehold(out.home)).toThrow('Household restore is incomplete');
  await expect(startLoom({ home: out.home, next: true, clock: new FakeClock() })).rejects.toThrow('Household restore is incomplete');
  expect(fs.readFileSync(join(out.home, 'loom.db'))).toEqual(bytes);
  expect(fs.readdirSync(out.home).sort()).toEqual(entries);
});
it.each(['directory', 'file', 'symlink', 'parent-symlink', 'public-parent', 'foreign-parent', 'relative', 'dotdot', 'ordinary-name', 'empty-suffix'] as const)('refuses unsafe or existing destination %s without changing it', async kind => {
  const f = await fixture(), out = destination(); let home = out.home;
  if (kind === 'directory') mkdirSync(home);
  if (kind === 'file') writeFileSync(home, 'KEEP');
  if (kind === 'symlink') fs.symlinkSync(f.home, home);
  if (kind === 'parent-symlink') { fs.symlinkSync(f.home, home); home = join(home, '.loom-restore-new-home'); }
  if (kind === 'public-parent') fs.chmodSync(out.parent, 0o755);
  if (kind === 'foreign-parent') {
    const fstat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
      const st = fstat(fd, options);
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) === out.parent) Object.assign(st, { uid: process.getuid!() + 1 });
      return st;
    });
  }
  if (kind === 'relative') home = 'relative';
  if (kind === 'dotdot') home = join(out.parent, 'x') + '/../.loom-restore-new-home';
  if (kind === 'ordinary-name') home = join(out.parent, 'ordinary-home');
  if (kind === 'empty-suffix') home = join(out.parent, '.loom-restore-');
  const entries = fs.readdirSync(out.parent), source = fs.readFileSync(join(f.home, 'loom.db'));
  await expect(stageHouseholdRestore(f.ciphertext, f.owner, home)).rejects.toThrow(/^Household restore staging failed$/);
  expect(fs.readdirSync(out.parent)).toEqual(entries);
  if (kind === 'file') expect(fs.readFileSync(out.home, 'utf8')).toBe('KEEP');
  expect(fs.readFileSync(join(f.home, 'loom.db'))).toEqual(source);
  expect(fs.existsSync(join(f.home, '.loom-restore-new-home'))).toBe(false);
});
it('finishes decryption and validation before ANY destination creation', async () => {
  const f = await fixture(), out = destination();
  const mkdir = vi.spyOn(fs, 'mkdirSync');
  await expect(stageHouseholdRestore(f.ciphertext, await generateX25519Identity(), out.home)).rejects.toThrow('Household restore staging failed');
  await expect(stageHouseholdRestore(f.ciphertext, f.owner, out.home, { documentCount: 1 })).rejects.toThrow('Household restore staging failed');
  expect(mkdir).not.toHaveBeenCalled(); expect(fs.readdirSync(out.parent)).toEqual([]);
});
it('blocks the mkdir-to-marker failure window, including an alias, and releases pinned descriptors', async () => {
  const f = await fixture(), out = destination(), open = fs.openSync, close = fs.closeSync;
  const held = new Set<number>();
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (String(path).endsWith(`/${restorePending}`)) throw Error('No space for marker');
    const fd = open(path, flags, mode); held.add(fd); return fd;
  });
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => { close(fd); held.delete(fd); });
  await expect(stageHouseholdRestore(f.ciphertext, f.owner, out.home)).rejects.toThrow('Household restore staging failed');
  expect(held.size).toBe(0); vi.restoreAllMocks();
  expect(fs.readdirSync(out.home)).toEqual([]);
  const alias = join(out.parent, 'ordinary-home'); fs.symlinkSync(out.home, alias);
  for (const home of [out.home, alias]) {
    expect(() => openDb(home)).toThrow('Household restore is incomplete');
    expect(() => prepareOperatorHome(home)).toThrow('Household restore is incomplete');
    expect(() => readContinuityHousehold(home)).toThrow('Household restore is incomplete');
    await expect(startLoom({ home, next: true, clock: new FakeClock() })).rejects.toThrow('Household restore is incomplete');
  }
  expect(fs.readdirSync(out.home)).toEqual([]);
});
it('refuses a reserved-name alias pointing to an ordinary valid household before stdio or daemon startup', async () => {
  const f = await fixture(), out = destination(); fs.symlinkSync(f.home, out.home);
  const bytes = fs.readFileSync(join(f.home, 'loom.db')), entries = fs.readdirSync(f.home).sort();
  expect(() => readContinuityHousehold(out.home)).toThrow('Household restore is incomplete');
  expect(() => openDb(out.home)).toThrow('Household restore is incomplete');
  expect(() => prepareOperatorHome(out.home)).toThrow('Household restore is incomplete');
  await expect(startLoom({ home: out.home, next: true, clock: new FakeClock() })).rejects.toThrow('Household restore is incomplete');
  expect(fs.readFileSync(join(f.home, 'loom.db'))).toEqual(bytes);
  expect(fs.readdirSync(f.home).sort()).toEqual(entries);
});
it.each(['symlink', 'directory'] as const)('refuses a %s blocker outside the reserved namespace before any startup side effects', async kind => {
  const out = destination(), home = join(out.parent, 'ordinary-home'); mkdirSync(home, { mode: 0o700 });
  if (kind === 'directory') mkdirSync(join(home, restorePending));
  else fs.symlinkSync('missing-target', join(home, restorePending));
  expect(() => openDb(home)).toThrow('Household restore is incomplete');
  expect(() => prepareOperatorHome(home)).toThrow('Household restore is incomplete');
  expect(() => readContinuityHousehold(home)).toThrow('Household restore is incomplete');
  await expect(startLoom({ home, next: true, clock: new FakeClock() })).rejects.toThrow('Household restore is incomplete');
  expect(fs.readdirSync(home)).toEqual([restorePending]);
});
it('continues closing every pinned directory if one directory close fails', async () => {
  const f = await fixture(), out = destination(), open = fs.openSync, close = fs.closeSync;
  const held = new Set<number>(); let failed = false;
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => { const fd = open(path, flags, mode); held.add(fd); return fd; });
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
    const directory = fs.fstatSync(fd).isDirectory(); close(fd); held.delete(fd);
    if (directory && !failed) { failed = true; throw Error('Directory close failed'); }
  });
  await expect(stageHouseholdRestore(f.ciphertext, f.owner, out.home)).rejects.toThrow('Household restore staging failed');
  expect(failed).toBe(true); expect(held.size).toBe(0);
});
it.each(['file', 'symlink'] as const)('refuses an injected %s collision immediately before a payload open', async kind => {
  const f = await fixture(), out = destination(), open = fs.openSync;
  const target = join(out.parent, 'outside'); writeFileSync(target, 'KEEP');
  let collided = false;
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (!collided && String(path).endsWith('/loom.db')) {
      collided = true;
      if (kind === 'file') fs.writeFileSync(path, 'KEEP');
      else fs.symlinkSync(target, path);
    }
    return open(path, flags, mode);
  });
  await expect(stageHouseholdRestore(f.ciphertext, f.owner, out.home)).rejects.toThrow('Household restore staging failed');
  expect(collided).toBe(true);
  expect(fs.readFileSync(join(out.home, 'loom.db'), 'utf8')).toBe('KEEP');
  expect(fs.readFileSync(target, 'utf8')).toBe('KEEP');
});
it.each(['write', 'sync', 'close', 'zero-write'] as const)('leaves a blocked candidate after %s failure and refuses a retry', async kind => {
  const f = await fixture(), out = destination();
  const write = fs.writeSync, sync = fs.fsyncSync, close = fs.closeSync, open = fs.openSync;
  const held = new Set<number>();
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => { const fd = open(path, flags, mode); held.add(fd); return fd; });
  // Failure after the durable blocker and app image: exercise a partial home.
  let writes = 0, fail = true;
  vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, bytes: Uint8Array, offset: number, size: number) => {
    writes++;
    if (writes === 3 && (kind === 'write' || kind === 'zero-write')) {
      if (kind === 'write') throw Error('SENSITIVE_DIAGNOSTIC');
      return 0;
    }
    return write(fd, bytes, offset, size);
  }) as typeof fs.writeSync);
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (kind === 'sync' && writes >= 3 && fail) { fail = false; throw Error('SENSITIVE_DIAGNOSTIC'); } sync(fd); });
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => { close(fd); held.delete(fd); if (kind === 'close' && writes >= 3 && fail) { fail = false; throw Error('SENSITIVE_DIAGNOSTIC'); } });
  await expect(stageHouseholdRestore(f.ciphertext, f.owner, out.home)).rejects.toThrow(/^Household restore staging failed$/);
  expect(held.size).toBe(0);
  vi.restoreAllMocks();
  expect(fs.existsSync(join(out.home, restorePending))).toBe(true);
  expect(() => openDb(out.home)).toThrow('Household restore is incomplete');
  await expect(stageHouseholdRestore(f.ciphertext, f.owner, out.home)).rejects.toThrow('Household restore staging failed');
});
it('handles short writes and syncs the blocker directory before writing any app bytes', async () => {
  const f = await fixture(), out = destination(), write = fs.writeSync;
  const events: string[] = [];
  const sync = fs.fsyncSync, mkdir = fs.mkdirSync, open = fs.openSync, close = fs.closeSync;
  const made: string[] = [], directorySyncs: string[] = [], fileSyncs: string[] = [], held = new Set<number>();
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => { const fd = open(path, flags, mode); held.add(fd); return fd; });
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => { close(fd); held.delete(fd); });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(((path: string, options: fs.MakeDirectoryOptions) => {
    const parent = path.slice(0, path.lastIndexOf('/')), leaf = path.slice(path.lastIndexOf('/') + 1);
    made.push(join(fs.realpathSync(parent), leaf)); return mkdir(path, options);
  }) as typeof fs.mkdirSync);
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    const directory = fs.fstatSync(fd).isDirectory(), path = fs.readlinkSync(`/proc/self/fd/${fd}`);
    events.push(directory ? 'directory-sync' : 'file-sync');
    (directory ? directorySyncs : fileSyncs).push(path); sync(fd);
  });
  vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, bytes: Uint8Array, offset: number, size: number) => {
    events.push(fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('/loom.db') ? 'app-write' : 'other-write');
    return write(fd, bytes, offset, Math.min(size, 101));
  }) as typeof fs.writeSync);
  await stageHouseholdRestore(f.ciphertext, f.owner, out.home);
  expect(held.size).toBe(0);
  expect(events.slice(0, events.indexOf('app-write')).filter(e => e === 'directory-sync')).toHaveLength(2);
  expect(fileSyncs).toEqual([restorePending, ...f.files.keys()].map(path => join(out.home, path)));
  expect(directorySyncs).toEqual([out.home, out.parent, ...made.reverse(), out.parent]);
  expect(fs.readFileSync(join(out.home, 'loom.db'))).toEqual(f.files.get('loom.db'));
});
it('pins ancestors during writes, refuses a renamed ancestor and never writes through its empty replacement', async () => {
  const f = await fixture(), out = destination(), write = fs.writeSync;
  const moved = out.parent + '-moved'; cleanups.push(() => rmSync(moved, { recursive: true, force: true }));
  let changed = false;
  vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, bytes: Uint8Array, offset: number, size: number) => {
    if (!changed && fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('/loom.db')) {
      changed = true; fs.renameSync(out.parent, moved); mkdirSync(out.parent, { mode: 0o700 });
      mkdirSync(out.home, { mode: 0o700 });
    }
    return write(fd, bytes, offset, size);
  }) as typeof fs.writeSync);
  await expect(stageHouseholdRestore(f.ciphertext, f.owner, out.home)).rejects.toThrow('Household restore staging failed');
  expect(changed).toBe(true);
  expect(fs.readdirSync(out.home)).toEqual([]);
  for (const [path, bytes] of f.files) expect(fs.readFileSync(join(moved, '.loom-restore-home', path))).toEqual(bytes);
  expect(() => openDb(join(moved, '.loom-restore-home'))).toThrow('Household restore is incomplete');
});
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
