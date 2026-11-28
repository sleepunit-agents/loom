/** Where a house comes from: the worker's own fetch of an agent's house repository.
 *
 * The worker keeps one bare mirror per repository under its state directory, fetches the job's branch into
 * it (or fetches an explicitly requested review commit) with the machine's `git`, and hands out that commit as a tar stream it writes itself from git's
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
import { endGit, houseContext, type ContextApart, type ContextLimits } from './house-context.js';
import { hasControlCharacter, houseAddress, houseBranch, houseFile } from './house-input.js';
export { houseFile, houseRepository } from './house-input.js';
import { COMMIT } from '../apps/merge-target.js';
import { GIT_MINIMUM } from './worker-limits.js';

/** How many repositories' mirrors the worker keeps: the ones fetched most recently. A mirror holds one
 * shallow commit per fetch until git's own collection, so this and the repositories' sizes bound what the
 * fetches leave on disk. One that is removed is fetched again when a job next needs it. */
export const HOUSE_MIRRORS_KEPT = 8;
/** A mirror's name: so many hex digits of its repository's digest. */
const MIRROR_DIGITS = 32, MIRROR = new RegExp(`^[0-9a-f]{${MIRROR_DIGITS}}\\.git$`);
/** What an agent's run settings say its house is. An empty `file` is a house with no Housefile of its
 * own: the core house with the repository copied in (house-core.ts). */
export interface House { repository: string; file: string; branch: string }
/** A house that cannot be fetched: its address, branch or file is not one the worker takes, or git failed.
 * The message is the worker's own words and never names the repository. */
export class HouseSourceError extends Error {}
/** Start git with these arguments and this environment, and nothing else of the worker's. */
export type GitSpawn = (args: readonly string[], env: Readonly<Record<string, string>>, output: 'pipe' | 'ignore', input?: 'pipe' | 'ignore') => ChildProcess;

const native: GitSpawn = (args, env, output, input = 'ignore') => spawn('git', [...args], { env: { ...env }, shell: false, detached: true, stdio: [input, output, 'ignore'] });
/** The header git sends for a repository secret: `user:password` when the secret has a colon, otherwise a
 * token as the password of `x-access-token`. */
function authorization(credential: Uint8Array): string {
  const text = Buffer.from(credential).toString('utf8').trim();
  if (!text || hasControlCharacter(text)) throw new HouseSourceError('House repository secret is not usable');
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

export interface HouseSource {
  /** Bring the mirror of the house's repository up to its branch and say which commit that is. The secret
   * is used for this one fetch and kept nowhere. For an exact revision fetch only that object,
   * even when the branch has advanced. Fail if the remote cannot serve that commit. */
  fetch(house: House, credential: Uint8Array | undefined, signal: AbortSignal, requestedCommit?: string): Promise<string>;
  /** That commit's files as a tar stream, written by the worker from git's objects (house-context.ts). The
   * stream fails when git does or the context is not one the worker writes, so a cut-off context is
   * never taken for a whole one. `apart` puts the commit's files one directory down, with one file of
   * the worker's own beside them (house-context.ts). */
  context(house: House, commit: string, signal: AbortSignal, apart?: ContextApart): Readable;
  /** Whether this source fetches from such an address. One that it does holds no credential. A source
   * that does not say is taken to fetch what a worker does (houseRepository). */
  fetches?(repository: string): boolean;
  /** The diff from `base` to `head`, both already fetched, as git writes it: no external diff program, no text
   * conversion, no colour, no configuration but the worker's. Cut at `limit` bytes, and then says so (`cut`). */
  diff?(house: House, base: string, head: string, signal: AbortSignal, limit: number): Promise<{ bytes: Buffer; cut: boolean }>;
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
  /** Removes a mirror; a test names one it can hold open. */
  remove?: (mirror: string) => Promise<void>;
}): HouseSource {
  const start = options.spawn ?? native, protocols = options.protocols ?? ['https'];
  const mirrorOf = (repository: string) => join(options.directory, `${createHash('sha256').update(repository).digest('hex').slice(0, MIRROR_DIGITS)}.git`);
  /** Run git to its end. Its error output is never read; its standard output only when asked for, and little of it. */
  const run = (args: readonly string[], env: Readonly<Record<string, string>>, signal: AbortSignal, output: 'pipe' | 'ignore' = 'ignore') => new Promise<string>((resolve, reject) => {
    if (signal.aborted) { reject(new HouseSourceError('House fetch cancelled')); return; }
    let child: ChildProcess;
    try { child = start(args, env, output); } catch { reject(new HouseSourceError('git could not be run')); return; }
    const forget = child.pid ? options.started?.(child.pid) : undefined;
    const kill = () => endGit(child);
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
  // Mirrors being removed just now: a fetch or a read of one waits until it is gone, and then starts clean.
  const removing = new Map<string, Promise<void>>();
  const gone = async (mirror: string) => { for (let removal = removing.get(mirror); removal; removal = removing.get(mirror)) await removal; };
  const remove = options.remove ?? ((mirror: string) => rm(mirror, { recursive: true, force: true }));
  /** Remove the mirrors beyond the number kept, oldest use last. Nobody's job: it runs beside the work, one
   * at a time. Whether a mirror is in use is asked again just before each removal, not once for them all. */
  let tidying = false;
  const tidy = async (latest: string) => {
    if (tidying) return; tidying = true;
    try {
      const now = new Date(); utimesSync(latest, now, now);
      const others = readdirSync(options.directory).filter(name => MIRROR.test(name)).map(name => join(options.directory, name))
        .filter(path => path !== latest).map(path => ({ path, used: statSync(path).mtimeMs })).sort((one, other) => other.used - one.used);
      for (const { path } of others.slice(Math.max(0, (options.kept ?? HOUSE_MIRRORS_KEPT) - 1))) {
        if (busy.has(path) || reading.has(path) || removing.has(path)) continue;
        const removal = remove(path).catch(() => {}).finally(() => { removing.delete(path); });
        removing.set(path, removal); await removal;
      }
    } catch { /* a mirror left over is found again next time */ } finally { tidying = false; }
  };
  return {
    fetch(house, credential, signal, requestedCommit) {
      const url = houseAddress(house.repository, protocols);
      if (!url || !houseBranch(house.branch) || (house.file !== '' && !houseFile(house.file))) return Promise.reject(new HouseSourceError('House is not one this worker fetches'));
      if (requestedCommit !== undefined && (typeof requestedCommit !== 'string' || requestedCommit.length !== 40 || !COMMIT.test(requestedCommit))) {
        return Promise.reject(new HouseSourceError('Expected a full commit id'));
      }
      const sourceRef = requestedCommit ?? `refs/heads/${house.branch}`;
      const mirror = mirrorOf(house.repository);
      let header: [string, string][] = [];
      try { if (credential !== undefined && url.protocol === 'https:') header = [[`http.${url.origin}/.extraHeader`, authorization(credential)]]; }
      catch (error) { return Promise.reject(error instanceof HouseSourceError ? error : new HouseSourceError('House repository secret is not usable')); }
      const next = (busy.get(mirror) ?? Promise.resolve()).catch(() => {}).then(async () => {
        await gone(mirror);
        mkdirSync(options.directory, { recursive: true, mode: 0o700 });
        const plain = environment(options.directory, protocols);
        if (!existsSync(join(mirror, 'HEAD'))) await run(['init', '--quiet', '--bare', mirror], plain, signal);
        // The address is given here each time and stored nowhere: not as a remote, and not in FETCH_HEAD,
        // which git is told not to write. Depth 1: the worker needs one commit.
        await run(['--git-dir', mirror, 'fetch', '--quiet', '--no-tags', '--depth=1', '--no-recurse-submodules', '--no-write-fetch-head', '--force', '--',
          house.repository, `+${sourceRef}:refs/loom/fetched`], environment(options.directory, protocols, header), signal);
        const commit = (await run(['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', 'refs/loom/fetched^{commit}'], plain, signal, 'pipe')).trim();
        if (!COMMIT.test(commit)) throw new HouseSourceError('git failed');
        if (requestedCommit !== undefined && commit !== requestedCommit) throw new HouseSourceError('git did not return the requested commit');
        void tidy(mirror);
        return commit;
      });
      busy.set(mirror, next);
      void next.catch(() => {}).finally(() => { if (busy.get(mirror) === next) busy.delete(mirror); });
      return next;
    },
    fetches: repository => houseAddress(repository, protocols) !== undefined,
    async diff(house, base, head, signal, limit) {
      if (!houseAddress(house.repository, protocols) || !COMMIT.test(base) || !COMMIT.test(head) || !Number.isSafeInteger(limit) || limit < 1)
        throw new HouseSourceError('House is not one this worker fetches');
      const mirror = mirrorOf(house.repository);
      await gone(mirror);
      reading.set(mirror, (reading.get(mirror) ?? 0) + 1);
      try {
        return await new Promise<{ bytes: Buffer; cut: boolean }>((resolve, reject) => {
          if (signal.aborted) { reject(new HouseSourceError('House fetch cancelled')); return; }
          let child: ChildProcess;
          // `--` ends the options: both ids were checked as full commit ids, so neither is read as one.
          try { child = start(['--git-dir', mirror, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', base, head, '--'], environment(options.directory, protocols), 'pipe'); }
          catch { reject(new HouseSourceError('git could not be run')); return; }
          const forget = child.pid ? options.started?.(child.pid) : undefined;
          const kill = () => endGit(child);
          signal.addEventListener('abort', kill, { once: true });
          const parts: Buffer[] = []; let size = 0, cut = false;
          child.stdout?.on('data', (chunk: Buffer) => {
            if (cut) return;
            const room = limit - size;
            if (chunk.length > room) { parts.push(chunk.subarray(0, room)); size = limit; cut = true; kill(); return; }
            parts.push(chunk); size += chunk.length;
          });
          child.once('error', () => { signal.removeEventListener('abort', kill); forget?.(); reject(new HouseSourceError('git could not be run')); });
          child.once('close', code => {
            signal.removeEventListener('abort', kill); forget?.();
            if (signal.aborted) reject(new HouseSourceError('House fetch cancelled'));
            else if (code === 0 || cut) resolve({ bytes: Buffer.concat(parts), cut });
            else reject(new HouseSourceError('git failed'));
          });
        });
      } finally {
        const left = (reading.get(mirror) ?? 1) - 1; if (left > 0) reading.set(mirror, left); else reading.delete(mirror);
      }
    },
    context(house, commit, signal, apart) {
      if (!houseAddress(house.repository, protocols) || !COMMIT.test(commit)) return Readable.from((async function* (): AsyncGenerator<Buffer> { throw new HouseSourceError('House is not one this worker fetches'); })());
      const mirror = mirrorOf(house.repository), env = environment(options.directory, protocols);
      // The mirror is not removed while it is being read from.
      reading.set(mirror, (reading.get(mirror) ?? 0) + 1);
      let counted = true;
      const done = () => { if (!counted) return; counted = false; const left = (reading.get(mirror) ?? 1) - 1; if (left > 0) reading.set(mirror, left); else reading.delete(mirror); };
      const store = (args: readonly string[], input: 'pipe' | 'ignore') => start(['--git-dir', mirror, ...args], env, 'pipe', input);
      const written = Readable.from((async function* (): AsyncGenerator<Buffer> {
        // A removal that began before this read was counted is waited for; the read then finds what is there.
        await gone(mirror);
        yield* houseContext(store, commit, signal, { started: options.started, limits: options.limits, apart });
      })(), { objectMode: false });
      written.once('close', done);
      return written;
    },
  };
}
