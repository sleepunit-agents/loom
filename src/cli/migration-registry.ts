/** Offline migration extension point. Never imported by the daemon. */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Db } from '../core/index.js';
import type { SnapshotManifest } from './migration-snapshot.js';
import { importHousehold } from './household-importer.js';
import { importTasks } from '../pieces/tasks/importer.js';
import { importAttention, type ImportScopes } from '../pieces/attention/importer.js';
import { importClock } from '../pieces/clock/importer.js';
import { importApprovals } from '../pieces/approvals/importer.js';
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
  /** Caller holds stopped-home lock. Importer owns its transaction and comparisons. */
  run(context: MigrationContext, input: MigrationInput<Options>): unknown;
}

/** Resolve only existing snapshot inputs, including directories containing old stores. */
export function snapshotPath(context: MigrationContext, path: string): string {
  if (!path || isAbsolute(path)) throw Error('Snapshot input must be relative');
  const root = realpathSync(context.snapshot.root);
  const target = realpathSync(resolve(root, path));
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw Error('Snapshot input escapes root');
  return target;
}

export class MigrationRegistry {
  private readonly entries = new Map<string, MigrationImporter<any>>();
  register<Options>(importer: MigrationImporter<Options>): void {
    if (!/^[a-z][a-z0-9-]*$/.test(importer.name) || this.entries.has(importer.name)) throw Error('Invalid or duplicate importer name');
    this.entries.set(importer.name, importer);
  }
  /** Unknown requested pieces are reported, never silently treated as imported. */
  order(requested: readonly string[] = [...this.entries.keys()]): { importers: MigrationImporter<any>[]; missing: string[]; blocked: string[] } {
    const importers: MigrationImporter<any>[] = [], missing = new Set<string>();
    const visiting = new Set<string>(), done = new Set<string>(), blocked = new Set<string>();
    const visit = (name: string): boolean => {
      if (done.has(name)) return !blocked.has(name);
      if (visiting.has(name)) throw Error('Migration dependency cycle');
      const entry = this.entries.get(name);
      if (!entry) { missing.add(name); return false; }
      visiting.add(name);
      let available = true;
      for (const dependency of entry.dependencies) if (!visit(dependency)) available = false;
      visiting.delete(name); done.add(name);
      if (available) importers.push(entry); else blocked.add(name);
      return available;
    };
    for (const name of requested) visit(name);
    return { importers, missing: [...missing].sort(), blocked: [...blocked].sort() };
  }
}

function single(context: MigrationContext, input: MigrationInput): string {
  if (input.paths.length !== 1) throw Error('Importer requires exactly one snapshot input');
  return snapshotPath(context, input.paths[0]);
}

export function createMigrationRegistry(): MigrationRegistry {
  const registry = new MigrationRegistry();
  registry.register({ name: 'household', dependencies: [], reads: ['home/ (household metadata, identity files and keys)'],
    run: (c, i) => importHousehold(c.db, c.home, single(c, i), c.now) });
  registry.register<Parameters<typeof importTasks>[3]>({ name: 'tasks', dependencies: ['household'], reads: ['tasks/store.db'],
    run: (c, i) => importTasks(c.db, single(c, i), c.now, i.options) });
  registry.register<ImportScopes>({ name: 'attention', dependencies: ['household'], reads: ['home/**/memories.db (conversation tables)'],
    run: (c, i) => importAttention(c.db, i.paths.map(path => snapshotPath(c, path)), i.options) });
  registry.register({ name: 'clock', dependencies: ['household'], reads: ['home/<old WAKE_DATA>/'],
    run: (c, i) => importClock(c.db, single(c, i), c.now) });
  registry.register<Parameters<typeof importApprovals>[3]>({ name: 'approvals', dependencies: ['household'], reads: ['home/<old approvals directory>/'],
    run: (c, i) => importApprovals(c.db, single(c, i), c.now, i.options) });
  registry.register<Parameters<typeof importChanges>[2]>({ name: 'changes', dependencies: ['household'], reads: ['home/<Changes snapshot JSON>'],
    run: (c, i) => importChanges(c.db, single(c, i), i.options) });
  return registry;
}
