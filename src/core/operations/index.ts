import { internalCaller, isInternalCaller, wasInternalCaller, closeInternalCallers } from '../internal.js';
import { RECEIPT_MS, type OperationReceipt, type ReceiptPersistence } from './receipts.js';
import { invalidateBuiltinServices, unregisterBuiltinServices } from '../services.js';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { Db } from '../db/index.js';
import type { Clock } from '../clock.js';
import type { Viewer } from '../../policy.js';
import type { Measuring, TimingTarget } from '../measuring/index.js';
/** How a call arrived. The /mcp route is not a door of its own: it maps tool names onto 'http' calls (src/shared-mcp.ts). */
export type Door = 'http' | 'socket' | 'direct';
/** A transport supplies this capability only after authenticating its session. */
const signedInWindow = (door: Door, viewer: Viewer, window: boolean) => window && viewer.kind === 'member' && (door === 'socket' || door === 'http');
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
/** The reply for something thrown while an operation ran. An OperationError is the
 * operation's own answer. With `refuses`, a plain Error from the service underneath
 * is one too: its message was written for the caller. Storage errors (they carry a
 * `code`) and anything long or empty stay behind one fixed line. */
function thrown(error: unknown, refuses: boolean | undefined): Failure {
  if (error instanceof OperationError) return failure(error.code, error.message);
  if (refuses && error instanceof Error && !('code' in error) && error.message.length > 0 && error.message.length <= 200) return failure('invalid', error.message);
  return failure('unavailable', 'Operation could not complete');
}
export interface Operation<I = unknown> {
  /** The service this calls refuses bad requests by throwing a plain Error whose
   * message is meant for the caller. Report those as `invalid`, not as an outage. */
  refuses?: boolean;
  /** A retry of a write is answered from its receipt, or from a recovered outside commit, only for a
   * caller who may still make the call: `may` is asked again first. That is the rule for every write and
   * needs no flag. An operation says `false` (or decides per call) only when its own `may` reads state that
   * its write changes, so that asking again would refuse the honest retry of a write that succeeded; it
   * then answers for what a caller who has since lost the right can learn from the stored result. */
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
  /** Validate a matching cached receipt inside the transaction, including any
   * prepared source snapshot. Must not mutate; throw OperationError to refuse. */
  validateReplay?(viewer: Viewer, input: I, prepared?: unknown): void;
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
/** A receipt is kept by who the credential is: its kind and id. What a door wrote on the viewer for the
 * rules to read (the member a body works for) is not part of the key, so a retry still finds its receipt;
 * an operation that must not replay across such a change binds it through inputHash. */
function callerKey(viewer: Viewer): string {
  return (wasInternalCaller(viewer) ? 'internal:' : '') + canonical({ kind: viewer.kind, id: viewer.id });
}
/** Shared connection write boundary supplied only by trusted composition. */
export interface OperationWrites {
  run<T>(operation: () => T): { value: T; notificationErrors: unknown[] };
}
export class Operations {
  // Heterogeneous schemas are erased only at registration; parsing restores each operation's input.
  private frames: Change[][] = [];
  private completedWriteDeadlines = new WeakMap<object,number>();
  private recoveries = new Set<NonNullable<Operation['recover']>>();
  private stopExpiry?: () => void;
  private ops = new Map<string, Operation<any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  private measuring?: Pick<Measuring, 'run' | 'runAsync'>;
  /** The receipt store must be backed by THIS connection, so that an effect and its receipt commit in one
   * transaction. The dispatcher keeps no receipt table of its own. */
  constructor(readonly db: Db, readonly clock: Clock, private committed: (changes: Change[]) => void, private readonly options: { receipts: ReceiptPersistence; writes?: OperationWrites; reportError?: (error: unknown) => void; currentOutside?: (viewer: Viewer, operation:string) => boolean; receiptScope?: (viewer:Viewer)=>string|undefined }) {
    if (options.writes && !options.reportError) throw new Error('Shared writes require an error reporter');
    this.expire();
  }
  private transaction<T>(run: () => T, write: boolean): T {
    if (!write || !this.options.writes) return this.db.transaction(run)();
    const committed = this.options.writes.run(run);
    for (const error of committed.notificationErrors) {
      this.report(error);
    }
    return committed.value;
  }
  private outsideAllowed(door:Door,viewer:Viewer,name:string):boolean {
    return door==='direct'||!this.options.currentOutside||this.options.currentOutside(viewer,name);
  }
  private report(error: unknown): void {
    try { this.options.reportError?.(error); } catch { /* reporting cannot undo a committed effect */ }
  }
  close() { closeInternalCallers(this); this.stopExpiry?.(); unregisterBuiltinServices(this); }
  private expire() {
    this.stopExpiry?.();
    this.expireReceipts(this.clock.now());
    const next = this.options.receipts.nextExpiry();
    this.stopExpiry = next === undefined ? undefined : this.clock.at(next, () => this.expire());
  }
  private expireReceipts(now: number) {
    this.options.receipts.expire(now);
  }
  private receipt(caller: string, id: string): OperationReceipt | undefined {
    return this.options.receipts.get(caller, id);
  }
  private saveReceipt(receipt: OperationReceipt, recovery = false) {
    if (recovery) this.options.receipts.recover(receipt);
    else this.options.receipts.insert(receipt);
  }
  register<I>(op: Operation<I>) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_-]*$/.test(op.name) || this.ops.has(op.name)) throw new Error('invalid or duplicate operation');
    if (op.admit && (!op.write || !op.prepare || !op.recover)) throw new Error('Admission needs a prepared write and global recovery');
    this.ops.set(op.name, op);
    invalidateBuiltinServices(this.db);
    if (op.write && op.recover) this.recoveries.add(op.recover);
  }
  /** Trusted in-process recovery from a piece's durable journal, without the
   * original input. No door exposes this method. The registered recovery hook
   * must bind the complete identity and recheck the original caller's CURRENT
   * authority; neither admission, preparation nor run is invoked here. */
  recoverWrite(viewer: Viewer, receipt: Readonly<WriteReceipt>): Result {
    if (this.invalidInternal('direct', viewer)) return failure('denied', 'Internal caller unavailable');
    if (this.db.inTransaction || this.frames.length) return failure('unavailable', 'Recovery must own the outer transaction');
    const op = this.ops.get(receipt.name);
    if (!op?.write || !op.recover || callerKey(viewer) !== receipt.viewer || !receipt.id || receipt.id.length > 200)
      return failure('unavailable', 'Recovery identity unavailable');
    const changes: Change[] = [];
    this.frames.push(changes);
    let result: Result;
    try {
      result = this.transaction((): Result => {
        const now = this.clock.now();
        const ctx: Context = {db:this.db, viewer, now, receipt, changed:(type,id)=>changes.push({type,id})};
        this.expireReceipts(now);
        const old = this.receipt(receipt.viewer, receipt.id);
        if (old && (old.operation !== receipt.name || old.inputHash !== receipt.inputHash)) throw new OperationError('conflict','Operation id already used for different input');
        let recovered: RecoveredWrite | undefined;
        for (const recover of this.recoveries) {
          const candidate = recover(ctx);
          if (candidate) {
            if (recovered) throw new OperationError('conflict','Multiple recovery receipts');
            recovered = candidate;
          }
        }
        if (!(recovered instanceof RecoveredWrite) || !Number.isFinite(recovered.expires) || recovered.expires <= now || recovered.expires > Math.min(receipt.expires, now + RECEIPT_MS))
          throw new Error('Recovery unavailable');
        const answer: Result = {ok:true,value:op.output.parse(recovered.value ?? null)};
        const serialized = JSON.stringify(answer);
        this.saveReceipt({ caller: receipt.viewer, id: receipt.id, operation: receipt.name, inputHash: receipt.inputHash,
          result: JSON.parse(serialized) as Result, expires: recovered.expires }, true);
        return JSON.parse(serialized) as Result;
      }, true);
    } catch (e) { result = e instanceof OperationError ? failure(e.code,e.message) : failure('unavailable','Recovery could not complete'); }
    finally { this.frames.pop(); }
    if (result.ok) {
      if (changes.length) { try { this.committed(changes); } catch (error) { this.report(error); /* committed recovery remains durable */ } }
      this.expire();
    }
    return result;
  }
  /** Exact completed/replayed result identity, not a later receipt lookup.
   * Metadata only: no payload retention, replay grant or transport field. */
  completedWriteDeadline(result: Result): number | undefined { return this.completedWriteDeadlines.get(result); }
  /** Trusted metadata for local post-call receipts. Never returns input or output. */
  retryDeadline(viewer: Viewer, id: string, name: string): number | undefined {
    this.expireReceipts(this.clock.now());
    const row = this.receipt(callerKey(viewer), id);
    return row?.operation===name && row.expires>this.clock.now() ? row.expires : undefined;
  }
  /** Installed modules use this local handle. No transport exposes it. Labels
   * identify retry receipts; they are never evidence of internal authority. */
  internal(id: string) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid module name');
    const viewer = internalCaller(this, id);
    return {
      viewer,
      call: (name: string, input: unknown, id?: string) => this.call('direct', viewer, name, input, id),
      callAsync: (name: string, input: unknown, id?: string) => this.callAsync('direct', viewer, name, input, id),
    };
  }
  private mayCall(door: Door, viewer: Viewer, op: Operation<any>, input: unknown): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
    return door === 'direct' && isInternalCaller(viewer, this) || op.may(viewer, input, this.db);
  }
  private invalidInternal(door: Door, viewer: Viewer): boolean {
    return wasInternalCaller(viewer) && (door !== 'direct' || !isInternalCaller(viewer, this));
  }
  has(name: string) { return this.ops.has(name); }
  /** Trusted composition only: inventory comes from code registration, never
   * from a caller's requested name. Attach a stable runtime after installation;
   * its owner controls reload and shutdown outside operation transactions. */
  timingTargets(): readonly TimingTarget[] {
    return [...this.ops.keys()].map(name => ({ kind: 'operation', name }));
  }
  measureWith(measuring: Pick<Measuring, 'run' | 'runAsync'> | undefined): void { this.measuring = measuring; }
  offered(door: Door) { return [...this.ops.values()].filter(o => !o.doors || o.doors.includes(door)).map(o => ({ name: o.name, input: o.input, output: o.output, write: !!o.write, cli: o.cli })); }
  callAsync(door: Door, viewer: Viewer, name: string, input: unknown, id?: string, window = false, valid: () => boolean = () => true): Promise<Result> {
    if (!this.measuring || !this.ops.has(name)) return this.dispatchAsync(door, viewer, name, input, id, window, valid);
    return this.measuring.runAsync('operation', name, () => this.dispatchAsync(door, viewer, name, input, id, window, valid));
  }
  private async dispatchAsync(door: Door, viewer: Viewer, name: string, input: unknown, id?: string, window = false, valid: () => boolean = () => true): Promise<Result> {
    if (this.invalidInternal(door, viewer)) return failure('denied', 'Internal caller unavailable');
    if (!valid()) return failure('denied', 'Authentication ended');
    if(!this.outsideAllowed(door,viewer,name))return failure('denied','Permission denied');
    const op = this.ops.get(name);
    if (!op) return failure('not-found', 'Unknown operation');
    if ((op.windowOnly && !signedInWindow(door, viewer, window)) || (op.doors && !op.doors.includes(door))) return failure('denied', 'Operation is not offered on this door');
    if (op.admit && (this.db.inTransaction || this.frames.length)) return failure('unavailable', 'Admission must own the outer transaction');
    if (!op.prepare && !op.windowOnly && !op.requiresWindow && !window) return this.dispatch(door, viewer, name, input, id);
    const parsed = op.input.safeParse(input);
    if (!parsed.success) return failure('invalid', 'Input does not match operation schema');
    if (op.requiresWindow?.(parsed.data, viewer) && !signedInWindow(door, viewer, window)) return failure('denied','A signed-in window is required');
    if (op.write && (!id || id.length > 200)) return failure('invalid', 'A write needs an operation id (1–200 characters)');
    try {
      let receipt: Readonly<WriteReceipt> | undefined;
      if (op.write) {
        const prior = this.execute(door, viewer, name, input, id, undefined, window, true);
        if (!(prior instanceof PreparationNeeded)) return prior;
        receipt = prior.receipt;
      } else if (!this.mayCall(door, viewer, op, parsed.data)) return failure('denied', 'Permission denied');
      if(!valid()||!this.outsideAllowed(door,viewer,name))return failure('denied','Authentication ended');
      const prepared = await op.prepare?.(parsed.data, {viewer, receipt});
      if (!valid()) return failure('denied', 'Authentication ended');
      return this.execute(door, viewer, name, input, id, prepared, window);
    } catch (error) { return thrown(error, op.refuses); }
  }
  call(door: Door, viewer: Viewer, name: string, input: unknown, id?: string): Result {
    if (!this.measuring || !this.ops.has(name)) return this.dispatch(door, viewer, name, input, id);
    return this.measuring.run('operation', name, () => this.dispatch(door, viewer, name, input, id));
  }
  private dispatch(door: Door, viewer: Viewer, name: string, input: unknown, id?: string): Result {
    if (this.ops.get(name)?.prepare) return failure('unavailable', 'Operation requires asynchronous dispatch');
    return this.execute(door, viewer, name, input, id);
  }
  private execute(door: Door, viewer: Viewer, name: string, input: unknown, id?: string, prepared?: unknown, window?: boolean): Result;
  private execute(door: Door, viewer: Viewer, name: string, input: unknown, id: string | undefined, prepared: unknown, window: boolean, preflight: true): Result | PreparationNeeded;
  private execute(door: Door, viewer: Viewer, name: string, input: unknown, id?: string, prepared?: unknown, window = false, preflight = false): Result | PreparationNeeded {
    if (this.invalidInternal(door, viewer)) return failure('denied', 'Internal caller unavailable');
    const op = this.ops.get(name);
    if (!op) return failure('not-found', 'Unknown operation');
    if ((op.windowOnly && !signedInWindow(door, viewer, window)) || (op.doors && !op.doors.includes(door))) return failure('denied', 'Operation is not offered on this door');
    const parsed = op.input.safeParse(input);
    if (!parsed.success) return failure('invalid', 'Input does not match operation schema');
    if (op.requiresWindow?.(parsed.data, viewer) && !signedInWindow(door, viewer, window)) return failure('denied','A signed-in window is required');
    if (op.write && (!id || id.length > 200)) return failure('invalid', 'A write needs an operation id (1–200 characters)');
    const changes: Change[] = [];
    let result: Result | PreparationNeeded;
    if (this.db.inTransaction && !this.frames.length) return failure('unavailable', 'Operations must own the outer transaction');
    this.frames.push(changes);
    try {
      result = this.transaction((): Result | PreparationNeeded => {
        const now = this.clock.now();
        if (!this.outsideAllowed(door,viewer,name)) return failure('denied','Permission denied');
        // Before any receipt or recovered commit is looked at: see recheckPolicy. A read has neither, and is
        // checked once, below.
        const recheck = typeof op.recheckPolicy === 'function' ? op.recheckPolicy(viewer, parsed.data) : op.recheckPolicy !== false;
        if ((op.windowOnly || op.write && recheck) && !this.mayCall(door, viewer, op, parsed.data)) return failure('denied', 'Permission denied');
        const who = callerKey(viewer);
        const fingerprint = op.inputHash ? op.inputHash(canonical(parsed.data), {viewer: who, actor: viewer, input: parsed.data, id, name}) : createHash('sha256').update(canonical(parsed.data)).digest('hex');
        // Keep the canonical principal for existing durable recovery journals.
        // A reused ID from another program/token conflicts before result replay.
        const scope=this.options.receiptScope?.(viewer);
        const body=scope?createHash('sha256').update('loom-program-receipt-v1\0').update(scope).update('\0').update(fingerprint).digest('hex'):fingerprint;
        if (op.write) {
          this.expireReceipts(now);
          const old = this.receipt(who, id!);
          if (old) {
            if (old.operation !== name || old.inputHash !== body) return failure('conflict', 'Operation id already used for different input');
            op.validateReplay?.(viewer, parsed.data, prepared);
            if(!this.outsideAllowed(door,viewer,name))throw new OperationError('denied','Permission denied');
            this.completedWriteDeadlines.set(old.result,old.expires);
            return old.result;
          }
        }
        const ctx: Context = { db: this.db, viewer, now, window, ...(op.write ? { receipt: { viewer: who, id: id!, name, inputHash: body, expires: now + RECEIPT_MS } } : {}), changed: (type, id) => { changes.push({ type, id }); } };
        let recovered: RecoveredWrite | undefined;
        if (op.write) for (const recover of this.recoveries) {
          recovered = recover(ctx);
          if (recovered) break;
        }
        if (!recovered && !this.mayCall(door, viewer, op, parsed.data)) return failure('denied', 'Permission denied');
        if(!this.outsideAllowed(door,viewer,name))throw new OperationError('denied','Permission denied');
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
        if (op.write) this.saveReceipt({ caller: who, id: id!, operation: name, inputHash: body,
          result: JSON.parse(serialized) as Result, expires: replay?.expires ?? now + RECEIPT_MS });
        const completed=JSON.parse(serialized) as Result;
        if(op.write)this.completedWriteDeadlines.set(completed,replay?.expires ?? now + RECEIPT_MS);
        return completed;
      }, !!op.write);
    } catch (e) { result = thrown(e, op.refuses); }
    finally { this.frames.pop(); }
    if (result instanceof PreparationNeeded) return result;
    if (!result.ok && op.rejected) {
      try { this.transaction(() => op.rejected!(viewer, parsed.data, result as Failure, this.clock.now()), true); }
      catch { /* An audit failure cannot turn a refused action into success. */ }
    }
    if (result.ok && changes.length) {
      const parent = this.frames.at(-1);
      if (parent) parent.push(...changes);
      else { try { this.committed(changes); } catch (error) { this.report(error); /* committed writes remain successful */ } }
    }
    if (result.ok && !this.frames.length && op.write) this.expire();
    if (result.ok) { try { op.after?.(parsed.data, result); } catch { /* durable jobs resume on restart */ } }
    return result;
  }
}
