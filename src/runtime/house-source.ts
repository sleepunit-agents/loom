/** Where a house comes from: the worker's own fetch of an agent's house repository.
 *
 * The worker keeps one bare mirror per repository under its state directory, fetches the job's branch into
 * it with the machine's `git`, and hands out that commit as a tar stream it writes itself from git's
 * objects (house-context.ts), which is the build context the engine is given (house-image.ts). That is all
 * the worker does with a repository: it never checks one out, neither it nor git interprets a file of
 * one, and nothing a repository holds becomes an argument, a file on this machine outside the mirror's
 * objects, or input to a shell. git is not asked to check what it fetches beyond what it always does
 * (`fetch.fsckObjects` is left off): that check reads a commit's `.gitmodules` and refuses tips over names
 * that only matter to a checkout, and nothing here checks out. The names the worker uses it checks itself.
 *
 * Whoever can place a job chooses the repository, so `git` is run as a stranger's errand:
 *  - only `https://` addresses. `ext::` would run a command, a local path or `file://` would read this
 *    machine's own repositories into an image, `ssh` would use the machine user's keys and configuration,
 *    and `http://` would send a credential in clear;
 *  - with an environment made here and nothing of the worker's own but PATH: no global or system
 *    configuration (so none of the machine user's stored credentials, helpers or rewrites), no prompt, no
 *    hooks, no other protocol, no redirect;
 *  - the repository's secret, when loom sent one, goes to that one fetch as a header for the repository's
 *    own origin, in the child's environment. It is never an argument (other users can read those), never
 *    in the mirror's configuration (the mirror stores no remote at all), and git's own output is dropped.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { houseContext, type ContextLimits } from './house-context.js';
import { COMMIT } from '../apps/merge-target.js';
import { GIT_MINIMUM } from './worker-limits.js';

/** How many repositories' mirrors the worker keeps: the ones fetched most recently. A mirror holds one
 * shallow commit per fetch until git's own collection, so this and the repositories' sizes bound what the
 * fetches leave on disk. One that is removed is fetched again when a job next needs it. */
export const HOUSE_MIRRORS_KEPT = 8;
/** A mirror's name: so many hex digits of its repository's digest. */
const MIRROR_DIGITS = 32, MIRROR = new RegExp(`^[0-9a-f]{${MIRROR_DIGITS}}\\.git$`);
/** What an agent's run settings say its house is. */
export interface House { repository: string; file: string; branch: string }
/** A house that cannot be fetched: its address, branch or file is not one the worker takes, or git failed.
 * The message is the worker's own words and never names the repository. */
export class HouseSourceError extends Error {}
/** Start git with these arguments and this environment, and nothing else of the worker's. */
export type GitSpawn = (args: readonly string[], env: Readonly<Record<string, string>>, output: 'pipe' | 'ignore', input?: 'pipe' | 'ignore') => ChildProcess;

const native: GitSpawn = (args, env, output, input = 'ignore') => spawn('git', [...args], { env: { ...env }, shell: false, detached: true, stdio: [input, output, 'ignore'] });
/** A branch name plain enough to be put in a refspec: no option, no range, no pattern, no ref trickery. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const control = (text: string) => /[\0-\x1f\x7f]/.test(text);

/** The Housefile's path inside the repository: relative, going nowhere but down. */
export const houseFile = (file: unknown): file is string => typeof file === 'string' && file.length > 0 && file.length <= 512 && !control(file)
  && !file.startsWith('/') && !file.includes('\\') && file.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const houseBranch = (branch: unknown): branch is string => typeof branch === 'string' && BRANCH.test(branch)
  && !branch.includes('..') && !branch.includes('//') && !branch.endsWith('/') && !branch.endsWith('.') && !branch.endsWith('.lock');
/** The repository's address as a URL, when it is one the worker fetches. */
function houseAddress(repository: unknown, protocols: readonly string[]): URL | undefined {
  // No backslash and no `@` anywhere: a URL parser and git do not read either the same way.
  if (typeof repository !== 'string' || repository.length > 2048 || control(repository) || /[\s\\@]/.test(repository)) return undefined;
  let url: URL;
  try { url = new URL(repository); } catch { return undefined; }
  if (!protocols.includes(url.protocol.slice(0, -1)) || !repository.startsWith(`${url.protocol}//`)) return undefined;
  if (url.username || url.password || url.search || url.hash || repository.includes('?') || repository.includes('#')) return undefined;
  // As it is written, not as a URL parser mends it: `https:///x` has no host, whatever a parser makes of it.
  if (url.protocol === 'https:' ? !url.hostname || !repository.toLowerCase().startsWith(`https://${url.host}`) : url.hostname !== '' || !repository.startsWith('file:///')) return undefined;
  return url;
}
/** The header git sends for a repository secret: `user:password` when the secret has a colon, otherwise a
 * token as the password of `x-access-token`. */
function authorization(credential: Uint8Array): string {
  const text = Buffer.from(credential).toString('utf8').trim();
  if (!text || control(text)) throw new HouseSourceError('House repository secret is not usable');
  return `Authorization: Basic ${Buffer.from(text.includes(':') ? text : `x-access-token:${text}`).toString('base64')}`;
}
/** Where git is looked for: the worker's own search path, the one thing of its environment git is given. */
const searchPath = () => process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
/** git's whole environment. Settings go in as configuration here, so no argument carries one. */
function environment(home: string, protocols: readonly string[], extra: readonly [string, string][] = []): Record<string, string> {
  const settings: [string, string][] = [
    ['credential.helper', ''], ['core.hooksPath', '/dev/null'], ['core.attributesFile', '/dev/null'], ['core.fsmonitor', 'false'],
    ['http.followRedirects', 'false'], ['gc.autoDetach', 'false'],
    ['protocol.allow', 'never'], ...protocols.map((protocol): [string, string] => [`protocol.${protocol}.allow`, 'always']), ...extra,
  ];
  return { PATH: searchPath(), HOME: home, LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: protocols.join(':'),
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(settings.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])) };
}
/** Whether what `git --version` printed names a git of at least GIT_MINIMUM. A git older than that is
 * not run at all: it would fetch without the worker's settings, which it does not read from the environment. */
export const gitNewEnough = (printed: string): boolean => {
  const found = /^git version (\d+)\.(\d+)\.(\d+)/.exec(printed);
  if (!found) return false;
  const has = found.slice(1).map(Number);
  for (const [at, least] of GIT_MINIMUM.entries()) if (has[at] !== least) return has[at] > least;
  return true;
};
/** Whether this machine has a git the worker can run, and one new enough. */
export const gitAvailable = (): boolean => {
  try {
    const asked = spawnSync('git', ['--version'], { env: { PATH: searchPath() }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, encoding: 'utf8' });
    return asked.status === 0 && gitNewEnough(asked.stdout);
  } catch { return false; }
};
/** End a git the worker started, and whatever it started in turn: it leads a process group of its own. */
const end = (child: ChildProcess) => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } } };

export interface HouseSource {
  /** Bring the mirror of the house's repository up to its branch and say which commit that is. The secret
   * is used for this one fetch and kept nowhere. */
  fetch(house: House, credential: Uint8Array | undefined, signal: AbortSignal): Promise<string>;
  /** That commit's files as a tar stream, written by the worker from git's objects (house-context.ts). The
   * stream fails when git does or the context is not one the worker writes, so a cut-off context is
   * never taken for a whole one. */
  context(house: House, commit: string, signal: AbortSignal): Readable;
}
export function houseSource(options: {
  /** The worker's own directory for mirrors: under its state directory, which is private to its user. */
  directory: string;
  spawn?: GitSpawn;
  /** `https` and nothing else for a worker. A test of the mirror itself, and the engine check script, name
   * `file` to fetch from a repository they made; no configuration can. */
  protocols?: readonly string[];
  /** Told each git process the worker starts, so a later worker can end one this worker was killed over. */
  started?: (pid: number) => () => void;
  /** How many mirrors to keep, for a test that cannot make nine repositories cheaply. */
  kept?: number;
  /** A context's limits, for a test that cannot make a gigabyte cheaply. */
  limits?: ContextLimits;
}): HouseSource {
  const start = options.spawn ?? native, protocols = options.protocols ?? ['https'];
  const mirrorOf = (repository: string) => join(options.directory, `${createHash('sha256').update(repository).digest('hex').slice(0, MIRROR_DIGITS)}.git`);
  /** Run git to its end. Its error output is never read; its standard output only when asked for, and little of it. */
  const run = (args: readonly string[], env: Readonly<Record<string, string>>, signal: AbortSignal, output: 'pipe' | 'ignore' = 'ignore') => new Promise<string>((resolve, reject) => {
    if (signal.aborted) { reject(new HouseSourceError('House fetch cancelled')); return; }
    let child: ChildProcess;
    try { child = start(args, env, output); } catch { reject(new HouseSourceError('git could not be run')); return; }
    const forget = child.pid ? options.started?.(child.pid) : undefined;
    const kill = () => end(child);
    signal.addEventListener('abort', kill, { once: true });
    let text = '';
    child.stdout?.on('data', (chunk: Buffer) => { if (text.length < 256) text += chunk.toString('utf8'); });
    child.once('error', () => { signal.removeEventListener('abort', kill); forget?.(); reject(new HouseSourceError('git could not be run')); });
    child.once('close', code => {
      signal.removeEventListener('abort', kill); forget?.();
      if (code === 0 && !signal.aborted) resolve(text); else reject(new HouseSourceError('git failed'));
    });
  });
  // One fetch at a time into one mirror: the commit read back is the one this fetch brought.
  const busy = new Map<string, Promise<unknown>>();
  // Mirrors being read from just now: never removed under a context being written.
  const reading = new Map<string, number>();
  return {
    fetch(house, credential, signal) {
      const url = houseAddress(house.repository, protocols);
      if (!url || !houseBranch(house.branch) || !houseFile(house.file)) return Promise.reject(new HouseSourceError('House is not one this worker fetches'));
      const mirror = mirrorOf(house.repository);
      let header: [string, string][] = [];
      try { if (credential !== undefined && url.protocol === 'https:') header = [[`http.${url.origin}/.extraHeader`, authorization(credential)]]; }
      catch (error) { return Promise.reject(error instanceof HouseSourceError ? error : new HouseSourceError('House repository secret is not usable')); }
      const next = (busy.get(mirror) ?? Promise.resolve()).catch(() => {}).then(async () => {
        mkdirSync(options.directory, { recursive: true, mode: 0o700 });
        const plain = environment(options.directory, protocols);
        if (!existsSync(join(mirror, 'HEAD'))) await run(['init', '--quiet', '--bare', mirror], plain, signal);
        // The address is given here each time and stored nowhere: not as a remote, and not in FETCH_HEAD,
        // which git is told not to write. Depth 1: the worker needs one commit.
        await run(['--git-dir', mirror, 'fetch', '--quiet', '--no-tags', '--depth=1', '--no-recurse-submodules', '--no-write-fetch-head', '--force', '--',
          house.repository, `+refs/heads/${house.branch}:refs/loom/fetched`], environment(options.directory, protocols, header), signal);
        const commit = (await run(['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', 'refs/loom/fetched^{commit}'], plain, signal, 'pipe')).trim();
        if (!COMMIT.test(commit)) throw new HouseSourceError('git failed');
        // Best effort: the mirror just used is the newest, and the oldest beyond the number kept go.
        try {
          const now = new Date(); utimesSync(mirror, now, now);
          const others = readdirSync(options.directory).filter(name => MIRROR.test(name)).map(name => join(options.directory, name))
            .filter(path => path !== mirror && !busy.has(path) && !reading.has(path)).map(path => ({ path, used: statSync(path).mtimeMs })).sort((one, other) => other.used - one.used);
          // Removed beside the work, not in its way: a large mirror takes a while, and reports must go out meanwhile.
          for (const { path } of others.slice(Math.max(0, (options.kept ?? HOUSE_MIRRORS_KEPT) - 1))) await rm(path, { recursive: true, force: true });
        } catch { /* a mirror left over is found again next time */ }
        return commit;
      });
      busy.set(mirror, next);
      void next.catch(() => {}).finally(() => { if (busy.get(mirror) === next) busy.delete(mirror); });
      return next;
    },
    context(house, commit, signal) {
      if (!houseAddress(house.repository, protocols) || !COMMIT.test(commit)) return Readable.from((async function* (): AsyncGenerator<Buffer> { throw new HouseSourceError('House is not one this worker fetches'); })());
      const mirror = mirrorOf(house.repository), env = environment(options.directory, protocols);
      // The mirror is not removed while it is being read from.
      reading.set(mirror, (reading.get(mirror) ?? 0) + 1);
      let counted = true;
      const done = () => { if (!counted) return; counted = false; const left = (reading.get(mirror) ?? 1) - 1; if (left > 0) reading.set(mirror, left); else reading.delete(mirror); };
      const written = houseContext((args, input) => start(['--git-dir', mirror, ...args], env, 'pipe', input), commit, signal, { started: options.started, limits: options.limits });
      written.once('close', done);
      return written;
    },
  };
}
