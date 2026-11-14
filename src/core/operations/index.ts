import { unregisterBuiltinServices } from '../services.js';
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
class PreparationNeeded { constructor(readonly receipt?: Readonly<WriteReceipt>) {} }
export const failure = (code: Code, message: string): Failure => ({ ok: false, code, message });
export class OperationError extends Error { constructor(readonly code: Code, message: string) { super(message); } }
export interface Change { type: string; id: string }
/** Stable identity for a write which also commits to a source outside loom.db.
 * Sources store this receipt atomically with their effects; it is not an intent.
 */
export interface WriteReceipt { viewer: string; id: string; name: string; inputHash: string; expires: number }
export interface Context { db: Db; viewer: Viewer; changed(type: string, id: string): void; now: number; receipt?: Readonly<WriteReceipt>; window?: boolean }
export interface CliCommand { name: string; write?: boolean; positional?: string[]; flags?: Record<string, string>; fileFields?: string[] }
/** A committed external result retains its original core retry deadline. */
export class RecoveredWrite<T = unknown> { constructor(readonly value: T, readonly expires: number) {} }
export interface Operation<I = unknown> {
  /** Sensitive authority results must recheck current policy even on receipt replay. */
  recheckPolicy?: boolean | ((viewer: Viewer, input: I) => boolean);
  /** Per-record window gate, evaluated before replay with the exact authenticated Viewer.
   * A piece may admit an independently proved acknowledgement-only body control. */
  requiresWindow?(input: I, viewer: Viewer): boolean;
  name: string; cli?: CliCommand; windowOnly?: boolean; input: z.ZodType<I>; output: z.ZodType; write?: boolean; doors?: Door[];
  /** Message words must never enter retry storage; these operations return an acknowledgement. */
  may(viewer: Viewer, input: I, db: Db): boolean;
  /** Private pieces key retry fingerprints so exported receipts cannot test guessed words.
   * actor retains the exact authenticated Viewer for trusted in-process scope readers. */
  inputHash?(canonicalInput: string, identity: Readonly<{viewer: string; actor: Viewer; input: I; id?: string; name: string}>): string;
  /** Async work is prepared outside the synchronous transaction, never persisted by core.
   * Write receipts and recovery are checked first and checked again after await.
   * This is NOT an external-effect commit protocol: concurrent preparations may
   * run and a later transaction/authentication check may still fail. A writer to
   * another store needs its own durable reconciliation and idempotency protocol. */
  prepare?(input: I, context: { readonly viewer: Viewer; readonly receipt?: Readonly<WriteReceipt> }): Promise<unknown>;
  /** Reserve external work synchronously in the preflight transaction, after
   * recovery and permission checks. Commit metadata only, never external effects.
   * A piece must guard this reservation in its global recovery hook and retain it
   * on preparation/authentication/final-transaction failure. */
  admit?(ctx: Context, input: I): void;
  after?(input: I, result: Result): void;
  run(ctx: Context, input: I, prepared?: unknown): unknown;
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
  close() { this.stopExpiry?.(); unregisterBuiltinServices(this); }
  private expire() {
    this.stopExpiry?.();
    this.db.prepare('DELETE FROM core_operations WHERE expires <= ?').run(this.clock.now());
    const row = this.db.prepare('SELECT min(expires) AS next FROM core_operations').get() as { next: number | null };
    this.stopExpiry = row.next === null ? undefined : this.clock.at(row.next, () => this.expire());
  }
  register<I>(op: Operation<I>) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_-]*$/.test(op.name) || this.ops.has(op.name)) throw new Error('invalid or duplicate operation');
    if (op.admit && (!op.write || !op.prepare || !op.recover)) throw new Error('Admission needs a prepared write and global recovery');
    this.ops.set(op.name, op);
    if (op.write && op.recover) this.recoveries.add(op.recover);
  }
  /** Trusted in-process recovery from a piece's durable journal, without the
   * original input. No door exposes this method. The registered recovery hook
   * must bind the complete identity and recheck the original caller's CURRENT
   * authority; neither admission, preparation nor run is invoked here. */
  recoverWrite(viewer: Viewer, receipt: Readonly<WriteReceipt>): Result {
    if (this.db.inTransaction || this.frames.length) return failure('unavailable', 'Recovery must own the outer transaction');
    const op = this.ops.get(receipt.name);
    if (!op?.write || !op.recover || canonical(viewer) !== receipt.viewer || !receipt.id || receipt.id.length > 200)
      return failure('unavailable', 'Recovery identity unavailable');
    const changes: Change[] = [];
    this.frames.push(changes);
    let result: Result;
    try {
      result = this.db.transaction((): Result => {
        const now = this.clock.now();
        const ctx: Context = {db:this.db, viewer, now, receipt, changed:(type,id)=>changes.push({type,id})};
        const old = this.db.prepare('SELECT name,input_hash FROM core_operations WHERE viewer=? AND id=?').get(receipt.viewer,receipt.id) as {name:string;input_hash:string}|undefined;
        if (old && (old.name !== receipt.name || old.input_hash !== receipt.inputHash)) throw new OperationError('conflict','Operation id already used for different input');
        let recovered: RecoveredWrite | undefined;
        for (const recover of this.recoveries) {
          const candidate = recover(ctx);
          if (candidate) {
            if (recovered) throw new OperationError('conflict','Multiple recovery receipts');
            recovered = candidate;
          }
        }
        if (!(recovered instanceof RecoveredWrite) || !Number.isFinite(recovered.expires) || recovered.expires <= now || recovered.expires > Math.min(receipt.expires, now + 30 * 86400_000))
          throw new Error('Recovery unavailable');
        const answer: Result = {ok:true,value:op.output.parse(recovered.value ?? null)};
        const serialized = JSON.stringify(answer);
        this.db.prepare('INSERT INTO core_operations VALUES (?,?,?,?,?,?) ON CONFLICT(viewer,id) DO UPDATE SET result=excluded.result,expires=excluded.expires')
          .run(receipt.viewer,receipt.id,receipt.name,receipt.inputHash,serialized,recovered.expires);
        return JSON.parse(serialized) as Result;
      })();
    } catch (e) { result = e instanceof OperationError ? failure(e.code,e.message) : failure('unavailable','Recovery could not complete'); }
    finally { this.frames.pop(); }
    if (result.ok) {
      if (changes.length) { try { this.committed(changes); } catch { /* committed recovery remains durable */ } }
      this.expire();
    }
    return result;
  }
  has(name: string) { return this.ops.has(name); }
  offered(door: Door) { return [...this.ops.values()].filter(o => !o.doors || o.doors.includes(door)).map(o => ({ name: o.name, input: o.input, output: o.output, write: !!o.write, cli: o.cli })); }
  /** MCP registration is a hook; it dispatches exactly like the other doors. */
  registerMcp(register: (name: string, input: z.ZodType, call: (viewer: Viewer, input: unknown, id?: string) => Result) => void) {
    for (const op of this.offered('mcp')) register(op.name, op.input, (v, input, id) => this.call('mcp', v, op.name, input, id));
  }
  async callAsync(door: Door, viewer: Viewer, name: string, input: unknown, id?: string, window = false, valid: () => boolean = () => true): Promise<Result> {
    if (!valid()) return failure('denied', 'Authentication ended');
    const op = this.ops.get(name);
    if (!op) return failure('not-found', 'Unknown operation');
    if ((op.windowOnly && (!window || door !== 'socket' || viewer.kind !== 'member')) || (op.doors && !op.doors.includes(door))) return failure('denied', 'Operation is not offered on this door');
    if (op.admit && (this.db.inTransaction || this.frames.length)) return failure('unavailable', 'Admission must own the outer transaction');
    if (!op.prepare && !op.windowOnly && !op.requiresWindow && !window) return this.call(door, viewer, name, input, id);
    const parsed = op.input.safeParse(input);
    if (!parsed.success) return failure('invalid', 'Input does not match operation schema');
    if (op.requiresWindow?.(parsed.data, viewer) && (!window || door!=='socket' || viewer.kind!=='member')) return failure('denied','A signed-in window is required');
    if (op.write && (!id || id.length > 200)) return failure('invalid', 'A write needs an operation id (1–200 characters)');
    try {
      let receipt: Readonly<WriteReceipt> | undefined;
      if (op.write) {
        const prior = this.execute(door, viewer, name, input, id, undefined, window, true);
        if (!(prior instanceof PreparationNeeded)) return prior;
        receipt = prior.receipt;
      } else if (!op.may(viewer, parsed.data, this.db)) return failure('denied', 'Permission denied');
      const prepared = await op.prepare?.(parsed.data, {viewer, receipt});
      if (!valid()) return failure('denied', 'Authentication ended');
      return this.execute(door, viewer, name, input, id, prepared, window);
    } catch (error) { return error instanceof OperationError ? failure(error.code, error.message) : failure('unavailable', 'Operation could not complete'); }
  }
  call(door: Door, viewer: Viewer, name: string, input: unknown, id?: string): Result {
    if (this.ops.get(name)?.prepare) return failure('unavailable', 'Operation requires asynchronous dispatch');
    return this.execute(door, viewer, name, input, id);
  }
  private execute(door: Door, viewer: Viewer, name: string, input: unknown, id?: string, prepared?: unknown, window?: boolean): Result;
  private execute(door: Door, viewer: Viewer, name: string, input: unknown, id: string | undefined, prepared: unknown, window: boolean, preflight: true): Result | PreparationNeeded;
  private execute(door: Door, viewer: Viewer, name: string, input: unknown, id?: string, prepared?: unknown, window = false, preflight = false): Result | PreparationNeeded {
    const op = this.ops.get(name);
    if (!op) return failure('not-found', 'Unknown operation');
    if ((op.windowOnly && (!window || door !== 'socket' || viewer.kind !== 'member')) || (op.doors && !op.doors.includes(door))) return failure('denied', 'Operation is not offered on this door');
    const parsed = op.input.safeParse(input);
    if (!parsed.success) return failure('invalid', 'Input does not match operation schema');
    if (op.requiresWindow?.(parsed.data, viewer) && (!window || door!=='socket' || viewer.kind!=='member')) return failure('denied','A signed-in window is required');
    if (op.write && (!id || id.length > 200)) return failure('invalid', 'A write needs an operation id (1–200 characters)');
    const changes: Change[] = [];
    let result: Result | PreparationNeeded;
    if (this.db.inTransaction && !this.frames.length) return failure('unavailable', 'Operations must own the outer transaction');
    this.frames.push(changes);
    try {
      result = this.db.transaction((): Result | PreparationNeeded => {
        const now = this.clock.now();
        if ((op.windowOnly || (typeof op.recheckPolicy === 'function' ? op.recheckPolicy(viewer, parsed.data) : op.recheckPolicy)) && !op.may(viewer, parsed.data, this.db)) return failure('denied', 'Permission denied');
        const who = canonical(viewer), body = op.inputHash ? op.inputHash(canonical(parsed.data), {viewer: who, actor: viewer, input: parsed.data, id, name}) : createHash('sha256').update(canonical(parsed.data)).digest('hex');
        if (op.write) {
          this.db.prepare('DELETE FROM core_operations WHERE expires <= ?').run(now);
          const old = this.db.prepare('SELECT * FROM core_operations WHERE viewer = ? AND id = ?').get(who, id) as { name: string; input_hash: string; result: string } | undefined;
          if (old) return old.name === name && old.input_hash === body ? JSON.parse(old.result) as Result : failure('conflict', 'Operation id already used for different input');
        }
        const ctx: Context = { db: this.db, viewer, now, window, ...(op.write ? { receipt: { viewer: who, id: id!, name, inputHash: body, expires: now + 30 * 86400_000 } } : {}), changed: (type, id) => { changes.push({ type, id }); } };
        let recovered: RecoveredWrite | undefined;
        if (op.write) for (const recover of this.recoveries) {
          recovered = recover(ctx);
          if (recovered) break;
        }
        if (!recovered && !op.may(viewer, parsed.data, this.db)) return failure('denied', 'Permission denied');
        if (preflight && !recovered) {
          const admitted: unknown = op.admit?.(ctx, parsed.data);
          if (admitted instanceof Promise) { void admitted.catch(() => {}); throw new Error('Admission must be synchronous'); }
          if (changes.length) throw new Error('Admission cannot publish changes');
          return new PreparationNeeded(ctx.receipt && Object.freeze({...ctx.receipt}));
        }
        const outcome = recovered ?? op.run(ctx, parsed.data, prepared);
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
    if (result instanceof PreparationNeeded) return result;
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
    if (result.ok) { try { op.after?.(parsed.data, result); } catch { /* durable jobs resume on restart */ } }
    return result;
  }
}
