/** Rules about stored data that nothing else ties together. Each fails when a second copy or a shortcut comes back. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createDataSchema } from './core/data/database.js';
import { BACKUP_KEEP_MAX, householdSettings, householdTimezone } from './core/data/household-settings.js';
import { agents, household } from './core/data/schema.js';
import { Conversations } from './core/conversations/index.js';
import { plainEpisode } from './pieces/mind/activity-episode.js';

const root = new URL('../', import.meta.url).pathname;
const sources = (directory: string): string[] => readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(directory, entry.name))
    : /\.ts$/.test(entry.name) && !/\.(test|fixture)\.ts$/.test(entry.name) ? [join(directory, entry.name)] : []);
const text = (file: string) => readFileSync(join(root, file), 'utf8');

it('names the columns of every insert into a household table, a memory receipt table or a secret holder table', () => {
  // An upgraded household database can hold a table's columns in another order than a fresh one
  // (an added column lands last), and recognition accepts that. So a value is never placed by position.
  const tables = new Set([...text('src/core/data/schema.ts').matchAll(/sqliteTable\(\s*'([a-z_]+)'/g)].map(match => match[1]));
  expect(tables.size).toBeGreaterThan(80);
  for (const name of ['mind_operation_receipts', 'mind_source_migrations', 'memory_command_receipts', 'memory_command_preparations']) tables.add(name);
  // The secret holder's own file: the same hazard the day one of its tables gains a column.
  for (const [, name] of text('src/pieces/secrets/holder-store.ts').matchAll(/CREATE TABLE IF NOT EXISTS (holder_\w+)/g)) tables.add(name);
  expect([...tables].filter(name => name.startsWith('holder_'))).toHaveLength(6);
  const positional = sources('src').flatMap(file => [...text(file).matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?(\w+)["`]?\s*(?:VALUES|SELECT)\b/gi)]
    .filter(match => tables.has(match[1])).map(match => `${file}: ${match[1]}`));
  expect(positional).toEqual([]);
});

it('reads and writes memory operation receipts in one module', () => {
  const users = sources('src').filter(file => /\b(FROM|INTO)\s+mind_operation_receipts\b/i.test(text(file)));
  expect(users).toEqual(['src/pieces/mind/receipt-schema.ts']);
});

it('writes knowledge page rows, their words and their citations only in the knowledge store', () => {
  // The door's page actions call the store's primitives (src/backends/knowledge-writes.ts) on their own transaction.
  const writers = sources('src').filter(file => !file.startsWith('src/backends/')
    && /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(pages|citations)\b|\bUPDATE\s+pages\b/i.test(text(file)));
  expect(writers).toEqual([]);
});

it('answers for an unset household in one place, with the database\'s own defaults', () => {
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client, () => '2026-11-16T00:00:00.000Z');
    // No household row yet: the answer is what the row would hold once made with nothing chosen.
    const unset = householdSettings(db);
    db.insert(household).values({}).run();
    const { singleton: _one, ...row } = db.select().from(household).get()!;
    expect(unset).toEqual(row);
    expect(householdTimezone(db)).toBe(row.timezone);
    db.update(household).set({ timezone: 'Pacific/Kiritimati' }).run();
    expect(householdTimezone(db)).toBe('Pacific/Kiritimati');
  } finally { client.close(); }
  expect(text('assets/data/schema.sql')).toContain(`"backup_keep" between 1 and ${BACKUP_KEEP_MAX}`);
  // A default written again beside a read of the household row would drift from the column's own.
  const copies = sources('src').filter(file => file !== 'src/core/data/household-settings.ts'
    && /\?\?\s*\(?(?:\(\)\s*=>\s*)?'UTC'|secretsDefault\s*\?\?|\.answer\s*\?\?\s*'ask'|backupAt\s*\?\?|backupKeep\s*\?\?|commsDays\s*\?\?|COMMS_DAYS_DEFAULT/.test(text(file))).sort();
  expect(copies).toEqual([]);
});

it('has no time zone of its own: every clock a person reads is the household\'s', () => {
  const zones = sources('src').filter(file => /America\/Chicago|LOOM_TIMEZONE|process\.env\.TZ\b/.test(text(file)));
  expect(zones).toEqual([]);
});

it('recognises in an episode the conversation id that Conversations makes', () => {
  // The id is made in one module and matched as text in another. This is what ties the two.
  const client = new Database(':memory:');
  try {
    const db = createDataSchema(client, () => '2026-11-16T00:00:00.000Z');
    db.insert(agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
    const { id } = new Conversations(db, () => '2026-11-16T00:00:00.000Z').open({ agent: 'art', venue: 'wake', place: 'daily', label: 'Daily review' });
    const none = () => undefined;
    expect(plainEpisode({ title: 'Reviewed the day', where: 'terminal', meta: { conversation: id } }, 'art', none).conversation).toBe(id);
    expect(plainEpisode({ title: 'Reviewed the day', content: `Its conversation is ${id} and this run is run-1`, where: 'terminal' }, 'art', none).conversation).toBe(id);
  } finally { client.close(); }
});

it('states each card limit, the kept-versions count and the knowledge check interval once', () => {
  // The shared card limits live in backends/cards.ts; a store or a form that wrote the number again would drift from it.
  for (const file of ['src/backends/people.ts', 'src/backends/projects.ts'])
    expect(text(file), file).not.toMatch(/const MAX_(?:NAME|SUMMARY|FIELDS|RENDER|PROJECT_RENDER) = \d/);
  expect(text('src/pieces/mind/people-actions.ts')).not.toMatch(/\.max\(\d+\)/);
  // Ten versions are kept of a card, a memory and a page: where one is pruned and where the list is read.
  const versions = sources('src').filter(file => /_revisions\b[^;`]*\bLIMIT \d+/.test(text(file)) || /MAX_REVISIONS\w* = \d/.test(text(file)));
  expect(versions).toEqual(['src/backends/cards.ts']);
  // The page calls a check due after the same number of days as the sweep raises it.
  expect(text('src/pieces/mind/knowledge-sweep.ts')).toMatch(/CHECK_INTERVAL = CHECK_DAYS \* DAY_MS/);
});

it('declares what the dispatcher asks of a receipt store once', () => {
  const declared = sources('src').filter(file => /interface (?:ReceiptPersistence|OperationReceipt)\b/.test(text(file)));
  expect(declared).toEqual(['src/core/operations/receipts.ts']);
  // The dispatcher keeps no receipt table of its own, and says once how long a receipt lasts.
  expect(sources('src').filter(file => /core_operations|core_migrations/.test(text(file)))).toEqual([]);
  expect(text('src/core/operations/index.ts')).not.toMatch(/\b30 \* 86_?400_?000/);
});

it('revokes a machine, and appends to the approval record, in one place each', () => {
  // A second writer would repeat the first's rule (the recount after a revocation, the record's sequence) or forget it.
  const revokers = sources('src').filter(file => /update\(boxes\)\s*\.set\(\{\s*revokedAt/.test(text(file)));
  expect(revokers).toEqual(['src/shared-root.ts']);
  const recorders = sources('src').filter(file => /insert\(approvalRecord\)/.test(text(file)));
  expect(recorders).toEqual(['src/apps/approvals.ts']);
});

it('states what a GitHub name looks like once', () => {
  const patterns = sources('src').filter(file => /\[A-Za-z0-9\]\[A-Za-z0-9-\]\{0,38\}/.test(text(file)));
  expect(patterns).toEqual(['src/apps/household.ts']);
});

/** Which source files write each household table, read from the source: every Drizzle insert, update or
 * delete, and every SQL statement of those kinds, outside the schema itself and the upgrade steps. A table
 * handed over in a variable is followed to where the variable was given its value. */
function tableWriters(): Map<string, string[]> {
  const exported = new Map([...text('src/core/data/schema.ts').matchAll(/export const (\w+)\s*=\s*sqliteTable\(\s*'([a-z_]+)'/g)].map(match => [match[1], match[2]]));
  const names = new Set(exported.values());
  const writers = new Map<string, Set<string>>();
  for (const file of sources('src')) {
    if (file === 'src/core/data/schema.ts' || file === 'src/core/data/database.ts') continue;
    const source = text(file), local = new Map<string, string>(), stars: string[] = [];
    for (const [, list] of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'[^']*\/schema\.js'/g))
      for (const part of list.split(',')) {
        const [name, alias = name] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        if (exported.has(name)) local.set(alias, exported.get(name)!);
      }
    for (const [, star] of source.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s*'[^']*\/schema\.js'/g)) stars.push(star);
    const named = (expression: string) => [...expression.matchAll(/(?:(\w+)\.)?(\w+)/g)].flatMap(([, scope, name]) =>
      scope === undefined ? (local.has(name) ? [local.get(name)!] : []) : stars.includes(scope) && exported.has(name) ? [exported.get(name)!] : []);
    const wrote = (table: string) => { if (!writers.has(table)) writers.set(table, new Set()); writers.get(table)!.add(file); };
    for (const match of source.matchAll(/\.(?:insert|update|delete)\(\s*((?:\w+\.)?\w+)\s*\)\s*\.(?:values|set|where|run|select|returning)\b/g)) {
      const direct = named(match[1]);
      if (direct.length) { direct.forEach(wrote); continue; }
      // A variable: the nearest value it was given before this write.
      const given = [...source.slice(0, match.index).matchAll(new RegExp(`(?:const|let|,)\\s*${match[1]}\\s*=(?!=)\\s*([^;,\\n]*)`, 'g'))].at(-1);
      const found = given ? named(given[1]) : [];
      // Every write must be attributed, or a new writer could hide behind a name this cannot follow.
      expect(found, `${file}: cannot tell which table .${match[0].slice(1, 40)} writes`).not.toEqual([]);
      found.forEach(wrote);
    }
    for (const [, table] of source.matchAll(/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?(\w+)["`]?/g)) if (names.has(table)) wrote(table);
  }
  return new Map([...writers].map(([table, files]) => [table, [...files].sort()]));
}

it('lets no second module write a household table unless it is listed here and in docs/accepted-tradeoffs.md', () => {
  // A table belongs to one module: a file, or a directory of files that are one part. Anything else that
  // writes it is named here with the table, and in the trade-offs entry "Some household tables are written
  // by more than one module" with the fact it records. A new writer from outside fails this until it is
  // either made to call the owner or listed in both places.
  const conversations = 'src/core/conversations/', signin = 'src/core/signin/', bridges = 'src/pieces/bridges/', runtime = 'src/runtime/';
  const words = 'src/core/conversations/private-bridge-words.ts';
  const shared: Record<string, { owner: string; others: string[] }> = {
    action_results: { owner: 'src/shared-action-results.ts', others: ['src/core/conversations/operations.ts'] },
    agent_run_settings: { owner: 'src/shared-agent-run-settings.ts', others: ['src/shared-secret-commands.ts'] },
    agent_status: { owner: conversations, others: [] },
    agents: { owner: 'src/apps/household.ts', others: ['src/desk-sprites.ts'] },
    approvals: { owner: 'src/apps/approvals.ts', others: ['src/shared-household-proposals.ts', 'src/shared-work-lifetime.ts'] },
    box_facts: { owner: 'src/shared-box-settings.ts', others: ['src/runtime/machines.ts'] },
    boxes: { owner: 'src/shared-machine-registry.ts', others: ['src/runtime/machines.ts', 'src/shared-box-settings.ts', 'src/shared-root.ts'] },
    bridge_connections: { owner: bridges, others: ['src/apps/household.ts'] },
    bridge_file_messages: { owner: bridges, others: [words] },
    bridge_files: { owner: bridges, others: [words] },
    bridge_incoming: { owner: bridges, others: [words] },
    bridge_sends: { owner: bridges, others: [words] },
    changes: { owner: 'src/apps/changes', others: ['src/shared-work-lifetime.ts'] },
    conversations: { owner: conversations, others: [] },
    inbox: { owner: conversations, others: ['src/core/tempo/volume.ts', 'src/runtime/jobs.ts'] },
    inbox_refs: { owner: conversations, others: [] },
    job_usage: { owner: runtime, others: ['src/core/conversations/terminal-sessions.ts', 'src/shared-job-usage.ts'] },
    jobs: { owner: runtime, others: ['src/core/conversations/terminal-sessions.ts', 'src/core/conversations/threads.ts', 'src/core/conversations/wake-delivery.ts'] },
    messages: { owner: conversations, others: ['src/runtime/jobs.ts'] },
    model_accounts: { owner: 'src/shared-model-account-admin.ts', others: ['src/runtime/account-usage.ts', 'src/runtime/account-windows.ts'] },
    notification_devices: { owner: signin, others: [] },
    notification_queue: { owner: signin, others: [] },
    passkeys: { owner: signin, others: [] },
    projects: { owner: 'src/shared-projects.ts', others: ['src/apps/household.ts'] },
    sessions: { owner: signin, others: ['src/shared-credentials.ts'] },
    signin_links: { owner: signin, others: [] },
    threads: { owner: conversations, others: ['src/runtime/jobs.ts'] },
    tokens: { owner: signin, others: ['src/shared-credentials.ts'] },
    trigger_log: { owner: 'src/core/tempo/', others: [] },
    turns: { owner: conversations, others: [] },
    wakes: { owner: 'src/core/tempo/wake-store.ts', others: [] },
  };
  const writers = tableWriters();
  expect(writers.size).toBeGreaterThan(80);
  const found: Record<string, { owner: string; others: string[] }> = {};
  for (const [table, files] of writers) {
    const entry = shared[table];
    if (!entry) { if (files.length > 1) found[table] = { owner: '?', others: files }; continue; }
    found[table] = { owner: entry.owner, others: files.filter(file => !file.startsWith(entry.owner)) };
    expect(files.some(file => file.startsWith(entry.owner)), `${table}: nothing under ${entry.owner} writes it`).toBe(true);
  }
  expect(found).toEqual(shared);
  const doc = text('docs/accepted-tradeoffs.md'), start = doc.indexOf('### Some household tables are written by more than one module');
  const bullets = doc.slice(start, doc.indexOf('\n### ', start + 1)).split(/\n {2}- /);
  for (const [table, entry] of Object.entries(shared)) for (const other of entry.others)
    expect(bullets.some(bullet => bullet.includes(`\`${other}\``) && new RegExp(`\`${table}[\`.]`).test(bullet)), `docs/accepted-tradeoffs.md does not list ${other} as a writer of ${table}`).toBe(true);
});
