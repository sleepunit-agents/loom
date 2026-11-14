import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
vi.mock('node:fs', async original => ({ ...await original<typeof fs>() }));
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { publishHouseholdPathBundle } from './backup-path.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const stamp = '20261114-0317', name = `loom-household-${stamp}.bundle`;
const error = 'Household backup path publication failed';
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'loom-path-')); roots.push(root);
  const home = join(root, 'home'), target = join(root, 'target');
  fs.mkdirSync(home); fs.mkdirSync(target, { mode: 0o700 });
  const bytes = Buffer.from('age-encryption.org/v1\nfixture encrypted bytes');
  const bundle = { bytes, coverage: 'explicit-household-inputs' as const,
    drill: { app: true, continuity: true, files: true, cookieKey: true, secrets: true } as const, files: 1, absent: 0 };
  const produce = vi.fn(async () => bundle);
  const run = (maxBytes?: number) => publishHouseholdPathBundle(home, target, stamp, produce, maxBytes);
  return { root, home, target, bytes, bundle, produce, run };
}
it('publishes exact native age ciphertext durably and preserves borrowed producer bytes', async () => {
  const f = fixture(), identity = await generateIdentity(), encrypt = new Encrypter();
  encrypt.addRecipient(await identityToRecipient(identity));
  f.bundle.bytes = Buffer.from(await encrypt.encrypt(Buffer.from('restorable fixture')));
  const expected = Buffer.from(f.bundle.bytes);
  const out = await f.run();
  expect(out).toEqual({ name, bytes: expected.length, sha256: createHash('sha256').update(expected).digest('hex') });
  const actual = fs.readFileSync(join(f.target, name));
  expect(actual).toEqual(expected); expect(f.bundle.bytes).toEqual(expected);
  const decrypt = new Decrypter(); decrypt.addIdentity(identity);
  expect(Buffer.from(await decrypt.decrypt(actual)).toString()).toBe('restorable fixture');
  expect(fs.readdirSync(f.target).sort()).toEqual(['.loom-backup', name]);
  expect(fs.statSync(join(f.target, name)).mode & 0o7777).toBe(0o600);
  expect(fs.statSync(join(f.target, '.loom-backup')).mode & 0o7777).toBe(0o600);
});
it('uses an existing marker of arbitrary content and preserves unrelated files and older backups', async () => {
  const f = fixture();
  for (const leaf of ['.loom-backup', 'unrelated', 'loom-household-20260101-0300.bundle']) fs.writeFileSync(join(f.target, leaf), 'KEEP');
  await f.run();
  for (const leaf of ['.loom-backup', 'unrelated', 'loom-household-20260101-0300.bundle']) expect(fs.readFileSync(join(f.target, leaf), 'utf8')).toBe('KEEP');
});
it.each(['missing', 'unmarked', 'marker-directory', 'marker-symlink', 'marker-hardlink', 'writable', 'inside', 'equal', 'target-alias', 'home-alias', 'ancestor-alias', 'collision'] as const)(
  'refuses %s before invoking export', async kind => {
    const f = fixture(); let home = f.home, target = f.target;
    if (kind === 'missing') fs.rmdirSync(target);
    if (kind === 'unmarked') fs.writeFileSync(join(target, 'KEEP'), 'private diagnostic');
    if (kind === 'marker-directory') fs.mkdirSync(join(target, '.loom-backup'));
    if (kind === 'marker-symlink') fs.symlinkSync(join(f.root, 'missing'), join(target, '.loom-backup'));
    if (kind === 'marker-hardlink') { fs.writeFileSync(join(f.root, 'marker'), 'KEEP'); fs.linkSync(join(f.root, 'marker'), join(target, '.loom-backup')); }
    if (kind === 'writable') fs.chmodSync(target, 0o777);
    if (kind === 'inside') { target = join(home, 'backup'); fs.mkdirSync(target); }
    if (kind === 'equal') target = home;
    if (kind === 'target-alias') { target = join(f.root, 'alias'); fs.symlinkSync(f.target, target); }
    if (kind === 'home-alias') { home = join(f.root, 'alias'); fs.symlinkSync(f.home, home); }
    if (kind === 'ancestor-alias') { fs.symlinkSync(f.root, join(f.root, 'alias')); target = join(f.root, 'alias', 'target'); }
    if (kind === 'collision') { fs.writeFileSync(join(target, '.loom-backup'), 'KEEP'); fs.writeFileSync(join(target, name), 'KEEP'); }
    await expect(publishHouseholdPathBundle(home, target, stamp, f.produce)).rejects.toThrow(error);
    expect(f.produce).not.toHaveBeenCalled();
    if (kind === 'collision') expect(fs.readFileSync(join(target, name), 'utf8')).toBe('KEEP');
  });
it.each(['20260229-0300', '../20261114-0317', '20261114-2400', '20261114-0317\n'])('refuses invalid stamp %j before IO/export', async bad => {
  const f = fixture(); const spy = vi.spyOn(fs, 'openSync');
  await expect(publishHouseholdPathBundle(f.home, f.target, bad, f.produce)).rejects.toThrow(error);
  expect(spy).not.toHaveBeenCalled(); expect(f.produce).not.toHaveBeenCalled();
});
it.each(['target-moved', 'home-moved', 'ancestor-moved', 'new-unmarked-file', 'mode-changed', 'marker-removed', 'final-collision'] as const)(
  'rechecks %s after suspended export before any writes', async kind => {
    const f = fixture();
    if (kind === 'marker-removed' || kind === 'final-collision') fs.writeFileSync(join(f.target, '.loom-backup'), 'KEEP');
    let resume!: () => void;
    f.produce.mockImplementation(async () => { await new Promise<void>(resolve => { resume = resolve; }); return f.bundle; });
    const running = f.run(); expect(f.produce).toHaveBeenCalledOnce();
    const write = vi.spyOn(fs, 'writeSync');
    if (kind === 'target-moved') { fs.renameSync(f.target, join(f.root, 'moved')); fs.symlinkSync(f.home, f.target); }
    if (kind === 'home-moved') { fs.renameSync(f.home, join(f.root, 'moved')); fs.mkdirSync(f.home); }
    if (kind === 'ancestor-moved') { const moved = `${f.root}-moved`; fs.renameSync(f.root, moved); roots.push(moved); fs.mkdirSync(f.root); }
    if (kind === 'new-unmarked-file') fs.writeFileSync(join(f.target, 'KEEP'), 'KEEP');
    if (kind === 'mode-changed') fs.chmodSync(f.target, 0o777);
    if (kind === 'marker-removed') { fs.unlinkSync(join(f.target, '.loom-backup')); fs.writeFileSync(join(f.target, 'KEEP'), 'KEEP'); }
    if (kind === 'final-collision') fs.writeFileSync(join(f.target, name), 'KEEP');
    resume(); await expect(running).rejects.toThrow(error);
    expect(write).not.toHaveBeenCalled();
    if (kind === 'final-collision') expect(fs.readFileSync(join(f.target, name), 'utf8')).toBe('KEEP');
  });
it('writes nothing when export or drill rejects and hides private diagnostics', async () => {
  const f = fixture(); f.produce.mockRejectedValue(Error('/private/target/secret'));
  await expect(f.run()).rejects.toThrow(error); expect(fs.readdirSync(f.target)).toEqual([]);
});
it.each(['empty', 'oversize', 'plaintext', 'failed-drill', 'bad-coverage'] as const)('refuses %s producer output without target writes', async kind => {
  const f = fixture();
  if (kind === 'empty') f.bundle.bytes = Buffer.alloc(0);
  if (kind === 'plaintext') f.bundle.bytes = Buffer.from('private plaintext');
  if (kind === 'failed-drill') (f.bundle.drill as { secrets: boolean }).secrets = false;
  if (kind === 'bad-coverage') (f.bundle as { coverage: string }).coverage = 'other';
  await expect(f.run(kind === 'oversize' ? 1 : undefined)).rejects.toThrow(error);
  expect(fs.readdirSync(f.target)).toEqual([]);
});
it('handles short writes and syncs ciphertext before atomic publication and directory before success', async () => {
  const f = fixture(), write = fs.writeSync, sync = fs.fsyncSync, link = fs.linkSync, events: string[] = [];
  vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, bytes: Buffer, offset: number, count: number, position: number) => write(fd, bytes, offset, Math.min(3, count), position)) as typeof fs.writeSync);
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { events.push(fs.fstatSync(fd).isDirectory() ? 'dir' : fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('.pending') ? 'cipher' : 'marker'); sync(fd); });
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => { events.push('publish'); link(from, to); });
  await f.run();
  expect(fs.readFileSync(join(f.target, name))).toEqual(f.bytes);
  expect(events).toEqual(['marker', 'dir', 'cipher', 'publish', 'dir']);
});
it.each(['zero-write', 'file-sync', 'directory-sync', 'corrupt-read', 'link', 'close'] as const)('fails closed on %s and attempts all directory closes', async kind => {
  const f = fixture(), close = fs.closeSync, sync = fs.fsyncSync, read = fs.readSync;
  const opened: number[] = [], closed: number[] = [], open = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => { const fd = open(...args); if (fs.fstatSync(fd).isDirectory()) opened.push(fd); return fd; });
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => { if (opened.includes(fd)) closed.push(fd); close(fd); if (kind === 'close') throw Error('private close'); });
  if (kind === 'zero-write') vi.spyOn(fs, 'writeSync').mockReturnValue(0);
  if (kind === 'file-sync' || kind === 'directory-sync') vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (fs.fstatSync(fd).isDirectory() === (kind === 'directory-sync')) throw Error('private sync'); sync(fd); });
  if (kind === 'corrupt-read') vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number, position: number) => { const n = read(fd, bytes, offset, length, position); if (n) bytes[offset] ^= 1; return n; }) as typeof fs.readSync);
  if (kind === 'link') vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Error('private link'); });
  await expect(f.run()).rejects.toThrow(error);
  expect(new Set(closed)).toEqual(new Set(opened));
  if (kind !== 'directory-sync') expect(fs.existsSync(join(f.target, name))).toBe(false);
});
it('refuses an intervening final-name collision without replacing either file', async () => {
  const f = fixture(), link = fs.linkSync;
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => { fs.writeFileSync(to, 'KEEP'); link(from, to); });
  await expect(f.run()).rejects.toThrow(error);
  expect(fs.readFileSync(join(f.target, name), 'utf8')).toBe('KEEP');
});
it('reports failure after final-directory sync failure while preserving complete ciphertext', async () => {
  const f = fixture(), sync = fs.fsyncSync; let published = false;
  const link = fs.linkSync; vi.spyOn(fs, 'linkSync').mockImplementation((...args) => { link(...args); published = true; });
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (published && fs.fstatSync(fd).isDirectory()) throw Error('private'); sync(fd); });
  await expect(f.run()).rejects.toThrow(error);
  expect(fs.readFileSync(join(f.target, name))).toEqual(f.bytes);
});
it.each([0, -1, NaN, 1.5, 898 * 1024 * 1024])('refuses budget %j before export', async budget => {
  const f = fixture(); await expect(f.run(budget)).rejects.toThrow(error); expect(f.produce).not.toHaveBeenCalled();
});

it.each(['target-before', 'marker-before', 'target-after', 'marker-after'] as const)('refuses foreign ownership at %s', async kind => {
  const f = fixture(), stat = fs.fstatSync;
  fs.writeFileSync(join(f.target, '.loom-backup'), 'KEEP');
  let changed = !kind.endsWith('after');
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: fs.StatOptions) => {
    const st = stat(fd, options as undefined), path = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (changed && path === (kind.startsWith('target') ? f.target : join(f.target, '.loom-backup'))) st.uid += 1;
    return st;
  }) as typeof fs.fstatSync);
  f.produce.mockImplementation(async () => { changed = true; return f.bundle; });
  await expect(f.run()).rejects.toThrow(error);
  if (kind.endsWith('before')) expect(f.produce).not.toHaveBeenCalled();
  else expect(f.produce).toHaveBeenCalledOnce();
  expect(fs.readdirSync(f.target)).toEqual(['.loom-backup']);
  expect(fs.readFileSync(join(f.target, '.loom-backup'), 'utf8')).toBe('KEEP');
});
it.each(['home', 'target'] as const)('rejects malformed existing %s paths before exporting', async side => {
  const f = fixture();
  const path = side === 'home' ? f.home : f.target;
  const altered = [path + '/', path + '/.', path + '/../' + side, path.replace('/' + side, '//' + side), path.slice(1),
    path + '\\suffix', path + '\nsuffix', path + '\0suffix'];
  // Backslash and newline names are legal on Linux, but not accepted by this seam.
  fs.mkdirSync(path + '\\suffix', { mode: 0o700 }); fs.mkdirSync(path + '\nsuffix', { mode: 0o700 });
  for (const bad of altered) {
    await expect(publishHouseholdPathBundle(side === 'home' ? bad : f.home, side === 'target' ? bad : f.target, stamp, f.produce)).rejects.toThrow(error);
    expect(f.produce).not.toHaveBeenCalled(); expect(fs.readdirSync(f.target)).toEqual([]);
  }
});
it('detects corruption of the final published inode and retains it without reporting success', async () => {
  const f = fixture(), link = fs.linkSync;
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    link(from, to); const corrupt = Buffer.from(f.bytes); corrupt[corrupt.length - 1] ^= 1; fs.writeFileSync(to, corrupt);
  });
  await expect(f.run()).rejects.toThrow(error);
  const final = fs.readFileSync(join(f.target, name));
  expect(final.length).toBe(f.bytes.length); expect(final).not.toEqual(f.bytes);
  expect(fs.readdirSync(f.target).sort()).toEqual(['.loom-backup', name]);
});

it.each(['marker', 'pending'] as const)('refuses an injected %s creation collision without overwriting existing bytes', async kind => {
  const f = fixture(), open = fs.openSync;
  let existing: string | undefined;
  const keep = Buffer.alloc(f.bytes.length, 75);
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    const leaf = String(path).split('/').at(-1)!;
    if (!existing && (Number(flags) & fs.constants.O_CREAT) !== 0
      && (kind === 'marker' ? leaf === '.loom-backup' : leaf.endsWith('.pending'))) {
      existing = leaf; fs.writeFileSync(path, keep);
    }
    return open(path, flags, mode);
  });
  await expect(f.run()).rejects.toThrow(error);
  expect(existing).toBeDefined();
  expect(fs.readFileSync(join(f.target, existing!))).toEqual(keep);
  expect(fs.existsSync(join(f.target, name))).toBe(false);
});
