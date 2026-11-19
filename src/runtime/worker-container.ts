import { BUILD_DEADLINE_MAX_MS, HOUSE_BUILD_DEFAULT_MS, STEP_DEADLINE_MAX_MS, validDeadline } from './worker-limits.js';
import { logTail } from './log-tail.js';
import { bodyInput } from './body-bootstrap.js';
/** Container bodies run only in the separate worker. One worker runs any agent's house: it fetches the
 * job's house repository and builds its image itself (house-source.ts, house-image.ts), mounts its own
 * body program into the container, and starts every body the same way (house-layout.ts). Every house is
 * built on the core house, which the worker builds from its own install (house-core.ts). Nothing about any one
 * agent is set up on the machine but, where wanted, that agent's mounts. */
import {canonicalKitImage} from './kit-manifest.js';
import {kitBroker} from './kit-broker.js';
import {kitSocket} from './kit-socket.js';
import {kitPrivateClient} from './kit-private-client.js';
import {runKitContainer} from './kit-container.js';
import {KIT_SOCKET} from './body-kit-tools.js';
import {deniedTools} from './harness-traits.js';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { dockerEngine, DockerResponseError, type DockerEngine } from './docker-engine.js';
import { BODY_OWN_HARNESS, BODY_SCRATCH } from './body-harness.js';
import { BuildTimeError, UnservedJobError, type WorkerAssignment, type WorkerBody, type WorkerExecutor } from './worker.js';
import { defaultWorkerState, workerLeft } from './worker-left.js';
import { gitAvailable, houseRepository, houseSource, type HouseSource } from './house-source.js';
import { buildCore, buildHouse, coreImage, coreThere, coreImageName, houseBuilt, houseCommit, houseCore, houseImage, houseImageName, houseStart, pruneHouses, type HouseGuard, type HouseStart } from './house-image.js';
import { CORE_DIRECTORY, coreDefinition, coreWeek, noHousefile, NO_HOUSEFILE, type CoreDefinition } from './house-core.js';
import { WorkerStop } from './worker-stop.js';
import { holdAlone, type Alone, type HoldAlone } from './worker-alone.js';
import { keyPart } from './worker-mounts.js';
import { containerExit } from './job-exit.js';
import { HOUSE_ENV, HOUSE_HOME, HOUSE_NODE, HOUSE_REPOSITORY, houseBodyFile, houseOverlap, houseSessions } from './house-layout.js';
import { bodyMounts, BODY_PROGRAM, type AccountLogins, type AgentMounts, type BodyMount } from './worker-mounts.js';

/** The names the worker may send as the engine's runtime. The operator states which one their engine has;
 * nothing is discovered. */
export const CONTAINER_RUNTIMES = ['runc', 'crun'] as const;

export interface ContainerConfig {
  socket: string;
  /** Explicit opt-in on this machine as well as in the agent's run settings. */
  nestedSocket?: string;
  /** Sent as `HostConfig.Runtime`. `runc` when left out. */
  runtime?: typeof CONTAINER_RUNTIMES[number];
  /** Directories of this machine given to the containers of one agent's bodies, by agent (worker-mounts.ts). */
  mounts?: AgentMounts;
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
/** The ports a job publishes, each on the same port inside. Checked before the engine is asked anything. */
function portBindings(job: WorkerAssignment) {
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const { address, port } of job.run?.ports ?? []) {
    if (!isIP(address) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid container port');
    (bindings[`${port}/tcp`] ??= []).push({ HostIp: address, HostPort: String(port) });
  }
  return bindings;
}
/** Whether the place this harness keeps its sessions is the container's own, with no mount at, above or under it. */
function ownSessions(harness: string, mounts: readonly EngineMount[]): boolean {
  const place = houseSessions(harness);
  return place !== undefined && !mounts.some(mount => houseOverlap(mount.Target, place));
}
/** One body's container. Where things are in it is the layout, the same in every house (house-layout.ts):
 * node, the harness's body file, the tenant's home and its repository, where the body starts. The program
 * is the worker's own, mounted. The rest of the environment is the image's: the worker adds the home,
 * where the body may keep scratch files (the container's own temporary directory, private to the body
 * because the container is and removed with it), and what the house was built from. A variable the
 * worker sets holds over an image's `ENV` of the same name.
 * @param built What the image was built from: the repository as fetched, the job's branch, and the
 * commit in the image's own name, which is the commit built and not wherever the branch is now. */
function createSpec(job: WorkerAssignment, house: HouseStart, built: { repository: string; branch: string; commit: string }, config: ContainerConfig, mounts: readonly EngineMount[], bindings: ReturnType<typeof portBindings>) {
  return { Image: house.id, Entrypoint: [HOUSE_NODE], Cmd: [BODY_PROGRAM, houseBodyFile(job.harness)], WorkingDir: HOUSE_REPOSITORY,
    Env: [`${BODY_SCRATCH}=/tmp`, `HOME=${HOUSE_HOME}`, `${HOUSE_ENV.repository}=${built.repository}`, `${HOUSE_ENV.branch}=${built.branch}`, `${HOUSE_ENV.commit}=${built.commit}`,
      // And whether the place its harness keeps sessions is this body's alone: it is the container's own
      // home unless a mount (an agent's own directory; a sign-in is mounted elsewhere) is, holds, or is inside
      // it (house-layout.ts, houseSessions). The worker always says, 1 or 0: a variable it sets holds over
      // an image's `ENV` of the same name, so no house can say it for itself.
      `${BODY_OWN_HARNESS}=${ownSessions(job.harness, mounts) ? '1' : '0'}`],
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

/** How long looking after the disk may take, each time: the longest one step may. */
const UPKEEP_MS = STEP_DEADLINE_MAX_MS;
/** What the worker says when it could not look after its house images. Its own words, to its own log. */
export const UPKEEP_FAILED = 'Worker could not look at its house images: old ones stay until it can\n';
/** Whether the body program can load from this directory alone, which is all a container is given of it:
 * `dist/body.js` is there, and every package the worker's own `package.json` depends on is a real directory
 * in this directory's `node_modules`. That is how `npm install -g` lays a package out, and a release
 * directory or checkout with its own `node_modules`. An install whose packages were hoisted above it (a
 * project's `node_modules`, the npx cache) or linked in from a store (pnpm) is not: the body would fail to
 * load in every container, so the worker is not started on one. */
function programInside(program: string): boolean {
  try {
    const body = join(program, 'dist', 'body.js');
    // Itself, and not a link to one outside: only this directory is in a container.
    if (!lstatSync(body).isFile() || realpathSync(body) !== body) return false;
    const manifest: unknown = JSON.parse(readFileSync(join(program, 'package.json'), 'utf8'));
    const needed: unknown = manifest && typeof manifest === 'object' && 'dependencies' in manifest ? manifest.dependencies : {};
    if (!needed || typeof needed !== 'object' || Array.isArray(needed)) return false;
    return Object.keys(needed).every(name => {
      const path = join(program, 'node_modules', name);
      return /^(@[a-z0-9~._-]+\/)?[a-z0-9~._-]+$/.test(name) && lstatSync(path).isDirectory() && realpathSync(path) === path;
    });
  } catch { return false; }
}

export function containerWorkerExecutor(config: {
  /** The longest a house's fetch and build together may take: HOUSE_BUILD_DEFAULT_MS when left out. A job
   * still waiting then fails with WORKER_EXIT.buildTime; the worker reports on the job all the while. */
  buildTimeoutMs?: number;
  container: ContainerConfig;
  /** When present, every job requires an exact account/harness sign-in directory (worker-mounts.ts). */
  accountLogins?: AccountLogins;
  /** This machine's id, as its jobs name it: the containers it may end at start carry it as a label. */
  box: string;
  /** The worker's own directory: held from here until close(), and where the house mirrors are kept. */
  state?: string;
  /** The file with the worker's token for loom, when the caller has one: no mount may reach it. */
  tokenFile?: string;
}, dependencies: {
  engine?: DockerEngine; name?: () => string;
  kitAccess?: {url:string;runner:string};
  /** Where houses are fetched from; a test names its own. */
  source?: HouseSource;
  /** The directory the worker is installed in. By default, where this program was loaded from. */
  program?: string;
  git?: () => boolean; left?: typeof workerLeft;
  /** The core house's definition. By default, the one in the directory the worker is installed in. */
  core?: CoreDefinition;
  /** Holds the engine and the sign-in directories to this worker (worker-alone.ts). A test of other things
   * names one that holds nothing. */
  alone?: HoldAlone;
  /** The time, which says which week's core house a job's house is built on. A test sets its own. */
  now?: () => number;
  /** Where the worker's own lines go (the worker program's error output). Fixed lines only. */
  say?: (line: string) => void;
} = {}): WorkerExecutor {
  const fixed = structuredClone(config);
  if (fixed.container.runtime !== undefined && !CONTAINER_RUNTIMES.includes(fixed.container.runtime)) throw new Error('Invalid container runtime');
  const buildMs = fixed.buildTimeoutMs ?? HOUSE_BUILD_DEFAULT_MS;
  if (!validDeadline(buildMs, BUILD_DEADLINE_MAX_MS)) throw new Error('Invalid worker build deadline');
  // This file is <program>/dist/runtime/worker-container.js: two directories up is the installed package.
  const program = dependencies.program ?? realpathSync(fileURLToPath(new URL('../..', import.meta.url))).replace(/\/$/, '');
  // Checked and fixed here, before the state directory is taken or anything asks the engine: a worker
  // whose mounts cannot be used is not made (WorkerStop 'mounts').
  const mountsFor = bodyMounts({ program, accountLogins: fixed.accountLogins, mounts: fixed.container.mounts, socket: fixed.container.socket,
    nestedSocket: fixed.container.nestedSocket, state: fixed.state ?? defaultWorkerState(fixed.box), tokenFile: fixed.tokenFile });
  if (!programInside(program)) throw new WorkerStop('program');
  if (!dependencies.source && !(dependencies.git ?? gitAvailable)()) throw new WorkerStop('git');
  // The core house every house is built on: read once, here, from the worker's own install. A worker
  // without it could build no house, so it is not started (WorkerStop 'core').
  let definition: CoreDefinition;
  try { definition = dependencies.core ?? coreDefinition(join(program, CORE_DIRECTORY)); } catch { throw new WorkerStop('core'); }
  const now = dependencies.now ?? Date.now;
  // What no other worker may use beside this one: the engine, by where its socket really is, and every
  // sign-in directory (each is written as its real path: worker-mounts.ts). Held before any work is
  // taken, for as long as this worker lives; asked for once, by whichever of endLeft and build comes first.
  const mine: Alone[] = [{ key: 'container.socket', path: realpathSync(fixed.container.socket) },
    ...Object.entries(fixed.accountLogins ?? {}).flatMap(([account, harnesses]) => Object.entries(harnesses)
      .map(([harness, login]) => ({ key: `accountLogins.${keyPart(account)}.${keyPart(harness)}.source`, path: login.source })))];
  let holding: Promise<() => void> | undefined;
  const alone = () => holding ??= (dependencies.alone ?? holdAlone)(mine);
  /** Whether this worker can run the job at all, asked before a build is worth starting. A house image is
   * signed in to nothing: the job's account reaches the body only as its sign-in directory. So with
   * several accounts of the job's provider on this machine and no sign-in directories configured, the
   * job cannot be held to the account loom placed it on, and is refused (WORKER_EXIT.runner). A nested
   * job on a machine with no nested socket still fails when its body is started, as before. */
  const serves = (job: WorkerAssignment) => {
    if (fixed.accountLogins === undefined && (job.accountChoices ?? 1) > 1) throw new UnservedJobError('Several accounts need a sign-in directory each');
    mountsFor({ agent: job.agent, account: job.account, harness: job.harness });
  };
  const engine = dependencies.engine ?? dockerEngine(fixed.container.socket);
  const left = fixed.state === undefined ? undefined : (dependencies.left ?? workerLeft)(fixed.state);
  const source = dependencies.source ?? houseSource({ directory: join(fixed.state ?? defaultWorkerState(fixed.box), 'houses'),
    started: pid => left ? left.note(pid, { job: 'house-fetch' }) : () => {} });
  /** The builds under way, by image, a core house's among them: one at a time for one image, and every job
   * that wants it waits on the one. A build is the worker's and not a job's: it has the build limit of its own, and a job that is
   * cancelled only stops waiting. */
  const builds = new Map<string, { done: Promise<void>; abort: AbortController; ranOut: boolean }>();
  /** Images a job wants or has, from the moment it knows which image that is until its body has ended or it
   * is known that it will never start one (`discard`): not removed meanwhile. Counted, since several jobs
   * may hold one image. */
  const inHand = new Map<string, number>();
  /** When each image was last taken by a job, as a count that only grows: what an upkeep ranks them by. */
  const recent = new Map<string, number>(); let takes = 0;
  const hold = (image: string, by: 1 | -1) => {
    const count = (inHand.get(image) ?? 0) + by; if (count > 0) inHand.set(image, count); else inHand.delete(image);
    if (by === 1) recent.set(image, ++takes);
  };
  /** Removals of house images under way, by image: whoever wants one of these waits for its removal to be
   * over before asking the engine whether the image is there. */
  const removing = new Map<string, { over: Promise<void>; end: () => void }>();
  /** An image may be removed when no job holds it and none is building it, asked at the moment of removal.
   * A core house also stays while a job holds, or a build is making, a house image built on it. */
  const wanted = (core: string) => [...inHand.keys(), ...builds.keys()].some(image => houseImageName(image) && houseCore(image) === core);
  const guard: HouseGuard = {
    take(image) {
      if (inHand.has(image) || builds.has(image) || removing.has(image) || (coreImageName(image) && wanted(image))) return false;
      let end!: () => void; const over = new Promise<void>(resolve => { end = resolve; });
      removing.set(image, { over, end }); return true;
    },
    done(image) { const removal = removing.get(image); removing.delete(image); recent.delete(image); removal?.end(); },
    used: image => recent.get(image),
  };
  /** Looking after the disk, after a build: old house images and what builds left behind. It is nobody's
   * job: it runs beside whatever comes next, under a limit of its own, one at a time, and a failure is
   * said and nothing more. An image a job holds, or one being built, is kept: asked at each removal. The
   * image a build has just made is kept on merit: it is the one this worker took most recently. */
  let upkeeping: AbortController | undefined;
  const upkeep = () => {
    if (upkeeping) return;
    const abort = upkeeping = new AbortController(), timer = setTimeout(() => abort.abort(), UPKEEP_MS);
    // What builds leave behind is asked gone only when this was the only build: another's unfinished
    // layers have no name either.
    void pruneHouses(engine, guard, builds.size <= 1, abort.signal).then(looked => looked, () => false)
      .then(looked => { clearTimeout(timer); if (upkeeping === abort) upkeeping = undefined; if (!looked && !closed) dependencies.say?.(UPKEEP_FAILED); });
  };
  let closed = false;
  /** One build of one image, shared by whoever wants it, with the build limit of its own. */
  type Build = { done: Promise<void>; abort: AbortController; ranOut: boolean };
  const shared = (image: string, make: (build: Build) => Promise<void>): Build => {
    let build = builds.get(image);
    if (!build) {
      const abort = new AbortController(), made: Build = { abort, ranOut: false, done: Promise.resolve() };
      const timer = setTimeout(() => { made.ranOut = true; abort.abort(); }, buildMs);
      made.done = make(made).finally(() => { clearTimeout(timer); if (builds.get(image) === made) builds.delete(image); });
      void made.done.catch(() => {});
      build = made; builds.set(image, build);
    }
    return build;
  };
  /** Wait for another build as part of this one: it ends when this one is ended, and its running out of
   * time is this one's too. */
  const within = async (build: Build, other: Build) => {
    const ended = new Promise<never>((_, reject) => { const stop = () => reject(new Error('Worker build cancelled')); if (build.abort.signal.aborted) stop(); else build.abort.signal.addEventListener('abort', stop, { once: true }); });
    void ended.catch(() => {});
    try { await Promise.race([other.done, ended]); } catch (error) { if (other.ranOut) build.ranOut = true; throw error; }
  };
  /** The core house, built unless it is there: from the worker's own definition, like a house in every
   * way that matters to a job (the same limit, the same one build for all who wait, the same failure). */
  const coreBuilt = (core: string) => shared(core, async build => {
    // One that is being removed this moment is waited for, and then found gone and built again.
    await removing.get(core)?.over;
    if (await coreThere(engine, core, build.abort.signal)) return;
    await buildCore(engine, core, definition.context(), build.abort.signal);
  });
  const built = (house: WorkerAssignment['house'], commit: string, image: string) => shared(image, async build => {
    if (await houseBuilt(engine, image, build.abort.signal)) return;
    await within(build, coreBuilt(houseCore(image)));
    // A house with no Housefile is the core with its repository copied in: the worker writes those lines.
    const apart = house.file === '' ? noHousefile() : undefined;
    await buildHouse(engine, image, apart ? NO_HOUSEFILE : house.file, source.context(house, commit, build.abort.signal, apart), build.abort.signal);
    upkeep();
  });
  const setupMs = deadline(fixed.container.setupTimeoutMs, 30_000);
  const cleanupMs = deadline(fixed.container.cleanupTimeoutMs, 30_000);
  return {
    close() { closed = true; for (const build of builds.values()) build.abort.abort(); upkeeping?.abort(); left?.close(); void holding?.then(release => release(), () => {}); },
    /** What a previous worker left: a git it had started is a process, recorded in the state directory.
     * Its bodies are containers: every one labelled as a job of this machine is removed, running or not.
     * The list is read a few at a time until it is empty, so one reply never outgrows what the engine
     * client reads. */
    async endLeft(signal) {
      // First of all: a worker that is not alone on its engine ends nothing there and takes no work.
      await alone();
      const processes = left ? { unverified: (await left.reap()).unverified } : { unverified: 0 };
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
    /** The job's house as an image on this engine: its repository fetched at the job's branch, and that
     * commit built unless it already is. The secret loom sent for the repository goes to the fetch and
     * nowhere else. Nothing here blocks: the worker goes on reporting on the job while it waits. A job
     * that has waited the build limit fails with BuildTimeError; whatever else goes wrong fails it as a
     * failed build, in one sentence, because git's and the engine's own words may name the repository. */
    build(job, signal, repositoryInput) {
      serves(job);
      const house = structuredClone(job.house);
      return (async () => {
        const limit = new AbortController(); let ranOut = false, shared: ReturnType<typeof built> | undefined, held: string | undefined;
        const cancel = () => limit.abort(), timer = setTimeout(() => { ranOut = true; limit.abort(); }, buildMs);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        // The wait ends with the limit or the job, whatever the fetch or the engine is doing.
        const ended = new Promise<never>((_, reject) => limit.signal.addEventListener('abort', () => reject(new Error('Worker build cancelled')), { once: true }));
        void ended.catch(() => {});
        try {
          if (limit.signal.aborted) throw new Error('Worker build cancelled');
          await alone();
          const commit = await Promise.race([source.fetch(house, repositoryInput, limit.signal), ended]);
          // Built on the core house of the week this job came in: a job under way when a week turns keeps the
          // image it has, and the next job's house is built on the new core.
          const image = houseImage(house, commit, coreImage(definition.digest, coreWeek(now())));
          // Held from here, before anything is asked about it: an upkeep under way will not remove it now.
          hold(image, 1); held = image;
          // One that is being removed this moment is waited for, so that it is found gone and built again
          // rather than found there and gone a moment later.
          const removal = removing.get(image);
          if (removal) await Promise.race([removal.over, ended]);
          shared = built(house, commit, image);
          await Promise.race([shared.done, ended]);
          held = undefined;
          return image;
        } catch {
          // Whatever went wrong, this job will not use the image.
          if (held !== undefined) hold(held, -1);
          throw ranOut || shared?.ranOut ? new BuildTimeError('Worker build ran out of time') : new Error('Worker build failed');
        } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
      })();
    },
    /** A job that was given this image and will start no body from it. */
    discard(_job, image) { hold(image, -1); },
    start(job, image, signal): WorkerBody {
      const assignment = structuredClone(job);
      // The image is this job's until its body has ended, or was never made.
      let held = true;
      const letGo = () => { if (held) { held = false; hold(image, -1); } };
      let mounts: EngineMount[], bindings: ReturnType<typeof portBindings>, name: string;
      try {
        if (signal.aborted) throw new Error('Container cancelled');
        serves(assignment);
        if (!houseImageName(image)) throw new Error('Invalid container image');
        // Told to the body as it is: only an address the worker fetches, which holds no credential.
        if (!(source.fetches ?? houseRepository)(assignment.house.repository)) throw new Error('Invalid house repository');
        mounts = engineMounts(mountsFor(assignment)); bindings = portBindings(assignment);
        name = `loom-${(dependencies.name ?? randomUUID)()}`;
        if (!/^loom-[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid container name');
      } catch (error) { letGo(); throw error; }
      const abort = new AbortController();
      let socket: Duplex | undefined, id: string | undefined, released = false, createRejected = false, createAsked = false;
      let kit:Awaited<ReturnType<typeof kitSocket>>|undefined, broker:ReturnType<typeof kitBroker>|undefined, houseId:string|undefined;
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
          // The image says that it is a house of this layout and serves the harness; one that does not fails
          // this job (UnmetHouseError). How a body starts is the layout's (house-layout.ts).
          const house=await houseStart(engine, image, assignment.harness, abort.signal);
          houseId=canonicalKitImage(house.id);
          // A body on a machine that lends out its engine can inspect other containers there.
          // Such a machine never receives kit secrets. A new socket belongs to one job only.
          if(houseId&&dependencies.kitAccess&&!fixed.container.nestedSocket&&!assignment.run?.nestedContainers){
            kit=await kitSocket(fixed.state??defaultWorkerState(fixed.box),()=>broker,abort.signal).catch(()=>undefined);
            if(kit)mounts=[...mounts,{Type:'bind',Source:kit.path,Target:KIT_SOCKET,ReadOnly:true}];
          }
          const spec = createSpec(assignment, house,
            { repository: assignment.house.repository, branch: assignment.house.branch, commit: houseCommit(image) }, fixed.container, mounts, bindings);
          if (abort.signal.aborted) throw new Error('Container cancelled');
          let created: unknown; createAsked = true;
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
      // The program is loom's own body program, so it takes the body's private credential.
      return { acceptsBootstrap: true, spawned: setup, exited,
        async release(bootstrap) {
          await setup;
          if (released || abort.signal.aborted || stopping || !socket || socket.destroyed) throw new Error('Container input unavailable');
          released = true;
          if (bootstrap) logs!.discard();
          const payload = bodyInput(assignment, image, bootstrap, true);
          if(kit&&dependencies.kitAccess&&payload.bootstrap&&houseId){
            broker=kitBroker({repository:assignment.house.repository,commit:houseCommit(image),image:houseId,denials:deniedTools(assignment.run?.policy),
              post:kitPrivateClient({url:dependencies.kitAccess.url,runner:dependencies.kitAccess.runner,body:payload.bootstrap.token,job:assignment.id}),
              run:invocation=>runKitContainer(engine,{...invocation,job:assignment.id,box:assignment.box})});
          }
          await new Promise<void>((resolve, reject) => socket!.end(JSON.stringify({...payload,...(broker?{kitSocket:true}:{})}) + '\n',
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
            await kit?.close().catch(()=>{}); broker=undefined;
            const cleanup = new AbortController();
            const timer = setTimeout(() => cleanup.abort(), cleanupMs);
            try {
              // Name also covers a create reply lost before its ID was received.
              // Nothing to remove when the engine was never asked for a container (the image was refused first).
              if (createAsked && !createRejected) await engine.json('DELETE', `/containers/${id ?? name}?force=1&v=1`, undefined, cleanup.signal);
              if (cleanup.signal.aborted) throw new Error('Container cleanup uncertain');
            } finally {
              clearTimeout(timer); signal.removeEventListener('abort', cancel); letGo();
            }
          });
          return stopping;
      }
    },
  };
}
