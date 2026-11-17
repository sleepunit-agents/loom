/** The directories of this machine that a container body is given: its own account's sign-in directory
 * (`accountLogins`) and the house's fixed mounts (`container.mounts`), and for a job allowed nested
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

/** Where a body allowed nested containers finds the engine's socket. */
export const NESTED_SOCKET_TARGET = '/var/run/docker.sock';
/** The places no other mount's target may be, hold or be inside, so that none hides or replaces the socket:
 * the place itself, and the one it is in most images, where `/var/run` is a link to `/run`. */
const SOCKET_PLACES = [NESTED_SOCKET_TARGET, '/run/docker.sock'] as const;
/** A configuration key's part as it is printed: as it is when it is an ordinary name, quoted otherwise. */
const named = (part: string) => /^[A-Za-z0-9_@.+-]+$/.test(part) ? part : JSON.stringify(part);
/** A directory of this machine and the path a container sees it at. */
export interface HostDirectory { source: string; target: string }
/** A mount every body on this machine gets. Read-only unless it says otherwise. */
export interface FixedMount extends HostDirectory { readOnly?: boolean }
/** A sign-in directory for each account id, then harness. */
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
 * first when the job is allowed nested containers, then its account's sign-in directory for its harness
 * when sign-ins are configured, then the fixed mounts.
 * @throws WorkerStop('mounts'), with the configuration key at fault, when the configuration breaks a rule.
 * Of two directories that overlap it names the later one. The returned function throws
 * UnservedJobError for a job with no exact sign-in entry, as a missing `accountRunners` entry does, and
 * a plain error for a nested job on a machine with no nested socket. */
export function bodyMounts(config: {
  accountLogins?: AccountLogins; mounts?: readonly FixedMount[];
  /** The engine's socket the worker itself talks to. Never mounted; a mount that reached it would hand
   * every body the engine. Left out only by callers that have no engine (tests of the mounts alone). */
  socket?: string;
  nestedSocket?: string;
  /** The worker's own files, never mounted: the state directory (its records of what it started, by which
   * the next worker ends what this one left) and the file holding its token for loom. */
  state?: string; tokenFile?: string;
}, user: { uid?: () => number | undefined } = {}): (job: Pick<WorkerAssignment, 'account' | 'harness' | 'run'>) => BodyMount[] {
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
  /** A mounted directory and the configuration key it was written under. */
  interface Entry { mount: BodyMount; key: string }
  const fixed: Entry[] = [], loginList: Entry[] = [], logins = new Map<string, Map<string, BodyMount>>();
  for (const [index, mount] of (config.mounts ?? []).entries()) {
    const key = `container.mounts[${index}]`;
    if (!directory(mount.source)) stop(`${key}.source`);
    if (!plainPath(mount.target)) stop(`${key}.target`);
    // Read-only unless it says exactly `false`.
    fixed.push({ key, mount: Object.freeze({ source: mount.source, target: mount.target, readOnly: mount.readOnly !== false }) });
  }
  for (const [account, harnesses] of Object.entries(config.accountLogins ?? {})) {
    const byHarness = new Map<string, BodyMount>();
    for (const [harness, login] of Object.entries(harnesses)) {
      const key = `accountLogins.${named(account)}.${named(harness)}`;
      if (!directory(login.source)) stop(`${key}.source`);
      if (!plainPath(login.target)) stop(`${key}.target`);
      // Read-write: the provider's program rewrites its files when it renews the sign-in. Two bodies on
      // one account share it: docs/accepted-tradeoffs.md, "Two bodies on one account share one sign-in directory".
      const mount = Object.freeze({ source: login.source, target: login.target, readOnly: false });
      byHarness.set(harness, mount); loginList.push({ key, mount });
    }
    logins.set(account, byHarness);
  }
  if (config.socket !== undefined && !socket(config.socket)) stop('container.socket');
  if (config.nestedSocket !== undefined && !socket(config.nestedSocket)) stop('container.nestedSocket');
  // Mounted as it is written, as before: the engine reports the source it was asked for.
  const nested = config.nestedSocket === undefined ? undefined
    : Object.freeze({ source: config.nestedSocket, target: NESTED_SOCKET_TARGET, readOnly: false });
  const directories = [...fixed, ...loginList];
  // Inside one container: no directory on, above or below the nested socket's place, another fixed mount or
  // a sign-in directory. Two sign-in directories are never in one container, so they may share a target.
  // (The fixed mounts come first in the list, so "an earlier fixed mount" is every pair with one in it.)
  for (const [index, { mount, key }] of directories.entries())
    if (SOCKET_PLACES.some(place => overlap(mount.target, place))
      || fixed.some((other, at) => at < index && overlap(mount.target, other.mount.target))) stop(`${key}.target`);
  // On this machine, one rule for every source. No two mounted directories are the same or one inside the
  // other: a sign-in directory then reaches only its own account and harness, and a read-only directory is
  // not writable under a second name. And none is, holds or lies inside what must stay out of a container
  // that was not given it: either engine socket, the worker's state directory, the file with its token.
  // Each of those is compared twice, as it is written and where it really is (or will be): a body must
  // reach neither the thing nor a link the worker follows to it.
  const kept = [config.socket, config.nestedSocket, config.state, config.tokenFile].flatMap(path => path === undefined ? [] : [resolve(path), resting(path)]);
  for (const [index, { mount, key }] of directories.entries())
    if (directories.some((other, at) => at < index && overlap(mount.source, other.mount.source)) || kept.some(path => overlap(mount.source, path))) stop(`${key}.source`);
  const everyBody = fixed.map(entry => entry.mount);
  const present = config.accountLogins !== undefined;
  return job => {
    const own: BodyMount[] = [];
    if (job.run?.nestedContainers) {
      if (!nested) throw new Error('Nested containers unavailable');
      own.push(nested);
    }
    if (present) {
      const login = logins.get(job.account)?.get(job.harness);
      // Never a fallback: not the fixed mounts alone, and never another account's directory.
      if (!login) throw new UnservedJobError('Worker has no configured sign-in directory for account');
      own.push(login);
    }
    return [...own, ...everyBody];
  };
}
