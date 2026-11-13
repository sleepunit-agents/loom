/** Offline coordinator: no daemon composition, subprocesses or live legacy paths. */
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { acquireHttpLock } from '../transport/http-lock.js';
import { createFoundation } from '../core/app.js';
import { SharingDatabase } from '../core/household/sharing.js';
import { createMigrationRegistry, type MigrationRegistry } from './migration-registry.js';
import { canonicalPlanValue, migrationPlanChecksum, prepareMigrationPlan, supportedMigrationImporters, type MigrationPlan } from './migration-plan.js';
import type { IOStreams } from './io.js';

const receiptName = '.migration-all.json', pendingName = '.migration-all.pending';
const receiptSchema = z.object({ version: z.literal(1), checksum: z.string().regex(/^[a-f0-9]{64}$/), plan: z.unknown(), now: z.number().int().nonnegative(), completed: z.array(z.string()).refine(v => new Set(v).size === v.length) }).strict();
type Receipt = { version: 1; checksum: string; plan: MigrationPlan; now: number; completed: string[] };
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return join(canonical(dirname(resolve(path))), basename(path));
  }
}
const inode = (path: string) => { const s = lstatSync(path); return `${s.dev}:${s.ino}`; };
function ancestors(path: string): string[] {
  const paths: string[] = [];
  for (;;) {
    try { lstatSync(path); paths.push(path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const parent = dirname(path); if (parent === path) return paths; path = parent;
  }
}
/** Refuse inode aliases as well as canonical ancestry before even the lock DB opens. */
export function separateDestination(root: string, home: string, plan: MigrationPlan): string[] {
  // Check lexical components too: realpath alone hides non-overlapping symlink aliases.
  for (const component of ancestors(resolve(home))) if (lstatSync(component).isSymbolicLink()) throw Error('Symlink destination');
  const source = canonical(root), target = canonical(home);
  if (source === target || source.startsWith(target + '/') || target.startsWith(source + '/') || target === '/') throw Error('Overlapping destination');
  const linked: string[] = [];
  const walk = (path: string, found: Set<string>, destination: boolean): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error('Unsafe destination or snapshot entry');
    if (stat.isFile() && stat.nlink !== 1) {
      if (!destination) throw Error('Hard-linked input');
      linked.push(path);
    }
    found.add(inode(path));
    if (stat.isDirectory()) for (const child of readdirSync(path)) walk(join(path, child), found, destination);
  };
  const sources = new Set<string>(), targets = new Set<string>();
  walk(source, sources, false);
  if (existsSync(target)) walk(target, targets, true);
  if ([...targets].some(id => sources.has(id)) || ancestors(target).some(p => sources.has(inode(p))) || ancestors(source).some(p => targets.has(inode(p)))) throw Error('Aliased destination');
  if (!linked.length) return [];
  // Durable key publishers may die after linking a complete file. Accept only
  // the exact root pair(s), identical to the corresponding verified snapshot key.
  if (!readReceipt(target, plan)) throw Error('Hard-linked destination');
  const remaining = new Set(linked), leftovers: string[] = [];
  for (const name of ['ui-cookie.key', 'comms.key']) {
    const key = join(target, name);
    if (!remaining.has(key)) continue;
    const pattern = name === 'ui-cookie.key' ? /^\.ui-cookie\.key-import-[0-9a-f-]{36}$/ : /^\.comms\.key-import-[0-9a-f-]{36}$/;
    const temps = [...remaining].filter(path => dirname(path) === target && pattern.test(basename(path)));
    if (temps.length !== 1 || inode(temps[0]) !== inode(key) || lstatSync(key).nlink !== 2 || !readFileSync(key).equals(readFileSync(join(source, 'home', name)))) throw Error('Hard-linked destination');
    remaining.delete(key); remaining.delete(temps[0]); leftovers.push(temps[0]);
  }
  if (remaining.size) throw Error('Hard-linked destination');
  return leftovers;
}
export function readReceipt(home: string, plan: MigrationPlan): Receipt | undefined {
  const path = join(home, receiptName);
  if (!existsSync(path)) {
    // A killed lock acquisition or first receipt publication can leave only these files.
    const allowed = new Set(['http-daemon-lock.db', 'http-daemon-lock.db-journal', pendingName]);
    if (existsSync(home) && readdirSync(home).some(name => !allowed.has(name))) throw Error('Destination is not a fresh migration home');
    return;
  }
  const raw = receiptSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (raw.checksum !== migrationPlanChecksum(plan) || canonicalPlanValue(raw.plan) !== canonicalPlanValue(plan) || raw.completed.some(name => !Object.hasOwn(plan.importers, name))) throw Error('Destination belongs to another migration');
  return { ...raw, plan };
}
/** Atomic and durable publication; a leftover pending file is never a completion marker. */
type Publication = { sync: typeof fsyncSync; rename: typeof renameSync };
const durablePublication: Publication = { sync: fsyncSync, rename: renameSync };
function saveReceipt(home: string, receipt: Receipt, publication: Publication): void {
  const fd = openSync(join(home, pendingName), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify(receipt) + '\n'); publication.sync(fd); } finally { closeSync(fd); }
  publication.rename(join(home, pendingName), join(home, receiptName));
  const dir = openSync(home, 'r'); try { publication.sync(dir); } finally { closeSync(dir); }
}
export interface MigrationReport { status: 'complete' | 'incomplete'; snapshot: string; plan: string; pieces: { name: string; status: 'imported' | 'completed' }[]; missing: string[]; blocked: string[] }
/** Hooks and alternate registries are internal TypeScript only, never JSON plan options. */
export async function runMigrationAll(snapshot: string, destination: string, supplied?: unknown, controls: { registry?: MigrationRegistry; now?: () => number; afterPiece?: (name: string) => void; publication?: Publication } = {}): Promise<MigrationReport> {
  const prepared = prepareMigrationPlan(snapshot, supplied), home = canonical(destination);
  separateDestination(prepared.root, destination, prepared.plan);
  readReceipt(home, prepared.plan); // No writable destination open until both preflights pass.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const release = acquireHttpLock(home);
  try {
    // Recheck ownership and inputs under the lock before resuming a stopped home.
    const publicationLeftovers = separateDestination(prepared.root, destination, prepared.plan);
    const checked = prepareMigrationPlan(snapshot, prepared.plan);
    const plan = checked.plan, checksum = migrationPlanChecksum(plan);
    const previous = readReceipt(home, plan);
    const receipt = previous ?? { version: 1 as const, checksum, plan, now: (controls.now ?? Date.now)(), completed: [] };
    for (const path of publicationLeftovers) unlinkSync(path);
    chmodSync(home, 0o700);
    if (!previous) saveReceipt(home, receipt, controls.publication ?? durablePublication);
    const ordered = (controls.registry ?? createMigrationRegistry()).order(Object.keys(plan.importers));
    const missing = new Set(ordered.missing), blocked = new Set(ordered.blocked);
    for (const entry of ordered.importers) if (!supportedMigrationImporters.includes(entry.name)) missing.add(entry.name);
    const entries = ordered.importers.filter(entry => {
      if (missing.has(entry.name)) return false;
      if (entry.dependencies.some(name => missing.has(name) || blocked.has(name))) { blocked.add(entry.name); return false; }
      if (!Object.hasOwn(plan.importers, entry.name)) throw Error('Dependency absent from plan');
      return true;
    });
    const report: MigrationReport = { status: missing.size || blocked.size ? 'incomplete' : 'complete', snapshot: plan.snapshot, plan: checksum, pieces: [], missing: [...missing].sort(), blocked: [...blocked].sort() };
    if (entries.every(entry => receipt.completed.includes(entry.name))) {
      report.pieces = entries.map(entry => ({ name: entry.name, status: 'completed' }));
      return report;
    }
    const app = createFoundation({ home });
    try {
      for (const entry of entries) {
        if (receipt.completed.includes(entry.name)) { report.pieces.push({ name: entry.name, status: 'completed' }); continue; }
        const input = plan.importers[entry.name];
        // Changes accepts a callback, but only the coordinator constructs it from the imported household.
        const effective = entry.name === 'changes' ? { ...input, options: () => {
          const sharing = new SharingDatabase(app.db, home);
          return { ...(input.options as object), projects: sharing.projectIds().map(id => {
            const project = sharing.project(id)!;
            return { slug: project.slug, name: project.name, repos: project.repositories };
          }) };
        } } : input;
        await entry.run({ db: app.db, home, now: receipt.now, snapshot: { root: checked.root, manifest: checked.manifest } }, effective);
        // If death lands before this write, the importer's own transaction/receipt makes retry safe.
        controls.afterPiece?.(entry.name);
        receipt.completed.push(entry.name); saveReceipt(home, receipt, controls.publication ?? durablePublication);
        report.pieces.push({ name: entry.name, status: 'imported' });
      }
      return report;
    } finally { app.close(); }
  } finally { release(); }
}
const usage = 'usage: loom migrate all --snapshot <directory> --home <fresh-stopped-home> [--plan <file>]\n       loom migrate plan --snapshot <directory> [--plan <edited-file>]\n';
export async function migrateAll(argv: string[], io: IOStreams, planOnly = false): Promise<number> {
  let args;
  try { args = parseArgs({ args: argv, options: { snapshot: { type: 'string' }, home: { type: 'string' }, plan: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }); }
  catch { io.stderr(`Invalid migration arguments.\n${usage}`); return 2; }
  if (args.values.help) { io.stdout(usage); return 0; }
  if (!args.values.snapshot || (!planOnly && !args.values.home) || (planOnly && args.values.home)) { io.stderr(usage); return 2; }
  try {
    const supplied = args.values.plan ? JSON.parse(readFileSync(args.values.plan, 'utf8')) : undefined;
    if (planOnly) { io.stdout(JSON.stringify(prepareMigrationPlan(args.values.snapshot, supplied).plan, null, 2) + '\n'); return 0; }
    const report = await runMigrationAll(args.values.snapshot, args.values.home!, supplied);
    io.stdout(JSON.stringify(report, null, 2) + '\n');
    return report.status === 'complete' ? 0 : 3;
  } catch { io.stderr('Migration refused; verify snapshot, plan and destination ownership, and stop the destination daemon.\n'); return 1; }
}
