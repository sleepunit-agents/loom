import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BodyFileRefused, bodyFileReader } from './body-files.js';
import { SEND_FILES, SEND_FILES_BYTES } from '../pieces/bridges/send-file-limit.js';

const made: string[] = [];
afterEach(() => { for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'loom-body-files-')); made.push(root);
  const cwd = join(root, 'house'), scratch = join(root, 'scratch'), outside = join(root, 'outside');
  for (const directory of [cwd, join(cwd, 'out'), scratch, outside]) mkdirSync(directory);
  writeFileSync(join(cwd, 'out', 'plot one.png'), 'PNG');
  writeFileSync(join(scratch, 'notes.txt'), 'notes');
  writeFileSync(join(outside, 'secret.key'), 'SECRET');
  return { cwd, scratch, outside, read: bodyFileReader(cwd, [cwd, scratch]) };
}

it('reads a file inside the body\'s working directory or its scratch directory, by relative or absolute path', () => {
  const f = fixture();
  expect(f.read(['out/plot one.png', join(f.scratch, 'notes.txt')]).map(file => [file.name, file.contents.toString()])).toEqual([['plot_one.png', 'PNG'], ['notes.txt', 'notes']]);
});

it('refuses anything outside that area, however it is reached', () => {
  const f = fixture();
  symlinkSync(join(f.outside, 'secret.key'), join(f.cwd, 'link-out'));
  symlinkSync(f.outside, join(f.cwd, 'dir-out'));
  for (const path of [join(f.outside, 'secret.key'), '../outside/secret.key', 'out/../../outside/secret.key', 'link-out', 'dir-out/secret.key', '/etc/hostname', '/proc/self/environ'])
    expect(() => f.read([path]), path).toThrow(BodyFileRefused);
  // A directory, a missing file, an empty file, a path with a NUL.
  writeFileSync(join(f.cwd, 'empty'), '');
  for (const path of ['out', 'no-such-file', 'empty', 'out/plot\0.png', '']) expect(() => f.read([path]), JSON.stringify(path)).toThrow(BodyFileRefused);
  // The refusal says which path, and nothing of a file's contents.
  expect(() => f.read(['dir-out/secret.key'])).toThrow("Not inside this body's working area: dir-out/secret.key");
});

it('asks everything of the open file: a link as the last step, a link on the way, and a second name', () => {
  const f = fixture();
  // The last step is a link: refused wherever it leads, even to a file of the body's own. It is the one step
  // a body could swap after a check, so it is never followed.
  symlinkSync(join(f.cwd, 'out', 'plot one.png'), join(f.cwd, 'link-in'));
  symlinkSync(join(f.outside, 'secret.key'), join(f.cwd, 'link-out'));
  expect(() => f.read(['link-in'])).toThrow('No such file, or a link: link-in');
  expect(() => f.read(['link-out'])).toThrow('No such file, or a link: link-out');
  // A link on the way that stays inside the area is the body's own layout; one that leads out is caught by
  // where the open file really is.
  symlinkSync(join(f.cwd, 'out'), join(f.cwd, 'also-out'));
  expect(f.read(['also-out/plot one.png'])[0].contents.toString()).toBe('PNG');
  symlinkSync(f.outside, join(f.scratch, 'way-out'));
  expect(() => f.read([join(f.scratch, 'way-out', 'secret.key')])).toThrow("Not inside this body's working area");
  // A hard link made inside the area to a file outside it has the inside path, so it is refused by its second name.
  linkSync(join(f.outside, 'secret.key'), join(f.cwd, 'looks-inside.key'));
  expect(() => f.read(['looks-inside.key'])).toThrow('A file with more than one name is not posted: looks-inside.key');
  // The same rule refuses a file of the body's own that has two names.
  linkSync(join(f.cwd, 'out', 'plot one.png'), join(f.cwd, 'second-name.png'));
  expect(() => f.read(['second-name.png'])).toThrow('more than one name');
  // A pipe is not waited on, and is no file.
  execFileSync('mkfifo', [join(f.cwd, 'pipe')]);
  expect(() => f.read(['pipe'])).toThrow(BodyFileRefused);
});

it('holds a post to its count and its bytes', () => {
  const f = fixture();
  for (let n = 0; n <= SEND_FILES; n++) writeFileSync(join(f.cwd, `f${n}`), 'x');
  expect(f.read(Array.from({ length: SEND_FILES }, (_, n) => `f${n}`))).toHaveLength(SEND_FILES);
  expect(() => f.read(Array.from({ length: SEND_FILES + 1 }, (_, n) => `f${n}`))).toThrow('at most');
  expect(() => f.read([])).toThrow(BodyFileRefused);
  writeFileSync(join(f.cwd, 'big'), Buffer.alloc(SEND_FILES_BYTES));
  expect(f.read(['big'])[0].contents.byteLength).toBe(SEND_FILES_BYTES);
  expect(() => f.read(['big', 'f0'])).toThrow('bytes together');
  writeFileSync(join(f.cwd, 'too-big'), Buffer.alloc(SEND_FILES_BYTES + 1));
  expect(() => f.read(['too-big'])).toThrow(BodyFileRefused);
});

it('has no area when its directories do not exist', () => {
  const read = bodyFileReader('/nonexistent-loom-cwd', ['/nonexistent-loom-cwd', undefined]);
  expect(() => read(['/etc/hostname'])).toThrow(BodyFileRefused);
});
