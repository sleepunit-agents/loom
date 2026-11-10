/**
 * Waiting for another process's lock without freezing the daemon (t-2130, t-2141).
 *
 * better-sqlite3 and loom's file locks wait synchronously: a busy_timeout or an Atomics.wait holds the whole HTTP
 * worker, so one request waiting on a lock stalls every other one (/login took 5 s behind a held Comms lock). A
 * request that may meet a lock first waits here, asynchronously, until each database it names can be read (or
 * written) and each lock file is free, and only then runs its synchronous code, which keeps its own timeouts for the
 * rare race. So contention costs the request time, never the worker, and never fails it: making contended calls fail
 * at once (#776, #783) broke Comms on its first deploy, as WAL recovery answered busy too. A spent budget fails
 * nothing either: a request goes on to its old synchronous wait (the Comms live tick, to its next poll).
 *
 * Waiters for the same locks queue in one line, first come first served. While the line has waiters, one probe
 * every few ms looks; while the locks are free, it lets them through one at a time, each one's synchronous section
 * done (and other requests answered) before the next. So a gap of a few ms between another process's holds drains
 * the line, where waiters polling on their own each missed it and then all went at once when their budgets ran out.
 *
 * Each database is probed with no busy wait, on a connection opened for that one look and closed at once: a read for
 * readers, BEGIN IMMEDIATE then ROLLBACK for writers. Never one kept: a file deleted and made again (Comms' erase, a
 * test's fresh store) can reuse its inode, and SQLite's per-process lock table would join a kept connection to the
 * new file (disk I/O errors on the next real write), or its close remove the new file's WAL.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import BetterSqlite3, { type Database } from 'better-sqlite3';

/** Every busy and locked code, extended ones too (SQLITE_BUSY_RECOVERY, SQLITE_BUSY_SNAPSHOT, SQLITE_LOCKED_SHAREDCACHE…). */
export function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}

/** The old synchronous budget, kept as the async one: a read, or a wait that may not be needed. */
export const READ_WAIT_MS = 5_000;
/**
 * A Comms post or live update, which must land, waits longer. Its budget and the old 5 s synchronous wait after it
 * stay inside the runtime's 15 s for a Comms call (loom-box core.mjs), so core never commits a post the runtime has
 * given up on and would send again.
 */
export const WRITE_WAIT_MS = 8_000;
/** A turn, an audit entry or a house binding: the runtime gives these 5 s in all. Past this, the old wait goes on. */
export const TURN_WAIT_MS = 2_500;
const PROBE_EVERY_MS = 5;

/** A lock file the request may take: held while it exists and its holder is live (each lock says what live means). */
export interface FileLock { path: string; held: () => boolean }

export interface LockWait {
  /** Database files to read; missing ones are skipped. */
  read?: readonly string[];
  /** Database files to write; missing ones are skipped. */
  write?: readonly string[];
  files?: readonly FileLock[];
  budgetMs?: number;
}

/** Whether `path` can be read (or written) right now. Anything but busy is the real code's to meet and report. */
function free(path: string, write: boolean): boolean {
  if (!existsSync(path)) return true;
  let db: Database | undefined;
  try {
    db = new BetterSqlite3(path, { fileMustExist: true, timeout: 0 });
    if (write) {
      db.exec('BEGIN IMMEDIATE');
      db.exec('ROLLBACK');
    } else {
      db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    }
    return true;
  } catch (error) {
    try { if (db?.inTransaction) db.exec('ROLLBACK'); } catch { /* nothing begun */ }
    return !isSqliteBusy(error);
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function allFree(w: LockWait): boolean {
  return (w.files ?? []).every((f) => !f.held())
    && (w.write ?? []).every((path) => free(path, true))
    && (w.read ?? []).every((path) => free(path, false));
}

interface Waiter { deadline: number; go: (free: boolean) => void }
interface Line { w: LockWait; waiters: Waiter[] }
const lines = new Map<string, Line>();

const lineKey = (w: LockWait): string => JSON.stringify([
  [...(w.read ?? [])].sort(), [...(w.write ?? [])].sort(), (w.files ?? []).map((f) => f.path).sort(),
]);

/** One line's probe: lets its waiters through while the locks are free, and each whose budget ran out, one at a time. */
async function pump(key: string, line: Line): Promise<void> {
  try {
    while (line.waiters.length) {
      if (allFree(line.w)) line.waiters.shift()!.go(true);
      else {
        const late = line.waiters.findIndex((x) => performance.now() >= x.deadline);
        if (late < 0) { await sleep(PROBE_EVERY_MS); continue; }
        line.waiters.splice(late, 1)[0].go(false);
      }
      // Its synchronous section runs, and the requests that came meanwhile are answered, before the next goes.
      await nextTurn();
    }
  } catch (error) {
    // Nothing above throws today; if a lock's check ever does, every waiter still goes on, to its old wait.
    console.error('loom: a lock wait failed; going on without it', error);
    for (const x of line.waiters.splice(0)) x.go(false);
  } finally {
    lines.delete(key);
  }
}

/**
 * Wait, without blocking the event loop, until every lock `w` names is free at once, up to its budget. True when
 * they were; false when the budget ran out first, and the caller goes on to its own synchronous wait.
 */
export function waitForLocks(w: LockWait): Promise<boolean> {
  const key = lineKey(w);
  if (!lines.has(key) && allFree(w)) return Promise.resolve(true);
  return new Promise((go) => {
    const deadline = performance.now() + (w.budgetMs ?? READ_WAIT_MS);
    const line = lines.get(key);
    if (line) { line.waiters.push({ deadline, go }); return; }
    const fresh: Line = { w, waiters: [{ deadline, go }] };
    lines.set(key, fresh);
    void pump(key, fresh);
  });
}

/** A household-style lock file, holding the holder's pid: held while that process lives (household.ts withLock). */
export function pidLock(path: string): FileLock {
  return {
    path,
    held: () => {
      let pid: number;
      try { pid = Number.parseInt(readFileSync(path, 'utf-8'), 10); } catch { return false; }
      if (!Number.isSafeInteger(pid) || pid <= 0) return true;
      try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
    },
  };
}

/** A lock file that goes stale with age (ui/sessions.ts): held while it exists and is younger than `staleMs`. */
export function ageLock(path: string, staleMs: number): FileLock {
  return {
    path,
    held: () => {
      try { return Date.now() - statSync(path).mtimeMs <= staleMs; } catch { return false; }
    },
  };
}
