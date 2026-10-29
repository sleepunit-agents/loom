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
 *
 * Who hears what (docs/specs/owners.md): even a bare "change" says when an agent was busy, so an app hears only
 * of what its owner may see. A file under one agent's folder is that agent's; an action is its actor's; a
 * piece's manifest moving is that scope's (the owner scope is part of it). Anything loom can't place (the
 * household file) goes to household owners. And the pieces are asked one round at a time, at most every
 * TICK_MIN_MS however many apps open, with at most STREAMS_PER_SESSION streams per signed-in browser.
 */
import { watch, type FSWatcher } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { clearPiecePages, refreshPieceManifests } from './pieces.js';

export const WATCH_MS = 15_000;
const BEAT_MS = 25_000;
const GAP_MS = 1_500;
const TICK_MIN_MS = 5_000;
export const STREAMS_PER_SESSION = 6;
/** What a change looks like in loom's data folder: an agent's stores and the household file. */
const DATA = /(^|\/)(memories|knowledge|people)\.db(-wal)?$|(^|\/)household\.json$/;

/** What an app's owner may see: every agent (`*`, a household owner), or theirs. */
export type Sees = '*' | readonly string[];
interface Client { res: ServerResponse; env: NodeJS.ProcessEnv; sees: Sees; session: string }
const clients = new Set<Client>();
let watcher: FSWatcher | undefined;
let ticking: NodeJS.Timeout | undefined;
let beating: NodeJS.Timeout | undefined;
const pending = new Map<Client, NodeJS.Timeout>();
const lastSent = new WeakMap<Client, number>();
let ticked = 0;
let tickRunning: Promise<void> | undefined;
let whose: (file: string) => Sees = () => '*';
const seen = new Map<string, Map<string, string>>();

/** Whether an app whose owner sees `sees` may hear of a change to `about`. */
const hears = (sees: Sees, about: Sees) => sees === '*' || (about !== '*' && about.some((a) => sees.includes(a)));

/** Tell the open apps that may see it that something changed (soon, and once for a burst). */
export function changed(about: Sees = '*'): void {
  for (const c of clients) if (hears(c.sees, about)) nudge(c);
}

function nudge(c: Client): void {
  if (pending.has(c)) return;
  pending.set(c, setTimeout(() => {
    pending.delete(c); lastSent.set(c, Date.now());
    send(c, 'event: change\ndata: {}\n\n');
  }, Math.max(0, (lastSent.get(c) ?? 0) + GAP_MS - Date.now())));
}

function send(c: Client, text: string): void {
  try { c.res.write(text); } catch { drop(c); }
}

function drop(c: Client): void {
  clients.delete(c);
  clearTimeout(pending.get(c)); pending.delete(c);
  if (clients.size) return;
  watcher?.close(); watcher = undefined;
  clearInterval(ticking); ticking = undefined;
  clearInterval(beating); beating = undefined;
  seen.clear();
}

const scopeOf = (env: NodeJS.ProcessEnv) => `${env.LOOM_SCOPE ?? ''}\0${env.LOOM_OWNER_SCOPE ?? ''}`;

/** Ask each open scope's pieces again (one round at a time); a piece that answers differently is that scope's change. */
function tick(): Promise<void> {
  if (tickRunning || Date.now() - ticked < TICK_MIN_MS) return tickRunning ?? Promise.resolve();
  ticked = Date.now();
  tickRunning = (async () => {
    const scopes = new Map<string, NodeJS.ProcessEnv>();
    for (const c of clients) scopes.set(scopeOf(c.env), c.env);
    for (const [scope, env] of scopes) {
      const now = await refreshPieceManifests(env).catch(() => undefined);
      if (!now) continue;
      const before = seen.get(scope);
      let moved = false;
      if (before) for (const [path, print] of now) if (before.get(path) !== print) { clearPiecePages(path); moved = true; }
      seen.set(scope, now);
      if (moved) for (const c of clients) if (scopeOf(c.env) === scope) nudge(c);
    }
  })().finally(() => { tickRunning = undefined; });
  return tickRunning;
}

/**
 * Open an app's stream. `home` is loom's data folder (the household's, or the one agent's); `place` says whose a
 * file under it is (a path relative to `home`); `sees` is what this app's owner may see; `session` names the
 * signed-in browser, so one can't open streams without end.
 */
export function openStream(res: ServerResponse, env: NodeJS.ProcessEnv, home: string, headers: Record<string, string>,
  opts: { sees: Sees; session: string; place: (file: string) => Sees }): void {
  const mine = [...clients].filter((x) => x.session === opts.session);
  if (mine.length >= STREAMS_PER_SESSION) { mine[0].res.end(); drop(mine[0]); }   // the oldest goes
  res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
  res.write('retry: 5000\n\n');
  const c: Client = { res, env, sees: opts.sees, session: opts.session };
  whose = opts.place;
  clients.add(c);
  res.on('close', () => drop(c));
  if (!watcher) {
    try { watcher = watch(home, { recursive: true }, (_e, file) => { if (file && DATA.test(String(file))) changed(whose(String(file))); }); } catch { /* no watch here: the pieces' tick and actions still tell */ }
  }
  ticking ??= setInterval(() => void tick(), WATCH_MS);
  beating ??= setInterval(() => { for (const x of clients) send(x, ': beat\n\n'); }, BEAT_MS);
  void tick();
}

/** How many apps are listening (for tests). */
export const listening = () => clients.size;
