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
export interface Context { db: Db; viewer: Viewer; changed(type: string, id: string): void; now: number }
export interface Operation<I = unknown> {
  name: string; input: z.ZodType<I>; output: z.ZodType; write?: boolean; doors?: Door[];
  /** Message words must never enter retry storage; these operations return an acknowledgement. */
  may(viewer: Viewer, input: I, db: Db): boolean;
  run(ctx: Context, input: I): unknown;
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
  }
  has(name: string) { return this.ops.has(name); }
  offered(door: Door) { return [...this.ops.values()].filter(o => !o.doors || o.doors.includes(door)).map(o => ({ name: o.name, input: o.input, output: o.output, write: !!o.write })); }
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
        if (!op.may(viewer, parsed.data, this.db)) return failure('denied', 'Permission denied');
        const value = op.run({ db: this.db, viewer, now, changed: (type, id) => { changes.push({ type, id }); } }, parsed.data);
        if (value instanceof Promise) throw new Error('Operations must be synchronous');
        if (value && typeof value === 'object' && 'ok' in value && value.ok === false) {
          const e = value as Failure; throw new OperationError(e.code, e.message);
        }
        const answer: Result = { ok: true, value: op.output.parse(value ?? null) };
        const serialized = JSON.stringify(answer);
        if (op.write) this.db.prepare('INSERT INTO core_operations VALUES (?, ?, ?, ?, ?, ?)').run(who, id, name, body, serialized, now + 30 * 86400_000);
        return JSON.parse(serialized) as Result;
      })();
    } catch (e) { return e instanceof OperationError ? failure(e.code, e.message) : failure('unavailable', 'Operation could not complete'); }
    finally { this.frames.pop(); }
    if (result.ok && changes.length) {
      const parent = this.frames.at(-1);
      if (parent) parent.push(...changes);
      else { try { this.committed(changes); } catch { /* committed writes remain successful; failed subscribers reconnect */ } }
    }
    if (result.ok && !this.frames.length && op.write) this.expire();
    return result;
  }
}
