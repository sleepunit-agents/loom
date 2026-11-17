/** Rules about stored data that nothing else ties together. Each fails when a second copy or a shortcut comes back. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = new URL('../', import.meta.url).pathname;
const sources = (directory: string): string[] => readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(directory, entry.name))
    : /\.ts$/.test(entry.name) && !/\.(test|fixture)\.ts$/.test(entry.name) ? [join(directory, entry.name)] : []);
const text = (file: string) => readFileSync(join(root, file), 'utf8');

it('names the columns of every insert into a household table or a memory receipt table', () => {
  // An upgraded household database can hold a table's columns in another order than a fresh one
  // (an added column lands last), and recognition accepts that. So a value is never placed by position.
  const tables = new Set([...text('src/core/data/schema.ts').matchAll(/sqliteTable\(\s*'([a-z_]+)'/g)].map(match => match[1]));
  expect(tables.size).toBeGreaterThan(80);
  for (const name of ['mind_operation_receipts', 'mind_source_migrations', 'memory_command_receipts', 'memory_command_preparations']) tables.add(name);
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
