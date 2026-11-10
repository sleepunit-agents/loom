/**
 * A Comms thread's own live stream (docs/specs/comms.md, "Live" and rule 4): GET /comms/<thread>/events, server-sent
 * events, open while the thread is on screen. It sends one event, `message`, with `{seq}` (the thread's newest seq),
 * and nothing else: no words, no title. Before each event it asks again whether the stream's member may still see the
 * thread, and a member who no longer may is cut off.
 *
 * loom runs several listeners (LAN, tailnet, localhost), and the runtime posts a reply to one while the browser holds
 * its stream on another. So a thread's move is told through household.db (comms_threads.updated) and a tick file
 * (`comms.tick`, a time only) that every listener with an open stream watches, plus a fallback poll. The same pass
 * tells the thread's member's shared stream (src/ui/live.ts changedFor), so the dock's count refreshes, and only theirs.
 */
import { watch, type FSWatcher } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { movedSince, onBump, seqsOf, threadState } from '../comms.js';
import { changedFor } from './live.js';

const BEAT_MS = 25_000;
const POLL_MS = 2_000;
/** Streams per thread per signed-in browser, at most; the oldest goes. */
const PER_SESSION = 4;

/** `state`: the thread's state this stream last told of (comms.ts threadState: working, a delivery's outcome; t-1881). */
interface Stream { res: ServerResponse; thread: string; session: string; sent: number; state: string; may: () => boolean }
const streams = new Set<Stream>();
const homes = new Map<string, { watcher?: FSWatcher; poll: NodeJS.Timeout; beat: NodeJS.Timeout; seen: number; off: () => void }>();

/** A stream closed or cut off. The home's watch stays: the shared stream's members still hear of their threads. */
function drop(s: Stream): void {
  streams.delete(s);
  try { s.res.end(); } catch { /* gone */ }
}

/** Stop watching every home (tests). */
export function stopCommsWatch(): void {
  for (const s of [...streams]) { streams.delete(s); try { s.res.end(); } catch { /* gone */ } }
  for (const h of homes.values()) { h.watcher?.close(); clearInterval(h.poll); clearInterval(h.beat); h.off(); }
  homes.clear();
}

function write(s: Stream, text: string): void {
  try { s.res.write(text); } catch { drop(s); }
}

/**
 * Send each open stream its thread's newest seq, if it moved and the member may still see it: a new message, or its
 * state (a message delivered or not, the body at work or done), which the app reads again (t-1881).
 */
function pass(home: string): void {
  for (const s of [...streams]) {
    const { last } = seqsOf(home, s.thread);
    const state = threadState(home, s.thread);
    if (last <= s.sent && state === s.state) continue;
    if (!s.may()) { drop(s); continue; }
    s.sent = Math.max(s.sent, last);
    s.state = state;
    write(s, `event: message\ndata: ${JSON.stringify({ seq: last })}\n\n`);
  }
}

/** The threads that moved since the last look: each one's member hears a change on the shared stream. */
function tellMembers(home: string): void {
  const h = homes.get(home);
  const since = h?.seen ?? Date.now();
  const moved = movedSince(home, since);
  if (h && moved.length) h.seen = Math.max(...moved.map((m) => m.updated));
  for (const m of new Set(moved.map((x) => x.member))) changedFor(m);
}

/**
 * Start telling `home`'s members of thread moves, without any thread stream open (the shared stream's count): the
 * daemon calls it once per household at start.
 */
export function watchComms(home: string): void {
  ensure(home);
}

function ensure(home: string): void {
  if (homes.has(home)) return;
  let busy = false;
  const tick = () => {
    try {
      tellMembers(home);
      pass(home);
      busy = false;
    } catch (error) {
      // Watchers and timers have no request error boundary. A transient lock
      // must leave the listener alive; the next poll retries the same cursor.
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED') {
        console.error('loom: Comms live update failed; retrying on the next poll', error);
        return;
      }
      if (!busy) console.warn('loom: Comms live updates waiting for the database; retrying on the next poll');
      busy = true;
    }
  };
  let watcher: FSWatcher | undefined;
  try { watcher = watch(home, (_e, file) => { if (String(file) === 'comms.tick') tick(); }); watcher.unref?.(); } catch { /* the poll still runs */ }
  const poll = setInterval(tick, POLL_MS); poll.unref();
  const beat = setInterval(() => { for (const s of streams) write(s, ': beat\n\n'); }, BEAT_MS); beat.unref();
  homes.set(home, { watcher, poll, beat, seen: Date.now(), off: onBump(tick) });
}

/**
 * Open a thread's stream. `may` re-checks the member against the thread (comms.ts stillSees); `from` is the seq the
 * app already has, so a reconnect sends the newest at once if it moved meanwhile.
 */
export function openThreadStream(res: ServerResponse, headers: Record<string, string>, home: string, opts: { thread: string; session: string; from: number; may: () => boolean }): void {
  const mine = [...streams].filter((x) => x.session === opts.session && x.thread === opts.thread);
  if (mine.length >= PER_SESSION) drop(mine[0]);
  res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const s: Stream = { res, thread: opts.thread, session: opts.session, sent: opts.from, state: threadState(home, opts.thread), may: opts.may };
  streams.add(s);
  res.on('close', () => drop(s));
  ensure(home);
  pass(home);
}

