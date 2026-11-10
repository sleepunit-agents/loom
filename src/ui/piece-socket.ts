/**
 * A piece's manifest from its own long-running service, over a local socket (t-2114). `<bin> ui --json` is a process
 * per freshness window, and the runtime's re-read every file it needs each time; its delivery service already has them
 * in memory. A managed piece that serves its manifest listens at `<its home>/run/ui.sock` (the home is core's to name:
 * LOOM_PIECE_HOME, never a path the piece hands core). With no socket there, or any doubt about it, the manifest runs
 * the one-shot way, as before.
 *
 * Protocol (loom-runtime src/ui-socket.mjs): one request per line, `{"id": n, "op": "manifest"}`; one answer per line,
 * in order, `{"id": n, "ok": true, "version": "<the file it runs>", "at": <ms>, "stdout": "<what ui --json prints>"}`.
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
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pieceOfPath, pieceEnvFor } from '../cli/pieces-managed.js';

/** How long an answer may take: the service computes one at most when its last is stale (seconds under load). */
export const SOCKET_WAIT_MS = 10_000;
/** After a socket failed, its manifests run the one-shot way this long. */
export const SOCKET_FAIL_MS = 30_000;

export type SocketAnswer = { ok: true; stdout: string } | { ok: false; reason: string };

interface Conn {
  sock: Socket;
  buf: string;
  bytes: number;
  dead: boolean;
  queue: Array<() => void>;
  busy: boolean;
  pending?: { id: number; done: (r: SocketAnswer | undefined) => void; timer: NodeJS.Timeout; maxBytes: number; version: string };
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

function kill(at: string, c: Conn, failure: boolean): void {
  if (c.dead) return;
  c.dead = true;
  if (failure) failedAt.set(at, Date.now());
  if (conns.get(at) === c) conns.delete(at);
  c.sock.destroy();
  const p = c.pending;
  c.pending = undefined;
  if (p) { clearTimeout(p.timer); p.done(undefined); }
  for (const next of c.queue.splice(0)) next();
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
    clearTimeout(p.timer);
    let m: { id?: unknown; ok?: unknown; version?: unknown; stdout?: unknown } | undefined;
    try { m = JSON.parse(line); } catch { m = undefined; }
    if (!m || m.id !== p.id || rest.length) { p.done(undefined); kill(at, c, true); return; }
    if (m.ok !== true) p.done({ ok: false, reason: 'the piece\'s service couldn\'t make its manifest' });
    // Another version's service (an install it hasn't restarted for yet): the one-shot way, this time.
    else if (m.version !== p.version) p.done(undefined);
    else if (typeof m.stdout !== 'string') p.done({ ok: false, reason: 'the piece\'s service answered without its output' });
    else if (Buffer.byteLength(m.stdout) > p.maxBytes) p.done({ ok: false, reason: 'answer too large' });
    else p.done({ ok: true, stdout: m.stdout });
    c.busy = false;
    c.queue.shift()?.();
  });
  return c;
}

/**
 * The manifest of the piece at `path` from its service: its answer, or undefined when there's no service to ask (no
 * socket, one that isn't this user's alone, a version that isn't the bin's, a failure lately): then run it the one-shot
 * way. `version` is what the bin resolves to now (realpath).
 */
export function socketManifest(path: string, env: NodeJS.ProcessEnv, opts: { maxBytes: number; waitMs?: number }): Promise<SocketAnswer | undefined> {
  const at = manifestSocket(path, env);
  if (!at) return Promise.resolve(undefined);
  const failed = failedAt.get(at);
  if (failed !== undefined && Date.now() - failed < SOCKET_FAIL_MS) return Promise.resolve(undefined);
  if (!ours(dirname(at), 'dir') || !ours(at, 'socket')) return Promise.resolve(undefined);
  let version: string;
  try { version = realpathSync(path); } catch { return Promise.resolve(undefined); }
  let c = conns.get(at);
  if (!c || c.dead) { c = connect(at); conns.set(at, c); }
  const conn = c;
  return new Promise((resolve) => {
    const go = () => {
      if (conn.dead) { resolve(undefined); return; }
      conn.busy = true;
      const id = nextId++;
      const timer = setTimeout(() => { if (conn.pending?.id === id) kill(at, conn, true); }, opts.waitMs ?? SOCKET_WAIT_MS);
      conn.pending = { id, done: resolve, timer, maxBytes: opts.maxBytes, version };
      conn.sock.write(JSON.stringify({ id, op: 'manifest' }) + '\n');
    };
    if (conn.busy) conn.queue.push(go); else go();
  });
}

/** Every connection closed (tests; the daemon shutting down). */
export function closePieceSockets(): void {
  for (const [at, c] of [...conns]) kill(at, c, false);
  failedAt.clear();
}
