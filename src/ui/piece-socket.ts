/**
 * A piece's manifest from its own long-running service, over a local socket (t-2114). `<bin> ui --json` is a process
 * per freshness window, and the runtime's re-read every file it needs each time; its delivery service already has them
 * in memory. A managed piece that serves its manifest listens at `<its home>/run/ui.sock` (the home is core's to name:
 * LOOM_PIECE_HOME, never a path the piece hands core). With no socket there, or any doubt about it, the manifest runs
 * the one-shot way, as before.
 *
 * Protocol (loom-runtime src/ui-socket.mjs): one request per line, `{"id": n, "op": "manifest", "version": "<the bin's file>@<mtime>", "since": <ms>}`; one answer per line,
 * in order, `{"id": n, "ok": true, "version": "<the file it runs>@<mtime>", "at": <ms>, "stdout": "<what ui --json prints>"}`.
 * The answer is used only when `version` is what the piece's bin resolves to now (an install is a new answer at once,
 * not the old service's), and it's read exactly as `ui --json`'s stdout is, with the same size limit.
 *
 * Who's on the other end: the socket and its directory must be this user's, and no one else's to read or write (the
 * directory 0700-like, the socket with no group or other bits). Nothing about a viewer goes over it: no grant, no
 * scope, no caller. The manifest is one answer for everyone, narrowed per viewer by core afterwards as a `ui --json`
 * answer is. Only the manifest: pages, actions and the API stay the one-shot way (or piece-server.ts).
 *
 * One connection per socket, kept open, one request in flight at a time on it (the rest wait their turn). A connection
 * that fails, answers out of turn or runs past SOCKET_WAIT_MS goes, and that socket is left alone for SOCKET_FAIL_MS:
 * its manifests run the one-shot way meanwhile.
 */
import { createConnection, type Socket } from 'node:net';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pieceOfPath, pieceEnvFor } from '../cli/pieces-managed.js';

/** How long an answer may take, from the ask: the service computes one only when its last is stale or older than a move. */
export const SOCKET_WAIT_MS = 5_000;
/** After a socket failed, its manifests run the one-shot way this long. */
export const SOCKET_FAIL_MS = 30_000;

export type SocketAnswer = { ok: true; stdout: string } | { ok: false; reason: string };

interface Pending { id: number; done: (r: SocketAnswer | undefined) => void; maxBytes: number; version: string; since: number }

interface Conn {
  sock: Socket;
  buf: string;
  bytes: number;
  dead: boolean;
  queue: Array<{ go: () => void; drop: () => void }>;
  busy: boolean;
  pending?: Pending;
}

const conns = new Map<string, Conn>();
const failedAt = new Map<string, number>();
let nextId = 1;

/** Where a managed piece's manifest socket would be, from its home as core names it; undefined for any other piece. */
export function manifestSocket(path: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!pieceOfPath(env, path)) return undefined;
  const home = pieceEnvFor(path, env).LOOM_PIECE_HOME;
  return typeof home === 'string' && home.startsWith('/') ? join(home, 'run', 'ui.sock') : undefined;
}

/** This user's alone: its own, and nothing for group or other. Never a symlink. */
function ours(path: string, kind: 'socket' | 'dir'): boolean {
  try {
    const st = lstatSync(path);
    if (kind === 'socket' ? !st.isSocket() : !st.isDirectory()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    return (st.mode & 0o077) === 0;
  } catch { return false; }
}

/** What the bin runs now: the file it resolves to and when that last changed (a rebuild in place is a new version). */
function versionOf(path: string): string | undefined {
  try { const real = realpathSync(path); return `${real}@${statSync(real).mtimeMs}`; } catch { return undefined; }
}

function kill(at: string, c: Conn, failure: boolean): void {
  if (c.dead) return;
  c.dead = true;
  if (failure) failedAt.set(at, Date.now());
  if (conns.get(at) === c) conns.delete(at);
  c.sock.destroy();
  const p = c.pending;
  c.pending = undefined;
  if (p) p.done(undefined);
  for (const q of c.queue.splice(0)) q.drop();
}

function connect(at: string): Conn {
  const sock = createConnection(at);
  const c: Conn = { sock, buf: '', bytes: 0, dead: false, queue: [], busy: false };
  // Never what keeps a process up (a CLI that read a page): a request in flight holds it by its timer.
  sock.unref();
  sock.setEncoding('utf-8');
  sock.on('error', () => kill(at, c, true));
  sock.on('close', () => kill(at, c, false));
  sock.on('data', (d: string) => {
    const p = c.pending;
    if (!p) { kill(at, c, true); return; }   // an answer nobody asked for
    const from = c.buf.length;
    c.buf += d;
    c.bytes += Buffer.byteLength(d);
    // JSON inside JSON: escaping can double it. The stdout's own size is checked once it's read.
    if (c.bytes > 2 * p.maxBytes + 4096) { kill(at, c, true); return; }
    const nl = c.buf.indexOf('\n', from);
    if (nl < 0) return;
    const line = c.buf.slice(0, nl);
    const rest = c.buf.slice(nl + 1);
    c.buf = '';
    c.bytes = 0;
    c.pending = undefined;
    let m: { id?: unknown; ok?: unknown; version?: unknown; at?: unknown; stdout?: unknown } | undefined;
    try { m = JSON.parse(line); } catch { m = undefined; }
    if (!m || m.id !== p.id || rest.length) { p.done(undefined); kill(at, c, true); return; }
    // Another version's service (an install it hasn't restarted for yet): the one-shot way, this time.
    if (m.version !== p.version) p.done(undefined);
    // A service that can't make its manifest, or answers without it, too large, or from before what moved it: the
    // one-shot way, and this socket left alone a while (never the last answer kept for minutes instead).
    else if (m.ok !== true || typeof m.stdout !== 'string' || Buffer.byteLength(m.stdout) > p.maxBytes || typeof m.at !== 'number' || m.at < p.since) {
      failedAt.set(at, Date.now());
      p.done(undefined);
    } else p.done({ ok: true, stdout: m.stdout });
    c.busy = false;
    c.queue.shift()?.go();
  });
  return c;
}

/**
 * The manifest of the piece at `path` from its service: its answer, or undefined when there's no service to ask (no
 * socket, one that isn't this user's alone, a version that isn't the bin's, a failure lately, no answer in time): then
 * run it the one-shot way. `since`: the answer must be made at or after it (when core last heard the piece moved, or an
 * action ran), so a look right after an action never gets the manifest from before it.
 */
export function socketManifest(path: string, env: NodeJS.ProcessEnv, opts: { maxBytes: number; waitMs?: number; since?: number }): Promise<SocketAnswer | undefined> {
  const at = manifestSocket(path, env);
  if (!at) return Promise.resolve(undefined);
  const failed = failedAt.get(at);
  if (failed !== undefined && Date.now() - failed < SOCKET_FAIL_MS) return Promise.resolve(undefined);
  if (!ours(dirname(at), 'dir') || !ours(at, 'socket')) return Promise.resolve(undefined);
  const version = versionOf(path);
  if (!version) return Promise.resolve(undefined);
  let c = conns.get(at);
  if (!c || c.dead) { c = connect(at); conns.set(at, c); }
  const conn = c;
  const since = Math.floor(opts.since ?? 0);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: SocketAnswer | undefined) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const id = nextId++;
    const entry = {
      go: () => {
        if (conn.dead || settled) { done(undefined); return; }
        conn.busy = true;
        conn.pending = { id, done, maxBytes: opts.maxBytes, version, since };
        conn.sock.write(JSON.stringify({ id, op: 'manifest', version, since }) + '\n');
      },
      drop: () => done(undefined),
    };
    // From the ask, not from its turn: one waiting behind a slow answer gives up as soon.
    const timer = setTimeout(() => {
      if (conn.pending?.id === id) { kill(at, conn, true); return; }
      const i = conn.queue.indexOf(entry);
      if (i >= 0) conn.queue.splice(i, 1);
      failedAt.set(at, Date.now());
      done(undefined);
    }, opts.waitMs ?? SOCKET_WAIT_MS);
    if (conn.busy) conn.queue.push(entry); else entry.go();
  });
}

/** Every connection closed (tests; the daemon shutting down). */
export function closePieceSockets(): void {
  for (const [at, c] of [...conns]) kill(at, c, false);
  failedAt.clear();
}
