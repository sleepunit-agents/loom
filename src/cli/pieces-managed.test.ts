/**
 * Managed pieces (docs/specs/pieces-install.md): installed from a pinned git
 * commit into $LOOM_HOME/pieces, found before PATH, run with their own
 * environment, updated, rolled back and removed.
 *
 * npm is a stand-in, first on PATH: it lays a package from fixtures/ down
 * in the prefix the way `npm install --prefix <dir> github:o/r#<sha>` does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
    // The shipped catalog has tasks from the same repo at another commit: that's an update on offer.
    const offered = readCatalog().find((c) => c.name === 'tasks' && c.repo === 'sleepunit-agents/taskstore')?.commit;
    expect(JSON.parse(listed.stdout)).toEqual([{ name: 'tasks', path: join(loomHome, 'pieces', 'bin', 'loom-tasks'),
      managed: { version: '0.4.0', commit: SHA1, repo: 'sleepunit-agents/taskstore', needsSetup: ['TASKSTORE_OWNER'], ...(offered ? { update: offered } : {}) } }]);
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
      .toContain('two has 2 loom-<name> bins (loom-a, loom-b): its loom block names which one is the piece (loom.name)');
    await install(SHA1);
    await fixture('x/thief', SHA1, { name: 'thief' }, { 'loom-thief': 'true', taskstore: 'echo stolen' });
    expect((await runCliCaptured(['pieces', 'install', '--from', `github:x/thief#${SHA1}`, '--yes'], { env })).stderr)
      .toContain("taskstore is already the tasks piece's");
    expect(parseLoomBlock({ settings: [{ name: 'API_KEY', label: 'Key', kind: 'secret' }] })).toMatch(/no secret kind/);
    expect(parseLoomBlock({ settings: [{ name: 'LOOM_URL', label: 'x' }] }, 'box')).toMatch(/isn't loom's own \(LOOM_\*, apart from LOOM_BOX_\*\)/);
    expect(parseLoomBlock({ settings: [{ name: 'LOOM_BOX_PUBLIC_URL', label: 'x' }] }, 'box')).toMatchObject({ settings: [{ name: 'LOOM_BOX_PUBLIC_URL' }] });
    expect(parseLoomBlock({ settings: [{ name: 'LOOM_BOX_PUBLIC_URL', label: 'x' }] }, 'tasks')).toMatch(/isn't loom's own/);
    expect(parseLoomBlock({ settings: [{ name: 'PATH', label: 'x' }] })).toMatch(/PATH/);
  });

  it('a package with several loom-<name> bins names its piece; the others are part of it', async () => {
    await fixture('x/multi', SHA1, { name: 'multi', loom: { name: 'shuttle', settings: [{ name: 'SHUTTLE_INSTANCE', label: 'Instance' }] } },
      { 'loom-shuttle': 'echo "shuttle $LOOM_PIECE_NAME $SHUTTLE_INSTANCE"', 'loom-subscriptions': 'echo "subs $LOOM_PIECE_NAME $SHUTTLE_INSTANCE"' });
    const r = await runCliCaptured(['pieces', 'install', '--from', `github:x/multi#${SHA1}`, '--yes'], { env });
    expect(r.stdout).toContain('installed shuttle');
    await runCliCaptured(['pieces', 'set', 'shuttle', 'SHUTTLE_INSTANCE=/srv/shuttle.json'], { env });
    expect((await runCliCaptured(['subscriptions'], { env })).stdout).toBe('subs shuttle /srv/shuttle.json\n');
    const listed = JSON.parse((await runCliCaptured(['pieces', '--json'], { env })).stdout);
    expect(listed.map((p: { name: string; managed?: { partOf?: string } }) => [p.name, p.managed?.partOf])).toEqual([['shuttle', undefined], ['subscriptions', 'shuttle']]);
    await fixture('x/multi', SHA2, { name: 'multi', loom: { name: 'nope' } }, { 'loom-a': 'true', 'loom-b': 'true' });
    expect((await runCliCaptured(['pieces', 'install', '--from', `github:x/multi#${SHA2}`, '--yes'], { env })).stderr)
      .toContain('loom.name is nope, which isn\'t one of its bins (loom-a, loom-b)');
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

  it('services: a unit per declared service, with the piece\'s env, restarted on change, gone with the piece', async () => {
    const xdg = join(tmp, 'xdg');
    const calls = join(tmp, 'systemctl.log');
    await writeFile(join(tmp, 'npmbin', 'systemctl'), `#!/bin/sh\necho "$*" >> '${calls}'\n[ "$2" = show-environment ] && [ -n "$NO_SYSTEMD" ] && exit 1\nexit 0\n`);
    await chmod(join(tmp, 'npmbin', 'systemctl'), 0o755);
    const senv = { ...env, XDG_CONFIG_HOME: xdg };
    await fixture('x/svc', SHA1, { name: 'svc', version: '1.0.0', loom: {
      settings: [{ name: 'SVC_URL', label: 'URL', default: 'http://default' }],
      services: [{ name: 'run', argv: ['loom-svc', 'run', '--dir=$HOME/100%'], keepChildren: true }],
    } }, { 'loom-svc': 'exit 0' });
    await fixture('x/svc', SHA2, { name: 'svc', version: '2.0.0', loom: { services: [] } }, { 'loom-svc': 'exit 0' });
    const r = await runCliCaptured(['pieces', 'install', '--from', `github:x/svc#${SHA1}`, '--yes'], { env: senv });
    expect(r.stdout).toContain('running: loom-piece-svc-run.service');
    const unit = await readFile(join(xdg, 'systemd', 'user', 'loom-piece-svc-run.service'), 'utf-8');
    const bin = join(loomHome, 'pieces', 'bin');
    expect(unit).toContain(`ExecStart="${bin}/loom-svc" "run" "--dir=$$HOME/100%%"`);
    expect(unit).toContain(`EnvironmentFile=${join(loomHome, 'pieces', 'svc', 'service.env')}`);
    expect(unit).toContain('KillMode=process');
    const senvFile = await readFile(join(loomHome, 'pieces', 'svc', 'service.env'), 'utf-8');
    expect(senvFile).toContain('LOOM_PIECE_NAME="svc"');
    expect(senvFile).toContain('SVC_URL="http://default"');
    expect(senvFile).toMatch(new RegExp(`^PATH="${bin}:`, 'm'));
    expect((await stat(join(loomHome, 'pieces', 'svc', 'service.env'))).mode & 0o777).toBe(0o600);
    expect(await readFile(calls, 'utf-8')).toContain('--user enable --now loom-piece-svc-run.service');
    // New settings: the env file is rewritten and the service restarted.
    await runCliCaptured(['pieces', 'set', 'svc', 'SVC_URL=https://real'], { env: senv });
    expect(await readFile(join(loomHome, 'pieces', 'svc', 'service.env'), 'utf-8')).toContain('SVC_URL="https://real"');
    expect(await readFile(calls, 'utf-8')).toContain('--user restart loom-piece-svc-run.service');
    // A version that drops the service stops and removes its unit; rolling back brings it back.
    await runCliCaptured(['pieces', 'install', '--from', `github:x/svc#${SHA2}`, '--yes'], { env: senv });
    expect(await readFile(calls, 'utf-8')).toContain('--user disable --now loom-piece-svc-run.service');
    expect(existsSync(join(xdg, 'systemd', 'user', 'loom-piece-svc-run.service'))).toBe(false);
    await runCliCaptured(['pieces', 'rollback', 'svc'], { env: senv });
    expect(existsSync(join(xdg, 'systemd', 'user', 'loom-piece-svc-run.service'))).toBe(true);
    await runCliCaptured(['pieces', 'remove', 'svc'], { env: senv });
    expect(existsSync(join(xdg, 'systemd', 'user', 'loom-piece-svc-run.service'))).toBe(false);
    // No user systemd: nothing written, and the owner is told how to start it.
    const none = await runCliCaptured(['pieces', 'install', '--from', `github:x/svc#${SHA1}`, '--yes'], { env: { ...senv, NO_SYSTEMD: '1' } });
    expect(none.stdout).toContain("There's no user systemd here, so loom can't run svc's services. Start them by hand: loom-svc run --dir=$HOME/100%");
    expect(existsSync(join(xdg, 'systemd', 'user', 'loom-piece-svc-run.service'))).toBe(false);
  });

  it('a piece runs on the node it was installed with, first on its PATH (its native modules were built for it)', async () => {
    // The daemon's PATH may find another node (/usr/bin/node 20 while npm ran on 24).
    const nodeDir = join(tmp, 'node24');
    await mkdir(nodeDir);
    await symlink(process.execPath, join(nodeDir, 'node'));
    const installEnv = { ...env, PATH: [join(tmp, 'npmbin'), nodeDir, onPath, '/usr/bin', '/bin'].join(delimiter) };
    await fixture('x/native', SHA1, { name: 'native' }, { 'loom-native': 'echo "PATH=$PATH"' });
    await runCliCaptured(['pieces', 'install', '--from', `github:x/native#${SHA1}`, '--yes'], { env: installEnv });
    const rec = JSON.parse(await readFile(join(loomHome, 'pieces', 'native', 'piece.json'), 'utf-8'));
    expect(rec.node).toBe(join(nodeDir, 'node'));
    // Run later by a daemon whose PATH has no such node: it's put first.
    const run = await runCliCaptured(['native'], { env: { ...env, PATH: [onPath, '/usr/bin', '/bin'].join(delimiter) } });
    expect(run.stdout.trim()).toBe(`PATH=${[nodeDir, onPath, '/usr/bin', '/bin'].join(delimiter)}`);
  });

  it('with no LOOM_HOME and no HOME, there is no managed dir and PATH is all there is', () => {
    expect(listPieces({ PATH: onPath })).toEqual([]);
    expect(pieceEnvFor('/x/loom-tasks', { PATH: onPath })).toEqual({ PATH: onPath });
  });
});
