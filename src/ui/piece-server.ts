/**
 * A piece's API from a long-lived process, for the paths it declares (`api_serve` in its loom block, t-2065).
 * `<bin> api --json` is one process per call; a warm house's body host calls the runtime's `body-sync` every 2 s, so
 * each house was a node start every 2 s on loom's machine. For a declared path, core keeps `<bin> api --serve` running
 * and writes it one request per line, `{id, grant, request}`; it answers one line per request, `{id, exit, stdout}`,
 * where `stdout` is what `api --json` would have printed, read here the same way.
 *
 * The same bounds as a one-shot call: the API's pool, its time limit and answer size (a server that runs over either
 * is killed with its process group, and the call fails as a one-shot's would). One request in flight per server, at
 * most SERVERS_PER_KEY per piece version and environment; with all of them busy, or for FAIL_MS after one of them
 * failed, a call runs the one-shot way.
 *
 * The store grant core mints for a call travels in that request's line, never in the server's environment: a server
 * starts with none. A server is for one piece version and one environment (the key: the bin as it resolves now and
 * when it last changed, and a hash of the env it was started with, settings included), so an install or a settings
 * change is a new server; the old one goes once it's idle. A server idle for IDLE_MS, or up for LIFETIME_MS, goes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';

export const IDLE_MS = 60_000;
export const LIFETIME_MS = 10 * 60_000;
export const SERVERS_PER_KEY = 2;
/** After a server of a key fails (dies, times out, answers out of turn), its calls run the one-shot way this long. */
export const FAIL_MS = 60_000;

export type Served = { ok: true; stdout: string } | { ok: false; reason: string; code?: number | null };

interface Server {
  key: string;
  child: ChildProcess;
  started: number;
  busy: boolean;
  dead: boolean;
  idle?: NodeJS.Timeout;
  buf: string;
  bytes: number;
  pending?: { id: number; done: (r: Served) => void; maxBytes: number; timer: NodeJS.Timeout };
}

const servers = new Map<string, Server[]>();
const failed = new Map<string, number>();
let nextId = 1;

/** The key: the bin as it resolves now (`resolved`, path and mtime) and the env the server would start with. */
export function serverKey(path: string, resolved: string, env: NodeJS.ProcessEnv): string {
  const h = createHash('sha256').update(JSON.stringify(Object.entries(env).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))).digest('hex');
  return `${path}\0${resolved}\0${h}`;
}

function killServer(s: Server, failure = true): void {
  if (s.dead) return;
  s.dead = true;
  if (failure) failed.set(s.key, Date.now());
  if (s.idle) clearTimeout(s.idle);
  const list = servers.get(s.key);
  if (list) { const i = list.indexOf(s); if (i >= 0) list.splice(i, 1); if (!list.length) servers.delete(s.key); }
  if (s.child.pid !== undefined) { try { process.kill(-s.child.pid, 'SIGKILL'); } catch { /* already gone */ } }
  const p = s.pending;
  s.pending = undefined;
  if (p) { clearTimeout(p.timer); p.done({ ok: false, reason: 'the piece\'s server ended' }); }
}

function armIdle(s: Server): void {
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => killServer(s, false), IDLE_MS);
  s.idle.unref?.();
}

function startServer(key: string, path: string, env: NodeJS.ProcessEnv): Server {
  // Its own process group, as a one-shot's: killed, it takes whatever it started with it.
  const child = spawn(path, ['api', '--serve'], { env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  const s: Server = { key, child, started: Date.now(), busy: false, dead: false, buf: '', bytes: 0 };
  child.on('error', () => killServer(s));
  child.on('exit', () => killServer(s));
  child.stdin?.on('error', () => killServer(s));
  // Decoded as a stream, so a character split across two chunks stays whole.
  child.stdout?.setEncoding('utf-8');
  child.stdout?.on('data', (d: string) => {
    const p = s.pending;
    if (!p) { killServer(s); return; }   // an answer nobody asked for: it's not speaking the protocol
    s.buf += d;
    s.bytes += Buffer.byteLength(d);
    // The answer is JSON inside JSON: escaping can double it. Its own size is checked once it's read.
    if (s.bytes > 2 * p.maxBytes + 4096) { s.pending = undefined; clearTimeout(p.timer); p.done({ ok: false, reason: 'answer too large' }); killServer(s); return; }
    const nl = s.buf.indexOf('\n');
    if (nl < 0) return;
    const line = s.buf.slice(0, nl);
    const rest = s.buf.slice(nl + 1);
    s.buf = '';
    s.bytes = 0;
    s.pending = undefined;
    clearTimeout(p.timer);
    let m: { id?: unknown; exit?: unknown; stdout?: unknown } | undefined;
    try { m = JSON.parse(line); } catch { m = undefined; }
    // Anything but the one answer to the one request in flight, or a byte past it: the server goes.
    if (!m || m.id !== p.id || typeof m.exit !== 'number' || rest.length) {
      p.done({ ok: false, reason: 'the piece\'s server answered out of turn' });
      killServer(s);
      return;
    }
    if (m.exit === 0 && typeof m.stdout === 'string' && Buffer.byteLength(m.stdout) <= p.maxBytes) p.done({ ok: true, stdout: m.stdout });
    else if (m.exit === 0) p.done({ ok: false, reason: typeof m.stdout === 'string' ? 'answer too large' : 'the piece\'s server answered without its output' });
    else p.done({ ok: false, reason: 'no ui', code: m.exit });
    s.busy = false;
    if (Date.now() - s.started >= LIFETIME_MS) killServer(s, false); else armIdle(s);
  });
  armIdle(s);
  return s;
}

/**
 * Ask `path`'s server (started now if none of its SERVERS_PER_KEY is free) for one request; `grant` is that request's
 * store grant. undefined when every server for its key is busy: the caller runs the call the one-shot way.
 */
export function serveCall(path: string, resolved: string, env: NodeJS.ProcessEnv, grant: string | undefined, request: unknown,
  opts: { timeoutMs: number; maxBytes: number }): Promise<Served> | undefined {
  const key = serverKey(path, resolved, env);
  // Servers of this path for a version or an env that's no longer the current one: gone once idle.
  for (const [k, list] of servers) if (k !== key && k.startsWith(`${path}\0`)) for (const s of [...list]) if (!s.busy) killServer(s, false);
  const at = failed.get(key);
  if (at !== undefined && Date.now() - at < FAIL_MS) return undefined;
  // One past its lifetime and idle goes now, not at its idle timer: it would hold a place it can't be given.
  for (const x of [...(servers.get(key) ?? [])]) if (!x.busy && Date.now() - x.started >= LIFETIME_MS) killServer(x, false);
  const list = servers.get(key) ?? [];
  let s = list.find((x) => !x.busy && !x.dead && Date.now() - x.started < LIFETIME_MS);
  if (!s) {
    if (list.filter((x) => !x.dead).length >= SERVERS_PER_KEY) return undefined;
    s = startServer(key, path, env);
    if (s.dead) return undefined;
    list.push(s);
    servers.set(key, list);
  }
  const server = s;
  server.busy = true;
  if (server.idle) clearTimeout(server.idle);
  const id = nextId++;
  return new Promise<Served>((resolve) => {
    const timer = setTimeout(() => {
      if (server.pending?.id !== id) return;
      server.pending = undefined;
      resolve({ ok: false, reason: 'timed out' });
      killServer(server);
    }, opts.timeoutMs);
    server.pending = { id, done: resolve, maxBytes: opts.maxBytes, timer };
    server.child.stdin?.write(JSON.stringify({ id, grant: grant ?? null, request }) + '\n');
  });
}

/** Every server ended (tests; a daemon shutting down). */
export function stopPieceServers(): void {
  for (const list of [...servers.values()]) for (const s of [...list]) killServer(s, false);
  failed.clear();
}

/** How many servers are up for `path` (tests). */
export function pieceServerCount(path: string): number {
  let n = 0;
  for (const [k, list] of servers) if (k.startsWith(`${path}\0`)) n += list.length;
  return n;
}
