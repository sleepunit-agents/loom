// Checks the worker's container mode against a real engine: Docker's socket, or another engine's that
// serves the same routes (rootless podman's). Not a test: nothing runs it but a person.
// Usage: npx tsc -p . && node scripts/check-container-engine.mjs <socket> <directory> <image>
//   <socket>     the engine's Unix socket
//   <directory>  an existing, empty directory of yours, written as its real path. Two directories are made
//                in it and mounted into the containers, and a symbolic link named check-link is made in
//                it and removed again
//   <image>      a small image already on the engine that has /bin/sh, cat, ls, touch, id, stat and sleep.
//                The house this script builds is `FROM` it, so nothing is pulled
// It needs git. It uses the built worker (dist/runtime) only: the executor for a house's whole life (its
// repository fetched, its image built and found again, bodies started in it), and the engine client for
// a few questions the executor never asks. The house is a repository this script makes in a temporary
// directory and fetches by a file address, which no worker configuration can do. Its "node" is a shell
// script, so the body program is mounted and named but never run. Every container it makes is named
// loom-check-* and labelled loom.box=houses-check; they, the image it built and its temporary directory
// are removed before it ends. It prints what the engine answered; docs/runtime/worker.md ("Container
// bodies") says what one run against podman showed.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dist = new URL('../dist/runtime/', import.meta.url);
const { containerWorkerExecutor } = await import(new URL('worker-container.js', dist));
const { dockerEngine, DockerResponseError } = await import(new URL('docker-engine.js', dist));
const { houseSource } = await import(new URL('house-source.js', dist));

const [socket, directory, image] = process.argv.slice(2);
if (!socket || !directory || !image) { console.error('usage: node scripts/check-container-engine.mjs <socket> <directory> <image>'); process.exit(2); }
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

// A house: a repository with a Housefile that meets the image contract, and a stand-in for node.
const work = mkdtempSync(join(realpathSync(tmpdir()), 'loom-check-')), repository = join(work, 'house');
const written = join(directory, 'written'), readOnly = join(directory, 'read-only');
mkdirSync(repository); mkdirSync(written, { recursive: true }); mkdirSync(readOnly, { recursive: true });
writeFileSync(join(readOnly, 'seen-by-the-body'), 'x');
writeFileSync(join(repository, 'Housefile'), `FROM ${image}
COPY check-node /usr/local/bin/check-node
COPY body /etc/loom/body
LABEL loom.house="1" loom.house.node="/usr/local/bin/check-node" \\
      loom.house.body.true="/etc/loom/body/true.json" loom.house.body.echo="/etc/loom/body/echo.json" \\
      loom.house.body.sleep="/etc/loom/body/sleep.json" loom.house.body.readonly="/etc/loom/body/readonly.json"
ENV PROBE=from-the-image
WORKDIR /tmp
`);
// Started as: check-node /opt/loom/dist/body.js /etc/loom/body/<harness>.json, with the job on stdin.
// What a container prints is dropped by the worker, so what it found is written to the mounted directory.
writeFileSync(join(repository, 'check-node'), `#!/bin/sh
out=/mnt/written/$(basename "$2" .json).txt
case "$2" in
  */readonly.json) cat >/dev/null; touch /mnt/read-only/x 2>/dev/null && exit 9; ls /mnt/read-only >/dev/null && exit 7; exit 8 ;;
esac
{ echo "program: $1 $(test -f "$1" && echo present || echo MISSING)"; echo "body file: $2"; echo "PROBE=$PROBE scratch=$LOOM_BODY_SCRATCH cwd=$(pwd)"
  echo "uid $(id -u); the mount belongs to uid $(stat -c %u /mnt/written) in here"; echo "stdin: $(cat | head -c 60)"; } > "$out" 2>&1
case "$2" in */sleep.json) exec sleep 300 ;; */echo.json) exit 7 ;; esac
exit 0
`);
chmodSync(join(repository, 'check-node'), 0o755);
mkdirSync(join(repository, 'body'));
for (const harness of ['true', 'echo', 'sleep', 'readonly']) writeFileSync(join(repository, 'body', `${harness}.json`), '{}\n');
const git = (...args) => execFileSync('git', args, { cwd: repository, stdio: 'ignore',
  env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.invalid', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.invalid' } });
git('init', '--quiet', '--initial-branch=main'); git('add', '--all'); git('commit', '--quiet', '--message', 'a house for the engine check');

const house = { repository: `file://${repository}`, file: 'Housefile', branch: 'main' };
const job = (id, harness, agent = 'check-written') => ({ id, box: 'houses-check', agent, conversation: 'cv', model: 'm', account: 'acct', harness, brief: 'b', house });
const bootstrap = id => ({ origin: 'https://loom.invalid', job: id, token: Buffer.from(`body_${'a'.repeat(64)}`) });
const container = { socket, runtime: 'crun', setupTimeoutMs: 60_000, cleanupTimeoutMs: 30_000,
  mounts: { 'check-written': [{ source: written, target: '/mnt/written', readOnly: false }], 'check-read-only': [{ source: readOnly, target: '/mnt/read-only' }] } };
const worker = (patch = {}, using = engine, name = 'check') => containerWorkerExecutor({ box: 'houses-check', buildTimeoutMs: 600_000, state: join(work, 'state'), container: { ...container, ...patch } },
  { engine: using, source: houseSource({ directory: join(work, 'mirrors'), protocols: ['file'] }), name: () => name });
let built;
{
  calls.length = 0;
  const executor = worker();
  let outcome;
  try { built = await executor.build(job('job-check-build', 'true'), never); outcome = { image: built }; } catch (error) { outcome = { failed: error.message }; }
  const first = [...calls]; calls.length = 0;
  let again; try { again = await executor.build(job('job-check-again', 'true'), never); } catch (error) { again = `failed: ${error.message}`; }
  executor.close();
  say('0. a house fetched and built through the engine, then asked for again', { outcome, calls: first, again, 'calls the second time': [...calls] });
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
await body('1. whole life of a body (runtime crun): the worker\'s program mounted, the image\'s node, body file, working directory and environment', 'true', 'check-true');
await body('2. a body that exits 7', 'echo', 'check-echo');
await body('3. the same with runtime runc (an engine may run its own whichever is asked)', 'true', 'check-runc', { patch: { runtime: 'runc' } });
await body('4. another agent\'s body: its own read-only mount and not the first agent\'s (exit 7: there and not writable; 9: writable; 8: not there)', 'readonly', 'check-readonly', { agent: 'check-read-only' });
await body('4b. a running body the worker stops (cancellation): removal of a running container', 'sleep', 'check-stop', { stopAfterMs: 1500 });
await body('4c. a harness the image has no body file for (the job fails, with the house\'s reason)', 'absent', 'check-absent');

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
say('14. the house image removed', await real.json('DELETE', `/images/${built}`, undefined, never).then(() => 'removed', error => `not removed: ${error instanceof DockerResponseError ? `HTTP ${error.status}` : error.message}`));
rmSync(work, { recursive: true, force: true }); rmSync(written, { recursive: true, force: true }); rmSync(readOnly, { recursive: true, force: true });
