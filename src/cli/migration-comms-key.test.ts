import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, fstatSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKey } from '../pieces/comms/crypto.js';
import { publishMigrationCommsKey } from './migration-comms-key.js';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'migration-comms-key-')); dirs.push(dir);
  const source = join(dir, 'snapshot'), home = join(dir, 'new'); mkdirSync(source); mkdirSync(home);
  await loadKey(source);
  return { dir, source, home, key: join(source, 'comms.key') };
}
it('publishes a complete private identical key, syncs file before directory, and repeats without writing', async () => {
  const f = await fixture(), before = readFileSync(f.key), order: string[] = [];
  publishMigrationCommsKey(f.key, f.home, { sync: fd => {
    const directory = fstatSync(fd).isDirectory(); order.push(directory ? 'directory' : 'file');
    if (!directory) expect(readdirSync(f.home)).not.toContain('comms.key');
    else expect(readFileSync(join(f.home, 'comms.key'))).toEqual(before);
    fsyncSync(fd);
  } });
  expect(order).toEqual(['file', 'directory']);
  expect(statSync(join(f.home, 'comms.key')).mode & 0o777).toBe(0o600);
  expect(statSync(join(f.home, 'comms.key')).nlink).toBe(1);
  expect(readdirSync(f.home)).toEqual(['comms.key']);
  publishMigrationCommsKey(f.key, f.home, { sync: fd => { expect(fstatSync(fd).isDirectory()).toBe(true); fsyncSync(fd); } });
  expect(readFileSync(f.key)).toEqual(before);
});
it('never leaves an empty final file on a failed file sync and retries after a directory sync failure', async () => {
  for (const stage of ['file', 'directory']) {
    const f = await fixture();
    expect(() => publishMigrationCommsKey(f.key, f.home, { sync: fd => {
      if (fstatSync(fd).isDirectory() === (stage === 'directory')) throw Error('power loss'); fsyncSync(fd);
    } })).toThrow('power loss');
    expect(readdirSync(f.home)).toEqual(stage === 'file' ? [] : ['comms.key']);
    publishMigrationCommsKey(f.key, f.home);
    expect(readFileSync(join(f.home, 'comms.key'))).toEqual(readFileSync(f.key));
  }
});
it('refuses different keys, aliases, broad permissions and overlapping homes without changing inputs', async () => {
  for (const kind of ['different', 'source-link', 'destination-link', 'source-mode', 'destination-mode', 'source-symlink', 'parent-symlink', 'overlap']) {
    const f = await fixture(); let input = f.key, home = f.home;
    if (kind === 'different') await loadKey(home);
    if (kind === 'source-link') linkSync(input, join(f.dir, 'outside'));
    if (kind === 'destination-link') { writeFileSync(join(home, 'comms.key'), readFileSync(input), { mode: 0o600 }); linkSync(join(home, 'comms.key'), join(f.dir, 'outside')); }
    if (kind === 'source-mode') chmodSync(input, 0o644);
    if (kind === 'destination-mode') writeFileSync(join(home, 'comms.key'), readFileSync(input), { mode: 0o644 });
    if (kind === 'source-symlink') { input = join(f.dir, 'alias'); symlinkSync(f.key, input); }
    if (kind === 'parent-symlink') { home = join(f.dir, 'alias'); symlinkSync(f.home, home); }
    if (kind === 'overlap') home = f.source;
    const before = readFileSync(f.key), entries = readdirSync(f.home);
    expect(() => publishMigrationCommsKey(input, home), kind).toThrow();
    expect(readFileSync(f.key)).toEqual(before); expect(readdirSync(f.home)).toEqual(entries);
  }
});

it('refuses missing or multiple source identities before publishing a key', async () => {
  for (const kind of ['empty', 'multiple']) {
    const f = await fixture(), identity = readFileSync(f.key, 'utf8');
    writeFileSync(f.key, kind === 'empty' ? '# no identity\n' : identity + identity);
    expect(() => publishMigrationCommsKey(f.key, f.home)).toThrow('one X25519 key');
    expect(readdirSync(f.home)).toEqual([]);
  }
});
it('returns no key and emits no output on success or refusal', async () => {
  const f = await fixture();
  const output: unknown[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { output.push(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { output.push(chunk); return true; });
  expect(publishMigrationCommsKey(f.key, f.home)).toBeUndefined();
  expect(publishMigrationCommsKey(f.key, f.home)).toBeUndefined();
  writeFileSync(join(f.home, 'comms.key'), 'different');
  expect(() => publishMigrationCommsKey(f.key, f.home)).toThrow('differs');
  expect(output).toEqual([]);
});
