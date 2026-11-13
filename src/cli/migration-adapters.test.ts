import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./household-importer.js', () => ({ importHousehold: vi.fn(() => 'household-result') }));
vi.mock('../pieces/tasks/importer.js', () => ({ importTasks: vi.fn(() => 'tasks-result') }));
vi.mock('../pieces/attention/importer.js', () => ({ importAttention: vi.fn(() => 'attention-result') }));
vi.mock(import('../pieces/clock/importer.js'), async original => ({ ...await original(), importClock: vi.fn(() => 'clock-result') }));
vi.mock('../pieces/approvals/importer.js', () => ({ importApprovals: vi.fn(() => 'approvals-result') }));
vi.mock('../pieces/changes/importer.js', () => ({ importChanges: vi.fn(() => 'changes-result') }));
vi.mock('../pieces/secrets/importer.js', () => ({ importSecrets: vi.fn(() => 'secrets-result') }));
vi.mock('../pieces/comms/importer.js', () => ({ importComms: vi.fn(async () => 'comms-result') }));
vi.mock('./migration-comms-key.js', () => ({ publishMigrationCommsKey: vi.fn() }));
import { importSecrets } from '../pieces/secrets/importer.js';
import { importComms } from '../pieces/comms/importer.js';
import { publishMigrationCommsKey } from './migration-comms-key.js';
import { openSnapshotSqlite } from './migration-sqlite.js';
import { importHousehold } from './household-importer.js';
import { importTasks } from '../pieces/tasks/importer.js';
import { importAttention } from '../pieces/attention/importer.js';
import { importClock } from '../pieces/clock/importer.js';
import { importApprovals } from '../pieces/approvals/importer.js';
import { importChanges } from '../pieces/changes/importer.js';
import { createMigrationRegistry, type MigrationContext } from './migration-registry.js';
let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
it('forwards destination, resolved inputs, options and results to all eight import functions', async () => {
  root = mkdtempSync(join(tmpdir(), 'migration-adapters-'));
  mkdirSync(join(root, 'input')); mkdirSync(join(root, 'second'));
  // Sentinel database is never opened: mocks distinguish each direct function and its arguments.
  const db = {} as MigrationContext['db'];
  const context = { db, home: '/fixture-new-home', now: 123, snapshot: { root } } as MigrationContext;
  const options = { marker: 'exact-options-object' };
  const entries = createMigrationRegistry().order().importers;
  for (const entry of entries) {
    const paths = entry.name === 'comms' ? ['comms.db','household.db','comms.key','comms.salt'].map(name => `input/${name}`)
      : entry.name === 'attention' ? ['input', 'second'] : ['input'];
    if (entry.name === 'comms') for (const path of paths) writeFileSync(join(root,path),'sentinel');
    expect(await entry.run(context, { paths, options })).toBe(`${entry.name}-result`);
  }
  const input = join(root, 'input');
  expect(importHousehold).toHaveBeenCalledExactlyOnceWith(db, context.home, input, 123);
  expect(importTasks).toHaveBeenCalledExactlyOnceWith(db, input, 123, options, openSnapshotSqlite);
  expect(importAttention).toHaveBeenCalledExactlyOnceWith(db, [input, join(root, 'second')], options, {}, openSnapshotSqlite);
  expect(importSecrets).toHaveBeenCalledExactlyOnceWith(db, context.home, input, 123, options);
  expect(importClock).toHaveBeenCalledExactlyOnceWith(db, input, 123);
  expect(importApprovals).toHaveBeenCalledExactlyOnceWith(db, input, 123, options);
  expect(importChanges).toHaveBeenCalledExactlyOnceWith(db, input, options);
  expect(publishMigrationCommsKey).toHaveBeenCalledExactlyOnceWith(join(input,'comms.key'), context.home);
  expect(importComms).toHaveBeenCalledExactlyOnceWith(db, input, context.home, {}, openSnapshotSqlite);
  for (const entry of entries.filter(e => e.name !== 'attention' && e.name !== 'comms')) expect(() => entry.run(context, { paths: [], options })).toThrow('exactly one');
});
