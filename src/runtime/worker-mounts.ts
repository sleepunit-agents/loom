/** The directories of this machine that a container body is given: its own account's sign-in directory
 * (`accountLogins`), its own agent's fixed mounts (`container.mounts`, by agent), the worker's own program
 * directory, read-only, which holds the body program every body runs, and for a job allowed nested
 * containers the engine's socket (`container.nestedSocket`). Nothing else of the host is ever mounted.
 *
 * Every rule about these paths is here and nowhere else, the engine's own socket (`container.socket`)
 * included; the configuration's schema reads only that each is a string. They are checked once, when the
 * worker starts: a configuration that breaks one stops the worker (WorkerStop 'mounts') before it takes
 * any work. The paths are machine-local, like `accountRunners`: no error made here carries one, and
 * nothing here writes a log. */
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { UnservedJobError, type WorkerAssignment } from './worker.js';
import { WorkerStop } from './worker-stop.js';
import { relativeName } from './house-context.js';
import { HARNESS_NAME, HOUSE_REPOSITORY, houseLogin, houseMount } from './house-layout.js';

/** Where a body allowed nested containers finds the engine's socket. */
export const NESTED_SOCKET_TARGET = '/var/run/docker.sock';
/** The places no other mount's target may be, hold or be inside, so that none hides or replaces the socket:
 * the place itself, and the one it is in most images, where `/var/run` is a link to `/run`. */
const SOCKET_PLACES = [NESTED_SOCKET_TARGET, '/run/docker.sock'] as const;
/** Where every body's container finds the worker's own program directory, and in it the body program. */
export const BODY_PROGRAM_TARGET = '/opt/loom';
/** The body program inside that directory, as a path in the container. */
export const BODY_PROGRAM = `${BODY_PROGRAM_TARGET}/dist/body.js`;
/** What a stop names when the program directory itself is at fault: it has no configuration key. */
const PROGRAM_KEY = 'the directory the worker is installed in';
/** A configuration key's part as it is printed: as it is when it is an ordinary name, quoted otherwise. */
export const keyPart = (part: string) => /^[A-Za-z0-9_@.+-]+$/.test(part) ? part : JSON.stringify(part);
/** A directory of this machine. */
export interface HostDirectory { source: string }
/** A mount every body of one agent gets on this machine. Read-only unless it says otherwise. */
export interface FixedMount extends HostDirectory {
  /** Where it lands in the container, as a path under the tenant's home (house-layout.ts): relative, and
   * going nowhere but down. A machine's configuration names no other place inside a container. */
  target: string;
  readOnly?: boolean;
}
/** The fixed mounts of each agent, by agent id. A body gets its own agent's list and no other. */
export type AgentMounts = Readonly<Record<string, readonly FixedMount[]>>;
/** A sign-in directory of this machine for each account id, then harness. Where it appears in a container
 * is loom's to say and the same in every house (house-layout.ts), so an entry has no target. */
export type AccountLogins = Readonly<Record<string, Readonly<Record<string, HostDirectory>>>>;
/** One bind mount the worker asks the engine for, and expects to find when it inspects the container. */
export interface BodyMount { readonly source: string; readonly target: string; readonly readOnly: boolean }

/** `inner` is `outer` or a path inside it. Both are plain absolute paths (see `plainPath`). */
const inside = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}/`);
const overlap = (one: string, other: string) => inside(one, other) || inside(other, one);
/** An absolute path written one way only: no `.`, `..`, doubled or trailing slash, and not the root. So
 * two paths name the same place, or one inside the other, exactly when their text says so. */
export const plainPath = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && path !== '/'
  && !path.includes('\0') && !path.endsWith('/') && posix.normalize(path) === path;

/** Where a path that may not exist yet will be: the real path of the nearest directory above it that
 * exists, and the rest as written. */
function resting(path: string): string {
  const full = resolve(path);
  try { return realpathSync(full); } catch { /* not there yet */ }
  const above = dirname(full);
  return above === full ? full : join(resting(above), basename(full));
}

/** Check the configured paths and fix them. Returns what one job's container is given: the engine's socket
 * first when the job is allowed nested containers, then the worker's program directory, then its account's
 * sign-in directory for its harness when sign-ins are configured, then its own agent's fixed mounts.
 * @throws WorkerStop('mounts'), with the configuration key at fault, when the configuration breaks a rule.
 * Of two directories that overlap it names the later one. The returned function throws
 * UnservedJobError for a job with no exact sign-in entry, as a missing `accountRunners` entry does, and
 * a plain error for a nested job on a machine with no nested socket. */
export function bodyMounts(config: {
  accountLogins?: AccountLogins; mounts?: AgentMounts;
  /** The directory the worker is installed in, mounted read-only into every body at BODY_PROGRAM_TARGET.
   * Left out only by callers that start no body (tests of the other mounts alone). */
  program?: string;
  /** The engine's socket the worker itself talks to. Never mounted; a mount that reached it would hand
   * every body the engine. Left out only by callers that have no engine (tests of the mounts alone). */
  socket?: string;
  nestedSocket?: string;
  /** The worker's own files, never mounted: the state directory (its records of what it started, by which
   * the next worker ends what this one left) and the file holding its token for loom. */
  state?: string; tokenFile?: string;
}, user: { uid?: () => number | undefined } = {}): (job: Pick<WorkerAssignment, 'agent' | 'account' | 'harness' | 'run'>) => BodyMount[] {
  const uid = (user.uid ?? (() => process.getuid?.()))();
  /** Stop the worker, naming the configuration key at fault and nothing written under it. */
  const stop = (key: string): never => { throw new WorkerStop('mounts', key); };
  /** An existing directory of the worker's own user, named by its real path: neither it nor a directory
   * above it is a symbolic link, so the place checked now is the place mounted later, and the text of two
   * sources can be compared. */
  const directory = (path: unknown): path is string => {
    if (!plainPath(path) || uid === undefined) return false;
    try { const found = lstatSync(path); return found.isDirectory() && found.uid === uid && realpathSync(path) === path; }
    catch { return false; }
  };
  /** An engine's socket: plainly written and, followed through any symbolic link (`/var/run` is one on
   * most machines), an existing Unix socket. It is the engine's, so it need not
   * belong to the worker's user. Anything else at that path (a directory above the sign-in directories,
   * say) would be mounted into a nested job's container in the socket's place. */
  const socket = (path: unknown): path is string => {
    if (!plainPath(path)) return false;
    try { return lstatSync(realpathSync(path)).isSocket(); }
    catch { return false; }
  };
  /** A mounted directory, the configuration key it was written under, and whose containers it is in:
   * one agent's (a fixed mount), one account and harness's (a sign-in directory), or every body's. */
  interface Entry { mount: BodyMount; key: string; agent?: string; login?: true }
  const fixed = new Map<string, BodyMount[]>(), logins = new Map<string, Map<string, BodyMount>>(), directories: Entry[] = [];
  // The worker's own directory need not be this user's (a system-wide install is root's). It is only read.
  let program: BodyMount | undefined;
  if (config.program !== undefined) {
    const path = config.program;
    try { if (!plainPath(path) || !lstatSync(path).isDirectory() || realpathSync(path) !== path) stop(PROGRAM_KEY); }
    catch { stop(PROGRAM_KEY); }
    program = Object.freeze({ source: path, target: BODY_PROGRAM_TARGET, readOnly: true });
    directories.push({ key: PROGRAM_KEY, mount: program });
  }
  for (const [agent, mounts] of Object.entries(config.mounts ?? {})) {
    const own: BodyMount[] = [];
    for (const [index, mount] of mounts.entries()) {
      const key = `container.mounts.${keyPart(agent)}[${index}]`;
      if (!directory(mount.source)) stop(`${key}.source`);
      // Under the tenant's home, and not the repository or a directory that holds it: a mount there would
      // put the machine's files where the house's own are. Inside the repository is the agent's to ask for.
      if (typeof mount.target !== 'string' || mount.target.includes('\0') || !relativeName(mount.target)) stop(`${key}.target`);
      const target = houseMount(mount.target);
      if (inside(HOUSE_REPOSITORY, target)) stop(`${key}.target`);
      // Read-only unless it says exactly `false`.
      const made = Object.freeze({ source: mount.source, target, readOnly: mount.readOnly !== false });
      own.push(made); directories.push({ key, mount: made, agent });
    }
    fixed.set(agent, own);
  }
  for (const [account, harnesses] of Object.entries(config.accountLogins ?? {})) {
    const byHarness = new Map<string, BodyMount>();
    for (const [harness, login] of Object.entries(harnesses)) {
      const key = `accountLogins.${keyPart(account)}.${keyPart(harness)}`;
      if (!directory(login.source)) stop(`${key}.source`);
      // A harness's name is part of the place its sign-in is mounted at.
      if (!HARNESS_NAME.test(harness)) stop(key);
      // Read-write: the provider's program rewrites its files when it renews the sign-in. Two bodies on
      // one account share it: docs/accepted-tradeoffs.md, "Two bodies on one account share one sign-in directory".
      const mount = Object.freeze({ source: login.source, target: houseLogin(harness), readOnly: false });
      byHarness.set(harness, mount); directories.push({ key, mount, login: true });
    }
    logins.set(account, byHarness);
  }
  if (config.socket !== undefined && !socket(config.socket)) stop('container.socket');
  if (config.nestedSocket !== undefined && !socket(config.nestedSocket)) stop('container.nestedSocket');
  // Mounted as it is written, as before: the engine reports the source it was asked for.
  const nested = config.nestedSocket === undefined ? undefined
    : Object.freeze({ source: config.nestedSocket, target: NESTED_SOCKET_TARGET, readOnly: false });
  // Inside one container: no directory on, above or below the nested socket's place or another directory
  // that can be in the same container. Two never meet when they are two agents' fixed mounts, or two
  // sign-in directories; those may share a target. Of two that collide, the later is named.
  const meet = (one: Entry, other: Entry) => !(one.login && other.login) && !(one.agent !== undefined && other.agent !== undefined && one.agent !== other.agent);
  for (const [index, entry] of directories.entries())
    if (SOCKET_PLACES.some(place => overlap(entry.mount.target, place))
      || directories.some((other, at) => at < index && meet(entry, other) && overlap(entry.mount.target, other.mount.target))) stop(`${entry.key}.target`);
  // On this machine, one rule for every source, whoever's it is. No two mounted directories are the same or
  // one inside the other: a sign-in directory then reaches only its own account and harness, an agent's
  // directory only that agent's bodies, the body program cannot be written through an agent's mount, and a
  // read-only directory is not writable under a second name. And none is, holds or lies inside what must
  // stay out of a container that was not given it: either engine socket, the worker's state directory, the
  // file with its token. Each of those is compared twice, as it is written and where it really is (or will
  // be): a body must reach neither the thing nor a link the worker follows to it.
  const kept = [config.socket, config.nestedSocket, config.state, config.tokenFile].flatMap(path => path === undefined ? [] : [resolve(path), resting(path)]);
  for (const [index, { mount, key }] of directories.entries())
    if (directories.some((other, at) => at < index && overlap(mount.source, other.mount.source)) || kept.some(path => overlap(mount.source, path)))
      stop(key === PROGRAM_KEY ? key : `${key}.source`);
  const present = config.accountLogins !== undefined;
  return job => {
    const own: BodyMount[] = [];
    if (job.run?.nestedContainers) {
      if (!nested) throw new Error('Nested containers unavailable');
      own.push(nested);
    }
    if (program) own.push(program);
    if (present) {
      const login = logins.get(job.account)?.get(job.harness);
      // Never a fallback: not the other mounts alone, and never another account's directory.
      if (!login) throw new UnservedJobError('Worker has no configured sign-in directory for account');
      own.push(login);
    }
    // Its own agent's and nobody else's; an agent with no list gets none.
    return [...own, ...fixed.get(job.agent) ?? []];
  };
}
