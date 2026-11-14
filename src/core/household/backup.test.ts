import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { fixture, installFixture } from '../../fixture.js';
import { HouseholdDatabase } from './document.js';
import { installHouseholdBackup } from './backup.js';
import type { RecordType } from '../live/index.js';
import { householdCommands } from './commands.js';
import type { Viewer } from '../../policy.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const config = { target: 'path:/mnt/backups', recipients: ['age1' + 'a'.repeat(40)], at: '03:17', tz: 'America/Chicago', keep: 7, required: ['tasks'] };
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'next-backup-')); fixture(home);
  const app = await startLoom({ home, next: true, install: installFixture, stdout: () => {} });
  cleanup.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const db = new HouseholdDatabase(app.db);
  const call = (name: string, input: unknown = {}) => app.operations.call('direct', owner, `household.${name}`, input, randomUUID());
  return { app, home, db, call };
}
it('projects imported settings without old file reads, private fields or a false scheduled/success claim', async () => {
  const { home, db, call } = await setup();
  db.change(home, raw => { raw.backup = config; raw.private = 'private'; });
  writeFileSync(join(home, 'household.json'), 'old file must not be read');
  mkdirSync(join(home, 'backup')); writeFileSync(join(home, 'backup', 'state.json'), JSON.stringify({ lastGood: { why: 'old secret', ok: true } }));
  expect(call('backup')).toEqual({ ok: true, value: { settings: config, state: 'awaiting-runner', message: expect.stringContaining('no backup is scheduled') } });
  db.change(home, raw => { raw.backup = { ...config, alertCommand: 'never execute' }; });
  expect(call('backup')).toMatchObject({ ok: true, value: { settings: null, state: 'invalid' } });
  expect(JSON.stringify(call('backup'))).not.toContain('never execute');
  db.change(home, raw => { delete raw.backup; });
  expect(call('backup')).toMatchObject({ ok: true, value: { settings: null, state: 'off' } });
});
it('uses current household ownership for every door and live projection', async () => {
  const { app, db, home } = await setup(); db.change(home, raw => { raw.backup = config; });
  const denied: Viewer[] = [{ kind: 'member', id: 'pollock' }, { kind: 'member', id: 'missing' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'box' }, { kind: 'service', id: 'sharing' }];
  for (const door of ['direct', 'http', 'mcp', 'socket'] as const) {
    expect(app.operations.call(door, owner, 'household.backup', {})).toMatchObject({ ok: true });
    for (const viewer of denied) for (const name of ['backup', 'setBackup', 'backupOff'])
      expect(app.operations.call(door, viewer, `household.${name}`, name === 'setBackup' ? config : {}, randomUUID())).toMatchObject({ code: 'denied' });
  }
  const types = new Map<string, RecordType>();
  installHouseholdBackup({ ...app, operations: { register: () => {} }, live: { register: (t: RecordType) => types.set(t.name, t) } } as unknown as Parameters<typeof installHouseholdBackup>[0], home);
  const record = types.get('household.backup');
  expect(record?.read('household', owner)).toMatchObject({ id: 'household', settings: config });
  for (const viewer of denied) expect(record?.read('household', viewer)).toBeUndefined();
  db.change(home, raw => { (raw.members as unknown[]).push({ person: 'replacement', role: 'owner', agents: '*' }); (raw.members as { person: string; agents: unknown }[]).find(m => m.person === 'jonathan')!.agents = ['art']; });
  expect(record?.read('household', owner)).toBeUndefined();
  expect(app.operations.call('direct', owner, 'household.backupOff', {}, randomUUID())).toMatchObject({ code: 'denied' });
});
it('saves and clears rows only, leaves bundles/key/old files intact, and advertises generated bindings', async () => {
  const { home, db, call } = await setup();
  mkdirSync(join(home, 'backup')); writeFileSync(join(home, 'backup', 'drill.key'), 'private key');
  writeFileSync(join(home, 'household.json'), 'untouched old metadata');
  const before = db.document()!, disk = readFileSync(join(home, 'household.json'), 'utf8');
  const added = call('setBackup', { ...config, recipients: [...config.recipients, ...config.recipients] });
  expect(added).toMatchObject({ ok: true, value: { settings: config, state: 'awaiting-runner' } });
  expect(db.document()).toEqual({ ...before, backup: config });
  expect(readFileSync(join(home, 'household.json'), 'utf8')).toBe(disk);
  expect(readdirSync(join(home, 'backup'))).toEqual(['drill.key']);
  expect(call('backupOff')).toMatchObject({ ok: true, value: { state: 'off', settings: null } });
  expect(db.document()).toEqual(before);
  expect(readFileSync(join(home, 'backup', 'drill.key'), 'utf8')).toBe('private key');
  expect(householdCommands.filter(c => ['backup', 'setBackup', 'backupOff'].includes(c.name))).toEqual([
    { name: 'backup', write: false, positional: ['json'] }, { name: 'setBackup', write: true, positional: ['json'] }, { name: 'backupOff', write: true, positional: ['json'] },
  ]);
});
it('rejects credentials, bad schedule/keys/retention and targets inside the home including missing descendants of symlinks', async () => {
  const { home, call, db } = await setup(); const before = db.document();
  const alias = join(home, 'outside-link'); symlinkSync(home, alias);
  for (const patch of [
    { target: `path:${home}/bundles` }, { target: `git:file://${home}/repo` }, { target: `path:${alias}/missing/deep` },
    { target: 'git:https://user:secret@example.com/repo' }, { target: 'git:https://example.com/repo?token=secret' },
    { target: 'git:ssh://user:secret@example.com/repo' }, { target: 'path:relative' }, { target: 'git:file:///tmp/%ZZ' }, { target: 'git:file:///tmp/%00' }, { target: 'git:-user@example.com:repo' },
    { at: '24:00' }, { tz: 'no/such-zone' }, { recipients: [] }, { recipients: ['private key'] }, { keep: 0 }, { keep: 91 }, { required: ['../secret'] },
    { alertCommand: 'never run' },
  ]) expect(call('setBackup', { ...config, ...patch })).toMatchObject({ ok: false, code: 'invalid' });
  expect(db.document()).toEqual(before);
  for (const target of ['git:https://example.com/repo.git', 'git:git@example.com:repo', 'git:ssh://git@example.com/repo'])
    expect(call('setBackup', { ...config, target })).toMatchObject({ ok: true });
});
