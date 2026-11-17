// Checks the worker's container mode against a real engine: Docker's socket, or another engine's that
// serves the same routes (rootless podman's). Not a test: nothing runs it but a person.
// Usage: npx tsc -p . && node scripts/check-container-engine.mjs <socket> <directory> <image>
//   <socket>     the engine's Unix socket
//   <directory>  an existing directory of yours, written as its real path; it is mounted into the containers,
//                and a file named seen-by-the-body is left in it. A symbolic link named check-link is made
//                beside it and removed again: anything already at that name is deleted
//   <image>      a small image already on the engine that has /bin/sh, cat, ls, touch, id, stat and sleep
// It uses the built worker (dist/runtime) only: the executor for the whole life of one body, and the engine
// client for a few questions the executor never asks. Every container it makes is named loom-check-* and
// labelled loom.box=houses-check, and is removed before it ends. It prints what the engine answered;
// docs/runtime/worker.md ("Container bodies") says what one run against podman showed.
import { rmdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dist = new URL('../dist/runtime/', import.meta.url);
const { containerWorkerExecutor } = await import(new URL('worker-container.js', dist));
const { dockerEngine, DockerResponseError } = await import(new URL('docker-engine.js', dist));

const [socket, directory, image] = process.argv.slice(2);
if (!socket || !directory || !image) { console.error('usage: node scripts/check-container-engine.mjs <socket> <directory> <image>'); process.exit(2); }
writeFileSync(join(directory, 'seen-by-the-body'), 'x');
const real = dockerEngine(socket), calls = [];
// The same client, with each call and its outcome noted.
const engine = {
  async json(method, path, body, signal) {
    try { const answer = await real.json(method, path, body, signal); calls.push(`${method} ${path.split('?')[0]} -> ok`); return answer; }
    catch (error) { calls.push(`${method} ${path.split('?')[0]} -> ${error instanceof DockerResponseError ? `HTTP ${error.status}` : error.message}`); throw error; }
  },
  async attach(id, signal) { const stream = await real.attach(id, signal); calls.push('POST attach -> upgraded'); return stream; },
};
const never = new AbortController().signal;
const say = (title, value) => console.log(`\n## ${title}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
const job = (id, harness) => ({ id, box: 'houses-check', agent: 'art', conversation: 'cv', model: 'm', account: 'acct', harness, brief: 'b', house: { repository: 'r', file: 'f', branch: 'b' } });
const builder = { build: async () => image, start() { throw new Error('unused'); } };
const sh = script => ({ command: '/bin/sh', args: ['-c', script], cwd: '/', env: { PROBE: 'value' } });

async function body(title, config, harness, name, stopAfterMs) {
  calls.length = 0;
  let result;
  try {
    const executor = containerWorkerExecutor({ box: 'houses-check', build: sh('true'), ...config }, { engine, builder, name: () => name });
    const left = await executor.endLeft(never);
    const started = executor.start(job(`job-${name}`, harness), image, never);
    try {
      await started.spawned;
      await started.release();
      if (stopAfterMs) { await new Promise(resolve => setTimeout(resolve, stopAfterMs)); await started.stop(); }
      result = await started.exited;
    } catch (error) { result = { failed: error.message }; }
    finally { await started.stop(); }
    result = { left, ...result };
  } catch (error) { result = { refused: error.message }; }
  say(title, { result, calls: [...calls] });
}

const mounts = [{ source: directory, target: '/mnt/ro' }];
const container = { socket, runtime: 'crun', mounts, setupTimeoutMs: 60_000, cleanupTimeoutMs: 30_000 };
const runners = {
  // Every real body reads its envelope. One that ends without reading it can end before the worker has
  // written it, and the worker then says its input is unavailable: on any engine, so not a finding here.
  true: sh('cat >/dev/null; exec /bin/true'),
  sleep: sh('cat >/dev/null; echo sleeping; exec sleep 300'),
  echo: sh('cat; echo "to stdout: $PROBE"; echo "to stderr" >&2; ls /mnt/ro; touch /mnt/ro/written 2>/dev/null && echo "MOUNT WRITABLE" || echo "mount is read-only"; exit 7'),
};
await body('1. whole life of a body running /bin/true (runtime crun, one read-only mount)', { runners, container }, 'true', 'check-true');
await body('2. a body that reads its stdin envelope to the end, writes both streams, tries the mount, exits 7', { runners, container }, 'echo', 'check-echo');
await body('3. the same with runtime runc (an engine may run its own whichever is asked)', { runners, container: { ...container, runtime: 'runc' } }, 'true', 'check-runc');
await body('4. a read-write mount', { runners: { rw: sh('cat >/dev/null; echo "body runs as uid $(id -u); the mount belongs to uid $(stat -c %u /mnt/ro) in here"; touch /mnt/ro/written-rw && echo wrote; exit 0') }, container: { ...container, mounts: [{ ...mounts[0], readOnly: false }] } }, 'rw', 'check-rw');
rmSync(join(directory, 'written-rw'), { force: true });
await body('4b. a running body the worker stops (cancellation): removal of a running container', { runners, container }, 'sleep', 'check-stop', 1500);

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
const linked = join(directory, '..', 'check-link'); rmSync(linked, { force: true }); symlinkSync(directory, linked);
await raw('9. a bind mount named through a symbolic link', 'check-link', spec => { spec.HostConfig.Mounts = [{ Type: 'bind', Source: linked, Target: '/mnt/x', ReadOnly: true }]; });
rmSync(linked, { force: true });
await raw('10. a privileged container, asked for on purpose (the worker never does)', 'check-privileged', spec => { spec.HostConfig.Privileged = true; }, inspect => inspect.HostConfig.Privileged);
await raw('11. a log driver the worker never asks for', 'check-log', spec => { spec.HostConfig.LogConfig = { Type: 'json-file', Config: {} }; }, inspect => inspect.HostConfig.LogConfig);

// The executor itself refusing: a declared volume must stop the start.
const volumeEngine = { ...engine, json: (method, path, spec, signal) => engine.json(method, path, method === 'POST' && path.startsWith('/containers/create') ? { ...spec, Volumes: { '/declared': {} } } : spec, signal) };
{
  calls.length = 0;
  const executor = containerWorkerExecutor({ box: 'houses-check', build: sh('true'), runners, container }, { engine: volumeEngine, builder, name: () => 'check-refused' });
  const started = executor.start(job('job-refused', 'true'), image, never);
  let outcome; try { await started.spawned; outcome = 'STARTED (wrong)'; } catch (error) { outcome = error.message; } finally { await started.stop(); }
  say('12. the worker, given a container with a volume it did not ask for', { outcome, calls: [...calls] });
}
const filters = encodeURIComponent(JSON.stringify({ label: ['loom.job', 'loom.box=houses-check'] }));
say('13. containers of this check still on the engine', await real.json('GET', `/containers/json?all=1&limit=8&filters=${filters}`, undefined, never));
