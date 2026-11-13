/** Offline migration extension point. Never imported by the daemon. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Db } from '../core/index.js';
import type { SnapshotManifest } from './migration-snapshot.js';
import { openSnapshotSqlite } from './migration-sqlite.js';
import { importHousehold } from './household-importer.js';
import { importTasks } from '../pieces/tasks/importer.js';
import { importAttention, type ImportScopes } from '../pieces/attention/importer.js';
import { importClock } from '../pieces/clock/importer.js';
import { importApprovals } from '../pieces/approvals/importer.js';
import { importComms } from '../pieces/comms/importer.js';
import { publishMigrationCommsKey } from './migration-comms-key.js';
import { importSecrets } from '../pieces/secrets/importer.js';
import type { SecretImportOptions } from '../pieces/secrets/import-source.js';
import { importChanges } from '../pieces/changes/importer.js';

export interface MigrationContext {
  db: Db;
  home: string;
  now: number;
  snapshot: { root: string; manifest: SnapshotManifest };
}
/** Paths are relative to the validated snapshot root; options are editable plan data. */
export interface MigrationInput<Options = unknown> {
  paths: string[];
  options: Options;
}
export interface MigrationImporter<Options = unknown> {
  name: string;
  /** Required registrations, ordered before this importer. */
  dependencies: readonly string[];
  /** Human-readable inventory of old snapshot data consumed. */
  reads: readonly string[];
  /** Machine-readable file globs relative to the old home (tasks is external). */
  sourceReads?: readonly string[];
  /** Caller holds stopped-home lock through settlement. Importer owns its transaction and comparisons. */
  run(context: MigrationContext, input: MigrationInput<Options>): unknown;
}

/** Resolve only existing snapshot inputs, including directories containing old stores. */
export function snapshotPath(context: Pick<MigrationContext, 'snapshot'>, path: string): string {
  if (!path || isAbsolute(path)) throw Error('Snapshot input must be relative');
  const root = realpathSync(context.snapshot.root);
  const target = realpathSync(resolve(root, path));
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw Error('Snapshot input escapes root');
  const checkTree = (entry: string): void => {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) throw Error('Snapshot input contains a symlink');
    if (stat.isDirectory()) for (const name of readdirSync(entry)) checkTree(resolve(entry, name));
    else if (!stat.isFile()) throw Error('Snapshot input contains a special file');
  };
  checkTree(target);
  return target;
}

export class MigrationRegistry {
  // Heterogeneous option types are erased only inside the registry; register retains each adapter type.
  private readonly entries = new Map<string, MigrationImporter<any>>();
  register<Options>(importer: MigrationImporter<Options>): void {
    if (!/^[a-z][a-z0-9-]*$/.test(importer.name) || this.entries.has(importer.name)) throw Error('Invalid or duplicate importer name');
    this.entries.set(importer.name, importer);
  }
  /** Unknown requested pieces are reported, never silently treated as imported. */
  // The returned entries retain their own typed run closures; callers validate plan options per importer.
  order(requested: readonly string[] = [...this.entries.keys()]): { importers: MigrationImporter<any>[]; missing: string[]; blocked: string[] } {
    const importers: MigrationImporter<any>[] = [], missing = new Set<string>();
    const visiting = new Set<string>(), done = new Set<string>(), blocked = new Set<string>();
    const rank = new Map([...this.entries.keys()].map((name, index) => [name, index]));
    const sorted = (names: readonly string[]) => [...names].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || a.localeCompare(b));
    const visit = (name: string): boolean => {
      if (done.has(name)) return !blocked.has(name);
      if (visiting.has(name)) throw Error('Migration dependency cycle');
      const entry = this.entries.get(name);
      if (!entry) { missing.add(name); return false; }
      visiting.add(name);
      let available = true;
      for (const dependency of sorted(entry.dependencies)) if (!visit(dependency)) available = false;
      visiting.delete(name); done.add(name);
      if (available) importers.push(entry); else blocked.add(name);
      return available;
    };
    for (const name of sorted(requested)) visit(name);
    // Same heterogeneous type erasure as entries: each registration owns its option validation.
    const ordered: MigrationImporter<any>[] = [];
    const pending = new Map(importers.map(entry => [entry.name, entry]));
    while (pending.size) {
      const next = sorted([...pending.keys()]).map(name => pending.get(name)!).find(entry => entry.dependencies.every(name => !pending.has(name)));
      if (!next) throw Error('Migration dependency cycle');
      ordered.push(next); pending.delete(next.name);
    }
    return { importers: ordered, missing: [...missing].sort(), blocked: [...blocked].sort() };
  }
}

function single(context: MigrationContext, input: MigrationInput): string {
  if (input.paths.length !== 1) throw Error('Importer requires exactly one snapshot input');
  return snapshotPath(context, input.paths[0]);
}

export function createMigrationRegistry(): MigrationRegistry {
  const registry = new MigrationRegistry();
  registry.register({ name: 'household', dependencies: [], reads: ['home/ (household metadata, identity files and keys)'],
    sourceReads: ['household.json', 'tokens.json', 'tokens.used.json', 'ui-sessions.json', 'ui-cookie.key', 'pieces/*/settings.json'],
    run: (context, input) => importHousehold(context.db, context.home, single(context, input), context.now) });
  registry.register<Parameters<typeof importTasks>[3]>({ name: 'tasks', dependencies: ['household'], reads: ['tasks/store.db'],
    run: (context, input) => importTasks(context.db, single(context, input), context.now, input.options, openSnapshotSqlite) });
  registry.register<ImportScopes>({ name: 'attention', dependencies: ['household'], reads: ['home/**/memories.db (conversation tables)'], sourceReads: ['**/memories.db'],
    run: (context, input) => importAttention(context.db, input.paths.map(path => snapshotPath(context, path)), input.options, {}, openSnapshotSqlite) });
  registry.register({ name: 'clock', dependencies: ['household'], reads: ['home/<old WAKE_DATA>/'], sourceReads: ['**/lanes.json', '**/fire', ...['spool.jsonl', 'schedules.json', 'paused', 'wake.log', 'filed.json', 'sessions.json', 'vouch.json', 'places.json'].map(name => `**/*/${name}`)],
    run: (context, input) => importClock(context.db, single(context, input), context.now) });
  registry.register<Parameters<typeof importApprovals>[3]>({ name: 'approvals', dependencies: ['household'], reads: ['home/<old approvals directory>/'], sourceReads: ['**/approvals.json', '**/rules.json', '**/audit.jsonl'],
    run: (context, input) => importApprovals(context.db, single(context, input), context.now, input.options) });
  registry.register<Parameters<typeof importChanges>[2]>({ name: 'changes', dependencies: ['household'], reads: ['home/<Changes snapshot JSON>'], sourceReads: ['**/changes.json', '**/changes/*.json'],
    run: (context, input) => importChanges(context.db, single(context, input), input.options) });
  registry.register({ name: 'comms', dependencies: ['household'], reads: ['home/**/{comms.db,household.db,comms.key,comms.salt}'],
    sourceReads: ['**/comms.db', '**/household.db', '**/comms.key', '**/comms.salt'],
    run: async (context, input) => {
      // Plan preparation requires the complete co-located input set; resolve every file.
      const paths = input.paths.map(path => snapshotPath(context, path));
      const source = dirname(paths.find(path => path.endsWith('/comms.db'))!);
      publishMigrationCommsKey(paths.find(path => path === join(source, 'comms.key'))!, context.home);
      return importComms(context.db, source, context.home, {}, openSnapshotSqlite);
    } });
  registry.register<SecretImportOptions>({ name: 'secrets', dependencies: ['household'], reads: ['home/<secrets directory>/{store.sops.json,policy.json,requests.json,audit.jsonl}'],
    sourceReads: ['**/store.sops.json','**/policy.json','**/requests.json','**/audit.jsonl'],
    run: (context,input) => importSecrets(context.db,context.home,single(context,input),context.now,input.options) });
  return registry;
}
