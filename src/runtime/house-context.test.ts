import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { afterAll, expect, it, vi } from 'vitest';
import { houseContext, HouseContextError, type ContextLimits, type ObjectStore } from './house-context.js';
import { CONTEXT_ENTRIES_MAX, CONTEXT_FILE_MAX, CONTEXT_MAX, CONTEXT_NAME_MAX } from './worker-limits.js';

// A real git, real repositories and the machine's own tar to read back what was written.
const root = mkdtempSync(join(realpathSync(tmpdir()), 'loom-house-context-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const quiet = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.invalid', PATH: process.env.PATH! };
const git = (cwd: string, args: string[], input?: string | Buffer, env: Record<string, string> = quiet) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8' }).trim();
/** A repository with these files, committed; a value that is an object is a symbolic link to its `link`, or an executable file. */
function repository(name: string, files: Record<string, string | Buffer | { link: string } | { executable: string }>) {
  const path = join(root, name); mkdirSync(path, { recursive: true });
  git(path, ['init', '--quiet', '--initial-branch=main']);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(path, file, '..'), { recursive: true });
    if (typeof content === 'object' && 'link' in content) symlinkSync(content.link, join(path, file));
    else if (typeof content === 'object' && 'executable' in content) writeFileSync(join(path, file), content.executable, { mode: 0o755 });
    else writeFileSync(join(path, file), content);
  }
  git(path, ['add', '--all']); git(path, ['commit', '--quiet', '--message', 'a house']);
  return { path, commit: git(path, ['rev-parse', 'HEAD']) };
}
/** git as an object store over one repository, with the environment given and nothing else. */
const storeOf = (path: string, env: Record<string, string> = quiet): ObjectStore => (args, input) =>
  spawn('git', ['--git-dir', join(path, '.git'), ...args], { env, detached: true, stdio: [input, 'pipe', 'ignore'] });
const all = async (stream: Readable) => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk as Buffer); return Buffer.concat(chunks); };
const never = () => new AbortController().signal;
/** Unpack a tar with the machine's tar and say where. */
function unpacked(tar: Buffer, name: string) {
  const into = join(root, `unpacked-${name}`); mkdirSync(into); writeFileSync(`${into}.tar`, tar);
  execFileSync('tar', ['-xf', `${into}.tar`, '-C', into], { stdio: 'ignore' });
  return into;
}
/** Every entry under a directory, by its path from there. */
const under = (directory: string) => readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => !entry.isDirectory())
  .map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort();

it('writes every file of the commit byte for byte, whatever the repository says about archiving, and runs nothing', async () => {
  // A program named gpg, first on the path: git would start it to check a commit's signature.
  const bin = join(root, 'fake-bin'), marker = join(root, 'a-program-ran'); mkdirSync(bin);
  for (const program of ['gpg', 'gpgsm', 'ssh-keygen']) writeFileSync(join(bin, program), `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
  const files = {
    'Housefile': 'FROM scratch\n', 'left-out.txt': 'git archive would leave this out\n', 'stamped.txt': 'commit $Format:%H$ signed $Format:%G?$ by $Format:%GG$\n',
    'windows.txt': 'one\ntwo\n', 'filtered.txt': 'through a filter\n', 'binary.bin': Buffer.from(Array.from({ length: 2_000 }, (_, index) => index % 256)),
    'empty': '', 'exactly-one-block': 'x'.repeat(512), 'run.sh': { executable: '#!/bin/sh\necho run\n' },
    '.gitattributes': 'left-out.txt export-ignore\nstamped.txt export-subst\nwindows.txt text eol=crlf\nfiltered.txt filter=run diff=run merge=run\n*.bin -text\n',
    '.gitmodules': `[submodule "x"]\n\tpath = x\n\turl = ext::sh -c touch% ${marker}\n\tupdate = !touch ${marker}\n`,
    '.gitconfig': `[filter "run"]\n\tsmudge = sh -c 'touch ${marker}; cat'\n[gpg]\n\tprogram = ${join(bin, 'gpg')}\n`,
  };
  const house = repository('attributes', files);
  // The same tree in a commit that carries a signature, as a signed commit does.
  const tree = git(house.path, ['rev-parse', 'HEAD^{tree}']);
  const signed = git(house.path, ['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nauthor a <a@example.invalid> 1700000000 +0000\ncommitter a <a@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n =abcd\n -----END PGP SIGNATURE-----\n\na signed house\n`);
  const env = { ...quiet, PATH: `${bin}:${process.env.PATH}`, HOME: join(root, 'no-home') };
  const out = unpacked(await all(houseContext(storeOf(house.path, env), signed, never())), 'attributes');
  expect(under(out)).toEqual(Object.keys(files).sort());
  for (const [name, content] of Object.entries(files)) {
    const written = readFileSync(join(out, name)), wanted = typeof content === 'object' && 'executable' in content ? Buffer.from(content.executable) : Buffer.from(content as string | Buffer);
    expect(written.equals(wanted), name).toBe(true);
    expect(lstatSync(join(out, name)).mode & 0o777, name).toBe(name === 'run.sh' ? 0o755 : 0o644);
  }
  expect(existsSync(marker)).toBe(false); expect(existsSync(join(root, 'no-home'))).toBe(false);
  // The check is not vacuous: git's own archive of the same commit leaves a file out, rewrites two others and starts the program.
  const archived = unpacked(execFileSync('git', ['--git-dir', join(house.path, '.git'), 'archive', '--format=tar', signed], { env, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24 }), 'git-archive');
  expect(under(archived)).not.toContain('left-out.txt'); expect(readFileSync(join(archived, 'windows.txt'), 'latin1')).toBe('one\r\ntwo\r\n');
  expect(readFileSync(join(archived, 'stamped.txt'), 'utf8')).toContain(signed); expect(existsSync(marker)).toBe(true);
});
it('writes a symbolic link as a link, with the target the commit gives it, and never what it points at', async () => {
  const house = repository('links', { 'real.txt': 'the real file\n', 'near': { link: 'real.txt' }, 'dir/up': { link: '../real.txt' }, 'out': { link: '/etc/hostname' }, 'dangling': { link: 'nowhere' },
    'far': { link: `${'deep/'.repeat(40)}target` } });
  const out = unpacked(await all(houseContext(storeOf(house.path), house.commit, never())), 'links');
  for (const [name, target] of [['near', 'real.txt'], ['dir/up', '../real.txt'], ['out', '/etc/hostname'], ['dangling', 'nowhere'], ['far', `${'deep/'.repeat(40)}target`]]) {
    expect(lstatSync(join(out, name)).isSymbolicLink(), name).toBe(true); expect(readlinkSync(join(out, name)), name).toBe(target);
  }
  expect(readFileSync(join(out, 'real.txt'), 'utf8')).toBe('the real file\n');
});
it('keeps a name as the tree has it: a line break, quotes, a backslash, spaces, other scripts, and a name too long for a plain header', async () => {
  const names = ['a "quoted"\nname with\ttab', "it's 'single'", 'back\\slash', ' leading and trailing ', 'ünïcödé/日本語.txt', '-rf', '--option=x', '$(touch x)', '`touch y`',
    `${'a'.repeat(120)}/${'b'.repeat(120)}/${'c'.repeat(120)}.txt`, `${'d'.repeat(99)}x`, `${'e'.repeat(100)}`, `${'f'.repeat(101)}`];
  const house = repository('names', Object.fromEntries(names.map((name, index) => [name, `file ${index}\n`])));
  const out = unpacked(await all(houseContext(storeOf(house.path), house.commit, never())), 'names');
  expect(under(out)).toEqual([...names].sort());
  for (const [index, name] of names.entries()) expect(readFileSync(join(out, name), 'utf8'), name).toBe(`file ${index}\n`);
  // Nothing was made of a name but an entry: no file named by what looks like a command.
  expect(existsSync(join(house.path, 'x')) || existsSync(join(house.path, 'y')) || existsSync('x') || existsSync('y')).toBe(false);
});
it('skips a submodule\'s entry and writes the rest', async () => {
  const house = repository('with-submodule', { 'Housefile': 'FROM scratch\n', 'kept/file.txt': 'kept\n' });
  git(house.path, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/other`]);
  git(house.path, ['commit', '--quiet', '--message', 'pin another repository']);
  const out = unpacked(await all(houseContext(storeOf(house.path), git(house.path, ['rev-parse', 'HEAD']), never())), 'with-submodule');
  expect(under(out)).toEqual(['Housefile', 'kept/file.txt']);
});
it('writes an empty commit as an empty tar', async () => {
  const path = join(root, 'empty'); mkdirSync(path); git(path, ['init', '--quiet']); git(path, ['commit', '--quiet', '--allow-empty', '--message', 'nothing']);
  const tar = await all(houseContext(storeOf(path), git(path, ['rev-parse', 'HEAD']), never()));
  expect(tar.equals(Buffer.alloc(1024))).toBe(true);
});
it('states its limits once', () => {
  expect([CONTEXT_FILE_MAX, CONTEXT_MAX, CONTEXT_ENTRIES_MAX, CONTEXT_NAME_MAX]).toEqual([104_857_600, 1_073_741_824, 50_000, 4_096]);
});
const roomy: ContextLimits = { file: 1_000, whole: 2_500, entries: 4, name: 60 };
it.each([
  ['a file larger than one file may be', { 'big': 'x'.repeat(1_001) }, 'House has a file that is too large'],
  ['more in all than a context may hold', { 'a': 'x'.repeat(900), 'b': 'x'.repeat(900), 'c': 'x'.repeat(900) }, 'House is too large'],
  ['more files than a context may have', { 'a': '1', 'b': '2', 'c': '3', 'd': '4', 'e': '5' }, 'House is too large'],
  ['a name longer than a name may be', { [`${'n'.repeat(30)}/${'n'.repeat(31)}`]: 'x' }, 'House has a file name the worker does not take'],
  ['a link whose target is longer than a name may be', { 'link': { link: 't'.repeat(61) } }, 'House has a file that is too large'],
])('fails cleanly over %s: not a byte is written', async (_what, files, message) => {
  const house = repository(`limit-${_what.replaceAll(' ', '-')}`, files);
  const written: Buffer[] = [], stream = houseContext(storeOf(house.path), house.commit, never(), { limits: roomy });
  const failure = await (async () => { try { for await (const chunk of stream) written.push(chunk as Buffer); } catch (error) { return error as Error; } })();
  expect(failure).toBeInstanceOf(HouseContextError); expect(failure!.message).toBe(message); expect(written).toEqual([]);
  expect(failure!.message).not.toContain(root);
});
it('writes a context that is exactly at its limits', async () => {
  const house = repository('at-the-limits', { [`${'n'.repeat(29)}/${'n'.repeat(30)}`]: 'x'.repeat(1_000), 'b': 'x'.repeat(1_000), 'c': 'x'.repeat(500), 'l': { link: 't'.repeat(60) } });
  // The link's sixty bytes count toward the whole, so the whole is 2,560: one limit is lifted to see the others hold.
  const out = unpacked(await all(houseContext(storeOf(house.path), house.commit, never(), { limits: { ...roomy, whole: 2_560 } })), 'at-the-limits');
  expect(under(out)).toHaveLength(4);
});

/** A git that answers as told, to see what the worker makes of answers a real one would not give. */
function answering(listing: Buffer | string, batch: (asked: string) => Buffer | string = () => '') {
  const calls: (readonly string[])[] = [];
  const store: ObjectStore = args => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null as number | null, stdout: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    const close = (code: number) => { child.exitCode = code; setImmediate(() => child.emit('close', code)); };
    if (args.includes('ls-tree')) queueMicrotask(() => { child.stdout.end(listing); close(0); });
    else {
      // An answer that ends in <gone> is a git that died there.
      child.stdin.on('data', (asked: Buffer) => { const answer = batch(asked.toString().trim()).toString('latin1'); if (answer.endsWith('<gone>')) { child.stdout.end(answer.slice(0, -6), 'latin1'); close(1); } else child.stdout.write(answer, 'latin1'); });
      child.stdin.on('end', () => { child.stdout.end(); close(0); });
    }
    return child as unknown as ChildProcess;
  };
  return { store, calls };
}
const oid = 'b'.repeat(40);
const listed = (name: string | Buffer, mode = '100644', type = 'blob', size = '1') => Buffer.concat([Buffer.from(`${mode} ${type} ${oid} ${size.padStart(7)}\t`), Buffer.from(name), Buffer.from([0])]);
it.each([
  ['an absolute name', '/etc/passwd'], ['a name that climbs', '../outside'], ['a name that climbs part of the way', 'a/../../b'], ['a part that is a dot', 'a/./b'],
  ['an empty part', 'a//b'], ['a trailing slash', 'a/'], ['a name that is not UTF-8', Buffer.from([0x61, 0xff, 0xfe])], ['an empty name', ''],
])('refuses a tree with %s, before it asks for any file', async (_what, name) => {
  const fake = answering(listed(name));
  await expect(all(houseContext(fake.store, 'c'.repeat(40), never()))).rejects.toThrow('House has a file name the worker does not take');
  expect(fake.calls.map(args => args[0])).toEqual(['ls-tree']);
});
it.each([
  ['a kind of entry that is neither a file nor a link', listed('a', '100644', 'tree')], ['a mode no file has', listed('a', '100664')], ['a listing cut short', Buffer.from(`100644 blob ${oid}       1\ta`)],
  ['a size that is no number', listed('a', '100644', 'blob', '-')], ['an object id that is none', Buffer.from(`100644 blob HEAD       1\ta\0`)],
])('fails over %s', async (_what, listing) => {
  await expect(all(houseContext(answering(listing).store, 'c'.repeat(40), never()))).rejects.toThrow('git failed');
});
it.each([
  ['a different size than the tree gave', () => `${oid} blob 2\nxx\n`], ['another kind of object', () => `${oid} tree 1\nx\n`], ['an object that is missing', () => `${oid} missing\n`],
  ['bytes that run on past the object', () => `${oid} blob 1\nxy\n`], ['an answer that stops short because git died', () => `${oid} blob 1\n<gone>`], ['a git that died before it answered', () => '<gone>'],
])('fails, and does not pass on a cut-off context as a whole one, when git answers for a file with %s', async (_what, answer) => {
  await expect(all(houseContext(answering(listed('a'), answer).store, 'c'.repeat(40), never()))).rejects.toThrow('git failed');
});
it('asks git for the tree of the one commit and for objects by their ids, and gives it no name from the repository', async () => {
  const fake = answering(Buffer.concat([listed('--upload-pack=x'), listed('$(id)')]), asked => `${asked} blob 1\nx\n`);
  await all(houseContext(fake.store, 'c'.repeat(40), never()));
  expect(fake.calls).toEqual([['ls-tree', '-r', '-l', '-z', '--full-tree', 'c'.repeat(40)], ['cat-file', '--batch']]);
});
it('ends git when the job is cancelled, when whoever reads stops, and tells the worker which processes it started', async () => {
  const house = repository('cancelled', Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`file-${index}`, 'x'.repeat(200_000)])));
  const started: number[] = [], forgotten: number[] = [], children: ChildProcess[] = [];
  const store: ObjectStore = (args, input) => { const child = storeOf(house.path)(args, input); children.push(child); return child; };
  const noted = { started: (pid: number) => { started.push(pid); return () => forgotten.push(pid); } };
  // Cancelled part of the way through.
  const abort = new AbortController(), stream = houseContext(store, house.commit, abort.signal, noted);
  const failed = (async () => { try { for await (const _chunk of stream) abort.abort(); } catch (error) { return error as Error; } })();
  expect(await failed).toBeInstanceOf(Error);
  await vi.waitFor(() => expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true));
  expect(started).toHaveLength(2); expect(forgotten.sort()).toEqual([...started].sort());
  // Whoever reads gives up (a build that failed): git is ended too.
  children.length = 0;
  const abandoned = houseContext(store, house.commit, never(), noted);
  for await (const _chunk of abandoned) break;
  await vi.waitFor(() => expect(children.length === 2 && children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true));
  // Already cancelled: git is not started at all.
  children.length = 0; const dead = new AbortController(); dead.abort();
  await expect(all(houseContext(store, house.commit, dead.signal))).rejects.toThrow(HouseContextError); expect(children).toEqual([]);
});
it('fails in its own words when git cannot be run or the commit is not there', async () => {
  const house = repository('failing', { a: 'x' });
  await expect(all(houseContext(storeOf(house.path), 'd'.repeat(40), never()))).rejects.toThrow('git failed');
  await expect(all(houseContext(() => { throw new Error('ENOENT /private/path'); }, house.commit, never()))).rejects.toThrow('git could not be run');
});
