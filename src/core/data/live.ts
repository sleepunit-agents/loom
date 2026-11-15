import { execute, getOperationAST, parse, validate, type ExecutionArgs, type GraphQLSchema } from 'graphql/index.js';

/** Paths address the selected GraphQL result, including aliases. Values are
 * transport data, never opaque database records. A missing value means remove. */
export interface DataPatch { path: (string | number)[]; value?: unknown }
export interface DataDelta { revision: number; patches: DataPatch[] }

/** Diff only selected fields. Equal rows cost no wire bytes. Arrays are patched
 * by position so queries need not expose a primary key (counts and join tables
 * are valid selections too). Consumers apply patches in the supplied order. */
export function dataDiff(before: unknown, after: unknown, path: (string | number)[] = []): DataPatch[] {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const patches: DataPatch[] = [];
    for (let i = 0; i < Math.min(before.length, after.length); i++) patches.push(...dataDiff(before[i], after[i], [...path, i]));
    for (let i = before.length - 1; i >= after.length; i--) patches.push({ path: [...path, i] });
    for (let i = before.length; i < after.length; i++) patches.push({ path: [...path, i], value: after[i] });
    return patches;
  }
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [
      ...Object.keys(a).filter(key => !Object.hasOwn(b, key)).map(key => ({ path: [...path, key] })),
      ...Object.keys(b).flatMap(key => Object.hasOwn(a, key) ? dataDiff(a[key], b[key], [...path, key]) : [{ path: [...path, key], value: b[key] }]),
    ];
  }
  return [{ path, value: after }];
}

/** One committed-write signal for the shared database. No polling, per-row
 * resolvers or extra table reads. Composition calls changed() AFTER commit,
 * including changes to sharing facts. Rolled-back writes must not signal.
 * Every rerun uses the generated SQL query and its current visibility policy.
 */
export type MeasureRead = <T>(read: () => T | Promise<T>) => T | Promise<T>;
export class DataLive {
  constructor(private readonly measure?: MeasureRead) {}
  private listeners = new Set<() => void>();
  private stopped = false;
  private executions = new Set<Promise<void>>();
  changed() { for (const listener of [...this.listeners]) listener(); }
  close() { this.stopped = true; this.changed(); this.listeners.clear(); }

  /** After stopping admission, wait for actual resolvers, including executions
   * whose consumer already cancelled. Cancellation cannot cancel their IO. */
  async drain() { while (this.executions.size) await Promise.all([...this.executions]); }

  private async read(args: ExecutionArgs, initial: boolean) {
    if (this.stopped) throw new Error('Live data access ended');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    // Retain before invoking user resolvers: they can synchronously reenter close.
    this.executions.add(done);
    try { return await (initial && this.measure ? this.measure(() => execute(args)) : execute(args)); }
    finally { this.executions.delete(done); finish(); }
  }

  watch(options: {
    schema: GraphQLSchema;
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string;
    /** Trusted executor context; never derive this from query variables. */
    contextValue?: unknown;
    valid(): boolean;
  }): AsyncIterableIterator<DataDelta> {
    if (this.stopped) throw new Error('Live data access ended');
    const document = parse(options.query);
    const errors = validate(options.schema, document);
    if (errors.length) throw errors[0];
    if (getOperationAST(document, options.operationName)?.operation !== 'query') throw new Error('A live selection must be a query');
    let initial = true;
    let ended = false, dirty = true, previous: unknown, revision = 0, reading = false;
    let wake: (() => void) | undefined;
    const cancelled = Symbol('cancelled');
    let cancel: (() => void) | undefined;
    const signal = () => { dirty = true; if (this.stopped) cancel?.(); wake?.(); wake = undefined; };
    const finish = () => { ended = true; cancel?.(); this.listeners.delete(signal); wake?.(); wake = undefined; };
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
          dirty = false;
          // Cancellation must release next() even if an async projection never
          // settles. The losing execution stays observed, including rejection.
          const cancellation = new Promise<typeof cancelled>(resolve => { cancel = () => resolve(cancelled); });
          const measure = initial; initial = false;
          const result = await Promise.race([
            this.read({ schema: options.schema, document, variableValues: options.variables, operationName: options.operationName, contextValue: options.contextValue }, measure),
            cancellation,
          ]);
          cancel = undefined;
          if (ended) break;
          if (this.stopped || result === cancelled) throw new Error('Live data access ended');
          if (result.errors?.length) throw result.errors[0];
          if (!options.valid()) throw new Error('Live data access ended');
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
