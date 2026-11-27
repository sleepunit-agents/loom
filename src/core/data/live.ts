import { clearReadDeadline } from './read-lease.js';
import { ExecutionDrain } from './execution.js';
import { execute, getOperationAST, parse, validate, type ExecutionArgs, type GraphQLSchema } from 'graphql/index.js';

/** Paths address the selected GraphQL result, including aliases. Values are
 * transport data, never opaque database records. A missing value means remove. */
export interface DataPatch { path: (string | number)[]; value?: unknown }
export interface DataDelta { revision: number; patches: DataPatch[] }

/** Diff only selected fields. Equal rows cost no wire bytes. Arrays are patched
 * by position so queries need not expose a primary key (counts and join tables
 * are valid selections too). Consumers apply patches in the supplied order. */
export function dataDiff(before: unknown, after: unknown, path: (string | number)[] = []): DataPatch[] {
  const patches: DataPatch[] = [];
  function compare(left: unknown, right: unknown, at: (string | number)[]) {
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let i = 0; i < Math.min(left.length, right.length); i++) {
        if (!Object.is(left[i], right[i])) compare(left[i], right[i], [...at, i]);
      }
      for (let i = left.length - 1; i >= right.length; i--) patches.push({ path: [...at, i] });
      for (let i = left.length; i < right.length; i++) patches.push({ path: [...at, i], value: right[i] });
    } else if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
      for (const key of Object.keys(a)) {
        if (!Object.hasOwn(b, key)) patches.push({ path: [...at, key] });
      }
      for (const key of Object.keys(b)) {
        if (!Object.hasOwn(a, key)) patches.push({ path: [...at, key], value: b[key] });
        else if (!Object.is(a[key], b[key])) compare(a[key], b[key], [...at, key]);
      }
    } else {
      patches.push({ path: at, value: right });
    }
  }
  if (!Object.is(before, after)) compare(before, after, path);
  return patches;
}

/** One committed-write signal for the shared database. No polling, per-row
 * resolvers or extra table reads. Composition calls changed() AFTER commit,
 * including changes to sharing facts. Rolled-back writes must not signal.
 * Every rerun uses the generated SQL query and its current visibility policy.
 */
export type MeasureRead = <T>(read: () => T | Promise<T>) => T | Promise<T>;
export class DataLive {
  /** `settleMs`: how soon after one reading of an open selection began the next may begin. Off (0), every commit
   * reads every open selection again, so twenty commits a few milliseconds apart are twenty readings of each. On, a
   * commit that comes alone is still read at once, and commits that come faster than this are read together: once
   * when the time is up, and so always once after the last of them. A selection's first answer never waits. */
  constructor(private readonly measure?: MeasureRead, private readonly settleMs = 0) {}
  private listeners = new Set<() => void>();
  private stopped = false;
  private version = 0;
  private readVersions = new WeakMap<object, number>();
  epoch(): number { return this.version; }
  captureRead(context: unknown): void {
    clearReadDeadline(context);
    if (context && typeof context === 'object') this.readVersions.set(context, this.version);
  }
  readVersion(context: unknown): number | undefined {
    return context && typeof context === 'object' ? this.readVersions.get(context) : undefined;
  }
  currentRead(version: number | undefined): boolean { return !this.stopped && version !== undefined && version === this.version; }
  private executions = new ExecutionDrain();
  private transportSchemas = new WeakMap<() => boolean, WeakMap<GraphQLSchema, GraphQLSchema>>();

  /** Only these receiver-independent transport guards can share wrappers.
   * A standalone watch may use its options object as its active() receiver. */
  transportGuard(active: () => boolean) {
    const guard = () => active();
    this.transportSchemas.set(guard, new WeakMap());
    return guard;
  }

  changed() { this.version++; for (const listener of [...this.listeners]) listener(); }
  /** Wake readers without making an otherwise current read invalidate its own
   * publication. Only for times loom stamps as it is used (a credential's last
   * use, a machine's last report, a timing row): they cannot change who may see
   * what or withdraw private data. The composition calls this rarely
   * (next-data.ts, STAMP_WAKE_MS). Real data and access writes must always use
   * changed(). */
  metadataChanged() { for (const listener of [...this.listeners]) listener(); }
  close() { this.stopped = true; this.changed(); this.listeners.clear(); }

  /** After stopping admission, wait for actual resolvers, including executions
   * whose consumer already cancelled. Cancellation cannot cancel their IO. */
  async drain() { await this.executions.drain(); }

  private async read(args: ExecutionArgs, initial: boolean) {
    if (this.stopped) throw new Error('Live data access ended');
    this.captureRead(args.contextValue);
    const read = () => execute(args);
    return this.executions.run(() => initial && this.measure ? this.measure(read) : read());
  }

  watch(options: {
    schema: GraphQLSchema;
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string;
    /** Trusted executor context; never derive this from query variables. */
    contextValue?: unknown;
    valid(): boolean;
    /** Pure transport lifecycle check; authentication stays at read/release. */
    active?(): boolean;
  }): AsyncIterableIterator<DataDelta> {
    if (this.stopped) throw new Error('Live data access ended');
    const document = parse(options.query);
    const errors = validate(options.schema, document);
    if (errors.length) throw errors[0];
    if (getOperationAST(document, options.operationName)?.operation !== 'query') throw new Error('A live selection must be a query');
    const guard = options.active;
    const cache = guard && this.transportSchemas.get(guard);
    let schema = cache?.get(options.schema);
    if (!schema) {
      const active = cache ? guard : () => options.active?.() ?? true;
      schema = this.executions.schema(options.schema, () => !this.stopped && active());
      cache?.set(options.schema, schema);
    }
    let initial = true;
    let ended = false, dirty = true, previous: unknown, revision = 0, reading = false;
    let wake: (() => void) | undefined;
    const cancelled = Symbol('cancelled');
    let cancel: (() => void) | undefined;
    // When the last reading began, and the way out of the wait for the next one's turn.
    let readAt = -Infinity, hurry: (() => void) | undefined;
    const signal = () => { dirty = true; if (this.stopped) { cancel?.(); hurry?.(); } wake?.(); wake = undefined; };
    const finish = () => { ended = true; cancel?.(); hurry?.(); this.listeners.delete(signal); wake?.(); wake = undefined; };
    // Register before the initial read: a commit cannot fall between the first
    // snapshot and subscription. Slow consumers retain one dirty bit, not an
    // unbounded queue of snapshots or patches against an unsent revision.
    this.listeners.add(signal);
    const next = async (): Promise<IteratorResult<DataDelta>> => {
      if (reading) throw new Error('Concurrent live reads are not supported');
      reading = true;
      try {
        while (!ended) {
          if (this.stopped || !options.valid()) throw new Error('Live data access ended');
          if (!dirty) { await new Promise<void>(resolve => { wake = resolve; }); continue; }
          // The dirty bit stays set while this waits, so nothing committed meanwhile is missed: the reading that
          // follows the wait is of everything committed up to its own start. Ending or closing does not wait.
          const wait = revision > 0 && this.settleMs > 0 ? readAt + this.settleMs - performance.now() : 0;
          if (wait > 0) {
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, wait);
              hurry = () => { clearTimeout(timer); resolve(); };
            });
            hurry = undefined;
            continue;
          }
          dirty = false; readAt = performance.now();
          // Cancellation must release next() even if an async projection never
          // settles. The losing execution stays observed, including rejection.
          const cancellation = new Promise<typeof cancelled>(resolve => { cancel = () => resolve(cancelled); });
          const measure = initial; initial = false;
          const readVersion = this.version;
          const result = await Promise.race([
            this.read({ schema, document, variableValues: options.variables, operationName: options.operationName, contextValue: options.contextValue }, measure),
            cancellation,
          ]);
          cancel = undefined;
          if (ended) break;
          if (this.stopped || result === cancelled) throw new Error('Live data access ended');
          if (!options.valid() || this.stopped) throw new Error('Live data access ended');
          if (result.errors?.length) {
            // Only a committed change makes an error stale. Metadata wakeups
            // must not hide a stable resolver failure.
            if (this.version !== readVersion) continue;
            throw result.errors[0];
          }
          // The generator resolves asynchronously. A commit while execution
          // yielded invalidates that result before any words leave this stream.
          if (dirty) continue;
          const patches = revision === 0 ? [{ path: [], value: result.data }] : dataDiff(previous, result.data);
          previous = result.data;
          if (patches.length) return { done: false, value: { revision: ++revision, patches } };
        }
        return { done: true, value: undefined };
      } catch (error) { finish(); throw error; }
      finally { cancel = undefined; reading = false; }
    };
    return { next, return: async () => { finish(); return { done: true, value: undefined }; }, [Symbol.asyncIterator]() { return this; } };
  }
}
