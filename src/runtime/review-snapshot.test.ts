import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { houseSource } from './house-source.js';
import { plainContext } from './house-context.js';
import { linkStaysInside, outsideLinkWords, removeReviewSnapshot, reviewHouse, snapshotFingerprint, writeReviewSnapshot, writeTar } from './review-snapshot.js';

// A real git and a real repository, fetched by full commit id like a frozen review's (conversation.review).
const root = mkdtempSync(join(realpathSync(tmpdir()), 'loom-review-snapshot-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const quiet = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.invalid', PATH: process.env.PATH! };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: quiet, encoding: 'utf8' }).trim();
function repository(name: string) {
  const path = join(root, name); mkdirSync(path, { recursive: true });
  git(path, 'init', '--quiet', '--initial-branch=main');
  const commit = (changed: Record<string, string>) => {
    for (const [file, text] of Object.entries(changed)) { mkdirSync(join(path, file, '..'), { recursive: true }); writeFileSync(join(path, file), text); }
    git(path, 'add', '--all'); git(path, 'commit', '--quiet', '--message', 'change');
    return git(path, 'rev-parse', 'HEAD');
  };
  return { path, house: { repository: `file://${path}`, file: '', branch: 'main' }, commit };
}
const never = () => new AbortController().signal;

it('writes the exact head commit, its diff against the pinned base, and what both are, even after the branch moved on', async () => {
  const origin = repository('origin');
  const base = origin.commit({ 'src/pump.ts': 'export const rate = 1;\n', 'README.md': 'Fictional pumps\n' });
  symlinkSync('pump.ts', join(origin.path, 'src/link.ts')); chmodSync(join(origin.path, 'README.md'), 0o755);
  const head = origin.commit({ 'src/pump.ts': 'export const rate = 2;\n', 'src/new.ts': 'export const added = true;\n' });
  const later = origin.commit({ 'src/pump.ts': 'export const rate = 3; // after the review was pinned\n' });
  expect(later).not.toBe(head);
  const source = houseSource({ directory: join(root, 'mirrors'), protocols: ['file'] }), directory = join(root, 'copy');
  const before = await writeReviewSnapshot({ source, directory, review: { repository: 'acme/app', head, base }, signal: never(), house: origin.house });
  expect(readFileSync(join(directory, 'tree/src/pump.ts'), 'utf8')).toBe('export const rate = 2;\n');
  expect(readFileSync(join(directory, 'tree/src/new.ts'), 'utf8')).toBe('export const added = true;\n');
  // A link is written as the link the commit has, never followed.
  expect(lstatSync(join(directory, 'tree/src/link.ts')).isSymbolicLink()).toBe(true); expect(readlinkSync(join(directory, 'tree/src/link.ts'))).toBe('pump.ts');
  // Read-only on the machine as well as by the mount: 0444, or 0555 for what the commit says is executable.
  expect(lstatSync(join(directory, 'tree/src/pump.ts')).mode & 0o777).toBe(0o444);
  expect(lstatSync(join(directory, 'tree/README.md')).mode & 0o777).toBe(0o555);
  const diff = readFileSync(join(directory, 'change.diff'), 'utf8');
  expect(diff).toContain('-export const rate = 1;'); expect(diff).toContain('+export const rate = 2;'); expect(diff).toContain('src/new.ts');
  expect(diff).not.toContain('after the review was pinned');
  expect(JSON.parse(readFileSync(join(directory, 'review.json'), 'utf8'))).toEqual({ repository: 'acme/app', head, base, diffCut: false });
  // The same copy, the same fingerprint: nothing in it is the time it was written.
  expect(await snapshotFingerprint(directory)).toBe(before);
  await removeReviewSnapshot(directory); expect(existsSync(directory)).toBe(false);
});

it('gives a changed copy another fingerprint: a byte, a mode, a file added', async () => {
  const directory = join(root, 'fingerprint');
  await writeTar(plainContext([{ name: 'a.txt', data: Buffer.from('one') }, { name: 'bin/run', data: Buffer.from('#!/bin/sh\n'), executable: true }]), directory);
  expect(lstatSync(join(directory, 'bin/run')).mode & 0o777).toBe(0o555);
  const first = await snapshotFingerprint(directory);
  chmodSync(join(directory, 'a.txt'), 0o644); const mode = await snapshotFingerprint(directory); expect(mode).not.toBe(first);
  writeFileSync(join(directory, 'a.txt'), 'two'); const bytes = await snapshotFingerprint(directory); expect(bytes).not.toBe(mode);
  writeFileSync(join(directory, 'b.txt'), ''); expect(await snapshotFingerprint(directory)).not.toBe(bytes);
});

it('writes links as links, never through them, and refuses what the worker does not write', async () => {
  const directory = join(root, 'links');
  await writeTar(plainContext([{ name: 'a.txt', data: Buffer.from('one') }]), directory);
  // A tar the worker never writes: an entry whose name climbs out of the copy.
  const block = Buffer.alloc(512); block.write('../escape.txt', 0); block.write('0000644\0', 100); block.write('00000000000\0', 124); block.write('0', 156); block.write('ustar\0' + '00', 257);
  block.fill(0x20, 148, 156); let sum = 0; for (const byte of block) sum += byte; block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const { Readable } = await import('node:stream');
  await expect(writeTar(Readable.from([block, Buffer.alloc(1024)]), join(root, 'climb'))).rejects.toThrow('name the worker does not take');
  expect(existsSync(join(root, 'escape.txt'))).toBe(false);
  expect(reviewHouse('acme/app')).toEqual({ repository: 'https://github.com/acme/app.git', file: '', branch: 'main' });
});

it('writes a link whose target leaves the copy as a small text file saying where it pointed, and keeps one that stays inside', async () => {
  const origin = repository('outside-links');
  origin.commit({ 'docs/guide.md': 'A fictional guide\n', 'src/pump.ts': 'export const rate = 1;\n' });
  // Each of these, followed in the reviewer's container, would read something that is not the reviewed commit.
  const outside: Record<string, string> = {
    'login': '/run/loom/login/claude', 'environ': '/proc/self/environ', 'src/up': '../../..',
    'here': '.', 'src/climb': '../here/..',
  };
  for (const [name, target] of Object.entries(outside)) symlinkSync(target, join(origin.path, name));
  // And these stay inside: a sibling, a parent's file, a link to a link, and one through a link with no climb after it.
  const inside: Record<string, string> = { 'src/link.ts': 'pump.ts', 'src/guide': '../docs/guide.md', 'guide2': 'src/guide', 'deep': 'here/docs/guide.md' };
  for (const [name, target] of Object.entries(inside)) symlinkSync(target, join(origin.path, name));
  const head = origin.commit({ 'src/pump.ts': 'export const rate = 2;\n' });
  const base = git(origin.path, 'rev-parse', 'HEAD~1');
  const source = houseSource({ directory: join(root, 'outside-mirrors'), protocols: ['file'] }), directory = join(root, 'outside-copy');
  const before = await writeReviewSnapshot({ source, directory, review: { repository: 'acme/app', head, base }, signal: never(), house: origin.house });
  for (const [name, target] of Object.entries(outside)) {
    const written = join(directory, 'tree', name);
    // `here` (the tree's root) stays inside on its own, so it is a link; every other one here is a file.
    if (name === 'here') { expect(lstatSync(written).isSymbolicLink()).toBe(true); continue; }
    expect(lstatSync(written).isFile(), name).toBe(true);
    expect(lstatSync(written).mode & 0o777).toBe(0o444);
    expect(readFileSync(written, 'utf8')).toBe(outsideLinkWords(target));
  }
  for (const [name, target] of Object.entries(inside)) {
    expect(lstatSync(join(directory, 'tree', name)).isSymbolicLink(), name).toBe(true);
    expect(readlinkSync(join(directory, 'tree', name))).toBe(target);
  }
  // Read through the copy, every link that is kept ends inside it.
  expect(realpathSync(join(directory, 'tree/guide2'))).toBe(join(directory, 'tree/docs/guide.md'));
  expect(await snapshotFingerprint(directory)).toBe(before);
  // The rule on its own: through a link and then up is refused, wherever that link points.
  expect(linkStaysInside('a/b', '../c', new Set())).toBe(true);
  expect(linkStaysInside('a/b', '../../c', new Set())).toBe(false);
  expect(linkStaysInside('x', 'l/../y', new Set(['l']))).toBe(false);
  expect(linkStaysInside('x', 'l/y', new Set(['l']))).toBe(true);
  expect(linkStaysInside('x', '/etc/passwd', new Set())).toBe(false);
});
