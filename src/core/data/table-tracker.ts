import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';

/** Which tables of the shared database a commit wrote, or `unknown`: anything could have changed, so every open
 * selection must be read again. Over-reporting is allowed (a write later rolled back still counts); reporting
 * fewer tables than were written is not. With LOOM_LIVE_SCOPE=on (./live-scope.ts) open selections that read none
 * of these tables are not read again (./live.ts). */
export type WrittenTables = ReadonlySet<string> | 'unknown';

/** What one live reading read: the tables its SQL opened on the shared connection, and the reasons, if any, that
 * its answer may depend on something those tables do not cover (the clock, another database file, in-process
 * state). A reading with any such reason is unscoped: every commit wakes it. */
export interface ReadRecord {
  tables: Set<string>;
  unscoped: Set<string>;
  /** How many statements of a tracked connection it ran. None means there is nothing to scope it by. */
  statements: number;
}

/** What one statement does to the shared database, from its EXPLAIN program. */
interface Shape {
  reads: readonly string[];
  writes: readonly string[];
  /** Set when the statement's tables cannot be known: it is unscoped as a read and `unknown` as a write. */
  unknown?: string;
  /** Set when its answer can change with nothing written (random(), changes(), a function not marked deterministic). */
  unscopedRead?: string;
  /** Calls a date or time function, which reads the clock when an argument is 'now'. */
  dateFunctions?: boolean;
  /** May change the schema; the schema version is read again after it runs. */
  schema?: boolean;
}
interface Capture { tables: Set<string>; unknown?: string }

const DATE_FUNCTIONS = new Set(['date', 'time', 'datetime', 'julianday', 'unixepoch', 'strftime', 'timediff']);
const TRANSACTION_CONTROL = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const DATA_STATEMENTS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH', 'VALUES']);
const SCHEMA_OPCODES = new Set(['CreateBtree', 'Destroy', 'ParseSchema', 'SetCookie', 'DropTable', 'DropIndex', 'DropTrigger', 'VCreate', 'VDestroy', 'LoadAnalysis', 'Vacuum', 'IntegrityCk']);
const VIRTUAL_OPCODES = new Set(['VOpen', 'VFilter', 'VUpdate', 'VBegin', 'VColumn', 'VNext', 'VRename', 'VCheck', 'VInitIn']);
const OPEN_READ = new Set(['OpenRead', 'ReopenIdx']);
const FUNCTION_OPCODES = new Set(['Function', 'PureFunc', 'AggStep', 'AggStep1', 'AggInverse', 'AggValue', 'AggFinal']);
const DETERMINISTIC = 0x800;
// The statements the tracker itself runs on the connection it watches, besides the EXPLAIN of each new SQL text.
const SCHEMA_VERSION_SQL = 'PRAGMA schema_version';
const DATA_VERSION_SQL = 'PRAGMA data_version';
const SCHEMA_ROWS_SQL = 'SELECT type, name, tbl_name AS tableName, rootpage FROM main.sqlite_schema WHERE rootpage > 0';
const FUNCTION_ROWS_SQL = 'SELECT name, type, flags FROM pragma_function_list';
const OWN_SQL = new Set([SCHEMA_VERSION_SQL, DATA_VERSION_SQL, SCHEMA_ROWS_SQL, FUNCTION_ROWS_SQL]);

const recorder = new AsyncLocalStorage<ReadRecord>();
const trackers = new WeakMap<object, TableTracker>();
const statements = new WeakMap<object, { tracker: TableTracker; generation: number; shape: Shape }>();
// The tracker's own reads of the schema and the EXPLAIN programs it reads must not observe themselves.
let quiet = 0;
type Method = (this: Database.Statement, ...args: unknown[]) => unknown;
let original: Record<'run' | 'get' | 'all' | 'iterate', Method> | undefined;

/** Run one live reading, collecting what it read. The record is complete when `read`'s value has settled. */
export function recordReads<T>(read: () => T): { record: ReadRecord; value: T } {
  const record: ReadRecord = { tables: new Set(), unscoped: new Set(), statements: 0 };
  return { record, value: recorder.run(record, read) };
}
/** Say that the reading under way depends on something no table of the shared database holds. Free outside one. */
export function markUnscoped(reason: string): void { recorder.getStore()?.unscoped.add(reason); }
export function readingUnderWay(): boolean { return recorder.getStore() !== undefined; }

/** Whether a statement seen by better-sqlite3's `verbose` hook is one the tracker ran itself: its schema and data
 * version pragmas, its reads of sqlite_schema and pragma_function_list, or the EXPLAIN of a statement it was
 * classifying (`EXPLAIN ` and a data statement: SELECT, INSERT, UPDATE, DELETE, REPLACE, WITH or VALUES, so
 * `EXPLAIN QUERY PLAN` is not one). A test that counts a connection's statements leaves these out, so the count
 * means the same with LOOM_LIVE_SCOPE=shadow as without. */
export function trackerStatement(sql: string): boolean {
  if (OWN_SQL.has(sql)) return true;
  if (!/^EXPLAIN\s/.test(sql)) return false;
  return DATA_STATEMENTS.has(keyword(sql.slice('EXPLAIN'.length)));
}

/** The tracker installed on this connection, if any. */
export function tableTracker(client: Database.Database): TableTracker | undefined { return trackers.get(client); }

/** Install the tracker on the shared connection, once: the same tracker for a second call. It wraps the
 * connection's prepare and exec and, once in the process, the run/get/all/iterate of better-sqlite3's statements,
 * so statements prepared before it was installed (or by better-sqlite3 itself, as transactions and pragmas are)
 * are seen too. A statement of a connection with no tracker counts as another database to a reading under way. */
export function installTableTracker(client: Database.Database): TableTracker {
  let tracker = trackers.get(client);
  if (!tracker) { tracker = new TableTracker(client); trackers.set(client, tracker); }
  return tracker;
}

function patchStatements(sample: Database.Statement) {
  if (original) return;
  const prototype = Object.getPrototypeOf(sample) as Record<string, Method>;
  original = { run: prototype.run!, get: prototype.get!, all: prototype.all!, iterate: prototype.iterate! };
  for (const name of ['run', 'get', 'all', 'iterate'] as const) {
    const call = original[name];
    prototype[name] = function (this: Database.Statement, ...args: unknown[]) {
      if (quiet) return call.apply(this, args);
      const entry = observe(this, args);
      if (!entry?.shape.schema) return call.apply(this, args);
      try { return call.apply(this, args); } finally { entry.tracker.checkSchema(); }
    };
  }
}

function observe(statement: Database.Statement, args: unknown[]) {
  let entry = statements.get(statement);
  if (!entry || entry.generation !== entry.tracker.generation) {
    const tracker = trackers.get(statement.database);
    if (!tracker) { markUnscoped('another database'); return undefined; }
    entry = { tracker, generation: tracker.generation, shape: tracker.shape(statement.source) };
    statements.set(statement, entry);
  }
  const { shape, tracker } = entry;
  const record = recorder.getStore();
  if (record) {
    record.statements++;
    if (shape.unknown) record.unscoped.add(shape.unknown);
    else {
      for (const table of shape.reads) record.tables.add(table);
      if (shape.unscopedRead) record.unscoped.add(shape.unscopedRead);
      if (shape.dateFunctions && mentionsNow(args)) record.unscoped.add('the clock (now)');
    }
  }
  if (shape.unknown || shape.writes.length) {
    for (const capture of tracker.writing()) {
      if (shape.unknown) capture.unknown ??= shape.unknown;
      for (const table of shape.writes) capture.tables.add(table);
    }
  }
  return entry;
}

function mentionsNow(args: unknown[]): boolean {
  for (const arg of args) {
    if (typeof arg === 'string') { if (arg.trim().toLowerCase() === 'now') return true; }
    else if (Array.isArray(arg)) { if (mentionsNow(arg)) return true; }
    else if (arg && typeof arg === 'object' && !ArrayBuffer.isView(arg)) { if (mentionsNow(Object.values(arg))) return true; }
  }
  return false;
}

/** The first keyword of a statement, past whitespace and comments. */
function keyword(sql: string): string {
  let at = 0;
  for (;;) {
    while (at < sql.length && /\s/.test(sql[at]!)) at++;
    if (sql.startsWith('--', at)) { const end = sql.indexOf('\n', at); at = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', at)) { const end = sql.indexOf('*/', at + 2); at = end < 0 ? sql.length : end + 2; continue; }
    break;
  }
  return /^[A-Za-z]+/.exec(sql.slice(at))?.[0]?.toUpperCase() ?? '';
}

export class TableTracker {
  /** Bumped when the schema changes; every classification made before it is made again. */
  generation = 0;
  /** Open write captures, outermost first. Every write of the connection is added to each. */
  readonly captures: Capture[] = [];
  /** What the connection wrote while no capture was open: a write that did not go through DataWrites.run, or that
   * told nobody. The next capture to begin starts with it, so it is told with the next commit, as it always was
   * when every commit woke every selection, and never lost. */
  private loose: Capture = { tables: new Set() };
  /** Where a write made now is collected. */
  writing(): readonly Capture[] { return this.captures.length ? this.captures : [this.loose]; }
  private shapes = new Map<string, Shape>();
  private roots = new Map<number, string>();
  private functions = new Map<string, boolean>();
  private readonly schemaVersion: Database.Statement;
  private readonly dataVersion: Database.Statement;
  private readonly schemaRows: Database.Statement;
  private readonly functionRows: Database.Statement;
  // Read first when first needed, so installing runs no statement.
  private lastSchema: number | undefined;
  private lastData: number | undefined;

  constructor(private readonly client: Database.Database) {
    const prepare = client.prepare.bind(client), exec = client.exec.bind(client), fn = client.function.bind(client);
    this.schemaVersion = prepare(SCHEMA_VERSION_SQL).pluck();
    this.dataVersion = prepare(DATA_VERSION_SQL).pluck();
    this.schemaRows = prepare(SCHEMA_ROWS_SQL);
    this.functionRows = prepare(FUNCTION_ROWS_SQL);
    patchStatements(this.schemaVersion);
    const tracker = this;
    client.prepare = function (this: Database.Database, source: string) {
      const statement = prepare(source);
      tracker.checkSchema();
      statements.set(statement, { tracker, generation: tracker.generation, shape: tracker.shape(source) });
      return statement;
    } as typeof client.prepare;
    // Whatever a script does, its tables are not known: unscoped to a reading, `unknown` to a write.
    client.exec = function (this: Database.Database, source: string) {
      markUnscoped('exec');
      for (const capture of tracker.writing()) capture.unknown ??= 'exec';
      try { return exec(source); } finally { tracker.checkSchema(); }
    } as typeof client.exec;
    client.function = function (this: Database.Database, ...args: unknown[]) {
      try { return (fn as (...a: unknown[]) => Database.Database)(...args); } finally { tracker.functions.clear(); tracker.clear(); }
    } as typeof client.function;
  }

  private quietly<T>(read: () => T): T { quiet++; try { return read(); } finally { quiet--; } }

  /** Read the schema version; when it moved, forget every classification. */
  checkSchema(): void {
    const version = this.quietly(() => this.schemaVersion.get() as number);
    if (version !== this.lastSchema) { this.lastSchema = version; this.clear(); }
  }
  /** Forget every classification. Reading sqlite_schema with a prepared statement also makes SQLite load the new
   * schema into this connection: EXPLAIN compiles against the schema the connection holds, which after another
   * connection's DDL is the old one until a statement steps and finds the schema cookie moved. */
  private clear() { this.generation++; this.shapes.clear(); this.loadRoots(); }

  /** Collect what the connection writes from now until `end`. Captures nest; each sees every write. */
  begin(): Capture {
    this.checkSchema();
    // Writes by others before the first capture woke nobody, as they never have; from here on they make it unknown.
    if (this.lastData === undefined) this.lastData = this.quietly(() => this.dataVersion.get() as number);
    let capture: Capture = { tables: new Set() };
    if (!this.captures.length) { capture = this.loose; this.loose = { tables: new Set() }; }
    this.captures.push(capture);
    return capture;
  }
  /** What the capture saw. `unknown` also when another connection or process wrote the file since the last capture
   * ended: SQLite's data_version moves only for others' commits. */
  end(capture: Capture): WrittenTables {
    const at = this.captures.lastIndexOf(capture);
    if (at >= 0) this.captures.splice(at, 1);
    const data = this.quietly(() => this.dataVersion.get() as number);
    if (data !== this.lastData) { this.lastData = data; capture.unknown ??= 'another connection wrote'; }
    return capture.unknown ? 'unknown' : capture.tables;
  }
  /** Run `write` and say what it wrote. For writes that do not go through DataWrites.run. */
  capture<T>(write: () => T): { value: T; written: WrittenTables } {
    const capture = this.begin();
    let value: T;
    try { value = write(); } catch (error) { this.end(capture); throw error; }
    return { value, written: this.end(capture) };
  }

  /** The tables a statement reads and writes, from its EXPLAIN program. Cached by SQL text until the schema changes. */
  shape(source: string): Shape {
    let shape = this.shapes.get(source);
    if (!shape) {
      if (this.lastSchema === undefined) this.checkSchema();
      shape = this.classify(source); this.shapes.set(source, shape);
    }
    return shape;
  }

  private classify(source: string): Shape {
    const word = keyword(source);
    if (TRANSACTION_CONTROL.has(word)) return { reads: [], writes: [] };
    if (!DATA_STATEMENTS.has(word)) return { reads: [], writes: [], unknown: `statement ${word || '(empty)'}`, schema: true };
    let program: { opcode: string; p1: number; p2: number; p3: number; p4: unknown }[];
    try { program = this.quietly(() => (this.client as unknown as { explain(sql: string): unknown }).explain(source) as typeof program); }
    catch { return { reads: [], writes: [], unknown: 'unexplained statement', schema: true }; }
    const reads = new Set<string>(), writes = new Set<string>();
    let unknown: string | undefined, unscopedRead: string | undefined, dates = false, now = false, schema = false;
    const table = (database: number, root: number): string | undefined => {
      if (database !== 0) { unknown ??= database === 1 ? 'the temp database' : 'an attached database'; return undefined; }
      if (root === 1) { unknown ??= 'sqlite_schema'; return undefined; }
      let name = this.roots.get(root);
      if (name === undefined) { this.loadRoots(); name = this.roots.get(root); }
      if (name === undefined) unknown ??= `root page ${root}`;
      return name;
    };
    for (const op of program) {
      if (OPEN_READ.has(op.opcode)) { const name = table(op.p3, op.p2); if (name) reads.add(name); }
      else if (op.opcode === 'OpenWrite') { const name = table(op.p3, op.p2); if (name) writes.add(name); }
      else if (op.opcode === 'Clear') { const name = table(op.p2, op.p1); if (name) writes.add(name); }
      else if (VIRTUAL_OPCODES.has(op.opcode)) unknown ??= 'a virtual table';
      else if (SCHEMA_OPCODES.has(op.opcode)) { unknown ??= `schema (${op.opcode})`; schema = true; }
      else if (op.opcode === 'String8' && typeof op.p4 === 'string' && op.p4.trim().toLowerCase() === 'now') now = true;
      else if (FUNCTION_OPCODES.has(op.opcode) && typeof op.p4 === 'string') {
        const name = op.p4.replace(/\(.*$/, '').toLowerCase();
        if (DATE_FUNCTIONS.has(name)) dates = true;
        else if (!this.deterministic(name)) unscopedRead ??= `function ${name}()`;
      }
    }
    if (dates && now) unscopedRead ??= 'the clock (now)';
    return { reads: [...reads], writes: [...writes], ...(unknown ? { unknown } : {}), ...(unscopedRead ? { unscopedRead } : {}), ...(dates ? { dateFunctions: true } : {}), ...(schema ? { schema } : {}) };
  }

  private loadRoots() {
    this.roots.clear();
    const rows = this.quietly(() => this.schemaRows.all() as { type: string; name: string; tableName: string; rootpage: number }[]);
    for (const row of rows) this.roots.set(row.rootpage, row.tableName);
  }
  /** A function is deterministic only when every form of it registered under that name says so. Aggregate and
   * window functions (count, sum, max …) are not flagged, but depend only on the rows they are given. */
  private deterministic(name: string): boolean {
    if (!this.functions.size) {
      const rows = this.quietly(() => this.functionRows.all() as { name: string; type: string; flags: number }[]);
      for (const row of rows) {
        const key = row.name.toLowerCase();
        this.functions.set(key, (this.functions.get(key) ?? true) && (row.type === 'w' || row.type === 'a' || (row.flags & DETERMINISTIC) !== 0));
      }
    }
    return this.functions.get(name) ?? false;
  }
}
