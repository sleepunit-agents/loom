import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { Db } from '../db/index.js';
import { migrate } from '../db/index.js';
import type { Clock } from '../clock.js';
import type { Viewer } from '../../policy.js';
export type Door = 'http' | 'socket' | 'mcp' | 'direct';
export type Code = 'denied' | 'not-found' | 'invalid' | 'conflict' | 'unavailable';
export type Failure = { ok: false; code: Code; message: string };
export type Result = { ok: true; value: unknown } | Failure;
export const failure = (code: Code, message: string): Failure => ({ ok: false, code, message });
export class OperationError extends Error { constructor(readonly code: Code, message: string) { super(message); } }
export interface Change { type: string; id: string }
/** Stable identity for a write which also commits to a source outside loom.db.
 * Sources store this receipt atomically with their effects; it is not an intent.
 */
export interface WriteReceipt { viewer: string; id: string; name: string; inputHash: string; expires: number }
export interface Context { db: Db; viewer: Viewer; changed(type: string, id: string): void; now: number; receipt?: Readonly<WriteReceipt> }
export interface CliCommand { name: string; write?: boolean; positional?: string[]; flags?: Record<string, string>; fileFields?: string[] }
/** A committed external result retains its original core retry deadline. */
export class RecoveredWrite<T = unknown> { constructor(readonly value: T, readonly expires: number) {} }
export interface Operation<I = unknown> {
  name: string; cli?: CliCommand; input: z.ZodType<I>; output: z.ZodType; write?: boolean; doors?: Door[];
  /** Message words must never enter retry storage; these operations return an acknowledgement. */
  may(viewer: Viewer, input: I, db: Db): boolean;
  run(ctx: Context, input: I): unknown;
  /** Read an already-committed external receipt by the shared viewer/id key.
   * Registered hooks run before may for EVERY write, not only this operation.
   * A mismatched name/hash must conflict. Must not apply an effect; may announce
   * recovered changes. Shared hook functions are registered only once.
   */
  recover?(ctx: Context): RecoveredWrite | undefined;
  /** Audit a rejected attempt after its effects have rolled back. This hook may
   * append audit rows only; it must never apply or retry the rejected action.
   * Audit failures do not change the caller's rejection.
   */
  rejected?(viewer: Viewer, input: I, failure: Failure, now: number): void;
}
export function operation<I>(op: Operation<I>): Operation<I> { return op; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export class Operations {
  // Heterogeneous schemas are erased only at registration; parsing restores each operation's input.
  private frames: Change[][] = [];
  private recoveries = new Set<NonNullable<Operation['recover']>>();
  private stopExpiry?: () => void;
  private ops = new Map<string, Operation<any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  constructor(readonly db: Db, readonly clock: Clock, private committed: (changes: Change[]) => void) {
    migrate(db, 'core', [{ number: 1, sql: 'CREATE TABLE core_operations (viewer TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(viewer,id))' }]);
    this.expire();
  }
  close() { this.stopExpiry?.(); }
  private expire() {
    this.stopExpiry?.();
    this.db.prepare('DELETE FROM core_operations WHERE expires <= ?').run(this.clock.now());
    const row = this.db.prepare('SELECT min(expires) AS next FROM core_operations').get() as { next: number | null };
    this.stopExpiry = row.next === null ? undefined : this.clock.at(row.next, () => this.expire());
  }
  register<I>(op: Operation<I>) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_-]*$/.test(op.name) || this.ops.has(op.name)) throw new Error('invalid or duplicate operation');
    this.ops.set(op.name, op);
    if (op.write && op.recover) this.recoveries.add(op.recover);
  }
  has(name: string) { return this.ops.has(name); }
  offered(door: Door) { return [...this.ops.values()].filter(o => !o.doors || o.doors.includes(door)).map(o => ({ name: o.name, input: o.input, output: o.output, write: !!o.write, cli: o.cli })); }
  /** MCP registration is a hook; it dispatches exactly like the other doors. */
  registerMcp(register: (name: string, input: z.ZodType, call: (viewer: Viewer, input: unknown, id?: string) => Result) => void) {
    for (const op of this.offered('mcp')) register(op.name, op.input, (v, input, id) => this.call('mcp', v, op.name, input, id));
  }
  call(door: Door, viewer: Viewer, name: string, input: unknown, id?: string): Result {
    const op = this.ops.get(name);
    if (!op) return failure('not-found', 'Unknown operation');
    if (op.doors && !op.doors.includes(door)) return failure('denied', 'Operation is not offered on this door');
    const parsed = op.input.safeParse(input);
    if (!parsed.success) return failure('invalid', 'Input does not match operation schema');
    if (op.write && (!id || id.length > 200)) return failure('invalid', 'A write needs an operation id (1–200 characters)');
    const changes: Change[] = [];
    let result: Result;
    if (this.db.inTransaction && !this.frames.length) return failure('unavailable', 'Operations must own the outer transaction');
    this.frames.push(changes);
    try {
      result = this.db.transaction((): Result => {
        const now = this.clock.now();
        const who = canonical(viewer), body = createHash('sha256').update(canonical(parsed.data)).digest('hex');
        if (op.write) {
          this.db.prepare('DELETE FROM core_operations WHERE expires <= ?').run(now);
          const old = this.db.prepare('SELECT * FROM core_operations WHERE viewer = ? AND id = ?').get(who, id) as { name: string; input_hash: string; result: string } | undefined;
          if (old) return old.name === name && old.input_hash === body ? JSON.parse(old.result) as Result : failure('conflict', 'Operation id already used for different input');
        }
        const ctx: Context = { db: this.db, viewer, now, ...(op.write ? { receipt: { viewer: who, id: id!, name, inputHash: body, expires: now + 30 * 86400_000 } } : {}), changed: (type, id) => { changes.push({ type, id }); } };
        let recovered: RecoveredWrite | undefined;
        if (op.write) for (const recover of this.recoveries) {
          recovered = recover(ctx);
          if (recovered) break;
        }
        if (!recovered && !op.may(viewer, parsed.data, this.db)) return failure('denied', 'Permission denied');
        const outcome = recovered ?? op.run(ctx, parsed.data);
        const replay = outcome instanceof RecoveredWrite ? outcome : undefined;
        if (replay && (!op.write || !Number.isFinite(replay.expires) || replay.expires <= now || replay.expires > ctx.receipt!.expires)) throw new Error('Invalid recovered receipt expiry');
        const value = replay ? replay.value : outcome;
        if (value instanceof Promise) throw new Error('Operations must be synchronous');
        if (value && typeof value === 'object' && 'ok' in value && value.ok === false) {
          const e = value as Failure; throw new OperationError(e.code, e.message);
        }
        const answer: Result = { ok: true, value: op.output.parse(value ?? null) };
        const serialized = JSON.stringify(answer);
        if (op.write) this.db.prepare('INSERT INTO core_operations VALUES (?, ?, ?, ?, ?, ?)').run(who, id, name, body, serialized, replay?.expires ?? now + 30 * 86400_000);
        return JSON.parse(serialized) as Result;
      })();
    } catch (e) { result = e instanceof OperationError ? failure(e.code, e.message) : failure('unavailable', 'Operation could not complete'); }
    finally { this.frames.pop(); }
    if (!result.ok && op.rejected) {
      try { this.db.transaction(() => op.rejected!(viewer, parsed.data, result as Failure, this.clock.now()))(); }
      catch { /* An audit failure cannot turn a refused action into success. */ }
    }
    if (result.ok && changes.length) {
      const parent = this.frames.at(-1);
      if (parent) parent.push(...changes);
      else { try { this.committed(changes); } catch { /* committed writes remain successful; failed subscribers reconnect */ } }
    }
    if (result.ok && !this.frames.length && op.write) this.expire();
    return result;
  }
}
