/** Docker bodies run only in the separate worker. Builds retain their bounded
 * configured worker command; its artifact must be an already-built image. */
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { dockerEngine, DockerResponseError, type DockerEngine } from './docker-engine.js';
import { commandWorkerExecutor, workerRunner, type WorkerRunnerConfig, type WorkerCommand } from './worker-process.js';
import type { WorkerAssignment, WorkerBody, WorkerExecutor } from './worker.js';

export interface ContainerConfig {
  socket: string;
  /** Explicit opt-in on this machine as well as in the agent's run settings. */
  nestedSocket?: string;
  setupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}
function deadline(value: number | undefined, fallback: number) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 300_000) throw new Error('Invalid Docker deadline');
  return result;
}
function createSpec(job: WorkerAssignment, image: string, plan: WorkerCommand, config: ContainerConfig) {
  if (!image.trim() || /[\s\0]/.test(image) || !plan.command || !plan.cwd.startsWith('/')) throw new Error('Invalid container command');
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const { address, port } of job.run?.ports ?? []) {
    if (!isIP(address) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid container port');
    (bindings[`${port}/tcp`] ??= []).push({ HostIp: address, HostPort: String(port) });
  }
  const mounts: { Type: string; Source: string; Target: string }[] = [];
  if (job.run?.nestedContainers) {
    if (!config.nestedSocket?.startsWith('/') || config.nestedSocket.includes('\0')) throw new Error('Nested containers unavailable');
    mounts.push({ Type: 'bind', Source: config.nestedSocket, Target: '/var/run/docker.sock' });
  }
  return { Image: image, Entrypoint: [plan.command], Cmd: [...plan.args], WorkingDir: plan.cwd,
    Env: Object.entries(plan.env).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('Invalid container environment');
      return `${key}=${value}`;
    }),
    AttachStdin: true, AttachStdout: true, AttachStderr: true, OpenStdin: true, StdinOnce: true, Tty: false,
    Labels: { 'loom.job': job.id, 'loom.agent': job.agent },
    ExposedPorts: Object.fromEntries(Object.keys(bindings).map(key => [key, {}])),
    HostConfig: { AutoRemove: false, Privileged: false, PublishAllPorts: false, Runtime: 'runc',
      LogConfig: { Type: 'none', Config: {} },
      PortBindings: bindings, Mounts: mounts,
      DeviceRequests: job.run?.gpu ? [{ Driver: '', Count: -1, Capabilities: [['gpu']] }] : [] },
  };
}

/** Incremental non-TTY Docker frames; memory stays bounded even for giant frames. */
function output(socket: Duplex, signal: AbortSignal) {
  let tail = '', header = Buffer.alloc(0), remaining = 0, stream = 0;
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8'), new StringDecoder('utf8')];
  const append = (text: string) => { tail = (tail + text).slice(-16_384); };
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
  return { done, tail: () => tail };
}

export function containerWorkerExecutor(config: WorkerRunnerConfig & {
  build: WorkerCommand; buildTimeoutMs?: number;
  container: ContainerConfig;
}, dependencies: { engine?: DockerEngine; builder?: WorkerExecutor; name?: () => string } = {}): WorkerExecutor {
  const fixed = structuredClone(config);
  const runner = workerRunner(fixed);
  const engine = dependencies.engine ?? dockerEngine(fixed.container.socket);
  const builder = dependencies.builder ?? commandWorkerExecutor(fixed);
  const setupMs = deadline(fixed.container.setupTimeoutMs, 30_000);
  const cleanupMs = deadline(fixed.container.cleanupTimeoutMs, 30_000);
  return {
    build: (job, signal, repositoryInput) => { runner(job); return repositoryInput?builder.build(job,signal,repositoryInput):builder.build(job,signal); },
    start(job, image, signal): WorkerBody {
      const assignment = structuredClone(job), plan = runner(assignment);
      if (!plan || signal.aborted) throw new Error('Container runner unavailable');
      const spec = createSpec(assignment, image, plan, fixed.container);
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
          if (!inspect || typeof inspect !== 'object' || !('Mounts' in inspect) || !Array.isArray(inspect.Mounts)
            || inspect.Mounts.length !== (assignment.run?.nestedContainers ? 1 : 0)
            || inspect.Mounts.some(mount => !mount || typeof mount !== 'object'
              || mount.Type !== 'bind' || mount.Source !== fixed.container.nestedSocket || mount.Destination !== '/var/run/docker.sock'))
            throw new Error('Unexpected container storage');
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
          return { exitCode: result.StatusCode as number, logTail: logs!.tail() };
        } finally { if (drainTimer) clearTimeout(drainTimer); void both.catch(() => {}); }
      })();
      void exited.catch(() => {});
      return { spawned: setup, exited,
        async release() {
          await setup;
          if (released || abort.signal.aborted || stopping || !socket || socket.destroyed) throw new Error('Container input unavailable');
          released = true;
          await new Promise<void>((resolve, reject) => socket!.end(JSON.stringify({ job: assignment, build: image }) + '\n',
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
