import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { gitAvailable, gitNewEnough, houseFile, houseSource, HouseSourceError, type GitSpawn } from './house-source.js';
import { GIT_MINIMUM } from './worker-limits.js';

// A real git and a real repository: what is tested is what git does with what the worker gives it.
const root = mkdtempSync(join(realpathSync(tmpdir()), 'loom-house-source-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
const quiet = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.invalid', PATH: process.env.PATH! };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: quiet, encoding: 'utf8' }).trim();
function repository(name: string, files: Record<string, string>) {
  const path = join(root, name); mkdirSync(path, { recursive: true });
  git(path, 'init', '--quiet', '--initial-branch=main');
  const commit = (changed: Record<string, string>, message = 'change') => {
    for (const [file, text] of Object.entries(changed)) { mkdirSync(join(path, file, '..'), { recursive: true }); writeFileSync(join(path, file), text); }
    git(path, 'add', '--all'); git(path, 'commit', '--quiet', '--message', message);
    return git(path, 'rev-parse', 'HEAD');
  };
  return { path, address: `file://${path}`, commit, first: commit(files, 'first') };
}
const all = async (stream: Readable) => { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk as Buffer); return Buffer.concat(chunks); };
const never = () => new AbortController().signal;
const local = (name: string) => houseSource({ directory: join(root, name), protocols: ['file'] });

it('fetches the job\'s branch into its own mirror, names the commit and hands that commit out as a tar', async () => {
  const origin = repository('origin', { 'house/Housefile': 'FROM scratch\n', 'notes.txt': 'first words\n' });
  const source = local('mirrors'), house = { repository: origin.address, file: 'house/Housefile', branch: 'main' };
  expect(await source.fetch(house, undefined, never())).toBe(origin.first);
  const tar = (await all(source.context(house, origin.first, never()))).toString('latin1');
  expect(tar).toContain('house/Housefile'); expect(tar).toContain('FROM scratch'); expect(tar).toContain('first words');
  // The branch moves: the next fetch names the new commit, and the old one can still be handed out.
  const second = origin.commit({ 'notes.txt': 'second words\n' });
  expect(await source.fetch(house, undefined, never())).toBe(second);
  expect((await all(source.context(house, second, never()))).toString('latin1')).toContain('second words');
  // Another branch of the same repository, in the same mirror.
  git(origin.path, 'checkout', '--quiet', '-b', 'next'); const next = origin.commit({ 'notes.txt': 'next words\n' });
  expect(await source.fetch({ ...house, branch: 'next' }, undefined, never())).toBe(next);
  expect(await source.fetch(house, undefined, never())).toBe(second);
  expect(readdirSync(join(root, 'mirrors'))).toHaveLength(1);
});
/** Every file under a directory, as text. */
function everything(directory: string): string {
  return readdirSync(directory, { withFileTypes: true, recursive: true }).filter(entry => entry.isFile())
    .map(entry => readFileSync(join(entry.parentPath, entry.name), 'latin1')).join('\n');
}
it('writes nothing of where a repository is, or of its secret, anywhere in the mirror', async () => {
  const origin = repository('unnamed-origin', { Housefile: 'FROM scratch\n' }), source = local('unnamed');
  const house = { repository: origin.address, file: 'Housefile', branch: 'main' };
  await source.fetch(house, new TextEncoder().encode('a-secret-token'), never());
  origin.commit({ 'more.txt': 'more\n' }); await source.fetch(house, new TextEncoder().encode('deploy:a-secret-token'), never());
  const [mirror] = readdirSync(join(root, 'unnamed')), kept = everything(join(root, 'unnamed', mirror));
  // Not in the configuration, not in FETCH_HEAD (which git writes with the address unless told not to),
  // not in a log of the reference, not anywhere.
  expect(kept).not.toContain(origin.path); expect(kept).not.toContain('unnamed-origin');
  expect(kept).not.toMatch(/a-secret-token|YS1zZWNyZXQtdG9rZW4|extraheader/i);
  expect(existsSync(join(root, 'unnamed', mirror, 'FETCH_HEAD'))).toBe(false);
});
it('keeps one mirror per repository and writes neither the address nor a remote into it', async () => {
  const one = repository('one', { Housefile: 'FROM scratch\n' }), two = repository('two', { Housefile: 'FROM scratch\n' });
  const source = local('apart');
  await source.fetch({ repository: one.address, file: 'Housefile', branch: 'main' }, undefined, never());
  await source.fetch({ repository: two.address, file: 'Housefile', branch: 'main' }, new TextEncoder().encode('a-secret-token'), never());
  const mirrors = readdirSync(join(root, 'apart'));
  expect(mirrors).toHaveLength(2); expect(mirrors.every(name => /^[0-9a-f]{32}\.git$/.test(name))).toBe(true);
  for (const mirror of mirrors) {
    const config = readFileSync(join(root, 'apart', mirror, 'config'), 'utf8');
    expect(config).not.toMatch(/remote|url|extraheader|credential|a-secret-token/i); expect(config).not.toContain(root);
    // Bare: no file of the repository is ever written out on this machine.
    expect(existsSync(join(root, 'apart', mirror, 'Housefile'))).toBe(false);
  }
});
it('runs git with none of the machine user\'s configuration: no rewrite, no helper, no hook, no filter', async () => {
  const wanted = repository('wanted', { Housefile: 'FROM scratch\n', 'data.txt': 'public\n', '.gitattributes': '* filter=marker\n' });
  const private_ = repository('private', { Housefile: 'FROM scratch\n', 'data.txt': 'the machine user\'s private repository\n' });
  // The machine user's own git configuration would send this fetch to another repository and run a program.
  const marker = join(root, 'ran'), userConfig = join(root, 'user.gitconfig'), hooks = join(root, 'user-hooks');
  // A hook git runs whenever a fetch moves a reference, as the user's own hooks directory would have it.
  mkdirSync(hooks); writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  writeFileSync(userConfig, `[url "${private_.address}"]\n\tinsteadOf = ${wanted.address}\n[filter "marker"]\n\tsmudge = sh -c 'touch ${marker}; cat'\n[credential]\n\thelper = "!touch ${marker};"\n[core]\n\thooksPath = ${hooks}\n`);
  // The same configuration does all of that when git is left to read it: the check below is not vacuous.
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '--quiet', wanted.address, join(root, 'as-the-user')], { env: { PATH: process.env.PATH!, GIT_CONFIG_GLOBAL: userConfig, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' });
  expect(existsSync(marker)).toBe(true); expect(readFileSync(join(root, 'as-the-user', 'data.txt'), 'utf8')).toContain('private repository'); rmSync(marker);
  vi.stubEnv('GIT_CONFIG_GLOBAL', userConfig); vi.stubEnv('HOME', root); writeFileSync(join(root, '.gitconfig'), readFileSync(userConfig));
  vi.stubEnv('GIT_DIR', private_.path + '/.git'); vi.stubEnv('GIT_SSH_COMMAND', `touch ${marker}`);
  const source = local('stranger'), house = { repository: wanted.address, file: 'Housefile', branch: 'main' };
  expect(await source.fetch(house, undefined, never())).toBe(wanted.first);
  const tar = (await all(source.context(house, wanted.first, never()))).toString('latin1');
  expect(tar).toContain('public'); expect(tar).not.toContain('private repository');
  expect(existsSync(marker)).toBe(false);
});
it.each([
  ['a local path', '/srv/repositories/house.git'], ['a file address', 'file:///srv/repositories/house.git'], ['plain http', 'http://example.com/house.git'],
  ['ssh', 'ssh://git@example.com/house.git'], ['the short ssh form', 'git@example.com:org/house.git'], ['a command transport', 'ext::sh -c touch% /tmp/x'],
  ['an option', '--upload-pack=touch /tmp/x'], ['the git protocol', 'git://example.com/house.git'], ['a user in the address', 'https://user@example.com/house.git'],
  ['a password in the address', 'https://user:pw@example.com/house.git'], ['a query', 'https://example.com/house.git?x=1'], ['a fragment', 'https://example.com/house.git#x'],
  ['a line break', 'https://example.com/house.git\n--upload-pack=x'], ['a backslash a parser reads as a slash', 'https://example.com\\@other.example/house.git'],
  ['an at sign in the path', 'https://example.com/a@b/house.git'], ['a space', 'https://example.com/house .git'], ['no host', 'https:///house.git'],
  ['an address that is not text', 7], ['nothing', ''],
])('fetches only https addresses: refuses %s without running git', async (_what, address) => {
  const spawned = vi.fn(), source = houseSource({ directory: join(root, 'unused'), spawn: spawned });
  const house = { repository: address as string, file: 'Housefile', branch: 'main' };
  await expect(source.fetch(house, undefined, never())).rejects.toThrow(HouseSourceError);
  await expect(all(source.context(house, 'a'.repeat(40), never()))).rejects.toThrow(HouseSourceError);
  expect(spawned).not.toHaveBeenCalled(); expect(existsSync(join(root, 'unused'))).toBe(false);
});
it('fetches a house that has no Housefile, and writes its files apart from the worker\'s own Housefile when it is given one', async () => {
  const origin = repository('no-housefile', { 'notes.txt': 'only notes\n' });
  const source = local('no-housefile-mirrors'), house = { repository: origin.address, file: '', branch: 'main' };
  expect(await source.fetch(house, undefined, never())).toBe(origin.first);
  const tar = (await all(source.context(house, origin.first, never(), { directory: 'repository', beside: { name: 'Housefile', data: Buffer.from('FROM ${LOOM_CORE}\n') } }))).toString('latin1');
  expect(tar).toContain('only notes'); expect(tar).toContain('repository/notes.txt'); expect(tar).toContain('FROM ${LOOM_CORE}');
  expect((await all(source.context(house, origin.first, never()))).toString('latin1')).not.toContain('repository/notes.txt');
});
it.each([
  ['an option as a branch', { branch: '--upload-pack=x' }], ['a refspec in a branch', { branch: 'main:refs/heads/x' }], ['a pattern', { branch: 'ma*n' }],
  ['a range', { branch: 'a..b' }], ['a space', { branch: 'a b' }], ['an empty branch', { branch: '' }], ['a trailing slash', { branch: 'a/' }],
  ['an absolute Housefile', { file: '/etc/passwd' }], ['a Housefile that climbs', { file: 'a/../../Housefile' }], ['a backslash', { file: 'a\\Housefile' }],
  ['a line break in the Housefile', { file: 'House\nfile' }], ['a Housefile through a dot', { file: './Housefile' }],
])('refuses %s without running git', async (_what, patch) => {
  const spawned = vi.fn(), source = houseSource({ directory: join(root, 'unused'), spawn: spawned });
  await expect(source.fetch({ repository: 'https://example.com/house.git', file: 'Housefile', branch: 'main', ...patch }, undefined, never())).rejects.toThrow(HouseSourceError);
  expect(spawned).not.toHaveBeenCalled();
});
it('reads a Housefile\'s path the one way', () => {
  expect(['Housefile', 'house/new/Housefile', 'a.b/c-d_e'].every(houseFile)).toBe(true);
  expect(['/Housefile', '../Housefile', 'a//b', 'a/', '', 'a\0', 7, undefined].some(houseFile)).toBe(false);
});

/** A git that does nothing, to see exactly what the worker would have given it. */
function recorded(answers: (args: readonly string[]) => { code?: number; out?: string } = () => ({})) {
  const calls: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const start: GitSpawn = (args, env) => {
    calls.push({ args, env });
    const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null as number | null, stdout: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    const answer = answers(args);
    queueMicrotask(() => { child.stdout.end(answer.out ?? ''); child.exitCode = answer.code ?? 0; setImmediate(() => child.emit('close', answer.code ?? 0)); });
    return child as unknown as ChildProcess;
  };
  return { calls, start };
}
const commit = 'c'.repeat(40);
const answering = (args: readonly string[]) => args.includes('rev-parse') ? { out: `${commit}\n` } : {};
const settings = (env: Readonly<Record<string, string>>) => Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]));

it('gives the repository\'s secret to the one fetch, as a header for the repository\'s own origin, and to nothing else', async () => {
  vi.stubEnv('WORKER_ONLY_SECRET', 'ambient-private'); vi.stubEnv('SSH_AUTH_SOCK', '/run/user/agent.sock'); vi.stubEnv('GIT_ASKPASS', '/usr/bin/leak');
  const git = recorded(answering), source = houseSource({ directory: join(root, 'secret'), spawn: git.start });
  const house = { repository: 'https://git.example.com:8443/org/house.git', file: 'Housefile', branch: 'main' };
  expect(await source.fetch(house, new TextEncoder().encode('tok-en-123\n'), never())).toBe(commit);
  await all(source.context(house, commit, never()));
  const basic = Buffer.from('x-access-token:tok-en-123').toString('base64');
  expect(git.calls.map(call => call.args.find(arg => ['init', 'fetch', 'rev-parse', 'ls-tree', 'cat-file'].includes(arg)))).toEqual(['init', 'fetch', 'rev-parse', 'ls-tree', 'cat-file']);
  const [init, fetch, parse, ...reading] = git.calls;
  expect(settings(fetch.env)['http.https://git.example.com:8443/.extraHeader']).toBe(`Authorization: Basic ${basic}`);
  // No argument of any call carries it, in any form; no other call's environment does.
  expect(JSON.stringify(git.calls.map(call => call.args))).not.toMatch(new RegExp(`tok-en-123|${basic}`));
  for (const call of [init, parse, ...reading]) expect(JSON.stringify(call.env)).not.toMatch(new RegExp(`tok-en-123|${basic}|extraHeader`));
  // The address is an argument of the fetch alone, after `--`, and the refspec is the worker's own.
  expect(fetch.args.slice(fetch.args.indexOf('--'))).toEqual(['--', house.repository, '+refs/heads/main:refs/loom/fetched']);
  expect(fetch.args).toEqual(expect.arrayContaining(['--no-tags', '--depth=1', '--no-recurse-submodules', '--no-write-fetch-head']));
  for (const call of git.calls) {
    // An environment made here: nothing of the worker's own but PATH.
    expect(Object.keys(call.env).filter(key => !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)).sort())
      .toEqual(['GIT_ALLOW_PROTOCOL', 'GIT_ATTR_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'PATH']);
    expect(call.env).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https', HOME: join(root, 'secret') });
    // git is not asked to check what it fetches: that reads a commit's .gitmodules, and nothing here checks out.
    expect(Object.keys(settings(call.env)).some(key => /fsck/i.test(key))).toBe(false);
    expect(settings(call.env)).toMatchObject({ 'credential.helper': '', 'core.hooksPath': '/dev/null', 'http.followRedirects': 'false', 'protocol.allow': 'never', 'protocol.https.allow': 'always' });
    expect(JSON.stringify(call.env)).not.toMatch(/ambient-private|agent\.sock|\/usr\/bin\/leak/);
  }
});
it('sends a secret with a colon as that user and password, and refuses one that cannot be a header', async () => {
  const git = recorded(answering), source = houseSource({ directory: join(root, 'secret-user'), spawn: git.start });
  const house = { repository: 'https://example.com/house.git', file: 'Housefile', branch: 'main' };
  await source.fetch(house, new TextEncoder().encode('deploy:pass:word'), never());
  expect(settings(git.calls[1].env)['http.https://example.com/.extraHeader']).toBe(`Authorization: Basic ${Buffer.from('deploy:pass:word').toString('base64')}`);
  // Without a secret, no header at all.
  await source.fetch(house, undefined, never());
  expect(Object.keys(settings(git.calls.at(-2)!.env)).some(key => /extraheader/i.test(key))).toBe(false);
  const before = git.calls.length;
  for (const bad of ['', '  \n', 'two\nlines', 'nul\0byte']) await expect(source.fetch(house, new TextEncoder().encode(bad), never())).rejects.toThrow(HouseSourceError);
  expect(git.calls).toHaveLength(before);
});
it('fails in its own words when git fails, a branch is missing or the commit it names is not one', async () => {
  const origin = repository('failing', { Housefile: 'FROM scratch\n' }), source = local('failing-mirror');
  const house = { repository: origin.address, file: 'Housefile', branch: 'absent' };
  const failed = await source.fetch(house, undefined, never()).catch(error => error as Error);
  expect(failed).toBeInstanceOf(HouseSourceError); expect(failed.message).toBe('git failed'); expect(failed.message).not.toContain(root);
  // A mirror that failed once fetches again.
  expect(await source.fetch({ ...house, branch: 'main' }, undefined, never())).toBe(origin.first);
  await expect(all(source.context({ ...house, branch: 'main' }, 'd'.repeat(40), never()))).rejects.toThrow('git failed');
  await expect(all(source.context({ ...house, branch: 'main' }, 'HEAD', never()))).rejects.toThrow(HouseSourceError);
  const lying = houseSource({ directory: join(root, 'lying'), spawn: recorded(args => args.includes('rev-parse') ? { out: '--not-a-commit\n' } : {}).start });
  await expect(lying.fetch({ repository: 'https://example.com/house.git', file: 'Housefile', branch: 'main' }, undefined, never())).rejects.toThrow('git failed');
  const missing = houseSource({ directory: join(root, 'no-git'), spawn: () => { throw new Error('ENOENT /private/path'); } });
  await expect(missing.fetch({ repository: 'https://example.com/house.git', file: 'Housefile', branch: 'main' }, undefined, never())).rejects.toThrow('git could not be run');
});
it('ends git when the job is cancelled, and tells the worker which processes it started', async () => {
  const abort = new AbortController(), started: number[] = [], forgotten: number[] = [];
  let child: ChildProcess | undefined;
  const source = houseSource({ directory: join(root, 'cancelled'), protocols: ['file'], started: pid => { started.push(pid); return () => forgotten.push(pid); },
    spawn: (args, env, output) => args.includes('fetch')
      ? child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
      : spawn('git', [...args], { env: { ...env }, detached: true, stdio: ['ignore', output, 'ignore'] }) });
  const origin = repository('cancelled-origin', { Housefile: 'FROM scratch\n' });
  const pending = source.fetch({ repository: origin.address, file: 'Housefile', branch: 'main' }, undefined, abort.signal), failed = expect(pending).rejects.toThrow(HouseSourceError);
  await vi.waitFor(() => expect(child).toBeDefined()); abort.abort(); await failed;
  expect(child!.signalCode).toBe('SIGKILL'); expect(started).toContain(child!.pid); expect(forgotten).toEqual(started);
  await expect(source.fetch({ repository: origin.address, file: 'Housefile', branch: 'main' }, undefined, abort.signal)).rejects.toThrow(HouseSourceError);
});
it('says whether this machine has a git it can run, new enough to fetch without writing the address down', () => {
  expect(gitAvailable()).toBe(true);
  expect([...GIT_MINIMUM]).toEqual([2, 32, 0]);
  expect(['git version 2.32.0', 'git version 2.34.1', 'git version 2.39.5', 'git version 2.47.3', 'git version 3.0.0', 'git version 2.39.5 (Apple Git-154)', 'git version 2.45.1.windows.1'].every(gitNewEnough)).toBe(true);
  // Older than what the fetch needs: no FETCH_HEAD (2.29), settings by environment (2.31), no per-user file (2.32).
  expect(['git version 2.31.8', 'git version 2.30.2', 'git version 2.29.0', 'git version 1.9.5', 'git version 2.32', 'git version 2', 'not git', ''].some(gitNewEnough)).toBe(false);
  vi.stubEnv('PATH', join(root, 'empty')); expect(gitAvailable()).toBe(false);
  // An old git on the path is no git for this.
  const old = join(root, 'old-git'); mkdirSync(old); writeFileSync(join(old, 'git'), '#!/bin/sh\necho git version 2.31.8\n', { mode: 0o755 });
  vi.stubEnv('PATH', old); expect(gitAvailable()).toBe(false);
});

it('keeps the mirrors of the repositories fetched most recently and removes the rest', async () => {
  const { HOUSE_MIRRORS_KEPT } = await import('./house-source.js');
  expect(HOUSE_MIRRORS_KEPT).toBe(8);
  const directory = join(root, 'bounded'), source = houseSource({ directory, protocols: ['file'], kept: 2 });
  const houses = ['one', 'two', 'three'].map(name => ({ repository: repository(`bounded-${name}`, { Housefile: name }).address, file: 'Housefile', branch: 'main' }));
  const mirrors = () => readdirSync(directory).filter(name => name.endsWith('.git')).sort();
  await source.fetch(houses[0], undefined, never()); const first = mirrors();
  await new Promise(resolve => setTimeout(resolve, 20)); await source.fetch(houses[1], undefined, never());
  expect(mirrors()).toHaveLength(2);
  await new Promise(resolve => setTimeout(resolve, 20)); await source.fetch(houses[2], undefined, never());
  // The oldest goes, beside the work and not in its way, and nothing but mirrors was ever in the directory to remove.
  await vi.waitFor(() => expect(mirrors()).toHaveLength(2)); expect(mirrors()).not.toContain(first[0]);
  // A house whose mirror was removed is simply fetched again.
  expect(await source.fetch(houses[0], undefined, never())).toMatch(/^[0-9a-f]{40}$/); await vi.waitFor(() => expect(mirrors()).toHaveLength(2));
});
it('makes a job for a repository wait while that repository\'s mirror is being removed, and then fetches it clean', async () => {
  const one = repository('removal-one', { Housefile: 'FROM scratch\n' }), two = repository('removal-two', { Housefile: 'FROM scratch\n' });
  const directory = join(root, 'removal'), held = { release: () => {}, started: [] as string[] }, asked: string[] = [];
  const source = houseSource({ directory, protocols: ['file'], kept: 1,
    // A removal that takes its time: half done until it is let go.
    remove: async path => { held.started.push(path); rmSync(join(path, 'HEAD'), { force: true }); await new Promise<void>(resolve => { held.release = resolve; }); rmSync(path, { recursive: true, force: true }); },
    spawn: (args, env, output, input) => { asked.push(args.join(' ')); return spawn('git', [...args], { env: { ...env }, detached: true, stdio: [input ?? 'ignore', output, 'ignore'] }); } });
  const first = { repository: one.address, file: 'Housefile', branch: 'main' }, second = { repository: two.address, file: 'Housefile', branch: 'main' };
  await source.fetch(first, undefined, never());
  const [mirror] = readdirSync(directory);
  // A second repository is fetched: the first mirror is beyond the one kept, and its removal begins. The fetch does not wait for it.
  expect(await source.fetch(second, undefined, never())).toBe(two.first);
  await vi.waitFor(() => expect(held.started).toEqual([join(directory, mirror)]));
  // A job for the first repository arrives while its mirror is half gone. Nothing is asked of git for it yet.
  asked.length = 0;
  let fetched: string | undefined; const again = source.fetch(first, undefined, never()).then(commit => { fetched = commit; });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(fetched).toBeUndefined(); expect(asked).toEqual([]);
  // The removal ends: the mirror is made again from nothing and fetched whole.
  held.release(); await again;
  expect(fetched).toBe(one.first); expect(asked[0]).toContain('init');
  expect((await all(source.context(first, one.first, never()))).toString('latin1')).toContain('FROM scratch');
});
it('looks again at each mirror just before it removes it: one a job has taken up meanwhile stays', async () => {
  const repositories = ['recheck-one', 'recheck-two', 'recheck-three'].map(name => repository(name, { Housefile: 'FROM scratch\n' }));
  const houses = repositories.map(found => ({ repository: found.address, file: 'Housefile', branch: 'main' }));
  const directory = join(root, 'recheck'), removed: string[] = []; let release = () => {}, held = true;
  // Two mirrors, made with room for both, the first the older.
  const roomy = houseSource({ directory, protocols: ['file'], kept: 8 });
  await roomy.fetch(houses[0], undefined, never()); const [older] = readdirSync(directory);
  await new Promise(resolve => setTimeout(resolve, 20)); await roomy.fetch(houses[1], undefined, never());
  const newer = readdirSync(directory).find(name => name !== older)!;
  // Now with room for one: a third fetch means both of those are to go, the newer of them first. Its removal is held open.
  const source = houseSource({ directory, protocols: ['file'], kept: 1,
    remove: async path => { if (held) { held = false; await new Promise<void>(resolve => { release = resolve; }); } removed.push(path); rmSync(path, { recursive: true, force: true }); } });
  await source.fetch(houses[2], undefined, never()); await vi.waitFor(() => expect(held).toBe(false));
  // Meanwhile a job begins to read the older one, which was chosen to go before that job came.
  const reading = source.context(houses[0], repositories[0].first, never());
  release(); await vi.waitFor(() => expect(removed).toEqual([join(directory, newer)]));
  await new Promise(resolve => setTimeout(resolve, 50));
  // It was looked at again when its turn came, found in use, and left: the read gets the whole of it.
  expect(removed).toEqual([join(directory, newer)]); expect(existsSync(join(directory, older, 'HEAD'))).toBe(true);
  expect((await all(reading)).toString('latin1')).toContain('FROM scratch');
});

