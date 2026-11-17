// Checks the worker's container mode against a real engine: Docker's socket, or another engine's that
// serves the same routes (rootless podman's). Not a test: nothing runs it but a person.
// Usage: npx tsc -p . && node scripts/check-container-engine.mjs <socket> <directory> <image> [--core]
//   <socket>     the engine's Unix socket
//   <directory>  an existing, empty directory of yours, written as its real path. Directories are made
//                in it and mounted into the containers, and a symbolic link named check-link is made in
//                it and removed again
//   <image>      a small image already on the engine that has /bin/sh, cat, ls, touch, id, stat and sleep.
//                The stand-in core house this script builds is `FROM` it, so nothing is pulled
//   --core       also build the real core house, from house/core of this checkout, and run one body in a
//                house that has no Housefile. This downloads Debian packages, Node, Claude Code and Codex
//                (several hundred MB) and may take ten minutes or more. The core house's image is left on
//                the engine: it is the one a worker of this loom would build this week, and finds again
// It needs git. It uses the built worker (dist/runtime) only: the executor for a house's whole life (the
// core house built, the house's repository fetched, its image built on the core and found again, bodies
// started in it), and the engine client for a few questions the executor never asks. The house is a
// repository this script makes in a temporary directory and fetches by a file address, which no worker
// configuration can do. Without --core the core house is a stand-in whose "node" is a shell script, so
// the body program is mounted and named but never run; with --core the real core's node runs a small
// program of this script's in place of the body program, which writes down what it finds. Every
// container it makes is named loom-check-* and labelled loom.box=houses-check; they, the house images it
// built, the stand-in core and its temporary directory are removed before it ends. It prints what the
// engine answered; docs/runtime/worker.md ("Container bodies") says what one run against podman showed.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dist = new URL('../dist/runtime/', import.meta.url);
const { containerWorkerExecutor } = await import(new URL('worker-container.js', dist));
const { dockerEngine, DockerResponseError } = await import(new URL('docker-engine.js', dist));
const { houseSource } = await import(new URL('house-source.js', dist));
const { coreDefinition, coreWeek } = await import(new URL('house-core.js', dist));
const { coreImage, houseCore } = await import(new URL('house-image.js', dist));

const [socket, directory, image, option] = process.argv.slice(2);
if (!socket || !directory || !image || (option !== undefined && option !== '--core')) { console.error('usage: node scripts/check-container-engine.mjs <socket> <directory> <image> [--core]'); process.exit(2); }
const realCore = option === '--core';
const real = dockerEngine(socket), calls = [];
const noted = async (what, work) => {
  try { const answer = await work(); calls.push(`${what} -> ok`); return answer; }
  catch (error) { calls.push(`${what} -> ${error instanceof DockerResponseError ? `HTTP ${error.status}` : error.message}`); throw error; }
};
// The same client, with each call and its outcome noted.
const engine = {
  json: (method, path, body, signal) => noted(`${method} ${decodeURIComponent(path.split('?')[0])}`, () => real.json(method, path, body, signal)),
  build: (path, context, signal) => noted(`POST ${decodeURIComponent(path)}`, () => real.build(path, context, signal)),
  async attach(id, signal) { const stream = await real.attach(id, signal); calls.push('POST attach -> upgraded'); return stream; },
};
const never = new AbortController().signal;
const say = (title, value) => console.log(`\n## ${title}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);

// A stand-in core house: the layout and the two labels on top of the small image, with a stand-in for node.
// A house: a repository whose Housefile starts from the core it is handed, as an agent's does.
const work = mkdtempSync(join(realpathSync(tmpdir()), 'loom-check-')), repository = join(work, 'house'), standIn = join(work, 'core');
const written = join(directory, 'written'), readOnly = join(directory, 'read-only'), logins = join(directory, 'logins');
const harnesses = ['true', 'echo', 'sleep', 'readonly', 'absent', 'claude'];
mkdirSync(repository); mkdirSync(written, { recursive: true }); mkdirSync(readOnly, { recursive: true });
for (const harness of harnesses) mkdirSync(join(logins, harness), { recursive: true });
writeFileSync(join(readOnly, 'seen-by-the-body'), 'x');
mkdirSync(join(standIn, 'body'), { recursive: true });
writeFileSync(join(standIn, 'Housefile'), `FROM ${image}
COPY check-node /usr/local/bin/node
COPY body /etc/loom/body
LABEL loom.house="2" loom.house.harnesses="true echo sleep readonly"
ENV PROBE=from-the-core HOME=/somewhere/else LOOM_HOUSE_COMMIT=set-by-the-image
WORKDIR /tmp
`);
// Started as: node /opt/loom/dist/body.js /etc/loom/body/<harness>.json, with the job on stdin.
// What a container prints is dropped by the worker, so what it found is written to the mounted directory.
writeFileSync(join(standIn, 'check-node'), `#!/bin/sh
out=$HOME/written/$(basename "$2" .json).txt
case "$2" in
  */readonly.json) cat >/dev/null; touch $HOME/read-only/x 2>/dev/null && exit 9; ls $HOME/read-only >/dev/null && exit 7; exit 8 ;;
esac
{ echo "program: $1 $(test -f "$1" && echo present || echo MISSING)"; echo "body file: $2"; echo "PROBE=$PROBE HOUSE=$HOUSE HOME=$HOME scratch=$LOOM_BODY_SCRATCH cwd=$(pwd)"
  echo "built from: $LOOM_HOUSE_REPOSITORY $LOOM_HOUSE_BRANCH $LOOM_HOUSE_COMMIT"; echo "repository: $(ls | tr '\\n' ' ')"; echo "sign-in: $(touch /run/loom/login/$(basename "$2" .json)/written-by-the-body 2>&1 && echo writable)"
  echo "uid $(id -u); the mount belongs to uid $(stat -c %u $HOME/written) in here"; echo "stdin: $(cat | head -c 60)"; } > "$out" 2>&1
case "$2" in */sleep.json) exec sleep 300 ;; */echo.json) exit 7 ;; esac
exit 0
`);
chmodSync(join(standIn, 'check-node'), 0o755);
for (const harness of ['true', 'echo', 'sleep', 'readonly']) writeFileSync(join(standIn, 'body', `${harness}.json`), '{}\n');
writeFileSync(join(repository, 'Housefile'), `ARG LOOM_CORE
FROM \${LOOM_CORE}
ENV HOUSE=from-the-house
COPY . /home/agent/repo
`);
writeFileSync(join(repository, 'notes.txt'), 'a file of the house\n');
const git = (...args) => execFileSync('git', args, { cwd: repository, stdio: 'ignore',
  env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.invalid', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.invalid' } });
git('init', '--quiet', '--initial-branch=main'); git('add', '--all'); git('commit', '--quiet', '--message', 'a house for the engine check');

// What the worker mounts as its own directory: laid out as an install is. The stand-in node only looks
// whether the body program is there, so this check does not depend on how this checkout was installed.
const program = join(work, 'install');
mkdirSync(join(program, 'dist'), { recursive: true }); writeFileSync(join(program, 'package.json'), '{"dependencies":{}}');
// In place of the body program: what the real core's node runs with --core. It writes down what a body
// would find and never reads a sign-in; the stand-in core's "node" only looks whether it is there.
writeFileSync(join(program, 'dist', 'body.js'), `const fs = require('node:fs'), { execFileSync } = require('node:child_process');
const tried = work => { try { return work(); } catch (error) { return 'FAILED: ' + String(error.message).split('\\n')[0]; } };
const version = name => tried(() => execFileSync(name, ['--version'], { encoding: 'utf8', timeout: 60000 }).trim());
const found = { node: process.version, 'node is': process.execPath, argv: process.argv.slice(1), HOME: process.env.HOME, cwd: process.cwd(), uid: process.getuid(),
  repository: tried(() => fs.readdirSync('.').sort()), 'body file': tried(() => JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))),
  'the program the body file names is there': tried(() => fs.existsSync(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).command)),
  'built from': [process.env.LOOM_HOUSE_REPOSITORY, process.env.LOOM_HOUSE_BRANCH, process.env.LOOM_HOUSE_COMMIT],
  claude: version('claude'), codex: version('codex'), git: version('git'),
  'Claude Code keeps its sign-in in': process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, 'Codex auth.json is a link to': tried(() => fs.readlinkSync(process.env.HOME + '/.codex/auth.json')),
  'the mounted sign-in directory can be written': tried(() => { fs.writeFileSync('/run/loom/login/claude/written-by-the-body', ''); return true; }) };
fs.writeFileSync(process.env.HOME + '/written/core.json', JSON.stringify(found, null, 2));
`);
// The core house a worker would build the houses on: a stand-in by default, the real one with --core.
const stand = coreDefinition(standIn), shipped = realCore ? coreDefinition(new URL('../house/core', import.meta.url).pathname) : undefined;
const accountLogins = { acct: Object.fromEntries(harnesses.map(harness => [harness, { source: join(logins, harness) }])) };
const house = { repository: `file://${repository}`, file: 'Housefile', branch: 'main' };
const job = (id, harness, agent = 'check-written') => ({ id, box: 'houses-check', agent, conversation: 'cv', model: 'm', account: 'acct', harness, brief: 'b', house });
const bootstrap = id => ({ origin: 'https://loom.invalid', job: id, token: Buffer.from(`body_${'a'.repeat(64)}`) });
const container = { socket, runtime: 'crun', setupTimeoutMs: 60_000, cleanupTimeoutMs: 30_000,
  mounts: { 'check-written': [{ source: written, target: 'written', readOnly: false }], 'check-read-only': [{ source: readOnly, target: 'read-only' }] } };
const worker = (patch = {}, using = engine, name = 'check', core = stand) => containerWorkerExecutor({ box: 'houses-check', buildTimeoutMs: core === stand ? 600_000 : 3_600_000, state: join(work, 'state'), accountLogins, container: { ...container, ...patch } },
  { engine: using, source: houseSource({ directory: join(work, 'mirrors'), protocols: ['file'] }), name: () => name, program, core });
let built;
{
  calls.length = 0;
  const executor = worker();
  let outcome;
  try { built = await executor.build(job('job-check-build', 'true'), never); outcome = { image: built }; } catch (error) { outcome = { failed: error.message }; }
  const first = [...calls]; calls.length = 0;
  let again; try { again = await executor.build(job('job-check-again', 'true'), never); } catch (error) { again = `failed: ${error.message}`; }
  executor.close();
  say('0. the core house built, then a house fetched and built on it through the engine, then asked for again', { outcome, 'the core it was built on': built && houseCore(built), calls: first, again, 'calls the second time': [...calls] });
}
if (!built) { rmSync(work, { recursive: true, force: true }); process.exit(1); }

async function body(title, harness, name, { patch = {}, agent, stopAfterMs } = {}) {
  calls.length = 0;
  let result;
  try {
    const executor = worker(patch, engine, name);
    const left = await executor.endLeft(never), assignment = job(`job-${name}`, harness, agent);
    const started = executor.start(assignment, built, never);
    try {
      await started.spawned;
      await started.release(bootstrap(assignment.id));
      if (stopAfterMs) { await new Promise(resolve => setTimeout(resolve, stopAfterMs)); await started.stop(); }
      result = await started.exited;
    } catch (error) { result = { failed: error.message }; }
    finally { await started.stop(); executor.close(); }
    let found; try { found = readFileSync(join(written, `${harness}.txt`), 'utf8'); } catch { found = undefined; }
    result = { left, ...result, 'what the body wrote to its mount': found };
  } catch (error) { result = { refused: error.message }; }
  say(title, { result, calls: [...calls] });
}
await body('1. whole life of a body (runtime crun): the worker\'s program mounted, node and the body file at their places, the repository as where it starts, HOME as the worker sets it, its sign-in mounted', 'true', 'check-true');
await body('2. a body that exits 7', 'echo', 'check-echo');
await body('3. the same with runtime runc (an engine may run its own whichever is asked)', 'true', 'check-runc', { patch: { runtime: 'runc' } });
await body('4. another agent\'s body: its own read-only mount and not the first agent\'s (exit 7: there and not writable; 9: writable; 8: not there)', 'readonly', 'check-readonly', { agent: 'check-read-only' });
await body('4b. a running body the worker stops (cancellation): removal of a running container', 'sleep', 'check-stop', { stopAfterMs: 1500 });
await body('4c. a harness the house does not serve (the job fails, with the house\'s reason)', 'absent', 'check-absent');

// What the executor never asks: the raw answers, for the record.
async function raw(title, name, patch, look = inspect => inspect.Mounts) {
  const spec = { Image: image, Entrypoint: ['/bin/true'], Cmd: [], WorkingDir: '/', Env: [], AttachStdin: true, AttachStdout: true, AttachStderr: true, OpenStdin: true, StdinOnce: true, Tty: false,
    Labels: { 'loom.job': name, 'loom.agent': 'art', 'loom.box': 'houses-check' }, ExposedPorts: {},
    HostConfig: { AutoRemove: false, Privileged: false, PublishAllPorts: false, Runtime: 'crun', LogConfig: { Type: 'none', Config: {} }, PortBindings: {}, Mounts: [], DeviceRequests: [] } };
  const made = patch(spec) ?? spec;
  let answer;
  try {
    const created = await real.json('POST', `/containers/create?name=loom-${name}`, made, never);
    const inspect = await real.json('GET', `/containers/${created.Id}/json`, undefined, never);
    answer = { created: { ...created, Id: `${created.Id.length} hex characters` }, seen: look(inspect) };
  } catch (error) { answer = { refused: error instanceof DockerResponseError ? `HTTP ${error.status}` : error.message }; }
  finally { await real.json('DELETE', `/containers/loom-${name}?force=1&v=1`, undefined, never).catch(error => { answer = { ...answer, removal: error.message }; }); }
  say(title, answer);
}
await raw('5. inspection of what the worker sends: mounts, and how its other demands read back', 'check-inspect', spec => { spec.HostConfig.Mounts = [{ Type: 'bind', Source: directory, Target: '/mnt/ro', ReadOnly: true }]; },
  inspect => ({ Mounts: inspect.Mounts, 'HostConfig.Runtime': inspect.HostConfig.Runtime, 'HostConfig.LogConfig': inspect.HostConfig.LogConfig, 'HostConfig.Privileged': inspect.HostConfig.Privileged,
    'HostConfig.PublishAllPorts': inspect.HostConfig.PublishAllPorts, 'HostConfig.AutoRemove': inspect.HostConfig.AutoRemove, 'HostConfig.Binds': inspect.HostConfig.Binds,
    'Config.StdinOnce': inspect.Config.StdinOnce, 'Config.OpenStdin': inspect.Config.OpenStdin, 'Config.AttachStdin': inspect.Config.AttachStdin, 'Config.Tty': inspect.Config.Tty,
    'Config.Labels (loom.*)': Object.fromEntries(Object.entries(inspect.Config.Labels ?? {}).filter(([key]) => key.startsWith('loom.'))),
    'Config.Labels (from the image)': Object.keys(inspect.Config.Labels ?? {}).filter(key => !key.startsWith('loom.')),
    'bytes of the whole answer': JSON.stringify(inspect).length }));
await raw('6. a volume the image (here: the request) declares', 'check-volume', spec => { spec.Volumes = { '/declared': {} }; });
await raw('7. a runtime name the engine does not have', 'check-bogus', spec => { spec.HostConfig.Runtime = 'no-such-runtime'; }, inspect => inspect.HostConfig.Runtime);
await raw('8. a bind mount of a directory that does not exist', 'check-missing', spec => { spec.HostConfig.Mounts = [{ Type: 'bind', Source: join(directory, 'not-there'), Target: '/mnt/x', ReadOnly: true }]; });
// An engine that makes the missing directory (podman does) leaves it behind: it is empty, and removed here.
try { rmdirSync(join(directory, 'not-there')); } catch { /* the engine did not make it */ }
const linked = join(directory, 'check-link'); rmSync(linked, { force: true }); symlinkSync(directory, linked);
await raw('9. a bind mount named through a symbolic link', 'check-link', spec => { spec.HostConfig.Mounts = [{ Type: 'bind', Source: linked, Target: '/mnt/x', ReadOnly: true }]; });
rmSync(linked, { force: true });
await raw('10. a privileged container, asked for on purpose (the worker never does)', 'check-privileged', spec => { spec.HostConfig.Privileged = true; }, inspect => inspect.HostConfig.Privileged);
await raw('11. a log driver the worker never asks for', 'check-log', spec => { spec.HostConfig.LogConfig = { Type: 'json-file', Config: {} }; }, inspect => inspect.HostConfig.LogConfig);

// The executor itself refusing: a declared volume must stop the start.
const volumeEngine = { ...engine, json: (method, path, spec, signal) => engine.json(method, path, method === 'POST' && path.startsWith('/containers/create') ? { ...spec, Volumes: { '/declared': {} } } : spec, signal) };
{
  calls.length = 0;
  const executor = worker({}, volumeEngine, 'check-refused');
  const started = executor.start(job('job-refused', 'true'), built, never);
  let outcome; try { await started.spawned; outcome = 'STARTED (wrong)'; } catch (error) { outcome = error.message; } finally { await started.stop(); executor.close(); }
  say('12. the worker, given a container with a volume it did not ask for', { outcome, calls: [...calls] });
}
const filters = encodeURIComponent(JSON.stringify({ label: ['loom.job', 'loom.box=houses-check'] }));
say('13. containers of this check still on the engine', await real.json('GET', `/containers/json?all=1&limit=8&filters=${filters}`, undefined, never));
// The image this check built, and everything it kept beside the directory it was given.
const removed = name => real.json('DELETE', `/images/${name}`, undefined, never).then(() => 'removed', error => `not removed: ${error instanceof DockerResponseError ? `HTTP ${error.status}` : error.message}`);
say('14. the house image and the stand-in core removed', { house: await removed(built), core: await removed(houseCore(built)) });

// The real core house, when asked for: built from this checkout's own definition, and one body run in a
// house that has no Housefile. The body is the small program above, run by the core's own node.
if (shipped) {
  calls.length = 0;
  const executor = worker({}, engine, 'check-core', shipped), plain = { ...job('job-check-core', 'claude'), house: { ...house, file: '' } };
  const expected = coreImage(shipped.digest, coreWeek(Date.now()));
  let outcome, image_;
  try {
    image_ = await executor.build(plain, never);
    const started = executor.start(plain, image_, never);
    try { await started.spawned; await started.release(bootstrap(plain.id)); outcome = await started.exited; }
    catch (error) { outcome = { failed: error.message }; } finally { await started.stop(); }
  } catch (error) { outcome = { 'build failed': error.message }; }
  executor.close();
  let found; try { found = JSON.parse(readFileSync(join(written, 'core.json'), 'utf8')); } catch { found = undefined; }
  let labels; try { labels = (await real.json('GET', `/images/${expected}/json`, undefined, never)).Config; } catch (error) { labels = `not there: ${error.message}`; }
  say('15. the real core house, and a body in a house with no Housefile', { 'the core house': expected, 'what it says of itself': labels && { Labels: labels.Labels, Volumes: labels.Volumes, User: labels.User }, 'the house': image_, outcome, 'what the body found': found, calls: [...calls] });
  if (image_) say('16. the house with no Housefile removed (the core house stays for the next worker)', await removed(image_));
}
rmSync(work, { recursive: true, force: true }); rmSync(written, { recursive: true, force: true }); rmSync(readOnly, { recursive: true, force: true }); rmSync(logins, { recursive: true, force: true });
