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
  expect(text('src/pieces/mind/knowledge-sweep.ts')).toMatch(/CHECK_INTERVAL = CHECK_DAYS \* 86_400_000/);
});

it('declares what the dispatcher asks of a receipt store once', () => {
  const declared = sources('src').filter(file => /interface (?:ReceiptPersistence|OperationReceipt)\b/.test(text(file)));
  expect(declared).toEqual(['src/core/operations/receipts.ts']);
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
