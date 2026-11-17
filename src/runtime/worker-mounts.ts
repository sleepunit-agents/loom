/** The directories of this machine that a container body is given: its own account's sign-in directory
 * (`accountLogins`) and the house's fixed mounts (`container.mounts`). Nothing else of the host is ever
 * mounted, except the nested engine socket (`container.nestedSocket`), whose path is held to the same rules
 * here and which worker-container.ts adds for a job allowed nested containers.
 *
 * Every rule about these paths is here and is checked once, when the worker starts: a configuration that
 * breaks one stops the worker (WorkerStop 'mounts') before it takes any work. The paths are machine-local,
 * like `accountRunners`: no error made here carries one, and nothing here writes a log. */
import { lstatSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { UnservedJobError, type WorkerAssignment } from './worker.js';
import { WorkerStop } from './worker-stop.js';

/** Where a body allowed nested containers finds the engine's socket. No mount may hide or replace it. */
export const NESTED_SOCKET_TARGET = '/var/run/docker.sock';
/** A directory of this machine and the path a container sees it at. */
export interface HostDirectory { source: string; target: string }
/** A mount every body on this machine gets. Read-only unless it says otherwise. */
export interface FixedMount extends HostDirectory { readOnly?: boolean }
/** A sign-in directory for each account id, then harness. */
export type AccountLogins = Readonly<Record<string, Readonly<Record<string, HostDirectory>>>>;
/** One bind mount the worker asks the engine for, and expects to find when it inspects the container. */
export interface BodyMount { readonly source: string; readonly target: string; readonly readOnly: boolean }

/** `inner` is `outer` or a path inside it. Both are plain absolute paths (see `plain`). */
const inside = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}/`);
const overlap = (one: string, other: string) => inside(one, other) || inside(other, one);
/** An absolute path written one way only: no `.`, `..`, doubled or trailing slash, and not the root. So
 * two paths name the same place, or one inside the other, exactly when their text says so. */
const plain = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && path !== '/'
  && !path.includes('\0') && !path.endsWith('/') && posix.normalize(path) === path;

/** Check the configured mounts and fix them. Returns what one job's container is given: its account's
 * sign-in directory for its harness first, when sign-ins are configured, then the fixed mounts.
 * The nested socket's path is checked with them and returned to nobody: worker-container.ts mounts it.
 * @throws WorkerStop('mounts') when the configuration breaks a rule; the returned function throws
 * UnservedJobError for a job with no exact sign-in entry, as a missing `accountRunners` entry does. */
export function bodyMounts(config: { accountLogins?: AccountLogins; mounts?: readonly FixedMount[]; nestedSocket?: string },
  files: { uid?: () => number | undefined } = {}): (job: Pick<WorkerAssignment, 'account' | 'harness'>) => BodyMount[] {
  const uid = (files.uid ?? (() => process.getuid?.()))();
  /** An existing directory of the worker's own user, named by its real path: neither it nor a directory
   * above it is a symbolic link, so the place checked now is the place mounted later, and the text of two
   * sources can be compared. */
  const directory = (path: unknown): path is string => {
    if (!plain(path) || uid === undefined) return false;
    try {
      const found = lstatSync(path);
      return found.isDirectory() && !found.isSymbolicLink() && found.uid === uid && realpathSync(path) === path;
    } catch { return false; }
  };
  /** The engine's socket for nested containers: an existing Unix socket named by its real path. It is the
   * engine's, so it need not belong to the worker's user. Anything else at that path (a directory above the
   * sign-in directories, say) would be mounted into a nested job's container in the socket's place. */
  const socket = (path: unknown): path is string => {
    if (!plain(path)) return false;
    try { const found = lstatSync(path); return found.isSocket() && !found.isSymbolicLink() && realpathSync(path) === path; }
    catch { return false; }
  };
  const fixed: BodyMount[] = [], logins = new Map<string, Map<string, BodyMount>>(), loginList: BodyMount[] = [];
  try {
    for (const mount of config.mounts ?? []) {
      if (!directory(mount.source) || !plain(mount.target)) throw new WorkerStop('mounts');
      // Read-only unless it says exactly `false`.
      fixed.push(Object.freeze({ source: mount.source, target: mount.target, readOnly: mount.readOnly !== false }));
    }
    for (const [account, harnesses] of Object.entries(config.accountLogins ?? {})) {
      const byHarness = new Map<string, BodyMount>();
      for (const [harness, login] of Object.entries(harnesses)) {
        if (!directory(login.source) || !plain(login.target)) throw new WorkerStop('mounts');
        // Read-write: the provider's program rewrites its files when it renews the sign-in. Two bodies on
        // one account share it: docs/accepted-tradeoffs.md, "Two bodies on one account share one sign-in directory".
        const mount = Object.freeze({ source: login.source, target: login.target, readOnly: false });
        byHarness.set(harness, mount); loginList.push(mount);
      }
      logins.set(account, byHarness);
    }
    if (config.nestedSocket !== undefined && !socket(config.nestedSocket)) throw new WorkerStop('mounts');
  } catch { throw new WorkerStop('mounts'); }
  const all = [...fixed, ...loginList], nested = config.nestedSocket;
  // Inside one container: no mount on, above or below the nested socket, another fixed mount or a sign-in
  // directory. Two sign-in directories are never in one container, so they may share a target.
  if (all.some(mount => overlap(mount.target, NESTED_SOCKET_TARGET))
    || fixed.some((mount, index) => all.some((other, at) => at !== index && overlap(mount.target, other.target)))
    // On this machine: a sign-in directory reaches only its own account and harness. So no fixed mount, and
    // no other entry's sign-in directory, is it, holds it or lies inside it.
    || loginList.some((login, index) => all.some((other, at) => at !== fixed.length + index && overlap(login.source, other.source)))
    // The nested socket is a source too, given to a job that is not every job: it is apart from every
    // directory mounted here, so it is never a way into one and no mount carries it to a job not allowed it.
    || (nested !== undefined && all.some(mount => overlap(nested, mount.source))))
    throw new WorkerStop('mounts');
  const present = config.accountLogins !== undefined;
  return job => {
    if (!present) return [...fixed];
    const login = logins.get(job.account)?.get(job.harness);
    // Never a fallback: not the fixed mounts alone, and never another account's directory.
    if (!login) throw new UnservedJobError('Worker has no configured sign-in directory for account');
    return [login, ...fixed];
  };
}
