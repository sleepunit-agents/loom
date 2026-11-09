/**
 * Managed pieces (docs/specs/pieces-install.md): installed from a pinned git
 * commit into $LOOM_HOME/pieces, found before PATH, run with their own
 * environment, updated, rolled back and removed.
 *
 * npm is a stand-in, first on PATH: it lays a package from fixtures/ down
 * in the prefix the way `npm install --prefix <dir> github:o/r#<sha>` does.
 * For a local piece it packs a directory into a "tarball" (its files as JSON:
 * the same files, the same bytes) and installs one the same way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { runCliCaptured } from './test-helpers.js';
import { findPiece, listPieces } from './pieces.js';
import { PIECE_ALIASES, installPiece, parseFrom, parseLoomBlock, parseSource, pieceEnvFor, readCatalog } from './pieces-managed.js';
import { execFileSync } from 'node:child_process';
import { listVenues } from '../household-store.js';

const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);

// The node running the tests, by path: a test's PATH is minimal, and on CI node isn't in /usr/bin.
const FAKE_NPM = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
function walk(root, rel = '') {
  return fs.readdirSync(path.join(root, rel)).sort().filter((f) => f !== 'node_modules' && f !== '.git').flatMap((f) => {
    const r = path.join(rel, f);
    return fs.statSync(path.join(root, r)).isDirectory() ? walk(root, r) : [[r, fs.readFileSync(path.join(root, r), 'base64')]];
  });
}
if (args[0] === 'pack') {
  const src = args[1], dest = args[args.indexOf('--pack-destination') + 1];
  const p = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf-8'));
  const tgz = p.name.replace(/^@/, '').replace('/', '-') + '-' + p.version + '.tgz';
  fs.writeFileSync(path.join(dest, tgz), JSON.stringify(walk(src)));
  console.log(tgz);
  process.exit(0);
}
const prefix = args[args.indexOf('--prefix') + 1];
const spec = args[args.length - 1];
let files;
if (spec.endsWith('.tgz')) files = JSON.parse(fs.readFileSync(spec, 'utf-8'));
else {
  const m = /^github:([^#]+)#(.+)$/.exec(spec);
  const fixture = path.join(process.env.FAKE_NPM_FIXTURES, m[1].replace('/', '__') + '@' + m[2]);
  if (!fs.existsSync(fixture)) { console.error('npm error 404 ' + spec); process.exit(1); }
  files = walk(fixture);
}
const pkg = JSON.parse(Buffer.from(files.find(([r]) => r === 'package.json')[1], 'base64').toString());
const dir = path.join(prefix, 'node_modules', pkg.name);
for (const [r, b64] of files) {
  fs.mkdirSync(path.dirname(path.join(dir, r)), { recursive: true });
  fs.writeFileSync(path.join(dir, r), Buffer.from(b64, 'base64'));
}
fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ dependencies: { [pkg.name]: spec.endsWith('.tgz') ? 'file:' + path.basename(spec) : spec } }));
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
    await packageAt(join(fixtures, `${repo.replace('/', '__')}@${commit}`), pkg, scripts);
  }

  /** A package in `dir`: bins are shell scripts. */
  async function packageAt(dir: string, pkg: Record<string, unknown>, scripts: Record<string, string>) {
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

  describe('offers (src/offers.ts) at install', () => {
    const tool = { description: 'A house for a body', input_schema: { type: 'object' }, argv: ['loom-runtime', 'house'] };
    const installFrom = (repo: string, commit = SHA1) => runCliCaptured(['pieces', 'install', '--from', `github:${repo}#${commit}`, '--yes'], { env });

    it('keeps a copy of the declarations in piece.json, checked against the package\'s own bins', async () => {
      const loom = {
        role: 'runtime', grants: ['loom-runtime', 'grants'],
        sections: { project: { label: 'Houses', argv: ['loom-runtime', 'feed'] } },
        venues: { relay: { label: 'Relay', kind: 'agent', send: ['loom-runtime', 'send'] } },
        mcp_tools: { house: tool },
      };
      await fixture('x/runtime', SHA1, { name: 'runtime', loom }, { 'loom-runtime': 'true' });
      expect((await installFrom('x/runtime')).code).toBe(0);
      const rec = JSON.parse(await readFile(join(loomHome, 'pieces', 'runtime', 'piece.json'), 'utf-8'));
      expect(rec.loom).toMatchObject({
        grants: ['loom-runtime', 'grants'], sections: { project: { label: 'Houses', argv: ['loom-runtime', 'feed'], unfiled: false } },
        venues: loom.venues, mcp_tools: loom.mcp_tools,
      });
    });

    it('conversations criterion 5: core\'s venues registry follows install, update and remove; removal orphans, reinstall clears', async () => {
      const slack = { label: 'Slack', kind: 'live', render: ['loom-slack', 'render'] };
      await fixture('x/slack', SHA1, { name: 'slack', loom: { venues: { slack } } }, { 'loom-slack': 'true' });
      await fixture('x/slack', SHA2, { name: 'slack', loom: { venues: { slack: { ...slack, label: 'Slack (work)' }, 'slack-huddle': { label: 'Huddle', kind: 'live' } } } }, { 'loom-slack': 'true' });
      expect((await installFrom('x/slack')).code).toBe(0);
      expect(listVenues(loomHome)).toEqual([{ name: 'slack', piece: 'slack', label: 'Slack', kind: 'live', render: ['loom-slack', 'render'] }]);
      expect((await installFrom('x/slack', SHA2)).code).toBe(0);
      expect(listVenues(loomHome).map((v) => [v.name, v.label, v.orphaned === undefined])).toEqual([['slack', 'Slack (work)', true], ['slack-huddle', 'Huddle', true]]);
      expect((await runCliCaptured(['pieces', 'remove', 'slack', '--purge'], { env })).code).toBe(0);
      const gone = listVenues(loomHome);
      expect(gone.map((v) => [v.name, v.label, v.kind, typeof v.orphaned, v.render])).toEqual([['slack', 'Slack (work)', 'live', 'string', undefined], ['slack-huddle', 'Huddle', 'live', 'string', undefined]]);
      expect((await installFrom('x/slack')).code).toBe(0);
      expect(listVenues(loomHome).map((v) => [v.name, v.orphaned === undefined, v.render])).toEqual([['slack', true, ['loom-slack', 'render']], ['slack-huddle', false, undefined]]);
    });

    it('an invalid offer rejects the whole block, and nothing is installed', async () => {
      await fixture('x/bad', SHA1, { name: 'bad', loom: { label: 'Bad', sections: { project: { label: 'X', argv: ['sh', '-c', 'x'] } } } }, { 'loom-bad': 'true' });
      const r = await installFrom('x/bad');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("loom.sections.project.argv[0] must be one of the piece's own bins (loom-bad)");
      expect(existsSync(join(loomHome, 'pieces', 'bad', 'piece.json'))).toBe(false);
    });

    it('refuses a second grants authority, and a tool or venue name another piece has; the piece itself may update', async () => {
      await fixture('x/runtime', SHA1, { name: 'runtime', loom: { role: 'runtime', grants: ['loom-runtime', 'grants'], mcp_tools: { house: tool }, venues: { relay: { label: 'Relay', kind: 'agent' } } } }, { 'loom-runtime': 'true' });
      await fixture('x/runtime', SHA2, { name: 'runtime', loom: { role: 'runtime', grants: ['loom-runtime', 'grants'], mcp_tools: { house: tool }, venues: { relay: { label: 'Relay', kind: 'agent' } } } }, { 'loom-runtime': 'true' });
      expect((await installFrom('x/runtime')).code).toBe(0);
      expect((await installFrom('x/runtime', SHA2)).code).toBe(0);

      await fixture('x/rival', SHA1, { name: 'rival', loom: { grants: ['loom-rival'] } }, { 'loom-rival': 'true' });
      expect((await installFrom('x/rival')).stderr).toContain('the runtime piece is already the grants authority: there is only one');
      await fixture('x/tooly', SHA1, { name: 'tooly', loom: { mcp_tools: { house: { ...tool, argv: ['loom-tooly'] } } } }, { 'loom-tooly': 'true' });
      expect((await installFrom('x/tooly')).stderr).toContain("tool house is already the runtime piece's");
      await fixture('x/venuey', SHA1, { name: 'venuey', loom: { role: 'runtime', venues: { relay: { label: 'R', kind: 'agent' } } } }, { 'loom-venuey': 'true' });
      expect((await installFrom('x/venuey')).stderr).toContain("venue relay is already the runtime piece's");
      for (const p of ['rival', 'tooly', 'venuey']) expect(existsSync(join(loomHome, 'pieces', p, 'piece.json'))).toBe(false);

      // Once the authority is removed, another piece may be it.
      expect((await runCliCaptured(['pieces', 'remove', 'runtime'], { env })).code).toBe(0);
      expect((await installFrom('x/rival')).code).toBe(0);
    });

    it('delivery (agent-runtime.md, Seams 2): only from a runtime-role piece, and only one installed piece offers it', async () => {
      await fixture('x/runtime', SHA1, { name: 'runtime', loom: { role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'] } }, { 'loom-runtime': 'true' });
      await fixture('x/runtime', SHA2, { name: 'runtime', loom: { role: 'runtime', delivery: ['loom-runtime', 'deliver'] } }, { 'loom-runtime': 'true' });
      expect((await installFrom('x/runtime')).code).toBe(0);
      expect(JSON.parse(await readFile(join(loomHome, 'pieces', 'runtime', 'piece.json'), 'utf-8')).loom.delivery).toEqual(['loom-runtime', 'deliver', '--json']);
      // Its own update is no rival.
      expect((await installFrom('x/runtime', SHA2)).code).toBe(0);

      await fixture('x/adapter', SHA1, { name: 'adapter', loom: { delivery: ['loom-adapter', 'deliver'] } }, { 'loom-adapter': 'true' });
      const notRuntime = await installFrom('x/adapter');
      expect(notRuntime.code).not.toBe(0);
      expect(notRuntime.stderr).toContain('loom.delivery is declared only by the runtime');
      await fixture('x/second', SHA1, { name: 'second', loom: { role: 'runtime', delivery: ['loom-second', 'deliver'] } }, { 'loom-second': 'true' });
      expect((await installFrom('x/second')).stderr).toContain('the runtime piece already offers delivery: there is only one');
      for (const p of ['adapter', 'second']) expect(existsSync(join(loomHome, 'pieces', p, 'piece.json'))).toBe(false);

      expect((await runCliCaptured(['pieces', 'remove', 'runtime'], { env })).code).toBe(0);
      expect((await installFrom('x/second')).code).toBe(0);
    });

    it('a second role:runtime piece is refused at install; the runtime itself may update', async () => {
      await fixture('x/runtime', SHA1, { name: 'runtime', loom: { role: 'runtime' } }, { 'loom-runtime': 'true' });
      await fixture('x/runtime', SHA2, { name: 'runtime', loom: { role: 'runtime', label: 'Runtime' } }, { 'loom-runtime': 'true' });
      expect((await installFrom('x/runtime')).code).toBe(0);
      expect((await installFrom('x/runtime', SHA2)).code).toBe(0);
      await fixture('x/pretender', SHA1, { name: 'pretender', loom: { role: 'runtime' } }, { 'loom-pretender': 'true' });
      const r = await installFrom('x/pretender');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('the runtime piece is already the runtime: a household has one');
      expect(existsSync(join(loomHome, 'pieces', 'pretender', 'piece.json'))).toBe(false);
    });
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
    // Only an absolute PATH entry is taken as the node, and a recorded one is used only while it's absolute and there.
    rec.node = 'relative/node';
    await writeFile(join(loomHome, 'pieces', 'native', 'piece.json'), JSON.stringify(rec));
    expect((await runCliCaptured(['native'], { env: { ...env, PATH: '/usr/bin:/bin' } })).stdout.trim()).toBe('PATH=/usr/bin:/bin');
    await runCliCaptured(['pieces', 'install', '--from', `github:x/native#${SHA1}`, '--yes'], { env: { ...installEnv, PATH: ['.', join(tmp, 'npmbin'), '/usr/bin', '/bin'].join(delimiter) } });
    const again = JSON.parse(await readFile(join(loomHome, 'pieces', 'native', 'piece.json'), 'utf-8'));
    expect(again.node === undefined || isAbsolute(again.node)).toBe(true);
  });

  describe('an old piece name (PIECE_ALIASES: box is now runtime)', () => {
    const installFrom = (repo: string, commit = SHA1) => runCliCaptured(['pieces', 'install', '--from', `github:${repo}#${commit}`, '--yes'], { env });
    const runtimePkg = { name: 'loom-runtime', loom: { name: 'runtime', role: 'runtime', label: 'Runtime' } };
    const both = { 'loom-runtime': 'true', 'loom-box': 'true' };

    it('the table is box → runtime, and the catalog lists loom-box\'s repo as runtime at its pinned commit', () => {
      expect(PIECE_ALIASES).toEqual({ box: 'runtime' });
      const c = readCatalog();
      expect(c[0]).toMatchObject({ name: 'runtime', repo: 'sleepunit-agents/loom-box', commit: '64be51bc7275a134d2a01b907ca0df3dfa0edf8f', label: 'Runtime', version: '0.1.0' });
      expect(c.find((x) => x.name === 'box')).toBeUndefined();
    });

    it('a piece can\'t be installed as box while runtime is', async () => {
      await fixture('x/runtime', SHA1, runtimePkg, both);
      expect((await installFrom('x/runtime')).code).toBe(0);
      await fixture('x/oldbox', SHA1, { name: 'loom-box-old', loom: { name: 'box' } }, { 'loom-box': 'true' });
      const r = await installFrom('x/oldbox');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("box is an old name for runtime, which is installed: a piece can't be installed as box while runtime is");
      expect(existsSync(join(loomHome, 'pieces', 'box', 'piece.json'))).toBe(false);
    });

    it('update box (the old package, from the repo the catalog now calls runtime) says how to switch, and changes nothing', async () => {
      const repo = 'sleepunit-agents/loom-box';
      await fixture(repo, SHA1, { name: 'loom-box', loom: { label: 'Boxes', settings: [{ name: 'LOOM_BOX_PUBLIC_URL', label: 'URL' }] } }, { 'loom-box': 'true' });
      expect((await installFrom(repo)).code).toBe(0);
      const before = await readFile(join(loomHome, 'pieces', 'box', 'piece.json'), 'utf-8');
      const r = await runCliCaptured(['pieces', 'update', 'box'], { env });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('box is now the runtime piece (the same repo, renamed), so it doesn\'t update in place');
      expect(r.stderr).toContain('loom pieces remove box (its settings and data are kept), then loom pieces install runtime');
      expect(await readFile(join(loomHome, 'pieces', 'box', 'piece.json'), 'utf-8')).toBe(before);
      // Following the advice: the runtime installs once box is gone, and box's settings are still there.
      await runCliCaptured(['pieces', 'set', 'box', 'LOOM_BOX_PUBLIC_URL=https://loom.example'], { env });
      await fixture(repo, '64be51bc7275a134d2a01b907ca0df3dfa0edf8f', runtimePkg, both);
      expect((await runCliCaptured(['pieces', 'remove', 'box'], { env })).code).toBe(0);
      const inst = await runCliCaptured(['pieces', 'install', 'runtime'], { env });
      expect(inst.stderr).toBe('');
      expect(inst.code).toBe(0);
      expect(JSON.parse(await readFile(join(loomHome, 'pieces', 'runtime', 'piece.json'), 'utf-8')).bins.sort()).toEqual(['loom-box', 'loom-runtime']);
      expect(existsSync(join(loomHome, 'pieces', 'box', 'settings.json'))).toBe(true);
    });
  });

  describe('local pieces (--from path:)', () => {
    let src: string;
    const hl = (version: string, tag: string) => packageAt(src, { name: '@art/homelab', version, loom: { label: 'Homelab', settings: [{ name: 'HL_HOST', label: 'Host', default: 'nas' }] } },
      { 'loom-homelab': `echo "${tag} name=$LOOM_PIECE_NAME host=$HL_HOST"` });
    const installLocal = (dir: string, ...more: string[]) => runCliCaptured(['pieces', 'install', '--from', `path:${dir}`, ...more], { env });
    beforeEach(async () => { src = join(tmp, 'src', 'homelab'); await hl('1.0.0', 'v1'); });

    it('installs a snapshot of the directory, versioned by its hash, and lists it as local', async () => {
      const noYes = await installLocal(src);
      expect(noYes.code).toBe(2);
      expect(noYes.stderr).toContain(`${src} is a local directory, not loom's catalog`);
      expect(noYes.stderr).toContain('installing it is running it');
      expect(existsSync(join(loomHome, 'pieces', 'homelab'))).toBe(false);

      const r = await installLocal(src, '--yes');
      expect(r.code).toBe(0);
      const home = join(loomHome, 'pieces', 'homelab');
      const rec = JSON.parse(await readFile(join(home, 'piece.json'), 'utf-8'));
      expect(rec.source).toEqual({ path: src, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(r.stdout).toBe(`installed homelab 1.0.0 (local ${src}@${rec.source.hash.slice(0, 12)})\n`);
      expect(await readlink(join(home, 'current'))).toBe(`versions/${rec.source.hash}`);
      // The snapshot (the packed tarball) is kept with the version it installed.
      expect(existsSync(join(home, 'versions', rec.source.hash, 'package.tgz'))).toBe(true);
      expect((await runCliCaptured(['homelab'], { env })).stdout).toBe('v1 name=homelab host=nas\n');
      expect((await runCliCaptured(['pieces'], { env })).stdout).toBe(`homelab\t${join(loomHome, 'pieces', 'bin', 'loom-homelab')}\tmanaged 1.0.0 (local)\n`);
      expect(JSON.parse((await runCliCaptured(['pieces', '--json'], { env })).stdout)[0].managed)
        .toEqual({ version: '1.0.0', local: true, path: src, hash: rec.source.hash });
      // Editing the directory doesn't change what's installed: it's a copy, not a link.
      await hl('1.0.0', 'edited');
      expect((await runCliCaptured(['homelab'], { env })).stdout).toBe('v1 name=homelab host=nas\n');
    });

    it('update re-reads the directory: nothing changed is a no-op, a change is a new version; rollback and remove work', async () => {
      await installLocal(src, '--yes');
      const home = join(loomHome, 'pieces', 'homelab');
      const first = JSON.parse(await readFile(join(home, 'piece.json'), 'utf-8'));
      const same = await runCliCaptured(['pieces', 'update', 'homelab'], { env });
      expect([same.code, same.stdout]).toEqual([0, `homelab is already 1.0.0 (local ${src}@${first.source.hash.slice(0, 12)}): nothing in its directory changed\n`]);
      expect(JSON.parse(await readFile(join(home, 'piece.json'), 'utf-8')).installed).toBe(first.installed);

      await hl('1.1.0', 'v2');
      const up = await runCliCaptured(['pieces', 'update', 'homelab'], { env });
      expect(up.code).toBe(0);
      const second = JSON.parse(await readFile(join(home, 'piece.json'), 'utf-8'));
      expect(second.source.hash).not.toBe(first.source.hash);
      expect(up.stdout).toBe(`updated homelab to 1.1.0 (local ${src}@${second.source.hash.slice(0, 12)}); loom pieces rollback homelab goes back\n`);
      expect(second.previous).toEqual({ commit: first.source.hash, version: '1.0.0', source: first.source });
      expect((await runCliCaptured(['homelab'], { env })).stdout).toBe('v2 name=homelab host=nas\n');

      const back = await runCliCaptured(['pieces', 'rollback', 'homelab'], { env });
      expect(back.stdout).toBe(`homelab is back on 1.0.0 (${first.source.hash.slice(0, 12)})\n`);
      expect((await runCliCaptured(['homelab'], { env })).stdout).toBe('v1 name=homelab host=nas\n');
      expect(JSON.parse(await readFile(join(home, 'piece.json'), 'utf-8')).source).toEqual(first.source);
      // And forward again: the newer snapshot is still on disk.
      await runCliCaptured(['pieces', 'rollback', 'homelab'], { env });
      expect((await runCliCaptured(['homelab'], { env })).stdout).toBe('v2 name=homelab host=nas\n');

      const rm = await runCliCaptured(['pieces', 'remove', 'homelab'], { env });
      expect(rm.code).toBe(0);
      expect(findPiece('homelab', env)).toBeUndefined();
      expect(existsSync(join(home, 'versions'))).toBe(false);
      // The source directory is the owner's: remove never touches it.
      expect(existsSync(join(src, 'package.json'))).toBe(true);
    });

    it('records the git commit when the directory is a clean work tree, and not when it is dirty', async () => {
      const git = (...a: string[]) => execFileSync('git', ['-C', src, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { env, encoding: 'utf-8' }).trim();
      git('init', '-q');
      git('add', '.');
      git('commit', '-q', '-m', 'one');
      const head = git('rev-parse', 'HEAD');
      await installLocal(src, '--yes');
      const home = join(loomHome, 'pieces', 'homelab');
      expect(JSON.parse(await readFile(join(home, 'piece.json'), 'utf-8')).source.commit).toBe(head);
      expect(JSON.parse((await runCliCaptured(['pieces', '--json'], { env })).stdout)[0].managed.commit).toBe(head);
      await hl('1.1.0', 'v2');
      await runCliCaptured(['pieces', 'update', 'homelab'], { env });
      expect(JSON.parse(await readFile(join(home, 'piece.json'), 'utf-8')).source.commit).toBeUndefined();
    });

    it('refuses a relative path, a missing directory, and a package with no loom-<name> bin', async () => {
      expect(() => parseFrom('path:src/homelab')).toThrow(/absolute path/);
      const rel = await runCliCaptured(['pieces', 'install', '--from', 'path:./homelab', '--yes'], { env });
      expect([rel.code, rel.stderr]).toEqual([1, 'loom pieces: a local source is an absolute path (path:/absolute/dir), not "./homelab"\n']);
      const missing = await installLocal(join(tmp, 'nope'), '--yes');
      expect([missing.code, missing.stderr]).toEqual([1, `loom pieces: ${join(tmp, 'nope')} doesn't exist\n`]);
      const notPkg = join(tmp, 'empty');
      await mkdir(notPkg);
      expect((await installLocal(notPkg, '--yes')).stderr).toBe(`loom pieces: ${notPkg} has no package.json, so it isn't a package\n`);
      const plain = join(tmp, 'src', 'plain');
      await packageAt(plain, { name: 'plain' }, { 'not-a-piece': 'true' });
      const nobin = await installLocal(plain, '--yes');
      expect([nobin.code, nobin.stderr]).toEqual([1, "loom pieces: plain has no loom-<name> bin, so it isn't a piece\n"]);
      expect(existsSync(join(loomHome, 'pieces', 'plain'))).toBe(false);
      expect(parseFrom(`path:${src}/`)).toEqual({ path: src });
    });

    it('a piece from GitHub can be replaced by a local one, and rolled back to it', async () => {
      await install(SHA1);
      const tasksSrc = join(tmp, 'src', 'tasks');
      await packageAt(tasksSrc, tasksPkg('0.4.1-local'), tasksBins('local'));
      expect((await installLocal(tasksSrc, '--yes')).stdout).toContain('updated tasks 0.4.1-local (local ');
      expect((await runCliCaptured(['tasks'], { env })).stdout).toMatch(/^local /);
      expect((await runCliCaptured(['pieces', 'rollback', 'tasks'], { env })).stdout).toBe(`tasks is back on 0.4.0 (${SHA1.slice(0, 12)})\n`);
      const rec = JSON.parse(await readFile(join(loomHome, 'pieces', 'tasks', 'piece.json'), 'utf-8'));
      expect(rec.source).toEqual({ repo: 'sleepunit-agents/taskstore', commit: SHA1 });
      expect((await runCliCaptured(['tasks'], { env })).stdout).toMatch(/^v1 /);
    });
  });

  it('with no LOOM_HOME and no HOME, there is no managed dir and PATH is all there is', () => {
    expect(listPieces({ PATH: onPath })).toEqual([]);
    expect(pieceEnvFor('/x/loom-tasks', { PATH: onPath })).toEqual({ PATH: onPath });
  });
});
