/** docs/architecture.md names real files and every table. It cannot check that a sentence is true. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { plumbing, tables } from './core/data/schema.js';

const root = new URL('../', import.meta.url).pathname;
const page = readFileSync(join(root, 'docs/architecture.md'), 'utf8');
const named = new Set([...page.matchAll(/`([^`\n]+)`/g)].map(match => match[1]));

it('names only files and directories that exist', () => {
  const paths = [...named].filter(text => /^(src|docs|assets|scripts|web)(\/[\w.\-/]+)?$/.test(text) || /^[A-Z]+\.md$/.test(text) || text === 'package.json');
  expect(paths.length).toBeGreaterThan(40);
  expect(paths.filter(path => !existsSync(join(root, path)))).toEqual([]);
});

it('names every table in the household schema', () => {
  const all = [...Object.values(tables), ...Object.values(plumbing)].map(getTableName);
  expect(all.length).toBeGreaterThan(90);
  expect(all.filter(table => !named.has(table))).toEqual([]);
});

it('names every table created outside the household schema', () => {
  const sources = (directory: string): string[] => readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(join(directory, entry.name))
      : /\.ts$/.test(entry.name) && !/\.(test|fixture)\.ts$/.test(entry.name) ? [join(directory, entry.name)] : []);
  // The household schema's own upgrade steps repeat tables the schema already defines.
  const created = sources('src').filter(file => file !== 'src/core/data/database.ts').flatMap(file =>
    [...readFileSync(join(root, file), 'utf8').matchAll(/CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?[`"]?([a-z_]+)\b/g)].map(match => ({ file, table: match[1] })));
  expect(created.length).toBeGreaterThan(40);
  expect(created.filter(({ table }) => !named.has(table))).toEqual([]);
});

it('keeps test fixtures out of the build: each is named *.fixture.ts, and tsconfig excludes that name', () => {
  const files = (directory: string): string[] => readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const { exclude } = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as { exclude: string[] };
  expect(exclude).toEqual(expect.arrayContaining(['**/*.test.ts', '**/*.fixture.ts']));
  // A fixture under any other name would be compiled into dist and published.
  expect(files('src').filter(file => /fixture[^/]*\.ts$/i.test(file) && !/\.fixture\.ts$/.test(file))).toEqual([]);
  // Every path the list names must exist, so a stale entry cannot stand in for a rule.
  expect(exclude.filter(path => !path.includes('*') && !['node_modules', 'dist'].includes(path) && !existsSync(join(root, path)))).toEqual([]);
});
