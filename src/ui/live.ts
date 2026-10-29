/**
 * The page, live (docs/specs/ui-app.md, "Live"; Jonathan, 2026-10-29: "websocket to send own information as it
 * updates"). Each open app holds one event stream, GET /events (server-sent events: loom to the app is all it
 * needs), and hears one thing on it: `change`. It then asks again for the page it shows, with that page's
 * fingerprint, so a page nothing touched costs a 304. The stream carries no data, so it needs no scoping of its
 * own beyond the sign-in every page has.
 *
 * What counts as a change:
 * - an agent's memory, knowledge or people, or the household file, written (a watch on loom's data folder; not
 *   the sessions file or SQLite's read index, which a page load itself touches, or a piece's store, which its
 *   own page load may write);
 * - a piece's manifest answering differently (asked every WATCH_MS while an app is open, per scope that's open);
 *   its kept pages are dropped then too;
 * - any action, through loom (`changed()`, from the handler).
 * Changes close together go out as one, at most every GAP_MS. A comment every BEAT_MS keeps proxies from
 * closing a quiet stream.
 */
import { watch, type FSWatcher } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { clearPiecePages, refreshPieceManifests } from './pieces.js';

export const WATCH_MS = 15_000;
const BEAT_MS = 25_000;
const GAP_MS = 1_500;
/** What a change looks like in loom's data folder: an agent's stores and the household file. */
const DATA = /(^|\/)(memories|knowledge|people)\.db(-wal)?$|(^|\/)household\.json$/;

interface Client { res: ServerResponse; env: NodeJS.ProcessEnv }
const clients = new Set<Client>();
let watcher: FSWatcher | undefined;
let ticking: NodeJS.Timeout | undefined;
let beating: NodeJS.Timeout | undefined;
let pending: NodeJS.Timeout | undefined;
let lastSent = 0;
const seen = new Map<string, Map<string, string>>();

/** Tell every open app that something changed (soon, and once for a burst). */
export function changed(): void {
  if (pending || !clients.size) return;
  pending = setTimeout(() => {
    pending = undefined; lastSent = Date.now();
    for (const c of clients) send(c, 'event: change\ndata: {}\n\n');
  }, Math.max(0, lastSent + GAP_MS - Date.now()));
}

function send(c: Client, text: string): void {
  try { c.res.write(text); } catch { drop(c); }
}

function drop(c: Client): void {
  clients.delete(c);
  if (clients.size) return;
  watcher?.close(); watcher = undefined;
  clearInterval(ticking); ticking = undefined;
  clearInterval(beating); beating = undefined;
  seen.clear();
}

const scopeOf = (env: NodeJS.ProcessEnv) => `${env.LOOM_SCOPE ?? ''}\0${env.LOOM_OWNER_SCOPE ?? ''}`;

/** Ask each open scope's pieces again; a piece that answers differently is a change. */
async function tick(): Promise<void> {
  const scopes = new Map<string, NodeJS.ProcessEnv>();
  for (const c of clients) scopes.set(scopeOf(c.env), c.env);
  let moved = false;
  for (const [scope, env] of scopes) {
    const now = await refreshPieceManifests(env).catch(() => undefined);
    if (!now) continue;
    const before = seen.get(scope);
    if (before) for (const [path, print] of now) if (before.get(path) !== print) { clearPiecePages(path); moved = true; }
    seen.set(scope, now);
  }
  if (moved) changed();
}

/** Open an app's stream: `home` is loom's data folder (the household's, or the one agent's). */
export function openStream(res: ServerResponse, env: NodeJS.ProcessEnv, home: string, headers: Record<string, string>): void {
  res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
  res.write('retry: 5000\n\n');
  const c: Client = { res, env };
  clients.add(c);
  res.on('close', () => drop(c));
  if (!watcher) {
    try { watcher = watch(home, { recursive: true }, (_e, file) => { if (file && DATA.test(String(file))) changed(); }); } catch { /* no watch here: the pieces' tick and actions still tell */ }
  }
  ticking ??= setInterval(() => void tick(), WATCH_MS);
  beating ??= setInterval(() => { for (const x of clients) send(x, ': beat\n\n'); }, BEAT_MS);
  void tick();
}

/** How many apps are listening (for tests). */
export const listening = () => clients.size;
