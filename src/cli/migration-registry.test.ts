import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MigrationRegistry, createMigrationRegistry, snapshotPath, type MigrationContext } from './migration-registry.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('orders shared dependencies once and reports unavailable pieces', () => {
  const registry = new MigrationRegistry();
  for (const [name, dependencies] of [['leaf', ['base']], ['base', []], ['other', ['base']]] as const) {
    registry.register({ name, dependencies, reads: [], run: () => undefined });
  }
  const result = registry.order(['leaf', 'other', 'comms', 'comms']);
  expect(result.importers.map(i => i.name)).toEqual(['base', 'leaf', 'other']);
  expect(result.missing).toEqual(['comms']);
});
it('refuses cycles, duplicate names and invalid names', () => {
  const registry = new MigrationRegistry();
  registry.register({ name: 'a', dependencies: ['b'], reads: [], run: () => undefined });
  registry.register({ name: 'b', dependencies: ['a'], reads: [], run: () => undefined });
  expect(() => registry.order()).toThrow('cycle');
  expect(() => registry.register({ name: 'a', dependencies: [], reads: [], run: () => undefined })).toThrow();
  expect(() => registry.register({ name: '../bad', dependencies: [], reads: [], run: () => undefined })).toThrow();
});
it('registers the nine current importers with household first and declared reads', () => {
  const result = createMigrationRegistry().order();
  expect(result.missing).toEqual([]);
  expect(result.importers.map(i => i.name)).toEqual(['household', 'tasks', 'attention', 'clock', 'approvals', 'changes', 'comms', 'secrets', 'runtime']);
  expect(result.importers.every(i => i.reads.length > 0)).toBe(true);
});
it('confines input files and directories to the snapshot, including symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-registry-')); roots.push(root);
  const snapshot = join(root, 'snapshot'); mkdirSync(snapshot); mkdirSync(join(snapshot, 'home'));
  writeFileSync(join(snapshot, 'home', 'input'), 'fixture'); writeFileSync(join(root, 'outside'), 'private');
  symlinkSync(join(root, 'outside'), join(snapshot, 'escape'));
  const context = { snapshot: { root: snapshot } } as MigrationContext;
  expect(snapshotPath(context, 'home/input')).toBe(join(snapshot, 'home/input'));
  expect(snapshotPath(context, 'home')).toBe(join(snapshot, 'home'));
  for (const path of ['.', '../outside', join(root, 'outside'), 'escape', 'missing']) expect(() => snapshotPath(context, path)).toThrow();
});

it('blocks transitive dependents of an unavailable registration without running them', () => {
  const registry = new MigrationRegistry();
  registry.register({ name: 'leaf', dependencies: ['middle'], reads: [], run: () => { throw Error('must not run'); } });
  registry.register({ name: 'middle', dependencies: ['absent'], reads: [], run: () => { throw Error('must not run'); } });
  const result = registry.order(['leaf']);
  expect(result.importers).toEqual([]);
  expect(result.missing).toEqual(['absent']);
  expect(result.blocked).toEqual(['leaf', 'middle']);
});

it('uses registration order to break ties regardless of requested order', () => {
  expect(createMigrationRegistry().order(['changes', 'tasks']).importers.map(i => i.name)).toEqual(['household', 'tasks', 'changes']);
});
it('rejects child symlinks inside a directory input', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-child-')); roots.push(root);
  mkdirSync(join(root, 'home', 'nested'), { recursive: true }); writeFileSync(join(root, 'outside'), 'private');
  symlinkSync(join(root, 'outside'), join(root, 'home', 'nested', 'household.json'));
  const context = { snapshot: { root } } as MigrationContext;
  expect(() => snapshotPath(context, 'home')).toThrow('symlink');
});

it('rejects a socket inside a directory input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-socket-')); roots.push(root);
  mkdirSync(join(root, 'home', 'nested'), { recursive: true });
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(root, 'home', 'nested', 'socket'), resolve); });
  try {
    expect(() => snapshotPath({ snapshot: { root } } as MigrationContext, 'home')).toThrow('special file');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
it('includes household for each individual piece request', () => {
  for (const name of ['tasks', 'attention', 'clock', 'approvals', 'changes']) {
    expect(createMigrationRegistry().order([name]).importers.map(i => i.name)).toEqual(['household', name]);
  }
});
it('chooses the earliest registered ready importer after each dependency is emitted', () => {
  const registry = new MigrationRegistry();
  for (const [name, dependencies] of [['dependent', ['late']], ['independent', []], ['late', []]] as const) {
    registry.register({ name, dependencies, reads: [], run: () => undefined });
  }
  expect(registry.order(['dependent', 'independent']).importers.map(i => i.name)).toEqual(['independent', 'late', 'dependent']);
});
