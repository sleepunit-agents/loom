/**
 * One HTTP worker per home runs maintenance. SQLite's exclusive transaction is an OS file lock, held on a
 * dedicated, otherwise empty database for the ownership term. It uses the existing SQLite dependency: no PID
 * files, stale-time guesses or expiring leases that could let a suspended worker resume alongside its successor.
 * The kernel releases it on process death. Never unlink this file (two inodes would mean two owners).
 *
 * Retiring workers stop admitting work immediately, then keep the lock until admitted asynchronous jobs drain.
 * Followers retry every second, below the shortest shared job period. Request/stream delivery stays local.
 */
import Database from 'better-sqlite3';
import { periodicContext } from './periodic-context.js';
import { join } from 'node:path';

export const OWNER_RETRY_MS = 1_000;

export class PeriodicOwner {
  private db: Database.Database | undefined;
  private eligible = false;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;
  private work = new Map<string, Promise<void>>();
  private drained: Array<() => void> = [];

  constructor(private readonly home: string, private readonly acquired: () => void,
    private readonly report: (e: unknown) => void = e => console.error('loom: periodic ownership failed', e)) {}

  get active(): boolean { return this.eligible && !this.closed && this.db !== undefined; }

  setEligible(eligible: boolean): void {
    if (this.closed) return;
    const was = this.eligible;
    this.eligible = eligible;
    if (!eligible) {
      clearInterval(this.timer); this.timer = undefined;
      this.releaseIfDrained();
      return;
    }
    if (!was && this.db) { try { this.acquired(); } catch (e) { this.report(e); } }
    this.attempt();
    this.timer ??= setInterval(() => this.attempt(), OWNER_RETRY_MS);
    this.timer.unref();
  }

  private attempt(): void {
    if (!this.eligible || this.closed || this.db) return;
    let db: Database.Database | undefined;
    try {
      db = new Database(join(this.home, 'periodic-owner.db'), { timeout: 0 });
      // A rollback-journal database: BEGIN EXCLUSIVE stays exclusive even without any data to mutate.
      db.exec('BEGIN EXCLUSIVE');
      this.db = db;
    } catch (e) {
      db?.close();
      if (!String((e as { code?: string }).code).startsWith('SQLITE_BUSY')) this.report(e);
      return;
    }
    try { this.acquired(); } catch (e) { this.report(e); }
  }

  /** At most one pass of a named job, and no admission after retirement. Errors never escape a timer. */
  run(name: string, job: () => unknown | Promise<unknown>): Promise<void> {
    if (!this.active) return Promise.resolve();
    const current = this.work.get(name);
    if (current) return current;
    // Register before invoking the job (which may retire this worker or re-enter run).
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    const promise = result.catch(this.report).then(() => undefined).finally(() => {
      this.work.delete(name);
      this.releaseIfDrained();
    });
    this.work.set(name, promise);
    try { resolve(periodicContext.run({ home: this.home, job: name }, job)); } catch (e) { reject(e); }
    return promise;
  }

  private releaseIfDrained(): void {
    if (this.active || this.work.size) return;
    if (this.db) { this.db.close(); this.db = undefined; }
    for (const done of this.drained.splice(0)) done();
  }

  async close(): Promise<void> {
    this.closed = true; this.eligible = false;
    clearInterval(this.timer); this.timer = undefined;
    this.releaseIfDrained();
    if (this.work.size) await new Promise<void>(resolve => this.drained.push(resolve));
  }
}
