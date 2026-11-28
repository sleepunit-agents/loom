import {prepareHouseCli} from './house-cli-file.js';
import { BUILD_DEADLINE_MAX_MS, HOUSE_BUILD_DEFAULT_MS, STEP_DEADLINE_MAX_MS, validDeadline } from './worker-limits.js';
import { logTail } from './log-tail.js';
import { failureLines, failureSignal, type JobFailure } from './job-failure.js';
import { bodyInput } from './body-bootstrap.js';
/** Container bodies run only in the separate worker. One worker runs any agent's house: it fetches the
 * job's house repository and builds its image itself (house-source.ts, house-image.ts), mounts its own
 * body program into the container, and starts every body the same way (house-layout.ts). Every house is
 * built on the core house, which the worker builds from its own install (house-core.ts). Nothing about any one
 * agent is set up on the machine but, where wanted, that agent's mounts. */
import {canonicalKitImage} from './kit-manifest.js';
import {kitUnavailableList,type KitUnavailable,type kitAvailabilityReport} from './kit-availability.js';
import type {z} from 'zod';
import {kitBroker} from './kit-broker.js';
import {kitSocket} from './kit-socket.js';
import {kitPrivateClient} from './kit-private-client.js';
import {houseProgramSchema} from './house-program.js';
import {scheduledContainer} from './scheduled-container.js';
import {runKitContainer} from './kit-container.js';
import {KIT_SOCKET} from './body-kit-tools.js';
import {deniedTools} from './harness-traits.js';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname,join } from 'node:path';
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
import { HOUSE_ENTRYPOINT, HOUSE_ENV, HOUSE_HOME, HOUSE_REPOSITORY, houseBodyFile, houseOverlap, houseSessions } from './house-layout.js';
import { removeReviewSnapshot, snapshotFingerprint, writeReviewSnapshot } from './review-snapshot.js';
import { REVIEW_MOUNT } from '../core/conversations/review-brief.js';
import { bodyMounts, BODY_PROGRAM, HOUSE_CLI_FILE, type AccountLogins, type AgentMounts, type BodyMount } from './worker-mounts.js';

/** The names the worker may send as the engine's runtime. The operator states which one their engine has;
 * nothing is discovered. */
export const CONTAINER_RUNTIMES = ['runc', 'crun'] as const;

export interface ContainerConfig {
  socket: string;
  podmanHelperSubid?: number;
  /** Retired configuration key. Its presence stops the worker. */
  nestedSocket?: string;
  protectedPaths?: readonly string[];
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
  return { Image: house.id, Entrypoint: [...HOUSE_ENTRYPOINT], Cmd: [BODY_PROGRAM, houseBodyFile(job.harness)], WorkingDir: HOUSE_REPOSITORY,
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
  // A body's output is dropped (discard). The one thing read from it either way is the line its body program
  // writes to say why it failed, kept only when it is exactly one of the fixed reasons (job-failure.ts).
  const failures = failureLines();
  const append = (text: string, from = 0) => { if (from === 2) failures.write(text); if (!privateOutput) tail = logTail(tail + text); };
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
        append(decoders[stream].write(chunk.subarray(offset, offset + count)), stream);
        remaining -= count; offset += count;
      }
    };
    socket.on('data', data);
    socket.once('error', fail);
    socket.once('end', () => {
      if (remaining || header.length) reject(new Error('Incomplete container output'));
      else { decoders.forEach((decoder, from) => append(decoder.end(), from)); resolve(); }
    });
    socket.once('close', () => { if (!socket.readableEnded) reject(new Error('Container output closed')); });
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) fail();
    // Listener is removed on either outcome without creating an unhandled chain.
    socket.once('close', () => signal.removeEventListener('abort', fail));
  });
  void done.catch(() => {});
  return { done, tail: () => tail, failure: failures.failure, discard: () => { privateOutput = true; tail = ''; } };
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
    const launcher = join(program,HOUSE_CLI_FILE);
    const paths = [join(program,'dist','body.js'),join(program,'dist','index.js'),launcher];
    for (const file of paths) {
      const stat = lstatSync(file), needed = file===launcher ? 0o555 : 0o444;
      if (!stat.isFile() || realpathSync(file)!==file || (stat.mode & needed)!==needed) return false;
      // Containers begin at the program mount; host directories above it are irrelevant.
      for (let parent=dirname(file);;parent=dirname(parent)) {
        if ((lstatSync(parent).mode & 0o111)!==0o111) return false;
        if (parent===program) break;
      }
    }
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
  configFile?: string;
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
    protectedPaths: fixed.container.protectedPaths, configFile: fixed.configFile,
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
    if (job.program) {
      const plan = houseProgramSchema.parse(job.program);
      if (job.house.repository !== plan.repository) throw new Error('Program repository does not match its pin');
      if (job.run?.nestedContainers) throw new Error('Nested containers unavailable');
      return;
    }
    if (fixed.accountLogins === undefined && (job.accountChoices ?? 1) > 1) throw new UnservedJobError('Several accounts need a sign-in directory each');
    mountsFor({ agent: job.agent, account: job.account, harness: job.harness });
  };
  const engine = dependencies.engine ?? dockerEngine(fixed.container.socket);
  const left = fixed.state === undefined ? undefined : (dependencies.left ?? workerLeft)(fixed.state);
  const source = dependencies.source ?? houseSource({ directory: join(fixed.state ?? defaultWorkerState(fixed.box), 'houses'),
    started: pid => left ? left.note(pid, { job: 'house-fetch' }) : () => {} });
  /** Frozen reviews' copies (review-snapshot.ts), by job: written by `build`, mounted read-only by `start`, fingerprinted
   * again and removed when the body has ended, or removed by `discard` for a job that never starts one. */
  const reviews = join(fixed.state ?? defaultWorkerState(fixed.box), 'reviews');
  const snapshots = new Map<string, { path: string; before: string; head: string }>();
  const forget = (job: string) => { const copy = snapshots.get(job); snapshots.delete(job); return copy ? removeReviewSnapshot(copy.path).catch(() => {}) : Promise.resolve(); };
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
      // A previous worker's frozen review copies: no body of this worker has one yet.
      await removeReviewSnapshot(reviews);
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
    build(job, signal, repositoryInput, reviewInput) {
      const reviewCommit = job.coldReview?.headCommit;
      if (reviewInput && !job.frozenReview) throw new UnservedJobError('Only a frozen review is given a review fetch credential');
      if (job.coldReview) {
        if (!reviewCommit || job.house.file !== '' || job.program || repositoryInput)
          throw new UnservedJobError('Cold reviews require a pinned, copy-only house without an agent credential');
      } else serves(job);
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
          const fetching = reviewCommit
            ? source.fetch(house, undefined, limit.signal, reviewCommit)
            : source.fetch(house, repositoryInput, limit.signal);
          const commit = await Promise.race([fetching, ended]);
          if (reviewCommit && commit !== reviewCommit) throw new Error('Review source differs from its pin');
          if (job.program && commit !== job.program.commit) throw new Error('Program commit does not match its pin');
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
          // A frozen review's copy: the reviewed commit and its diff, fetched from GitHub with the credential loom's
          // forge bindings hold for the reviewed repository's owner (never the house's), which goes to git and nowhere
          // else. None, no copy. A job id is loom's, checked here before it names a directory.
          const frozen = job.frozenReview;
          if (frozen) {
            if (!reviewInput?.length) throw new Error('Review fetch credential unavailable');
            if (!/^[A-Za-z0-9_-]{1,200}$/.test(job.id)) throw new Error('Invalid job identity');
            await forget(job.id);
            const path = join(reviews, job.id);
            await removeReviewSnapshot(path); await mkdir(reviews, { recursive: true, mode: 0o700 });
            const before = await Promise.race([writeReviewSnapshot({ source, directory: path, review: frozen, credential: reviewInput, signal: limit.signal }), ended]);
            snapshots.set(job.id, { path, before, head: frozen.head });
          }
          held = undefined;
          return image;
        } catch {
          // Whatever went wrong, this job will not use the image, nor its copy.
          if (held !== undefined) hold(held, -1);
          if (job.frozenReview) await forget(job.id);
          throw ranOut || shared?.ranOut ? new BuildTimeError('Worker build ran out of time') : new Error('Worker build failed');
        } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
      })();
    },
    /** A job that was given this image and will start no body from it. */
    discard(job, image) { hold(image, -1); void forget(job.id); },
    start(job, image, signal): WorkerBody {
      const assignment = structuredClone(job);
      // The image is this job's until its body has ended, or was never made.
      let held = true;
      const letGo = () => { if (held) { held = false; hold(image, -1); } };
      let mounts: EngineMount[], bindings: ReturnType<typeof portBindings>, name: string;
      try {
        if (signal.aborted) throw new Error('Container cancelled');
        if (assignment.coldReview) throw new UnservedJobError('A cold review needs an isolated reviewer');
        serves(assignment);
        if (!houseImageName(image)) throw new Error('Invalid container image');
        // Told to the body as it is: only an address the worker fetches, which holds no credential.
        if (!(source.fetches ?? houseRepository)(assignment.house.repository)) throw new Error('Invalid house repository');
        if (assignment.program) return scheduledContainer(engine, assignment, image, assignment.program, signal, {
          runtime:fixed.container.runtime, podmanHelperSubid:fixed.container.podmanHelperSubid, setupTimeoutMs:setupMs, cleanupTimeoutMs:cleanupMs,
        },letGo);
        prepareHouseCli(fixed.state ?? defaultWorkerState(fixed.box));
        // A frozen review is given its copy read-only, and none of its agent's own fixed mounts: a reviewer is handed
        // nothing of the agent's but what every body is (the program, the house's tool, its sign-in).
        const copy = assignment.frozenReview ? snapshots.get(assignment.id) : undefined;
        if (assignment.frozenReview && (!copy || copy.head !== assignment.frozenReview.head)) throw new Error('Review copy unavailable');
        mounts = engineMounts([...mountsFor(assignment, { agentMounts: !assignment.frozenReview }),
          ...(copy ? [{ source: copy.path, target: REVIEW_MOUNT, readOnly: true }] : [])]);
        // Nor its agent's published ports: a reviewer serves nothing.
        bindings = assignment.frozenReview ? {} : portBindings(assignment);
        name = `loom-${(dependencies.name ?? randomUUID)()}`;
        if (!/^loom-[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid container name');
      } catch (error) { letGo(); throw error; }
      const abort = new AbortController();
      let socket: Duplex | undefined, id: string | undefined, released = false, createRejected = false, createAsked = false;
      let kit:Awaited<ReturnType<typeof kitSocket>>|undefined, broker:ReturnType<typeof kitBroker>|undefined, houseId:string|undefined;
      let reportKits:((transport:z.infer<typeof kitAvailabilityReport>['transport'],signal:AbortSignal)=>Promise<KitUnavailable[]>)|undefined;
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
          // A review uses no kit (shared-kit-access.ts refuses one too): no socket is made for it.
          if(houseId&&dependencies.kitAccess&&!assignment.frozenReview){
            kit=await kitSocket(fixed.state??defaultWorkerState(fixed.box),()=>broker,abort.signal,(transport,signal)=>reportKits?.(transport,signal)??Promise.resolve([])).catch(()=>undefined);
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
      const ran = (async () => {
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
          if (exitCode === status) return { exitCode, logTail: logs!.tail(), signalled: false, failure: logs!.failure() };
          // A signal ended the body, so it said nothing. The worker says which, and whether the engine saw the
          // system's memory killer at work in the container (`State.OOMKilled`): read before the container is removed.
          const state: unknown = await engine.json('GET', `/containers/${id}/json`, undefined, abort.signal)
            .then(found => found && typeof found === 'object' && 'State' in found ? found.State : undefined, () => undefined);
          const signal = failureSignal(status - 128);
          const failure: JobFailure = state && typeof state === 'object' && 'OOMKilled' in state && state.OOMKilled === true ? { reason: 'out-of-memory' } : { reason: 'killed', ...(signal ? { signal } : {}) };
          return { exitCode, logTail: logs!.tail(), signalled: true, failure };
        } finally { if (drainTimer) clearTimeout(drainTimer); void both.catch(() => {}); }
      })();
      void ran.catch(() => {});
      // A frozen review's copy, fingerprinted again now the body has ended: the report says whether it changed.
      const exited = assignment.frozenReview ? ran.then(async result => {
        const copy = snapshots.get(assignment.id), after = copy && await snapshotFingerprint(copy.path).catch(() => undefined);
        return copy && after ? { ...result, reviewTree: { head: copy.head, before: copy.before, after } } : result;
      }) : ran;
      void exited.catch(() => {});
      // The program is loom's own body program, so it takes the body's private credential.
      return { acceptsBootstrap: true, spawned: setup, exited,
        async release(bootstrap) {
          await setup;
          if (released || abort.signal.aborted || stopping || !socket || socket.destroyed) throw new Error('Container input unavailable');
          released = true;
          if (bootstrap) logs!.discard();
          const payload = bodyInput(assignment, image, bootstrap, true);
          let kitUnavailable:KitUnavailable[]=[],kitReportFailed=false;
          if(dependencies.kitAccess&&payload.bootstrap&&!assignment.frozenReview){
            const post=kitPrivateClient({url:dependencies.kitAccess.url,runner:dependencies.kitAccess.runner,body:payload.bootstrap.token,job:assignment.id});
            const pin=houseId ? {repository:assignment.house.repository,commit:houseCommit(image),image:houseId} : undefined;
            reportKits=async(transport,signal)=>{
              // The report is idempotent. A lost reply may follow a committed notice.
              const report={id:randomUUID(),pin,transport,offered:transport==='ready'?broker?.offeredTools()??[]:[]};
              for(let attempt=0;attempt<2 && !signal.aborted;attempt++){
                try{
                  const result=await post('availability',report,signal);
                  return kitUnavailableList.parse((result as {unavailable:unknown}).unavailable);
                }catch{/* Retry the same availability observation; tool calls are never replayed here. */}
              }
              dependencies.say?.('Could not report kit availability for job '+assignment.id);
              throw Error('Kit availability report failed');
            };
            if(kit&&pin){
              broker=kitBroker({...pin,denials:deniedTools(assignment.run?.policy),post,
                run:invocation=>runKitContainer(engine,{...invocation,job:assignment.id,box:assignment.box,runtime:fixed.container.runtime,podmanHelperSubid:fixed.container.podmanHelperSubid})});
            }else try {kitUnavailable=await reportKits(pin?'socket':'image',abort.signal);}
            catch {kitReportFailed=true;}
          }
          await new Promise<void>((resolve, reject) => socket!.end(JSON.stringify({...payload,...(broker?{kitSocket:true}:{}),
            ...(kitUnavailable.length?{kitUnavailable}:{}),...(kitReportFailed?{kitReportFailed:true}:{})}) + '\n',
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
              if (assignment.frozenReview) await exited.catch(() => {}).then(() => forget(assignment.id));
            }
          });
          return stopping;
      }
    },
  };
}
