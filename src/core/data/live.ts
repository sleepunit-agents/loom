import { clearReadDeadline } from './read-lease.js';
import { outsideReadIn } from './outside-read.js';
import { ExecutionDrain } from './execution.js';
import type { LivePace } from './live-pace.js';
import { recordReads, type ReadRecord, type WrittenTables } from './table-tracker.js';
import { describeWritten, reportViolation, type LiveScope, type LiveScopeViolation } from './live-scope.js';
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
   * when the time is up, and so always once after the last of them. A selection's first answer never waits.
   * `relaxedMs`: the same time for a selection opened `relaxed` (./live-pace.ts). It is never shorter than
   * `settleMs`, whatever is given.
   * `scope` (./live-scope.ts): `shadow` records what each reading read and checks, against each answer, whether
   * skipping the readings no written table touched would have been right. It changes no reading. `on` records the
   * same and acts on it: a commit wakes a selection only when it wrote a table the selection's last reading read,
   * or when either side is not known (`wouldSkip`). */
  constructor(private readonly measure?: MeasureRead, private readonly settleMs = 0, relaxedMs = settleMs,
    private readonly scope: LiveScope = 'off', private readonly report: (violation: LiveScopeViolation) => void = reportViolation) { this.relaxedMs = Math.max(settleMs, relaxedMs); }
  private readonly relaxedMs: number;
  private listeners = new Set<(written: WrittenTables) => void>();
  private stopped = false;
  private version = 0;
  private readVersions = new WeakMap<object, number>();
  epoch(): number { return this.version; }
  captureRead(context: unknown): void {
    clearReadDeadline(context);
    if (context && typeof context === 'object') this.readVersions.set(context, this.version);
  }
  /** A reading whose answer is known to hold at the current version (scope `on`: nothing committed since it began
   * wrote what it read). Its read deadline is kept. */
  private current(context: unknown): void {
    if (context && typeof context === 'object' && this.readVersions.has(context)) this.readVersions.set(context, this.version);
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

  /** `written`: the tables the commit wrote (./table-tracker.ts), `unknown` when not known. With scope `on` a
   * selection none of whose tables was written is not read again; otherwise every open selection is. */
  changed(written: WrittenTables = 'unknown') { this.version++; for (const listener of [...this.listeners]) listener(written); }
  /** Wake readers without making an otherwise current read invalidate its own
   * publication. Only for times loom stamps as it is used (a credential's last
   * use, a machine's last report, a timing row): they cannot change who may see
   * what or withdraw private data. The composition calls this rarely
   * (next-data.ts, STAMP_WAKE_MS). Real data and access writes must always use
   * changed(). */
  metadataChanged() { for (const listener of [...this.listeners]) listener('unknown'); }
  close() { this.stopped = true; this.changed(); this.listeners.clear(); }

  /** After stopping admission, wait for actual resolvers, including executions
   * whose consumer already cancelled. Cancellation cannot cancel their IO. */
  async drain() { await this.executions.drain(); }

  private async read(args: ExecutionArgs, initial: boolean, recorded?: (record: ReadRecord) => void) {
    if (this.stopped) throw new Error('Live data access ended');
    this.captureRead(args.contextValue);
    const read = recorded ? () => { const { record, value } = recordReads(() => execute(args)); recorded(record); return value; } : () => execute(args);
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
    /** How often it is read again: `relaxed` waits the longer time between readings. Anything else is eager. */
    pace?: LivePace;
    /** Given the way to ask for this selection now, once, as it opens; what it returns is called as the selection
     * ends. Asked "now", the selection is read again without waiting out a relaxed time, though never sooner
     * than the settle time after its last reading began, and it answers even when nothing changed: with a
     * revision that has no patches, so whoever asked knows the reading was made. */
    refresh?(now: () => void): () => void;
  }): AsyncIterableIterator<DataDelta> {
    if (this.stopped) throw new Error('Live data access ended');
    const document = parse(options.query);
    const errors = validate(options.schema, document);
    if (errors.length) throw errors[0];
    if (getOperationAST(document, options.operationName)?.operation !== 'query') throw new Error('A live selection must be a query');
    const outside = outsideReadIn(options.schema, document);
    if (outside) throw new Error(`A live selection cannot hold ${outside}: it is read from outside loom, once each time it is asked`);
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
    const between = options.pace === 'relaxed' ? this.relaxedMs : this.settleMs;
    // Asked for now, and not yet answered by a reading that began after the asking.
    let asked = false;
    // Shadow and on: what the last accepted reading read. Shadow: what was written since that reading began.
    const shadow = this.scope === 'shadow', scoped = this.scope === 'on', tracking = shadow || scoped;
    let depends: ReadRecord | undefined, written: Set<string> | 'unknown' = new Set();
    const wrote = (tables: WrittenTables) => {
      if (written === 'unknown') return;
      if (tables === 'unknown') written = 'unknown'; else for (const table of tables) written.add(table);
    };
    // On: what was committed while a reading was under way. Its tables are not known until it ends, so these are
    // matched against what it read when it does, and a reading that read any of them is made again.
    let inFlight = false, during: Set<string> | 'unknown' | undefined;
    const meanwhile = (tables: WrittenTables) => {
      if (during === 'unknown') return;
      if (tables === 'unknown') { during = 'unknown'; return; }
      during ??= new Set();
      for (const table of tables) during.add(table);
    };
    const selection = options.operationName ?? options.query.replace(/\s+/g, ' ').trim().slice(0, 160);
    const signal = (tables: WrittenTables) => {
      if (shadow) wrote(tables);
      if (!scoped || this.stopped) dirty = true;
      else if (inFlight) meanwhile(tables);
      // Nothing it read was written: the last answer stands, and it is not read again.
      else if (!dirty && wouldSkip(depends, tables)) return;
      else dirty = true;
      if (this.stopped) { cancel?.(); hurry?.(); }
      wake?.(); wake = undefined;
    };
    const now = () => { if (ended) return; if (shadow) wrote('unknown'); asked = true; dirty = true; hurry?.(); wake?.(); wake = undefined; };
    let forget: (() => void) | undefined;
    const finish = () => { ended = true; cancel?.(); hurry?.(); this.listeners.delete(signal); forget?.(); forget = undefined; wake?.(); wake = undefined; };
    // Register before the initial read: a commit cannot fall between the first
    // snapshot and subscription. Slow consumers retain one dirty bit, not an
    // unbounded queue of snapshots or patches against an unsent revision.
    this.listeners.add(signal);
    forget = options.refresh?.(now);
    const next = async (): Promise<IteratorResult<DataDelta>> => {
      if (reading) throw new Error('Concurrent live reads are not supported');
      reading = true;
      try {
        while (!ended) {
          if (this.stopped || !options.valid()) throw new Error('Live data access ended');
          if (!dirty) { await new Promise<void>(resolve => { wake = resolve; }); continue; }
          // The dirty bit stays set while this waits, so nothing committed meanwhile is missed: the reading that
          // follows the wait is of everything committed up to its own start. Ending or closing does not wait.
          // A selection asked for now waits only the settle time, as an eager one does; it is asked again each time round,
          // so one asked for while it waits out a relaxed time leaves that wait at once.
          const pause = asked ? this.settleMs : between;
          const wait = revision > 0 && pause > 0 ? readAt + pause - performance.now() : 0;
          if (wait > 0) {
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, wait);
              hurry = () => { clearTimeout(timer); resolve(); };
            });
            hurry = undefined;
            continue;
          }
          dirty = false; readAt = performance.now(); inFlight = scoped; during = undefined;
          // Cancellation must release next() even if an async projection never
          // settles. The losing execution stays observed, including rejection.
          const cancellation = new Promise<typeof cancelled>(resolve => { cancel = () => resolve(cancelled); });
          const measure = initial; initial = false;
          const readVersion = this.version;
          // What this reading answers for: everything written since the last accepted reading began. A reading
          // that is not accepted hands it back to the next.
          const since = written, previousDepends = depends;
          let record: ReadRecord | undefined;
          if (shadow) written = new Set();
          const result = await Promise.race([
            this.read({ schema, document, variableValues: options.variables, operationName: options.operationName, contextValue: options.contextValue }, measure, tracking ? found => { record = found; } : undefined),
            cancellation,
          ]);
          // On: a commit while it read makes it stale only if it wrote what this reading read.
          // One that wrote only elsewhere leaves the answer current as of now, and it is published as such: the
          // socket drops (and reconnects for) a frame read at an older version than loom's (./socket.ts).
          if (inFlight) {
            inFlight = false;
            if (during !== undefined) { if (!wouldSkip(record, during)) dirty = true; else this.current(options.contextValue); }
            during = undefined;
          }
          const accepted = () => { if (tracking) depends = record; };
          const rejected = () => { if (shadow) { const later = written; written = since; wrote(later); } };
          cancel = undefined;
          if (ended) break;
          if (this.stopped || result === cancelled) throw new Error('Live data access ended');
          if (!options.valid() || this.stopped) throw new Error('Live data access ended');
          if (result.errors?.length) {
            // Only a committed change makes an error stale. Metadata wakeups
            // must not hide a stable resolver failure.
            if (scoped ? dirty : this.version !== readVersion) { rejected(); continue; }
            throw result.errors[0];
          }
          // The generator resolves asynchronously. A commit while execution
          // yielded invalidates that result before any words leave this stream.
          if (dirty) { rejected(); continue; }
          const patches = revision === 0 ? [{ path: [], value: result.data }] : dataDiff(previous, result.data);
          // Shadow: scoping would have skipped this reading when the last one depended only on tables, and nothing
          // written since touched them. A changed answer means skipping would have been wrong.
          if (shadow && revision > 0 && patches.length && wouldSkip(previousDepends, since)) {
            this.report({ selection, read: [...previousDepends!.tables].sort(), written: describeWritten(since) });
          }
          accepted();
          previous = result.data;
          // Asking sets the dirty bit, so this reading began after the last asking: it is the answer to it.
          const confirm = asked; asked = false;
          if (patches.length || confirm) return { done: false, value: { revision: ++revision, patches } };
        }
        return { done: true, value: undefined };
      } catch (error) { finish(); throw error; }
      finally { cancel = undefined; reading = false; }
    };
    return { next, return: async () => { finish(); return { done: true, value: undefined }; }, [Symbol.asyncIterator]() { return this; } };
  }
}

/** Whether scoping would skip a reading: the last one ran SQL of the tracked connection, all its dependencies are
 * tables, and none of them was written. Anything not known (no record, an unscoped dependency, an unknown write)
 * wakes it. */
export function wouldSkip(depends: ReadRecord | undefined, written: ReadonlySet<string> | 'unknown'): boolean {
  if (!depends || written === 'unknown' || depends.unscoped.size || !depends.statements) return false;
  for (const table of written) if (depends.tables.has(table)) return false;
  return true;
}
