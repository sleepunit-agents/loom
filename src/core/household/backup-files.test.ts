import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
vi.mock('node:fs', async original => ({ ...await original<typeof fs>() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>() }));
vi.mock('better-sqlite3', () => ({ default: vi.fn(() => { throw Error('No database may open during file capture'); }) }));
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { capturePortableFiles } from './backup-files.js';

const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'portable-backup-')); homes.push(home);
  const agent = join(home, 'agents', 'art'); fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(join(agent, 'IDENTITY.md'), 'CREED');
  return { home, agent };
}
function put(root: string, path: string, bytes: string | Buffer) {
  const target = join(root, path); fs.mkdirSync(join(target, '..'), { recursive: true }); fs.writeFileSync(target, bytes);
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const failure = /^Portable household file capture failed$/;
it('captures the explicit portable allowlist and referenced attachments, leaving unrelated files untouched', () => {
  const { home, agent } = fixture();
  const attachment = Buffer.from([0, 255, 128, 1]), hash = sha(attachment);
  put(agent, 'preferences.md', 'PREFERENCES'); put(agent, 'self-model.md', 'SELF');
  put(agent, 'roles/Code.md', 'ROLE'); put(agent, 'projects/loom.md', 'PROJECT');
  put(agent, `note-files/${hash.slice(0, 2)}/${hash}`, attachment);
  for (const path of ['memories.db','notes.db','comms.db','audit.key','backup/drill.key','telemetry/recall.jsonl','roles/private.key','projects/nested/secret.md','memories/INDEX.md','unknown.md']) put(agent, path, 'EXCLUDED');
  put(agent, `note-files/ff/${'f'.repeat(64)}`, 'UNREFERENCED');
  put(home, 'household.json', 'OLD'); put(home, 'ui-cookie.key', 'KEY'); put(home, 'backup/drill.key', 'DRILL');
  fs.symlinkSync(join(home, 'backup'), join(agent, 'ignored-symlink'));
  const captures = capturePortableFiles(home, [{ agent: 'art', noteHashes: [hash, hash] }]);
  expect(captures.map(f => f.path)).toEqual(['agents/art/IDENTITY.md','agents/art/preferences.md','agents/art/self-model.md','agents/art/roles/Code.md','agents/art/projects/loom.md',`agents/art/note-files/${hash.slice(0, 2)}/${hash}`]);
  expect(captures.map(f => f.bytes)).toEqual(['CREED','PREFERENCES','SELF','ROLE','PROJECT',attachment].map(v => Buffer.from(v)));
  for (const file of captures) { expect(Object.keys(file).sort()).toEqual(['bytes','path','sha256']); expect(file.sha256).toBe(sha(file.bytes)); }
  expect(fs.readFileSync(join(agent, 'IDENTITY.md'), 'utf8')).toBe('CREED');
  for (const file of captures) file.bytes.fill(0);
});
it('preserves deliberate optional absence and orders selected agents deterministically', () => {
  const { home } = fixture(); put(home, 'agents/pollock/IDENTITY.md', 'POLLOCK');
  const files = capturePortableFiles(home, [{ agent: 'pollock', noteHashes: [] }, { agent: 'art', noteHashes: [] }]);
  expect(files.map(f => f.path)).toEqual(['agents/art/IDENTITY.md','agents/pollock/IDENTITY.md']);
});
it.each(['../art','art/../../backup','ART','', 'a\\b'])('refuses invalid agent selection %s before opening files', agent => {
  const { home } = fixture(); const open = vi.spyOn(fs, 'openSync');
  expect(() => capturePortableFiles(home, [{ agent, noteHashes: [] }])).toThrow(failure); expect(open).not.toHaveBeenCalled();
});
it('refuses duplicate agents, traversal hashes, missing creeds and missing/hash-mismatched attachments', () => {
  const { home, agent } = fixture(); const item = { agent: 'art', noteHashes: [] };
  expect(() => capturePortableFiles(home, [item,item])).toThrow(failure);
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: ['../drill.key'] }])).toThrow(failure);
  const hash = sha('expected');
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [hash] }])).toThrow(failure);
  put(agent, `note-files/${hash.slice(0, 2)}/${hash}`, 'wrong');
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [hash] }])).toThrow(failure);
  fs.unlinkSync(join(agent, 'IDENTITY.md'));
  expect(() => capturePortableFiles(home, [item])).toThrow(failure);
});
it.each(['home','agents','agent','roles','file','attachment'])('refuses a symlink at %s without reading its target', kind => {
  const { home, agent } = fixture(), outside = fixture();
  const secret = join(outside.agent, 'IDENTITY.md');
  const hash = sha('CREED'); let selectedHome = home;
  let hashes: string[] = [];
  if (kind === 'home') { selectedHome = join(home, 'alias'); fs.symlinkSync(outside.home, selectedHome); }
  if (kind === 'agents') { fs.renameSync(join(home, 'agents'), join(home, 'original')); fs.symlinkSync(join(outside.home, 'agents'), join(home, 'agents')); }
  if (kind === 'agent') { fs.renameSync(agent, join(home, 'original')); fs.symlinkSync(outside.agent, agent); }
  if (kind === 'roles') fs.symlinkSync(outside.agent, join(agent, 'roles'));
  if (kind === 'file') fs.symlinkSync(secret, join(agent, 'preferences.md'));
  if (kind === 'attachment') { hashes = [hash]; fs.mkdirSync(join(agent, 'note-files', hash.slice(0, 2)), { recursive: true }); fs.symlinkSync(secret, join(agent, 'note-files', hash.slice(0, 2), hash)); }
  const actualRead = fs.readSync, paths: string[] = [];
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => { paths.push(fs.realpathSync(`/proc/self/fd/${args[0]}`)); return Reflect.apply(actualRead, fs, args); });
  expect(() => capturePortableFiles(selectedHome, [{ agent: 'art', noteHashes: hashes }])).toThrow(failure);
  expect(paths.every(path => !path.startsWith(outside.home))).toBe(true);
});
it('refuses hard links and oversized files before reading them', () => {
  const { home, agent } = fixture();
  fs.linkSync(join(agent, 'IDENTITY.md'), join(agent, 'preferences.md'));
  const read = vi.spyOn(fs, 'readSync');
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }])).toThrow(failure); expect(read).not.toHaveBeenCalled();
  fs.unlinkSync(join(agent, 'preferences.md')); fs.truncateSync(join(agent, 'IDENTITY.md'), 10 * 1024 * 1024 + 1);
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }])).toThrow(failure); expect(read).not.toHaveBeenCalled();
});
it('keeps an ancestor pinned when its pathname is replaced by an outside symlink mid-capture', () => {
  const { home, agent } = fixture(), outside = fixture(); put(outside.agent, 'preferences.md', 'OUTSIDE'); put(agent, 'preferences.md', 'INSIDE');
  const read = fs.readSync; let moved = false;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    if (!moved) { moved = true; fs.renameSync(agent, join(home, 'pinned')); fs.symlinkSync(outside.agent, agent); }
    return Reflect.apply(read, fs, args);
  });
  const files = capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }]);
  expect(files.map(f => f.bytes.toString())).toEqual(['CREED','INSIDE']);
});
it('clears all allocated plaintext and closes descriptors on a later read failure', () => {
  const { home, agent } = fixture(); put(agent, 'preferences.md', 'PREFERENCES');
  const allocated: Buffer[] = [], alloc = Buffer.alloc, open = fs.openSync, descriptors: number[] = [];
  vi.spyOn(Buffer, 'alloc').mockImplementation((...args: Parameters<typeof Buffer.alloc>) => { const bytes = Reflect.apply(alloc, Buffer, args); allocated.push(bytes); return bytes; });
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => { const fd = Reflect.apply(open, fs, args); descriptors.push(fd); return fd; });
  const read = fs.readSync; let calls = 0;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => { if (++calls === 2) throw Error('PRIVATE DIAGNOSTIC'); return Reflect.apply(read, fs, args); });
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }])).toThrow(failure);
  expect(allocated.length).toBe(2); expect(allocated.every(b => b.every(byte => byte === 0))).toBe(true);
  for (const fd of new Set(descriptors)) expect(() => fs.fstatSync(fd)).toThrow();
});
it.each(['change','truncate'])('refuses a file that undergoes %s during its read and wipes the allocation', kind => {
  const { home, agent } = fixture(); let captured: Buffer | undefined;
  const read = fs.readSync;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    captured = args[1] as Buffer;
    if (kind === 'truncate') { fs.truncateSync(join(agent, 'IDENTITY.md'), 0); return 0; }
    const count = Reflect.apply(read, fs, args);
    fs.writeFileSync(join(agent, 'IDENTITY.md'), 'CHANGED AND LONGER'); return count;
  });
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }])).toThrow(failure);
  expect(captured?.length).toBeGreaterThan(0); expect(captured?.every(b => b === 0)).toBe(true);
});
it('bounds aggregate bytes and wipes earlier successful captures when the limit is exceeded', () => {
  const { home, agent } = fixture(); const size = 10 * 1024 * 1024;
  for (let i = 0; i < 7; i++) { put(agent, `roles/r${i}.md`, ''); fs.truncateSync(join(agent, `roles/r${i}.md`), size); }
  const buffers: Buffer[] = [], read = fs.readSync;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => { buffers.push(args[1] as Buffer); return Reflect.apply(read, fs, args); });
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }])).toThrow(failure);
  expect(buffers).toHaveLength(7); expect(buffers.every(b => b.every(byte => byte === 0))).toBe(true);
});
it('refuses unsupported platforms and unsafe home components before any file opens', () => {
  const { home } = fixture(), open = vi.spyOn(fs, 'openSync');
  for (const path of ['relative',`${home}/../alias`,`${home}/./alias`,`${home}\\alias`,`${home}\0private`])
    expect(() => capturePortableFiles(path, [])).toThrow(failure);
  vi.stubGlobal('process', { platform: 'darwin' });
  expect(() => capturePortableFiles(home, [])).toThrow(failure); expect(open).not.toHaveBeenCalled();
});
it('attempts every remaining directory close, fails generically and wipes captured plaintext if closing fails', () => {
  const { home } = fixture(); const close = fs.closeSync, read = fs.readSync, captured: Buffer[] = [], closed: number[] = [];
  let injected = false;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => { captured.push(args[1] as Buffer); return Reflect.apply(read, fs, args); });
  vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
    const directory = fs.fstatSync(fd).isDirectory(); close(fd); closed.push(fd);
    if (directory && !injected) { injected = true; throw Error('PRIVATE CLOSE DIAGNOSTIC'); }
  });
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }])).toThrow(failure);
  expect(injected).toBe(true); expect(closed.length).toBeGreaterThan(4);
  expect(captured).toHaveLength(1); expect(captured[0].every(byte => byte === 0)).toBe(true);
  for (const fd of closed) expect(() => fs.fstatSync(fd)).toThrow();
});
it('refuses a nonregular source before reading it', () => {
  const { home, agent } = fixture(); fs.unlinkSync(join(agent, 'IDENTITY.md')); fs.mkdirSync(join(agent, 'IDENTITY.md'));
  const read = vi.spyOn(fs, 'readSync');
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }])).toThrow(failure); expect(read).not.toHaveBeenCalled();
});
it('bounds file count even when aggregate bytes are small', () => {
  const { home, agent } = fixture();
  for (let i = 0; i < 4096; i++) put(agent, `roles/r${i}.md`, '');
  const alloc = Buffer.alloc, allocated: Buffer[] = [];
  vi.spyOn(Buffer, 'alloc').mockImplementation((...args: Parameters<typeof Buffer.alloc>) => { const bytes = Reflect.apply(alloc, Buffer, args); allocated.push(bytes); return bytes; });
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }])).toThrow(failure);
  expect(allocated).toHaveLength(4096); expect(allocated[0].every(byte => byte === 0)).toBe(true);
});
it('detects a same-length rewrite with an independently changed timestamp', () => {
  const { home, agent } = fixture(), path = join(agent, 'IDENTITY.md'); const read = fs.readSync;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(read, fs, args); fs.writeFileSync(path, 'OTHER'); fs.utimesSync(path, 1, 1); return count;
  });
  expect(() => capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }])).toThrow(failure);
});
it('opens only allowlisted files, without write flags, writes, databases or processes', async () => {
  const { home, agent } = fixture(); put(agent, 'audit.key', 'AUDIT'); put(home, 'household.json', 'OLD');
  put(agent, 'comms.db', 'PRIVATE'); put(agent, 'backup/drill.key', 'DRILL');
  const open = fs.openSync, opened: string[] = [];
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const flags = args[1]; expect(typeof flags).toBe('number');
    expect(Number(flags) & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)).toBe(0);
    const fd = Reflect.apply(open, fs, args); if (fs.fstatSync(fd).isFile()) opened.push(fs.realpathSync(`/proc/self/fd/${fd}`)); return fd;
  });
  const blocked = () => { throw Error('FORBIDDEN IO'); };
  const writes = ['writeFileSync','appendFileSync','writeSync','mkdirSync','renameSync','unlinkSync','rmSync','copyFileSync','chmodSync','truncateSync'] as const;
  for (const method of writes) vi.spyOn(fs, method).mockImplementation(blocked);
  const processes = await import('node:child_process');
  for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'] as const) vi.spyOn(processes, method).mockImplementation(blocked);
  const Database = (await import('better-sqlite3')).default;

  const capture = capturePortableFiles(home, [{ agent: 'art', noteHashes: [] }]);
  expect(capture.map(f => f.bytes.toString())).toEqual(['CREED']); expect(opened).toEqual([join(agent, 'IDENTITY.md')]); expect(Database).not.toHaveBeenCalled();
});
