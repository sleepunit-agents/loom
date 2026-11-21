import {bridgeDocumentLimits,bridgeDocumentPath,readBridgeDocuments} from '../pieces/bridges/import-documents.js';
import { runtimeRepositoryCacheRule } from '../pieces/runtime/import-source.js';
import { copyMigrationFile, fileDigest } from '../core/migration-files.js';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { createMigrationRegistry } from './migration-registry.js';
import { legacyClockAgentFiles } from '../pieces/clock/importer.js';
import type { IOStreams } from './io.js';

export interface SnapshotManifest {
  version: 1;
  consistency: 'per-database';
  skipped?: { path: string; rule: string; bytes: number | null }[];
  followed?: { path: string; realPath: string }[];
  /** Explicit runtime roots remain inventoried even when their directories are empty. */
  runtimeRoots?: ('runtime'|'runtime-data')[];
  files: { path: string; sha256: string; bytes: number; kind: 'sqlite' | 'file' }[];
}

function isSqlite(input: string): boolean {
  if (!lstatSync(input).isFile()) return false;
  const fd = openSync(input, 'r');
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    return header.toString() === 'SQLite format 3\0';
  } finally { closeSync(fd); }
}
/** No installed programs or live handles belong in an importer snapshot. */
const excluded = new Set(['node_modules', '.git', 'run', 'runs', 'current', 'releases', 'versions']);
class SnapshotFailure extends Error {}
const refusal = (path: string, rule: string): never => { throw new SnapshotFailure(`Snapshot refused: ${JSON.stringify(path)}: ${rule}`); };
function guarded<T>(path: string, rule: string, fn: () => T): T {
  try { return fn(); } catch (error) { if (error instanceof SnapshotFailure) throw error; return refusal(path, rule); }
}
/** A retired WAL database in a sealed directory cannot create read-coordination
 * files. Only a checkpointed main file with no sidecars may take this path. */
async function backupDatabase(source: string, temporary: string): Promise<void> {
  const sealed = () => (lstatSync(dirname(source)).mode & 0o222) === 0 &&
    ['-wal','-shm','-journal'].every(suffix => !lstatSync(source + suffix, {throwIfNoEntry:false}));
  if (!sealed()) {
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try { await db.backup(temporary); } finally { db.close(); }
    return;
  }
  const image = temporary + '.source';
  try {
    copyMigrationFile(source, image);
    if (!sealed() || fileDigest(source).sha256 !== fileDigest(image).sha256 || !sealed()) {
      throw Error('Retired database changed during capture');
    }
    const db = new Database(image, {fileMustExist:true});
    try {
      if (db.pragma('integrity_check', {simple:true}) !== 'ok') throw Error('Invalid retired database');
      await db.backup(temporary);
    } finally { db.close(); }
  } finally { rmSync(image, {force:true}); }
}
export function canonicalSnapshotPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalSnapshotPath(dirname(path)), basename(path));
}
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
function destinationPath(to: string): string {
  const target = resolve(to);
  let path = target;
  while (true) {
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') refusal('<destination>', 'destination cannot be inspected');
    }
    if (stat?.isSymbolicLink()) refusal('<destination>', 'destination path contains a symlink; writes must stay in destination');
    if (dirname(path) === path) break;
    path = dirname(path);
  }
  return target;
}
function matches(path: string, pattern: string): boolean {
  const segments = path.split('/'), parts = pattern.split('/');
  const match = (i: number, j: number): boolean => {
    if (j === parts.length) return i === segments.length;
    if (parts[j] === '**') return match(i, j + 1) || (i < segments.length && match(i + 1, j));
    if (i === segments.length) return false;
    const expression = parts[j].split('*').map(p => [...p].map(c => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.includes(c) ? c : `\\${c}`).join('')).join('.*');
    return new RegExp(`^${expression}$`).test(segments[i]) && match(i + 1, j + 1);
  };
  return match(0, 0);
}
/** Files the rebuilt household's offline Memory reader consumes. */
function identityPage(path: string): boolean {
  return /^agents\/[^/]+\/(?:IDENTITY\.md|preferences\.md|self-model\.md|(?:harnesses|models|roles|projects|clients|capabilities|procedures)\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md)$/.test(path);
}
export const noteAttachmentPath = (path: string): boolean =>
  /^agents\/[^/]+\/note-files\/([a-f0-9]{2})\/\1[a-f0-9]{62}$/.test(path);

function householdMemoryFile(path: string): boolean {
  return identityPage(path) || noteAttachmentPath(path) || /^commons\/(knowledge|people)\.db$/.test(path) ||
    /^agents\/[^/]+\/notes\.db$/.test(path);
}
export interface SnapshotInventory {
  consistency: 'per-database';
  copies: { path: string; bytes: number; source: string }[];
  skipped: NonNullable<SnapshotManifest['skipped']>;
  followed: NonNullable<SnapshotManifest['followed']>;
}
/** Inventory only: no SQLite connection, destination creation or source writes. */
export interface SnapshotRoots { clock?: string; wake?: string; approvals?: string; changes?: string; secrets?: string; runtime?: string; 'runtime-data'?: string; bridges?: string[]; 'bridges-document'?: string[] }
export function inventorySnapshot(from: string, to: string, tasks?: string, roots: SnapshotRoots = {}, householdMemory = false): SnapshotInventory {
  let source = guarded('.', 'source home must exist', () => realpathSync(from));
  let prefix = 'home';
  const target = destinationPath(to);
  if (within(target, source) || within(source, target)) refusal('<destination>', 'source and destination must be separate');
  if (existsSync(target)) refusal('<destination>', 'destination already exists');
  const importerPatterns = createMigrationRegistry().order().importers.flatMap(entry => [...(entry.sourceReads ?? [])]);
  let patterns: readonly string[] = [...importerPatterns, '**/*.key', '**/review.pub', '**/keys/**'];
  // Key material stays in files even when no current importer consumes it.
  const inventory: SnapshotInventory = { consistency: 'per-database', copies: [], skipped: [], followed: [] };
  const seen = new Set<string>();
  let rootId = 0;
  const claims = new Map<string, number>();
  const addCopy = (path: string, input: string, bytes: number) => {
    if (claims.has(path) && claims.get(path) !== rootId) refusal('<roots>', 'source roots collide in the snapshot');
    claims.set(path, rootId);
    const previous = inventory.copies.find(file => file.path === path);
    if (previous && previous.source !== input) refusal('<roots>', 'source roots collide in the snapshot');
    if (!previous) inventory.copies.push({path, bytes, source: input});
  };
  const skipRule = (path: string, directory: boolean, input: string): string | undefined => {
    const parts = path.split('/');
    if(prefix==='runtime-data' && path==='repos' && directory)return runtimeRepositoryCacheRule;
    if(prefix==='runtime-data' && parts[0]==='logins')return 'runner-owned CLI login material (credential values are not imported)';
    const omitted = prefix === 'runtime' || prefix === 'runtime-data' ? new Set(['.git','node_modules']) : excluded;
    if (parts.slice(0, directory ? undefined : -1).some(p => omitted.has(p)) || (prefix==='home' && ((path === 'pieces/bin' && directory) || path.startsWith('pieces/bin/')))) return 'installed program or runtime directory';
    const base = input.replace(/(?:-wal|-shm|-journal)$/, '');
    if (base !== input && existsSync(base) && guarded(path, 'cannot inspect possible SQLite coordination file', () => isSqlite(base))) return 'SQLite coordination file (backup API reads committed data)';
    if (/(?:^|[/.])(?:[^/]*\.)?lock$/.test(path)) return 'lock file';
    return undefined;
  };
  const label = (path: string) => prefix === 'home' ? path : `${prefix}/${path}`;
  const visit = (input: string, logical = relative(source, input).split(sep).join('/') || '.', ancestors = new Set<string>()): void => {
    let path = relative(source, input).split(sep).join('/') || '.';
    const memoryFile = householdMemory && prefix === 'home' && householdMemoryFile(logical);
    const declaredAlias = memoryFile || patterns.some(pattern => matches(logical, pattern));
    let stat = guarded(path, 'cannot inspect source entry', () => lstatSync(input));
    const fileAlias = stat.isSymbolicLink();
    const excludedRule = !stat.isSymbolicLink() && (skipRule(logical, stat.isDirectory(), input) ?? skipRule(path, stat.isDirectory(), input));
    if (excludedRule) { inventory.skipped.push({ path: label(path), rule: excludedRule, bytes: stat.isFile() ? stat.size : null }); return; }
    if (stat.isSymbolicLink()) {
      let real: string;
      try { real = realpathSync(input); } catch { inventory.skipped.push({ path: label(path), rule: 'dangling or unresolved symlink', bytes: null }); return; }
      if (!within(real, source)) { inventory.skipped.push({ path: label(path), rule: 'symlink outside source home', bytes: null }); return; }
      const realPath = relative(source, real).split(sep).join('/');
      stat = guarded(path, 'cannot inspect resolved data', () => lstatSync(real));
      if (skipRule(realPath, stat.isDirectory(), real) || skipRule(logical, stat.isDirectory(), real)) { inventory.skipped.push({ path: label(path), rule: 'symlink to excluded program, runtime or coordination entry', bytes: null }); return; }
      inventory.followed.push({ path: label(path), realPath: label(realPath) });
      input = real; path = realPath;
    }
    if (stat.isDirectory()) {
      if (ancestors.has(input)) { inventory.skipped.push({path: label(logical), rule: 'cyclic directory alias', bytes: null}); return; }
      const visitKey = `${rootId}\0${input}\0${logical}`;
      if (seen.has(visitKey)) return;
      seen.add(visitKey);
      const parents = new Set(ancestors).add(input);
      for (const name of guarded(path, 'cannot list data directory', () => readdirSync(input).sort())) visit(join(input, name), logical === '.' ? name : `${logical}/${name}`, parents);
    } else if (!stat.isFile()) inventory.skipped.push({ path: label(path), rule: 'special file (socket, pipe or device)', bytes: null });
    else if (declaredAlias || patterns.some(pattern => matches(path, pattern))) {
      if (memoryFile && logical !== path &&
          !(identityPage(logical) && identityPage(path) && logical.split('/')[1] === path.split('/')[1])) {
        refusal(logical, 'memory source alias must stay within its agent identity pages');
      }
      addCopy(`${prefix}/${path}`, input, stat.size);
      // Fixed-path importers still need the original file name. Materialize it
      // as regular bytes, retaining canonical provenance in followed.
      const preserveAlias = prefix === 'home' ? memoryFile || (fileAlias && importerPatterns.some(pattern => matches(logical, pattern))) : declaredAlias;
      if (logical !== path && preserveAlias) {
        addCopy(`${prefix}/${logical}`, input, stat.size);
        if (!inventory.followed.some(alias => alias.path === label(logical) && alias.realPath === label(path))) inventory.followed.push({path: label(logical), realPath: label(path)});
      }
      inventory.skipped = inventory.skipped.filter(entry => entry.path !== label(path));
    }
    else if (!inventory.copies.some(file => file.source === input)) inventory.skipped.push({ path: label(path), rule: 'not declared by a registered importer or key rule', bytes: stat.size });
  };
  visit(source);
  const clockFiles = legacyClockAgentFiles;
  let documentBytes=0,documentCount=0;
  const expandedRoots=Object.entries(roots).flatMap(([name,value])=>(name==='bridges'||name==='bridges-document')?(value as string[]|undefined??[]).map((path,index)=>[`${name}/${index}`,path] as const):[[name,value as string|undefined] as const]);
  for (const [name, supplied] of expandedRoots) {
    if (supplied === undefined) continue;
    if (!supplied) refusal(`<${name}>`, 'source root must not be empty');
    rootId++;
    source = guarded(`<${name}>`, 'source root must exist', () => realpathSync(supplied));
    if (within(target, source) || within(source, target)) refusal(`<${name}>`, 'source and destination must be separate');
    const stat = guarded(`<${name}>`, 'cannot inspect source root', () => lstatSync(source));
    if(name.startsWith('bridges-document/')){
      documentBytes+=stat.size;documentCount++;
      if(!stat.isFile()||stat.size>bridgeDocumentLimits.bytes||documentBytes>bridgeDocumentLimits.total||documentCount>bridgeDocumentLimits.count)refusal('<bridges-document>','selected documents require regular files, at most 1 MiB each, 8 MiB total and 128 files');
      addCopy(`bridges-documents/${name.split('/')[1]}.md`,source,stat.size);continue;
    }
    if (name === 'changes') {
      if (!stat.isFile()) refusal('<changes>', 'Changes snapshot must be a regular file');
      addCopy('changes/changes.json', source, stat.size);
      continue;
    }
    if (!stat.isDirectory()) refusal(`<${name}>`, 'source root must be a directory');
    prefix = name === 'wake' ? 'clock/art' : name;
    patterns = name === 'clock' ? ['lanes.json', 'fire', ...clockFiles.map(file => `*/${file}`)]
      : name === 'wake' ? clockFiles
      : name === 'secrets' ? ['store.sops.json', 'policy.json', 'requests.json', 'audit.jsonl']
      : name.startsWith('bridges/') ? ['shuttle.json','people.json','routes.json']
      : name === 'runtime' || name === 'runtime-data' ? ['**']
      : ['approvals.json', 'rules.json', 'audit.jsonl'];
    // Each root has its own alias confinement boundary; never follow a link to another root.
    visit(source);
  }
  if (tasks) {
    const input = guarded('<tasks>', 'taskstore must exist', () => realpathSync(tasks));
    const stat = guarded('<tasks>', 'cannot inspect taskstore', () => lstatSync(input));
    if (!stat.isFile()) refusal('<tasks>', 'taskstore must be a regular file');
    if (within(input, target)) refusal('<tasks>', 'taskstore and destination must be separate');
    rootId++; addCopy('tasks/store.db', input, stat.size);
  }
  inventory.copies.sort((a,b) => a.path.localeCompare(b.path));
  return inventory;
}
/** SQLite backup gives each database a committed view while writers run.
 * JSON files are copied individually: a rehearsal can be seconds stale across stores.
 * Cross-store consistency requires stopping old services for the final move. */
export async function createSnapshot(from: string, to: string, tasks?: string, roots: SnapshotRoots = {}, householdMemory = false): Promise<SnapshotManifest> {
  const inventory = inventorySnapshot(from, to, tasks, roots, householdMemory), target = destinationPath(to);
  guarded('<destination>', 'cannot create destination parent', () => mkdirSync(dirname(target), { recursive: true }));
  guarded('<destination>', 'cannot reserve fresh private destination', () => mkdirSync(target, { mode: 0o700 }));
  const reserved = lstatSync(target);
  // Pin the reserved directory across SQLite backup's asynchronous opens.
  const rootFd = guarded('<destination>', 'cannot pin reserved destination', () => openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  const checkTarget = () => {
    destinationPath(target);
    const current = guarded('<destination>', 'reserved destination disappeared', () => lstatSync(target));
    if (current.dev !== reserved.dev || current.ino !== reserved.ino) refusal('<destination>', 'reserved destination was replaced');
  };
  const manifest: SnapshotManifest = { version: 1, consistency: 'per-database', files: [], skipped: inventory.skipped, followed: inventory.followed };
  const runtimeRoots = (['runtime','runtime-data'] as const).filter(name=>roots[name]!==undefined);
  if(runtimeRoots.length)manifest.runtimeRoots=runtimeRoots;
  let capturedDocumentBytes=0;
  const copied = new Map<string, string>();
  try {
    destinationPath(join(target, 'home'));
    guarded('.', 'cannot create copied home', () => mkdirSync(join(target, 'home'), { mode: 0o700 }));
    for(const name of runtimeRoots)guarded(name,'cannot create copied runtime root',()=>mkdirSync(join(target,name),{mode:0o700}));
    for (const file of inventory.copies) {
      const path = file.path.startsWith('home/') ? file.path.slice(5) : file.path;
      // Recheck confinement/type immediately before reading; never copy symlink bytes.
      guarded(path, 'source data moved or changed type during snapshot', () => {
        if (realpathSync(file.source) !== file.source || !lstatSync(file.source).isFile()) refusal(path, 'source data moved or changed type during snapshot');
      });
      checkTarget();
      const output = join(target, file.path);
      destinationPath(output);
      guarded(path, 'cannot create private destination directory', () => mkdirSync(dirname(output), { recursive: true, mode: 0o700 }));
      destinationPath(output);
      if (existsSync(output)) refusal(path, 'destination entry already exists');
      const selectedDocument=bridgeDocumentPath(file.path);
      const attachment = householdMemory && file.path.startsWith('home/') && noteAttachmentPath(file.path.slice(5));
      const sqlite = !attachment && !selectedDocument&&guarded(path, 'cannot read data header', () => isSqlite(file.source));
      try {
        const copyKey = JSON.stringify([file.source, sqlite]);
        const previous = copied.get(copyKey);
        if(selectedDocument){
          const document=readBridgeDocuments([{name:file.path,path:file.source}])[0];
          capturedDocumentBytes+=document.bytes;
          if(capturedDocumentBytes>bridgeDocumentLimits.total)throw Error();
          writeFileSync(output,document.content,{encoding:'utf8',flag:'wx',mode:0o600});
        }
        else if (previous) copyMigrationFile(previous, output);
        else if (sqlite) {
          // Keep both the private input and output within the reserved snapshot.
          const temporary = `/proc/self/fd/${rootFd}/.backup-${randomUUID()}`;
          await backupDatabase(file.source, temporary);
          checkTarget();
          destinationPath(output);
          renameSync(temporary, output);
          checkTarget();
          destinationPath(output);
          const out = openSync(output, 'r');
          try { fchmodSync(out, 0o600); } finally { closeSync(out); }
        } else copyMigrationFile(file.source, output);
        const digest = fileDigest(output);
        if (attachment && digest.sha256 !== basename(file.path)) refusal(path, 'attachment digest differs from its name');
        if(!selectedDocument)copied.set(copyKey, output);
        manifest.files.push({ path: file.path, ...digest, kind: sqlite ? 'sqlite' : 'file' });
      } catch { refusal(path, sqlite ? 'SQLite backup failed' : 'data copy failed'); }
    }
    checkTarget();
    destinationPath(join(target, 'manifest.json'));
    guarded('manifest.json', 'cannot publish completion manifest', () => writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' }));
    return manifest;
  } catch (error) {
    try { checkTarget(); rmSync(target, { recursive: true, force: true }); } catch { /* no completion manifest means unusable */ }
    throw error;
  } finally { closeSync(rootFd); }
}
export function readSnapshot(dir: string): SnapshotManifest {
  const root = realpathSync(dir);
  const manifestPath = join(root, 'manifest.json');
  if (lstatSync(manifestPath).isSymbolicLink()) throw new Error('Invalid manifest link');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid snapshot manifest');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || seen.has(file.path)) throw new Error('Invalid snapshot entry');
    seen.add(file.path);
    const path = resolve(root, file.path);
    if (!within(path, root) || path === root || relative(root, path).startsWith('..')) throw new Error('Invalid snapshot path');
    if (!within(realpathSync(path), root)) throw new Error('Invalid snapshot link');
    const digest = fileDigest(path);
    if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256) throw new Error('Snapshot integrity check failed');
  }
  return manifest;
}
const usage = 'usage: loom migrate snapshot --from <old-home> [--tasks <store.db>] [--clock <WAKE_DATA>] [--wake <Art/.wake>] [--approvals <directory>] [--changes <snapshot.json>] [--secrets <directory>] [--bridges <instance-root> ...] [--bridges-document <file> ...] [--runtime <LOOM_BOX_HOME>] [--runtime-data <LOOM_BOX_DATA>] --to <new-directory> [--dry-run] [--household-memory]\n';
export async function migrateSnapshot(argv: string[], io: IOStreams): Promise<number> {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: { from: { type: 'string' }, to: { type: 'string' }, tasks: { type: 'string' }, clock: { type: 'string' }, wake: { type: 'string' }, approvals: { type: 'string' }, changes: { type: 'string' }, secrets: { type: 'string' }, bridges: { type: 'string', multiple: true }, 'bridges-document': {type:'string',multiple:true}, runtime: { type: 'string' }, 'runtime-data': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'household-memory': { type: 'boolean' } }, strict: true, allowPositionals: false })); }
  catch { io.stderr(usage); return 2; }
  if (!values.from || !values.to) { io.stderr(usage); return 2; }
  try {
    const roots: SnapshotRoots = { clock: values.clock, wake: values.wake, approvals: values.approvals, changes: values.changes, secrets: values.secrets, bridges:values.bridges,'bridges-document':values['bridges-document'],runtime:values.runtime,'runtime-data':values['runtime-data'] };
    if (values['dry-run']) {
      const inventory = inventorySnapshot(values.from, values.to, values.tasks, roots, values['household-memory']);
      io.stdout(JSON.stringify({ status: 'dry-run', consistency: inventory.consistency, sizes: 'source main-file bytes; SQLite backup size may differ', copies: inventory.copies.map(({ path, bytes }) => ({ path, bytes })), skipped: inventory.skipped, followed: inventory.followed }, null, 2) + '\n');
      return 0;
    }
    const manifest = await createSnapshot(values.from, values.to, values.tasks, roots, values['household-memory']);
    io.stdout(JSON.stringify({ status: 'ok', files: manifest.files.length, consistency: manifest.consistency }) + '\n');
    return 0;
  } catch (error) { io.stderr((error instanceof SnapshotFailure ? error.message : 'Snapshot refused: \".\": unexpected snapshot failure') + '\n'); return 1; }
}
