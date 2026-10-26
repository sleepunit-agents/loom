/**
 * Managed pieces (docs/specs/pieces-install.md): installed from a pinned git
 * commit into $LOOM_HOME/pieces, found before PATH, run with their own
 * environment, updated, rolled back and removed.
 *
 * npm is a stand-in, first on PATH: it lays a package from fixtures/ down
 * in the prefix the way `npm install --prefix <dir> github:o/r#<sha>` does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { findPiece, listPieces } from './pieces.js';
import { installPiece, parseLoomBlock, parseSource, pieceEnvFor, readCatalog } from './pieces-managed.js';

const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);

// The node running the tests, by path: a test's PATH is minimal, and on CI node isn't in /usr/bin.
const FAKE_NPM = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
const spec = args[args.length - 1];
const m = /^github:([^#]+)#(.+)$/.exec(spec);
const fixture = path.join(process.env.FAKE_NPM_FIXTURES, m[1].replace('/', '__') + '@' + m[2]);
if (!fs.existsSync(fixture)) { console.error('npm error 404 ' + spec); process.exit(1); }
const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf-8'));
const dir = path.join(prefix, 'node_modules', pkg.name);
fs.mkdirSync(dir, { recursive: true });
fs.cpSync(fixture, dir, { recursive: true });
fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ dependencies: { [pkg.name]: spec } }));
fs.mkdirSync(path.join(prefix, 'node_modules', '.bin'), { recursive: true });
for (const [b, rel] of Object.entries(pkg.bin || {})) {
  fs.chmodSync(path.join(dir, rel), 0o755);
  fs.symlinkSync(path.join('..', pkg.name, rel), path.join(prefix, 'node_modules', '.bin', b));
}
console.log('added 1 package');
`;

describe('managed pieces', () => {
  let tmp: string;
  let loomHome: string;
  let fixtures: string;
  let onPath: string;
  let env: Record<string, string>;

  /** A package fixture for repo@commit: bins are shell scripts. */
  async function fixture(repo: string, commit: string, pkg: Record<string, unknown>, scripts: Record<string, string>) {
    const dir = join(fixtures, `${repo.replace('/', '__')}@${commit}`);
    await mkdir(join(dir, 'bin'), { recursive: true });
    const bin: Record<string, string> = {};
    for (const [name, body] of Object.entries(scripts)) {
      await writeFile(join(dir, 'bin', name), `#!/bin/sh\n${body}\n`);
      bin[name] = `bin/${name}`;
    }
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', ...pkg, bin }));
  }

  const tasksPkg = (version: string) => ({
    name: 'taskstore', version,
    loom: {
      role: 'tasks', label: 'Tasks',
      settings: [
        { name: 'TASKSTORE_DB', label: 'Store file', default: '${LOOM_PIECE_HOME}/data/store.db' },
        { name: 'TASKSTORE_OWNER', label: 'Whose call', required: true },
      ],
    },
  });
  const tasksBins = (tag: string) => ({
    'loom-tasks': `echo "${tag} name=$LOOM_PIECE_NAME home=$LOOM_PIECE_HOME db=$TASKSTORE_DB owner=$TASKSTORE_OWNER args=$*"`,
    taskstore: `echo "${tag} plain"`,
  });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'loom-managed-'));
    loomHome = join(tmp, 'home');
    fixtures = join(tmp, 'fixtures');
    onPath = join(tmp, 'path');
    await mkdir(onPath, { recursive: true });
    await mkdir(join(tmp, 'npmbin'));
    await writeFile(join(tmp, 'npmbin', 'npm'), FAKE_NPM);
    await chmod(join(tmp, 'npmbin', 'npm'), 0o755);
    env = {
      LOOM_HOME: loomHome, FAKE_NPM_FIXTURES: fixtures,
      PATH: [join(tmp, 'npmbin'), onPath, '/usr/bin', '/bin'].join(delimiter),
    };
    await fixture('sleepunit-agents/taskstore', SHA1, tasksPkg('0.4.0'), tasksBins('v1'));
    await fixture('sleepunit-agents/taskstore', SHA2, tasksPkg('0.5.0'), tasksBins('v2'));
    await fixture('sleepunit-agents/taskstore', SHA3, tasksPkg('0.6.0'), tasksBins('v3'));
  });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  const install = (commit: string, ...more: string[]) =>
    runCliCaptured(['pieces', 'install', '--from', `github:sleepunit-agents/taskstore#${commit}`, '--yes', ...more], { env });

  it('installs from a commit, is found before PATH, and runs with its own home and settings', async () => {
    await writeFile(join(onPath, 'loom-tasks'), '#!/bin/sh\necho from-path\n');
    await chmod(join(onPath, 'loom-tasks'), 0o755);
    const r = await install(SHA1);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('installed tasks 0.4.0');
    expect(r.stdout).toContain('needs settings: loom pieces set tasks TASKSTORE_OWNER=');
    const home = join(loomHome, 'pieces', 'tasks');
    expect(findPiece('tasks', env)).toBe(join(loomHome, 'pieces', 'bin', 'loom-tasks'));
    const run = await runCliCaptured(['tasks', 'ready'], { env });
    expect(run.stdout).toBe(`v1 name=tasks home=${home} db=${home}/data/store.db owner= args=ready\n`);
    // Every bin is linked, through current.
    expect(await readlink(join(loomHome, 'pieces', 'bin', 'taskstore'))).toBe('../tasks/current/node_modules/.bin/taskstore');
    expect(await readlink(join(home, 'current'))).toBe(`versions/${SHA1}`);
    const rec = JSON.parse(await readFile(join(home, 'piece.json'), 'utf-8'));
    expect([rec.name, rec.package, rec.version, rec.source]).toEqual(['tasks', 'taskstore', '0.4.0', { repo: 'sleepunit-agents/taskstore', commit: SHA1 }]);
    const listed = await runCliCaptured(['pieces', '--json'], { env });
    expect(JSON.parse(listed.stdout)).toEqual([{ name: 'tasks', path: join(loomHome, 'pieces', 'bin', 'loom-tasks'),
      managed: { version: '0.4.0', commit: SHA1, repo: 'sleepunit-agents/taskstore', needsSetup: ['TASKSTORE_OWNER'] } }]);
  });

  it('settings: the owner beats the daemon, the daemon beats a default, and only declared names are taken', async () => {
    await install(SHA1);
    const daemon = { ...env, TASKSTORE_DB: '/srv/tasks.db', TASKSTORE_OWNER: 'robin' };
    expect((await runCliCaptured(['tasks'], { env: daemon })).stdout).toContain('db=/srv/tasks.db owner=robin');
    expect((await runCliCaptured(['pieces', 'set', 'tasks', 'TASKSTORE_OWNER=sam'], { env })).code).toBe(0);
    expect((await runCliCaptured(['tasks'], { env: daemon })).stdout).toContain('owner=sam');
    const st = await stat(join(loomHome, 'pieces', 'tasks', 'settings.json'));
    expect(st.mode & 0o777).toBe(0o600);
    const bad = await runCliCaptured(['pieces', 'set', 'tasks', 'SOMETHING=1'], { env });
    expect([bad.code, bad.stderr]).toEqual([1, 'loom pieces: tasks has no setting SOMETHING (it has TASKSTORE_DB, TASKSTORE_OWNER)\n']);
    expect(JSON.parse((await runCliCaptured(['pieces', '--json'], { env })).stdout)[0].managed.needsSetup).toBeUndefined();
    // Only for the managed piece: the same env reaches an unmanaged one untouched.
    expect(pieceEnvFor(join(onPath, 'loom-tasks'), env)).toBe(env);
  });

  it('an update keeps the one before; rollback goes back; a third install drops the oldest', async () => {
    await install(SHA1);
    expect((await install(SHA2)).stdout).toContain('updated tasks 0.5.0');
    const home = join(loomHome, 'pieces', 'tasks');
    expect((await runCliCaptured(['tasks'], { env })).stdout).toMatch(/^v2 /);
    const back = await runCliCaptured(['pieces', 'rollback', 'tasks'], { env });
    expect(back.stdout).toBe(`tasks is back on 0.4.0 (${SHA1.slice(0, 12)})\n`);
    expect((await runCliCaptured(['tasks'], { env })).stdout).toMatch(/^v1 /);
    await install(SHA3);
    expect(existsSync(join(home, 'versions', SHA3))).toBe(true);
    expect(existsSync(join(home, 'versions', SHA1))).toBe(true);
    expect(existsSync(join(home, 'versions', SHA2))).toBe(false);
  });

  it('a failed install leaves what was current untouched, and keeps npm\'s output', async () => {
    await install(SHA1);
    const r = await install('4'.repeat(40));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('npm install failed (exit 1)');
    expect(await readFile(join(loomHome, 'pieces', 'install.log'), 'utf-8')).toContain('npm error 404');
    expect((await runCliCaptured(['tasks'], { env })).stdout).toMatch(/^v1 /);
    expect((await stat(join(loomHome, 'pieces'))).isDirectory()).toBe(true);
  });

  it('refuses a source that could move, a stranger without --yes, and packages that would break the namespace', async () => {
    expect(() => parseSource('github:a/b#main')).toThrow(/full 40-character commit/);
    expect(() => parseSource(`github:a/b#${SHA1.slice(0, 7)}`)).toThrow(/full 40-character commit/);
    expect(() => parseSource('https://evil.example/x')).toThrow(/github:<owner>/);
    const noYes = await runCliCaptured(['pieces', 'install', '--from', `github:sleepunit-agents/taskstore#${SHA1}`], { env });
    expect(noYes.code).toBe(2);
    expect(noYes.stderr).toContain('installing it is running it');
    expect(existsSync(join(loomHome, 'pieces', 'tasks'))).toBe(false);

    await fixture('x/two', SHA1, { name: 'two' }, { 'loom-a': 'true', 'loom-b': 'true' });
    expect((await runCliCaptured(['pieces', 'install', '--from', `github:x/two#${SHA1}`, '--yes'], { env })).stderr)
      .toContain('exactly one loom-<name> bin; two has 2');
    await install(SHA1);
    await fixture('x/thief', SHA1, { name: 'thief' }, { 'loom-thief': 'true', taskstore: 'echo stolen' });
    expect((await runCliCaptured(['pieces', 'install', '--from', `github:x/thief#${SHA1}`, '--yes'], { env })).stderr)
      .toContain("taskstore is already the tasks piece's");
    expect(parseLoomBlock({ settings: [{ name: 'API_KEY', label: 'Key', kind: 'secret' }] })).toMatch(/no secret kind/);
    expect(parseLoomBlock({ settings: [{ name: 'LOOM_URL', label: 'x' }] })).toMatch(/isn't LOOM_\*/);
    expect(parseLoomBlock({ settings: [{ name: 'PATH', label: 'x' }] })).toMatch(/PATH/);
  });

  it('remove keeps settings and data unless --purge, and never takes another piece\'s links', async () => {
    await install(SHA1);
    await fixture('x/tasks2', SHA1, { name: 'tasks2' }, { 'loom-tasksx': 'echo x' });
    await runCliCaptured(['pieces', 'install', '--from', `github:x/tasks2#${SHA1}`, '--yes'], { env });
    await runCliCaptured(['pieces', 'set', 'tasks', 'TASKSTORE_OWNER=sam'], { env });
    const r = await runCliCaptured(['pieces', 'remove', 'tasks'], { env });
    expect(r.stdout).toContain('its settings and data are kept');
    expect(findPiece('tasks', env)).toBeUndefined();
    expect(findPiece('tasksx', env)).toBe(join(loomHome, 'pieces', 'bin', 'loom-tasksx'));
    expect(existsSync(join(loomHome, 'pieces', 'tasks', 'settings.json'))).toBe(true);
    await install(SHA1);
    expect((await runCliCaptured(['tasks'], { env })).stdout).toContain('owner=sam');
    await runCliCaptured(['pieces', 'remove', 'tasks', '--purge'], { env });
    expect(existsSync(join(loomHome, 'pieces', 'tasks'))).toBe(false);
    expect(listPieces(env).map((p) => p.name)).toEqual(['tasksx']);
  });

  it('the catalog installs by name and offers updates', async () => {
    const cat = join(tmp, 'pieces.json');
    await writeFile(cat, JSON.stringify({ v: 1, pieces: [
      { name: 'tasks', repo: 'sleepunit-agents/taskstore', commit: SHA2 },
      { name: 'bad', repo: 'not a repo', commit: SHA1 },
    ] }));
    expect(readCatalog(cat).map((c) => c.name)).toEqual(['tasks']);
    const r = await installPiece(env, { repo: 'sleepunit-agents/taskstore', commit: SHA1 }, 'tasks');
    expect(r.record.version).toBe('0.4.0');
    await expect(installPiece(env, { repo: 'sleepunit-agents/taskstore', commit: SHA1 }, 'other')).rejects.toThrow(/installs loom-tasks, not loom-other/);
    // The shipped catalog is valid, and every entry is a public piece pinned to a commit.
    for (const c of readCatalog()) expect(c.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readCatalog().length).toBeGreaterThan(0);
  });

  it('with no LOOM_HOME and no HOME, there is no managed dir and PATH is all there is', () => {
    expect(listPieces({ PATH: onPath })).toEqual([]);
    expect(pieceEnvFor('/x/loom-tasks', { PATH: onPath })).toEqual({ PATH: onPath });
  });
});
