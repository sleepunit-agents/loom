import type { PeriodicOwner } from '../transport/periodic-owner.js';
import { invalidateManifest, manifestDemand } from './manifest-shared.js';
import { liveDbPath } from '../collections/log.js';
import { isSqliteBusy, waitForLocks } from '../lock-gate.js';
import { backgroundJob } from '../transport/stall-watch.js';
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
 * - a piece's manifest answering differently (asked every WATCH_MS while an app is open, per scope that's open, one
 *   run shared by the scopes it doesn't read and less often while it doesn't move (pieces.ts, t-2110), and at once
 *   when a piece says it moved: POST /api/loom/pieces/changed writes PIECES_TICK, t-1945);
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
import { randomBytes } from 'node:crypto';
import { readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dataChanges } from './live-files.js';
import { basename, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { ROUND_MS, sharePieceManifests, sharedPiecePrints, clearPiecePages, expirePieceManifests, refreshPieceManifests } from './pieces.js';

export const WATCH_MS = ROUND_MS;
const BEAT_MS = 25_000;
const GAP_MS = 1_500;
const TICK_MIN_MS = 5_000;
export const STREAMS_PER_SESSION = 6;
/** What a change looks like in loom's data folder: an agent's stores and the household file. */
const DATA = /(^|\/)(memories|knowledge|people)\.db(-wal)?$|(^|\/)household\.json$/;
/** The file a piece's word that its manifest moved is left in (a time only), in loom's data folder: every listener sees it. */
export const PIECES_TICK = 'pieces.tick';

/** What an app's owner may see: every agent (`*`, a household owner), or theirs. */
export type Sees = '*' | readonly string[];
/**
 * `id` is the stream's name (its `hello`, docs/specs/collections.md: queries name it to subscribe on it); `seq` counts
 * the frames this stream was sent and nothing else; `behind` counts writes the socket hasn't drained.
 */
interface Client { home: string; res: ServerResponse; env: NodeJS.ProcessEnv; sees: Sees; session: string; member?: string; id: string; seq: number; behind: number; onClose?: () => void; authorized?: (event?: string) => boolean }
const clients = new Set<Client>();
let watcher: FSWatcher | undefined;
let ticking: NodeJS.Timeout | undefined;
let beating: NodeJS.Timeout | undefined;
const pending = new Map<Client, NodeJS.Timeout>();
const lastSent = new WeakMap<Client, number>();
let ticked = 0;
let tickRunning: Promise<void> | undefined;
// What the next round asks, once the one under way is done: false nothing, true every piece, a set just those paths.
let tickAgain: boolean | Set<string> = false;
// The regular round came due while another ran: it runs next.
let roundAgain = false;
let whose: (file: string) => Sees = () => '*';
const seen = new Map<string, Map<string, string>>();

const sharedBackgrounds = new Map<string, { home: string; env: NodeJS.ProcessEnv; owner: PeriodicOwner; listener: string; scopes: NodeJS.ProcessEnv[] }>();
const sharedFor = (home: string) => [...sharedBackgrounds.values()].find(s => s.home === home && s.owner.active) ?? [...sharedBackgrounds.values()].find(s => s.home === home);
/** Keep the owner polling follower demand even when it has no local browser streams. */
export function configureManifestBackground(home: string, env: NodeJS.ProcessEnv, owner: PeriodicOwner): () => Promise<void> {
  const stopSharing = sharePieceManifests(home);
  const state = { home, env: { ...env, LOOM_HOME: home }, owner, listener: randomBytes(12).toString('hex'), scopes: [] as NodeJS.ProcessEnv[] };
  sharedBackgrounds.set(state.listener, state);
  let polling: Promise<void> | undefined;
  const poll = () => polling ??= manifestWrite(home, () => {
    if (!sharedBackgrounds.has(state.listener)) return;
    state.scopes = manifestDemand(home, state.listener, [...clients].filter(c => c.home === home).map(c => c.env));
    if (owner.active) {
      const word = tickWord(home);
      if (word.fresh) {
        invalidatePaths(home, word.paths);
        void tick(true, word.paths); return;
      }
    }
    void tick();
  }).finally(() => { polling = undefined; });
  const timer = setInterval(() => void backgroundJob('manifest demand', poll), 2_000);
  timer.unref();
  void poll();
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    sharedBackgrounds.delete(state.listener);
    await polling;
    await manifestWrite(home, () => { manifestDemand(home, state.listener, []); });
    await tickRunning;
    stopSharing();
  };
}

/** A busy derived-cache writer is retried by the next demand poll; timers/watchers never throw. */
async function manifestWrite(home: string, write: () => void): Promise<void> {
  try {
    if (await waitForLocks({ write: [liveDbPath(home)] })) write();
  } catch (error) {
    if (!isSqliteBusy(error)) console.error('loom: manifest live update failed; retrying on the next poll', error);
  }
}
function invalidatePaths(home: string, paths?: ReadonlySet<string>): void {
  if (paths) for (const path of paths) invalidateManifest(home, path); else invalidateManifest(home);
}

/** Whether an app whose owner sees `sees` may hear of a change to `about`. */
const hears = (sees: Sees, about: Sees) => sees === '*' || (about !== '*' && about.some((a) => sees.includes(a)));

/**
 * What else hears "something changed", by household home: the shared collections, whose attention records are made
 * from everything a change can move (t-2025: subs.ts nudges `loom/attention`, which costs at most one pull per GAP_MS).
 */
const changeHooks = new Map<string, (about: Sees) => void | Promise<void>>();
export function onChanged(home: string, f: (about: Sees) => void | Promise<void>): void { changeHooks.set(home, f); }
function hooks(about: Sees = '*'): Promise<void> {
  const jobs = [...changeHooks.values()].map(f => { try { return f(about); } catch (error) { return Promise.reject(error); } });
  const done = Promise.all(jobs).then(() => undefined);
  // Watchers may ignore the result; operations await it and must see a failed publication.
  void done.catch(() => undefined);
  return done;
}

/** Tell the open apps that may see it that something changed (soon, and once for a burst).
 * Operations await the result so their change hints are durable before acknowledgment. */
export function changed(about: Sees = '*'): Promise<void> {
  const durable = hooks(about);
  tell(about);
  return durable;
}
function tell(about: Sees): void {
  for (const c of clients) if (hears(c.sees, about)) nudge(c);
}

/**
 * Tell only `member`'s open apps that something of theirs changed: a Comms thread is its member's alone
 * (docs/specs/comms.md, rule 4), so another owner of the same agent never hears of it, not even as a bare change.
 */
export function changedFor(member: string, notifyHooks = true): void {
  if (notifyHooks) hooks();
  for (const c of clients) if (c.member === member) nudge(c);
}

function nudge(c: Client): void {
  if (pending.has(c)) return;
  pending.set(c, setTimeout(() => backgroundJob('live change frame', () => {
    pending.delete(c); lastSent.set(c, Date.now());
    send(c, 'event: change\ndata: {}\n\n');
  }), Math.max(0, (lastSent.get(c) ?? 0) + GAP_MS - Date.now())));
}

function send(c: Client, text: string, event?: string): void {
  try {
    if (c.authorized && !c.authorized(event)) { c.res.end(); drop(c); return; }
    if (!c.res.write(text)) {
      if (!c.behind) c.res.once('drain', () => { c.behind = 0; });
      c.behind++;
    }
  } catch { drop(c); }
}

/** A numbered frame on a stream (collections.md, "Core to window"): its seq is the stream's next. */
function frame(c: Client, event: string, data: Record<string, unknown>): number {
  c.seq++;
  send(c, `event: ${event}\ndata: ${JSON.stringify({ seq: c.seq, ...data })}\n\n`, event);
  return c.seq;
}

/** What the collections runtime holds of a stream (src/collections/subs.ts, StreamPort). */
export interface StreamHandle {
  id: string;
  session: string;
  frame: (event: string, data: Record<string, unknown>) => number;
  seq: () => number;
  behind: () => number;
  close: () => void;
}

function drop(c: Client): void {
  if (!clients.has(c)) return;
  clients.delete(c);
  c.onClose?.();
  clearTimeout(pending.get(c)); pending.delete(c);
  if (clients.size) return;
  watcher?.close(); watcher = undefined;
  clearInterval(ticking); ticking = undefined;
  clearInterval(beating); beating = undefined;
  seen.clear();
}

const scopeOf = (env: NodeJS.ProcessEnv) => `${env.LOOM_HOME ?? ''}\0${env.LOOM_SCOPE ?? ''}\0${env.LOOM_OWNER_SCOPE ?? ''}`;

/**
 * Ask each open scope's pieces again (one round at a time); a piece that answers differently is that scope's change.
 * `now`: a piece's own word, asked at once; `only` (with it): just the paths that moved (t-2065), else every piece.
 */
function tick(now = false, only?: ReadonlySet<string>): Promise<void> {
  return backgroundJob('live manifest tick', () => tickWork(now, only));
}

function tickWork(now = false, only?: ReadonlySet<string>): Promise<void> {
  // Empty owner polls must not delay the first browser's baseline (or its first producer hint has nothing to compare).
  if (!clients.size && ![...sharedBackgrounds.values()].some(s => s.owner.active && s.scopes.length)) return Promise.resolve();
  const first = [...clients].some(c => !seen.has(scopeOf(c.env)));
  // A piece's own word (now): asked at once, or straight after the round under way, whatever the last round's time.
  if (now && tickRunning) {
    tickAgain = !only || tickAgain === true ? true : new Set([...(tickAgain || []), ...only]);
    return tickRunning;
  }
  // The regular round, due while one piece's round runs: it comes straight after, never skipped.
  if (!now && tickRunning && Date.now() - ticked >= TICK_MIN_MS) { roundAgain = true; return tickRunning; }
  if (tickRunning || (!now && !first && Date.now() - ticked < TICK_MIN_MS)) return tickRunning ?? Promise.resolve();
  // A round of every piece resets the clock; one piece's word doesn't, so the round every WATCH_MS still comes.
  if (!only) ticked = Date.now();
  // A piece's own word: its kept answer goes in every scope (the open ones are asked again just below).
  if (now) { if (only) for (const p of only) expirePieceManifests(p); else expirePieceManifests(); }
  tickRunning = (async () => {
    const scopes = new Map<string, NodeJS.ProcessEnv>();
    for (const c of clients) scopes.set(scopeOf(c.env), c.env);
    for (const shared of sharedBackgrounds.values()) if (shared.owner.active) for (const scope of shared.scopes) {
      const env = { ...shared.env, LOOM_SCOPE: scope.LOOM_SCOPE, LOOM_OWNER_SCOPE: scope.LOOM_OWNER_SCOPE };
      scopes.set(scopeOf(env), env);
    }
    for (const [scope, env] of scopes) {
      const shared = sharedFor(env.LOOM_HOME ?? '');
      let now: Map<string, string> | undefined;
      if (!shared) now = await refreshPieceManifests(env, only).catch(() => undefined);
      else {
        await shared.owner.run('piece manifests', async () => { now = await refreshPieceManifests(env, only); });
        now ??= sharedPiecePrints(env, only);
      }
      if (!now) continue;
      const before = seen.get(scope);
      let moved = false;
      if (before) for (const [path, print] of now) if (before.get(path) !== print) { clearPiecePages(path); moved = true; }
      // Only what was asked replaces what was seen: the others' last answers stay the ones to compare with.
      // A round of some pieces is no first look at a scope: the next full round is (else every other piece "moved").
      if (only && !before) continue;
      seen.set(scope, only ? new Map([...before!, ...now]) : now);
      if (moved) for (const c of clients) if (scopeOf(c.env) === scope) nudge(c);
      // A piece's manifest moving is a piece's asks moving: the hooks hear it (the attention records, t-2025).
      if (moved && (!shared || shared.owner.active)) hooks();
      // Piece pages stay piece-rendered: a `page` frame says which piece's pages moved (collections.md), beside the bare
      // change that t-2032 retires.
      if (before) for (const [path, print] of now) if (before.get(path) !== print) {
        const piece = basename(path).replace(/^loom-/, '');
        // Household owners' streams only: an owner of some agents isn't told which pieces are installed (a piece that
        // doesn't scope them is hidden from them), and still hears the bare change, as before.
        for (const c of clients) if (scopeOf(c.env) === scope && c.sees === '*') frame(c, 'page', { piece });
      }
    }
  })().finally(() => {
    tickRunning = undefined;
    const again = tickAgain, round = roundAgain;
    tickAgain = false; roundAgain = false;
    // A regular round due goes first: it asks every piece, the one that moved too (its kept answer already went when
    // it said so), so a stream of one piece's words can never put it off. Else that piece's word.
    if (round && again !== true) void tick();
    else if (again) void tick(true, again === true ? undefined : again);
  });
  return tickRunning;
}

/**
 * What a tick file says: its time, and the piece paths it names (one per line after its time), or none: every piece.
 * One write is often two or three watch events; each word is heard once (t-2110: each event ran the piece again).
 */
const lastWords = new Map<string, string>();
function tickWord(home: string): { fresh: boolean; paths?: Set<string> } {
  try {
    const [at, ...paths] = readFileSync(join(home, PIECES_TICK), 'utf-8').split('\n').filter(Boolean);
    const word = [at, ...paths].join('\n');
    const fresh = word !== lastWords.get(home);
    lastWords.set(home, word);
    return { fresh, ...(paths.length ? { paths: new Set(paths) } : {}) };
  } catch { return { fresh: false }; }
}

/**
 * Open an app's stream. `home` is loom's data folder (the household's, or the one agent's); `place` says whose a
 * file under it is (a path relative to `home`); `sees` is what this app's owner may see; `session` names the
 * signed-in browser, so one can't open streams without end.
 */
export function openStream(res: ServerResponse, env: NodeJS.ProcessEnv, home: string, headers: Record<string, string>,
  opts: { sees: Sees; session: string; place: (file: string) => Sees; member?: string; authorized?: (event?: string) => boolean; opened?: (h: StreamHandle) => { scope: number; viewer: string; onClose: () => void } | undefined }): void {
  const mine = [...clients].filter((x) => x.session === opts.session);
  if (mine.length >= STREAMS_PER_SESSION) { mine[0].res.end(); drop(mine[0]); }   // the oldest goes
  res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
  res.write('retry: 5000\n\n');
  const c: Client = { home, res, env: { ...env, LOOM_HOME: home }, sees: opts.sees, session: opts.session, ...(opts.member ? { member: opts.member } : {}), authorized: opts.authorized, id: `e-${randomBytes(12).toString('base64url')}`, seq: 0, behind: 0 };
  // Who it is: the collections runtime learns of it, and the window learns its name (collections.md, "Core to window").
  const held = opts.opened?.({ id: c.id, session: c.session, frame: (e, d) => frame(c, e, d), seq: () => c.seq, behind: () => c.behind, close: () => { try { c.res.end(); } catch { /* gone */ } drop(c); } });
  if (held) c.onClose = held.onClose;
  res.write(`event: hello\ndata: ${JSON.stringify({ stream: c.id, scope: held?.scope ?? 0, seq: 0, ...(held ? { viewer: held.viewer } : {}) })}\n\n`);
  whose = opts.place;
  clients.add(c);
  res.on('close', () => drop(c));
  if (!watcher) {
    try {
      const files = dataChanges(home, DATA);
      watcher = watch(home, { recursive: true }, (_e, file) => backgroundJob('live files watch', () => {
        if (String(file) === PIECES_TICK) { void manifestWrite(home, () => {
          const w = tickWord(home); if (!w.fresh) return;
          if (sharedFor(home)) invalidatePaths(home, w.paths);
          void tick(true, w.paths);
        }); }
        // A store's file moved. Not the hooks' news: the records they move are built by reading these stores, and the
        // code that reads them writes to them, so a hook told of it would rebuild itself forever (t-2025, measured).
        else if (file && DATA.test(String(file)) && files.moved(String(file))) tell(whose(String(file)));
      }));
      // Reconcile the registration gap; queued callbacks then see the updated baseline.
      for (const file of files.reconcile()) tell(whose(file));
    } catch { /* no watch here: the pieces' tick and actions still tell */ }
  }
  ticking ??= setInterval(() => void tick(), WATCH_MS);
  beating ??= setInterval(() => backgroundJob('live heartbeat', () => { for (const x of clients) send(x, ': beat\n\n'); }), BEAT_MS);
  void tick();
}

/** Close every stream of a session (sign-out: collections.md, "Sign-out or revocation closes the session's streams"). */
export function closeSession(session: string): void {
  for (const c of [...clients]) if (c.session === session) { try { c.res.end(); } catch { /* gone */ } drop(c); }
}

/** How many apps are listening (for tests). */
export const listening = () => clients.size;

/**
 * A piece's word that its manifest moved (POST /api/loom/pieces/changed): every listener's open apps ask it again now.
 * `path`: the piece that said so, and only it is asked again (t-2065: the runtime says so at every body's start and end,
 * and each word used to re-run every piece's `ui --json`); none, every piece.
 */
export function piecesMoved(home: string, path?: string): void {
  if (sharedFor(home)) invalidateManifest(home, path);
  // A producer's new observation also matters when no stream is open to watch the tick file.
  expirePieceManifests(path);
  try { writeFileSync(join(home, PIECES_TICK), `${Date.now()}\n${path ?? ''}\n`); } catch { /* the pieces' own tick finds it */ }
}
