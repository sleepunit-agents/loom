/** Offline preparation only: no destination, daemon, legacy programs or writable source opens. */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import type Database from 'better-sqlite3';
import { openSnapshotSqlite } from './migration-sqlite.js';
import { readChangesImport } from '../pieces/changes/importer.js';
import { legacyClockAgentFiles } from '../pieces/clock/importer.js';
import { z } from 'zod';
import { secretImportOptions } from '../pieces/secrets/import-source.js';
import { parseHouseholdDocument } from '../household.js';
import { readSnapshot, type SnapshotManifest } from './migration-snapshot.js';
import { createMigrationRegistry, snapshotPath } from './migration-registry.js';

const slug = z.string().max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const agent = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const audience = z.object({ project: slug.optional(), member: slug.optional() }).strict();
const attribution = z.object({
  agents: z.record(agent, z.object({ logins: z.array(z.string().min(1)), branches: z.array(z.string().min(1)) }).strict()),
  ownerLogins: z.array(z.string().min(1)), taskOwner: z.string().min(1).optional(),
}).strict();
const options = {
  household: z.object({}).strict(),
  tasks: z.object({ projects: z.record(z.string().regex(/^t-[0-9]+$/), slug), agent: agent.optional() }).strict(),
  attention: z.record(z.string().regex(/^cv-[0-9a-f]{12}$/), audience),
  clock: z.object({}).strict(),
  approvals: z.object({ projects: z.record(z.string(), slug) }).strict(),
  changes: z.object({ attribution }).strict(),
  comms: z.object({}).strict(),
  secrets: secretImportOptions,
};
export const supportedMigrationImporters: readonly string[] = Object.keys(options);
const inputSchema = z.object({ paths: z.array(z.string().min(1)).min(1), options: z.json() }).strict();
const planSchema = z.object({ version: z.literal(1), snapshot: z.string().regex(/^[a-f0-9]{64}$/), importers: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), inputSchema) }).strict();
export type MigrationPlan = z.infer<typeof planSchema>;
export const canonicalPlanValue = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalPlanValue).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalPlanValue(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
/** The full plan, including every option and missing registration, belongs in the all receipt. */
export const migrationPlanChecksum = (plan: MigrationPlan): string => createHash('sha256').update(canonicalPlanValue(plan)).digest('hex');
export const migrationSnapshotChecksum = (manifest: SnapshotManifest): string => createHash('sha256').update(canonicalPlanValue({ ...manifest, files: [...manifest.files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) })).digest('hex');

type TaskSource = { id: string; type?: string; project?: string };
/** Deserialize the verified main-file bytes: discovery never creates sidecars or consumes an unlisted WAL. */
function sqlite<T>(path: string, read: (db: Database.Database) => T): T {
  const db = openSnapshotSqlite(path);
  try { return read(db); } finally { db.close(); }
}
/** Check types before readSnapshot can hash a FIFO or other live handle. */
function regularFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (relative: string): void => {
    const path = join(root, relative), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('Snapshot contains a symlink');
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(relative ? `${relative}/${name}` : name);
    else if (!stat.isFile()) throw Error('Snapshot contains a special file');
    else files.push(relative);
  };
  if (!lstatSync(root).isDirectory()) throw Error('Snapshot must be a directory');
  walk('');
  return files;
}
function assertInventory(root: string, manifest: SnapshotManifest, regular: string[]): void {
  const schema = z.object({ version: z.literal(1), consistency: z.literal('per-database'), files: z.array(z.object({
    path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), kind: z.enum(['sqlite','file']),
  }).strict()), skipped: z.array(z.object({ path: z.string(), rule: z.string(), bytes: z.number().nonnegative().nullable() }).strict()).optional(), followed: z.array(z.object({ path: z.string(), realPath: z.string() }).strict()).optional() }).strict();
  schema.parse(manifest);
  const paths = new Set(manifest.files.map(f => f.path));
  if (paths.has('manifest.json')) throw Error('Manifest cannot inventory itself');
  for (const path of paths) if (path !== posix.normalize(path) || path.startsWith('/') || path.startsWith('../') || path.includes('\\')) throw Error('Noncanonical snapshot path');
  if (regular.some(p => p !== 'manifest.json' && !paths.has(p))) throw Error('Snapshot contains an unlisted file');
  for (const file of manifest.files) {
    const fd = openSync(join(root, file.path), 'r');
    const header = Buffer.alloc(16);
    try { readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
    const kind = header.toString() === 'SQLite format 3\0' ? 'sqlite' : 'file';
    if (kind !== file.kind) throw Error('Snapshot kind disagrees with file contents');
  }
}

export function prepareMigrationPlan(snapshot: string, supplied?: unknown): {
  root: string; manifest: SnapshotManifest; plan: MigrationPlan; missing: string[]; blocked: string[];
} {
  const explicit = supplied === undefined ? undefined : planSchema.parse(supplied);
  const root = realpathSync(snapshot);
  const regular = regularFiles(root);
  const manifest = readSnapshot(root);
  assertInventory(root, manifest, regular);
  const context = { snapshot: { root, manifest } };
  const path = (relative: string) => snapshotPath(context, relative);
  const json = (relative: string) => JSON.parse(readFileSync(path(relative), 'utf8'));
  const physical = new Set(manifest.files.map(f => f.path));
  // File aliases needed by fixed-path importers are regular copies, not links.
  // Discover through their importer-visible path once, rather than twice.
  const aliased = new Set((manifest.followed ?? []).flatMap(alias => {
    const prefix = physical.has(`home/${alias.path}`) ? 'home/' : '';
    return physical.has(prefix + alias.path) && physical.has(prefix + alias.realPath) ? [prefix + alias.realPath] : [];
  }));
  const files = new Set([...physical].filter(path => !aliased.has(path)));
  if (!files.has('home/household.json')) throw Error('Snapshot household is required');
  const household = parseHouseholdDocument(path('home'), json('home/household.json'));
  const memories = manifest.files.filter(f => files.has(f.path) && f.kind === 'sqlite' && basename(f.path) === 'memories.db').map(f => f.path).sort();
  const scopes: Record<string, Record<string, string>> = {};
  const attentionPaths: string[] = [];
  for (const source of memories) sqlite(path(source), db => {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
    const required = ['conversations','conversation_turns','conversation_days','conversation_digests'];
    if (![...required, 'conversation_needs_answers', 'findings'].some(t => tables.has(t))) return;
    if (!required.every(t => tables.has(t))) throw Error('Incomplete attention source');
    const columns: Record<string, string[]> = {
      conversations: ['id','agent','venue','place','label','people_json','agents_json','started','last','last_seq'],
      conversation_turns: ['conversation','seq','at','from_json','kind','latency_ms','writer'],
      conversation_days: ['conversation','day','counts_json','median_latency_ms','outcomes_json'],
      conversation_digests: ['id','conversation','run','at','summary','asks_json','decisions_json','tasks_json','projects_json','needs_owner'],
      conversation_needs_answers: ['digest','conversation','verdict','by','at'],
      findings: ['id','conversation','seq','day','measure','score','text','at'],
    };
    for (const [table, names] of Object.entries(columns)) if (tables.has(table)) {
      const held = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name));
      if (names.some(name => !held.has(name))) throw Error('Incomplete attention source columns');
    }
    attentionPaths.push(source);
    for (const row of db.prepare('SELECT id, agent FROM conversations').all() as { id: string; agent: string }[]) {
      z.string().regex(/^cv-[0-9a-f]{12}$/).parse(row.id);
      if (Object.hasOwn(scopes, row.id)) throw Error('Duplicate conversation across snapshot sources');
      if (!household.agents.includes(row.agent)) throw Error('Conversation names an unknown household agent');
      scopes[row.id] = {}; // Private to its agent and owners; never infer an audience from venue/title.
    }
  });
  const tasks = files.has('tasks/store.db') ? sqlite(path('tasks/store.db'), db =>
    (db.prepare('SELECT record FROM tasks ORDER BY ord').all() as { record: string }[]).map(r => JSON.parse(r.record) as TaskSource)) : [];
  const epics = tasks.filter(t => t.type === 'epic');
  const clock = [...new Set([...files].filter(p => (legacyClockAgentFiles as readonly string[]).includes(basename(p)) && agent.safeParse(posix.basename(posix.dirname(p))).success).map(p => posix.dirname(posix.dirname(p))))].sort();
  if ((files.has('clock/lanes.json') || files.has('clock/fire')) && !clock.includes('clock')) throw Error('Explicit clock source has no agent files');
  const approvals = [...files].filter(p => basename(p) === 'approvals.json').map(p => posix.dirname(p)).sort();
  if ((files.has('approvals/rules.json') || files.has('approvals/audit.jsonl')) && !approvals.includes('approvals')) throw Error('Explicit approvals source is incomplete');
  const changes = [...files].filter(p => basename(p) === 'changes.json' || /(?:^|\/)changes\/.*\.json$/.test(p)).filter(p => {
    const value = json(p);
    const valid = value?.v === 1 && Array.isArray(value.changes);
    if (p === 'changes/changes.json') {
      if (!valid) throw Error('Invalid explicit Changes snapshot');
      // Source-only projection validates records, identities and duplicate ids before any destination opens.
      readChangesImport(path(p), {projects: [], attribution: {agents: {}, ownerLogins: []}});
    }
    return valid;
  }).sort();
  const commsDirectories = new Set([...files].filter(p => basename(p) === 'comms.db' || basename(p) === 'comms.salt').map(p => posix.dirname(p)));
  // Missing words DB must not hide retained threads/tombstones in household.db.
  // A key alone is not evidence of stored data (snapshots also retain unused keys).
  for (const source of [...files].filter(p => basename(p) === 'household.db')) {
    const containsComms = sqlite(path(source), db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('comms_threads','comms_deleted') LIMIT 1").get());
    if (containsComms) commsDirectories.add(posix.dirname(source));
  }
  const comms = [...commsDirectories].map(directory => `${directory}/comms.db`).sort();
  // A destination has one Comms identity; selecting one of several stores would discard data.
  if (comms.length > 1) throw Error('Multiple Comms sources are not supported');
  const commsPaths = comms.flatMap(source => {
    const directory = posix.dirname(source);
    const required = ['comms.db', 'household.db', 'comms.key'].map(name => `${directory}/${name}`);
    if (required.some(p => !physical.has(p))) throw Error('Incomplete Comms source');
    const columns = {
      'household.db': {
        comms_threads: ['id','agent','member','conversation','title','titled_by','project','pinned','archived','opened','last','read_seq','first_id','first_hash','stop','working_since'],
        comms_deleted: ['id','member','agent','at'],
      },
      'comms.db': {
        comms_messages: ['thread','seq','at','kind','sender','id','hash','text','card_json','run','delivered','step'],
        comms_asks: ['thread','ref','approval','raised','seen','words','answer_json'],
        conversation_steps: ['seq','conversation','at','run','id','tool','state','words'],
      },
    };
    for (const [database,tables] of Object.entries(columns)) sqlite(path(`${directory}/${database}`), db => {
      for (const [table,names] of Object.entries(tables)) {
        const held = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row => row.name));
        if (!held.size && table !== 'comms_threads' && table !== 'comms_messages') continue;
        if (names.some(name => !held.has(name))) throw Error('Incomplete Comms source columns');
      }
    });
    return [...required, ...[`${directory}/comms.salt`].filter(p => physical.has(p))];
  });
  const secrets = [...new Set([...files].filter(p=>{
    if(basename(p)==='store.sops.json')return true;
    if(basename(p)==='requests.json')return Object.hasOwn(json(p),'requests');
    if(basename(p)==='policy.json')return Object.hasOwn(json(p),'secrets');
    return false;
  }).map(p=>posix.dirname(p)))].sort();
  const discovered: MigrationPlan['importers'] = { household: { paths: ['home'], options: {} } };
  if (commsPaths.length) discovered.comms = { paths: commsPaths, options: {} };
  if (files.has('tasks/store.db')) discovered.tasks = { paths: ['tasks/store.db'], options: {
    projects: Object.fromEntries(epics.filter(t => t.project !== undefined).map(t => [t.id, t.project!])), agent: household.default,
  } };
  if (attentionPaths.length) discovered.attention = { paths: attentionPaths, options: scopes };
  const pick = (name: string, candidates: string[], value: z.infer<typeof inputSchema>['options']) => {
    if (!candidates.length) return;
    // An explicit plan resolves ambiguous layouts; discovery must never pick one silently.
    if (candidates.length > 1 && explicit === undefined) throw Error(`Multiple ${name} inputs; supply an explicit plan`);
    discovered[name] = { paths: [candidates[0]], options: value };
  };
  pick('secrets', secrets, {agents:Object.fromEntries(household.agents.map(id=>[id,id])),members:Object.fromEntries(household.members.map(m=>[m.person,m.person]))});
  pick('clock', clock, {});
  pick('approvals', approvals, { projects: {} });
  pick('changes', changes, { attribution: { agents: Object.fromEntries(household.agents.map(id => [id, { logins: [], branches: [] }])), ownerLogins: [] } });
  const plan = planSchema.parse(explicit ?? { version: 1, snapshot: migrationSnapshotChecksum(manifest), importers: discovered });
  if (plan.snapshot !== migrationSnapshotChecksum(manifest)) throw Error('Plan belongs to a different snapshot');
  for (const name of Object.keys(discovered)) if (!Object.hasOwn(plan.importers, name)) throw Error(`Plan omits discovered ${name} input`);
  if (canonicalPlanValue(plan.importers.household.paths) !== '["home"]') throw Error('Household must use copied home');
  for (const [name, input] of Object.entries(plan.importers)) {
    if (new Set(input.paths).size !== input.paths.length) throw Error('Duplicate plan input');
    for (const source of input.paths) {
      path(source);
      if (!files.has(source) && ![...files].some(p => p.startsWith(`${source}/`))) throw Error('Input is not in snapshot inventory');
    }
    if (Object.hasOwn(options, name)) {
      const schema = options[name as keyof typeof options];
      input.options = schema.parse(input.options);
      if (name !== 'attention' && name !== 'comms' && input.paths.length !== 1) throw Error('Importer requires exactly one input');
    }
  }
  if (plan.importers.comms && canonicalPlanValue(plan.importers.comms.paths) !== canonicalPlanValue(commsPaths)) throw Error('Comms must include every discovered input in order');
  const taskOptions = plan.importers.tasks && options.tasks.parse(plan.importers.tasks.options);
  if (taskOptions) {
    if (plan.importers.tasks.paths[0] !== 'tasks/store.db') throw Error('Tasks must use copied taskstore');
    if (taskOptions.agent && !household.agents.includes(taskOptions.agent)) throw Error('Unknown task agent');
    for (const [id, project] of Object.entries(taskOptions.projects)) {
      const epic = epics.find(t => t.id === id);
      if (!epic || (epic.project !== undefined && epic.project !== project)) throw Error('Invalid or conflicting epic project map');
    }
  }
  if (plan.importers.attention) {
    if (canonicalPlanValue([...plan.importers.attention.paths].sort()) !== canonicalPlanValue(attentionPaths)) throw Error('Attention must include every discovered source');
    const selected = options.attention.parse(plan.importers.attention.options);
    if (canonicalPlanValue(Object.keys(selected).sort()) !== canonicalPlanValue(Object.keys(scopes).sort())) throw Error('Attention requires an audience for every conversation');
    if (Object.values(selected).some(a => a.member && !household.members.some(m => m.person === a.member))) throw Error('Unknown audience member');
  }
  if (plan.importers.secrets && !secrets.includes(plan.importers.secrets.paths[0])) throw Error('Unknown Secrets source layout');
  if (plan.importers.clock && !clock.includes(plan.importers.clock.paths[0])) throw Error('Unknown clock source layout');
  if (plan.importers.approvals && !approvals.includes(plan.importers.approvals.paths[0])) throw Error('Unknown approvals source layout');
  if (plan.importers.changes) {
    if (!changes.includes(plan.importers.changes.paths[0])) throw Error('Unknown Changes source layout');
    const value = options.changes.parse(plan.importers.changes.options).attribution;
    if (Object.keys(value.agents).some(a => !household.agents.includes(a)) || (value.taskOwner && !household.agents.includes(value.taskOwner) && !household.members.some(m => m.person === value.taskOwner))) throw Error('Unknown Changes attribution identity');
  }
  const { missing, blocked } = createMigrationRegistry().order(Object.keys(plan.importers));
  return { root, manifest, plan, missing, blocked };
}
