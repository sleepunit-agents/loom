import { ENV_NAME, STEP_DEADLINE_MAX_MS, validDeadline } from './worker-limits.js';
import { logTail } from './log-tail.js';
import { bodyInput } from './body-bootstrap.js';
/** Docker bodies run only in the separate worker. Builds retain their bounded
 * configured worker command; its artifact must be an already-built image. */
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { dockerEngine, DockerResponseError, type DockerEngine } from './docker-engine.js';
import { BODY_SCRATCH } from './body-harness.js';
import { commandWorkerExecutor, workerRunner, type WorkerRunnerConfig, type WorkerCommand } from './worker-process.js';
import type { WorkerAssignment, WorkerBody, WorkerExecutor } from './worker.js';
import { WorkerStop } from './worker-stop.js';
import { containerExit } from './job-exit.js';
import { bodyMounts, type AccountLogins, type BodyMount, type FixedMount } from './worker-mounts.js';

/** The names the worker may send as the engine's runtime. The operator states which one their engine has;
 * nothing is discovered. */
export const CONTAINER_RUNTIMES = ['runc', 'crun'] as const;

export interface ContainerConfig {
  socket: string;
  /** Explicit opt-in on this machine as well as in the agent's run settings. */
  nestedSocket?: string;
  /** Sent as `HostConfig.Runtime`. `runc` when left out. */
  runtime?: typeof CONTAINER_RUNTIMES[number];
  /** Directories of this machine given to every body's container (worker-mounts.ts). */
  mounts?: readonly FixedMount[];
  setupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}
function deadline(value: number | undefined, fallback: number) {
  const result = value ?? fallback;
  if (!validDeadline(result, STEP_DEADLINE_MAX_MS)) throw new Error('Invalid Docker deadline');
  return result;
}
/** One bind mount as the engine is asked for it, and as it must report it. */
interface EngineMount { Type: 'bind'; Source: string; Target: string; ReadOnly: boolean }
const engineMounts = (mounts: readonly BodyMount[]): EngineMount[] =>
  mounts.map(mount => ({ Type: 'bind', Source: mount.source, Target: mount.target, ReadOnly: mount.readOnly }));
/** The created container has exactly the mounts the worker asked for: each one a bind mount of the same
 * source at the same place, writable or not as asked, and nothing else (an image's declared volume, a
 * mount an engine adds by itself). The order is the engine's own. */
function ownMounts(inspect: unknown, asked: readonly EngineMount[]): boolean {
  if (!inspect || typeof inspect !== 'object' || !('Mounts' in inspect) || !Array.isArray(inspect.Mounts) || inspect.Mounts.length !== asked.length) return false;
  const left = new Map(asked.map(mount => [mount.Target, mount]));
  for (const found of inspect.Mounts as unknown[]) {
    if (!found || typeof found !== 'object' || !('Destination' in found) || typeof found.Destination !== 'string') return false;
    const mount = left.get(found.Destination);
    if (!mount || !('Type' in found) || found.Type !== 'bind' || !('Source' in found) || found.Source !== mount.Source) return false;
    if (!('RW' in found) || found.RW !== !mount.ReadOnly) return false;
    left.delete(found.Destination);
  }
  return left.size === 0;
}
function createSpec(job: WorkerAssignment, image: string, plan: WorkerCommand, config: ContainerConfig, mounts: readonly EngineMount[]) {
  if (!image.trim() || /[\s\0]/.test(image) || !plan.command || !plan.cwd.startsWith('/')) throw new Error('Invalid container command');
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const { address, port } of job.run?.ports ?? []) {
    if (!isIP(address) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid container port');
    (bindings[`${port}/tcp`] ??= []).push({ HostIp: address, HostPort: String(port) });
  }
  // A container body's scratch directory is the container's own temporary directory: it is private to the
  // body because the container is, and it is removed with the container.
  const env = { [BODY_SCRATCH]: plan.env.TMPDIR || '/tmp', ...plan.env };
  return { Image: image, Entrypoint: [plan.command], Cmd: [...plan.args], WorkingDir: plan.cwd,
    Env: Object.entries(env).map(([key, value]) => {
      if (!ENV_NAME.test(key) || value.includes('\0')) throw new Error('Invalid container environment');
      return `${key}=${value}`;
    }),
    AttachStdin: true, AttachStdout: true, AttachStderr: true, OpenStdin: true, StdinOnce: true, Tty: false,
    // The labels are how a later worker of the same machine finds a body this one was killed over (endLeft).
    Labels: { 'loom.job': job.id, 'loom.agent': job.agent, 'loom.box': job.box },
    ExposedPorts: Object.fromEntries(Object.keys(bindings).map(key => [key, {}])),
    HostConfig: { AutoRemove: false, Privileged: false, PublishAllPorts: false, Runtime: config.runtime ?? CONTAINER_RUNTIMES[0],
      LogConfig: { Type: 'none', Config: {} },
      PortBindings: bindings, Mounts: mounts,
      DeviceRequests: job.run?.gpu ? [{ Driver: '', Count: -1, Capabilities: [['gpu']] }] : [] },
  };
}

/** Incremental non-TTY Docker frames; memory stays bounded even for giant frames. */
function output(socket: Duplex, signal: AbortSignal) {
  let privateOutput = false;
  let tail = '', header = Buffer.alloc(0), remaining = 0, stream = 0;
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8'), new StringDecoder('utf8')];
  const append = (text: string) => { if (!privateOutput) tail = logTail(tail + text); };
  const done = new Promise<void>((resolve, reject) => {
    const fail = () => { socket.destroy(); reject(new Error('Container output unavailable')); };
    const data = (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (!remaining) {
          const count = Math.min(8 - header.length, chunk.length - offset);
          header = Buffer.concat([header, chunk.subarray(offset, offset + count)]); offset += count;
          if (header.length < 8) continue;
          stream = header[0];
          if (stream > 2 || header[1] || header[2] || header[3]) { fail(); return; }
          remaining = header.readUInt32BE(4); header = Buffer.alloc(0);
          if (!remaining) continue;
        }
        const count = Math.min(remaining, chunk.length - offset);
        append(decoders[stream].write(chunk.subarray(offset, offset + count)));
        remaining -= count; offset += count;
      }
    };
    socket.on('data', data);
    socket.once('error', fail);
    socket.once('end', () => {
      if (remaining || header.length) reject(new Error('Incomplete container output'));
      else { decoders.forEach(decoder => append(decoder.end())); resolve(); }
    });
    socket.once('close', () => { if (!socket.readableEnded) reject(new Error('Container output closed')); });
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) fail();
    // Listener is removed on either outcome without creating an unhandled chain.
    socket.once('close', () => signal.removeEventListener('abort', fail));
  });
  void done.catch(() => {});
  return { done, tail: () => tail, discard: () => { privateOutput = true; tail = ''; } };
}

export function containerWorkerExecutor(config: WorkerRunnerConfig & {
  build: WorkerCommand; buildTimeoutMs?: number;
  container: ContainerConfig;
  /** When present, every job requires an exact account/harness sign-in directory (worker-mounts.ts). */
  accountLogins?: AccountLogins;
  /** This machine's id, as its jobs name it: the containers it may end at start carry it as a label. */
  box: string;
  /** For the build commands, which are processes: see commandWorkerExecutor. */
  state?: string;
  /** The file with the worker's token for loom, when the caller has one: no mount may reach it. */
  tokenFile?: string;
}, dependencies: { engine?: DockerEngine; builder?: WorkerExecutor; name?: () => string } = {}): WorkerExecutor {
  const fixed = structuredClone(config);
  const runner = workerRunner(fixed);
  if (fixed.container.runtime !== undefined && !CONTAINER_RUNTIMES.includes(fixed.container.runtime)) throw new Error('Invalid container runtime');
  // Checked and fixed here, before the builder takes the state directory or anything asks the engine: a
  // worker whose mounts cannot be used is not made (WorkerStop 'mounts').
  const mountsFor = bodyMounts({ accountLogins: fixed.accountLogins, mounts: fixed.container.mounts, socket: fixed.container.socket,
    nestedSocket: fixed.container.nestedSocket, state: fixed.state, tokenFile: fixed.tokenFile });
  /** What must hold before a build is worth starting: the job has a sign-in directory, when those are configured.
   * A nested job on a machine with no nested socket still fails when its body is started, as before. */
  const signIn = (job: WorkerAssignment) => { mountsFor({ account: job.account, harness: job.harness }); };
  const engine = dependencies.engine ?? dockerEngine(fixed.container.socket);
  const builder = dependencies.builder ?? commandWorkerExecutor(fixed);
  const setupMs = deadline(fixed.container.setupTimeoutMs, 30_000);
  const cleanupMs = deadline(fixed.container.cleanupTimeoutMs, 30_000);
  return {
    close() { builder.close?.(); },
    /** The build commands a previous worker left are processes (the builder ends those). Its bodies are
     * containers: every one labelled as a job of this machine is removed, running or not. The list is
     * read a few at a time until it is empty, so one reply never outgrows what the engine client reads. */
    async endLeft(signal) {
      const processes = await builder.endLeft?.(signal) ?? { unverified: 0 };
      const filters = encodeURIComponent(JSON.stringify({ label: ['loom.job', `loom.box=${fixed.box}`] }));
      for (let round = 0; ; round++) {
        const within = AbortSignal.any([signal, AbortSignal.timeout(cleanupMs)]);
        const listed = await engine.json('GET', `/containers/json?all=1&limit=8&filters=${filters}`, undefined, within);
        if (!Array.isArray(listed)) throw new Error('Invalid container list');
        if (!listed.length) return processes;
        if (round >= 64) throw new WorkerStop('left');
        for (const row of listed) {
          const id: unknown = row && typeof row === 'object' && 'Id' in row ? row.Id : undefined;
          if (typeof id !== 'string' || !/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Invalid container identity');
          await engine.json('DELETE', `/containers/${id}?force=1&v=1`, undefined, within);
        }
      }
    },
    build: (job, signal, repositoryInput) => { runner(job); signIn(job); return repositoryInput?builder.build(job,signal,repositoryInput):builder.build(job,signal); },
    start(job, image, signal): WorkerBody {
      const assignment = structuredClone(job), plan = runner(assignment);
      if (!plan || signal.aborted) throw new Error('Container runner unavailable');
      const mounts = engineMounts(mountsFor(assignment));
      const spec = createSpec(assignment, image, plan, fixed.container, mounts);
      const name = `loom-${(dependencies.name ?? randomUUID)()}`;
      if (!/^loom-[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid container name');
      const abort = new AbortController();
      let socket: Duplex | undefined, id: string | undefined, released = false, createRejected = false;
      let logs: ReturnType<typeof output> | undefined;
      let stopping: Promise<void> | undefined;
      // Abort must begin reaping even while loom's running acknowledgement is
      // pending; closing the attach socket alone does not stop a container.
      const cancel = () => { abort.abort(); void stop().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const setupTimer = setTimeout(cancel, setupMs);
      const setup = (async () => {
        try {
          let created: unknown;
          try { created = await engine.json('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec, abort.signal); }
          catch (error) {
            // A definite rejected create (especially a name conflict) grants no
            // ownership over a pre-existing container with that name.
            createRejected = error instanceof DockerResponseError && error.status >= 400 && error.status < 500;
            throw error;
          }
          if (!created || typeof created !== 'object' || !('Id' in created) || typeof created.Id !== 'string' || !/^[a-f0-9]{12,64}$/.test(created.Id)) throw new Error('Invalid container identity');
          id = created.Id;
          if (abort.signal.aborted) throw new Error('Container cancelled');
          // Images may declare VOLUME entries. Check the actual created mounts,
          // not just our requested HostConfig, before any image code can run.
          const inspect = await engine.json('GET', `/containers/${id}/json`, undefined, abort.signal);
          if (!ownMounts(inspect, mounts)) throw new Error('Unexpected container storage');
          socket = await engine.attach(id, abort.signal);
          logs = output(socket, abort.signal);
          if (abort.signal.aborted) throw new Error('Container cancelled');
          await engine.json('POST', `/containers/${id}/start`, undefined, abort.signal);
          if (abort.signal.aborted) throw new Error('Container cancelled');
        } finally { clearTimeout(setupTimer); }
      })();
      void setup.catch(() => {});
      const exited = (async () => {
        await setup;
        const waited = engine.json('POST', `/containers/${id}/wait?condition=not-running`, undefined, abort.signal);
        // Either side ending starts a bounded drain/wait period for the other.
        const both = Promise.all([waited, logs!.done]);
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([waited, logs!.done]);
          drainTimer = setTimeout(cancel, cleanupMs);
          const [result] = await both;
          if (abort.signal.aborted || !result || typeof result !== 'object' || !('StatusCode' in result)
            || !Number.isSafeInteger(result.StatusCode) || ('Error' in result && result.Error)) throw new Error('Invalid container exit');
          const status = result.StatusCode as number, exitCode = containerExit(status);
          return { exitCode, logTail: logs!.tail(), signalled: exitCode !== status };
        } finally { if (drainTimer) clearTimeout(drainTimer); void both.catch(() => {}); }
      })();
      void exited.catch(() => {});
      return { acceptsBootstrap: plan.bodyBootstrap === true, spawned: setup, exited,
        async release(bootstrap) {
          await setup;
          if (released || abort.signal.aborted || stopping || !socket || socket.destroyed) throw new Error('Container input unavailable');
          released = true;
          if (bootstrap) logs!.discard();
          const payload = bodyInput(assignment, image, bootstrap, plan.bodyBootstrap === true);
          await new Promise<void>((resolve, reject) => socket!.end(JSON.stringify(payload) + '\n',
            (error?: Error | null) => error ? reject(error) : resolve()));
        },
        stop,
      };
      function stop(): Promise<void> {
          // Publish shared cleanup before abort synchronously notifies listeners.
          if (!stopping) stopping = Promise.resolve().then(async () => {
            abort.abort();
            await setup.catch(() => {});
            socket?.destroy();
            const cleanup = new AbortController();
            const timer = setTimeout(() => cleanup.abort(), cleanupMs);
            try {
              // Name also covers a create reply lost before its ID was received.
              if (!createRejected) await engine.json('DELETE', `/containers/${id ?? name}?force=1&v=1`, undefined, cleanup.signal);
              if (cleanup.signal.aborted) throw new Error('Container cleanup uncertain');
            } finally {
              clearTimeout(timer); signal.removeEventListener('abort', cancel);
            }
          });
          return stopping;
      }
    },
  };
}
