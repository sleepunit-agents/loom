import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as childProcess from 'node:child_process';
import { validBackupRecipient } from './backup-schema.js';
vi.mock('node:child_process', async original => {
  const real = await original<typeof childProcess>();
  const blocked = () => vi.fn(() => { throw Error('No process may run during configuration'); });
  return { ...real, spawn: blocked(), spawnSync: blocked(), exec: blocked(), execSync: blocked(), execFile: blocked(), execFileSync: blocked(), fork: blocked() };
});
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
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
const config = { target: 'path:/mnt/backups', recipients: ['age1lq8a7xcvnkxrp8ym2278tfv70yk73r6uxluqdgdfak38ftatcu7qz6vcmh'], at: '03:17', tz: 'America/Chicago', keep: 7, required: ['tasks'] };
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'next-backup-')); fixture(home);
  const app = await startLoom({ home, next: true, install: installFixture, stdout: () => {}, authenticate: () => ({ viewer: owner, valid: () => true }) });
  cleanup.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const db = new HouseholdDatabase(app.db);
  const call = (name: string, input: unknown = {}) => app.operations.call('direct', owner, `household.${name}`, input, randomUUID());
  return { app, home, db, call };
}
function revokeOwner(db: HouseholdDatabase, home: string) {
  db.change(home, raw => {
    (raw.members as unknown[]).push({ person: 'replacement', role: 'owner', agents: '*' });
    (raw.members as { person: string; agents: unknown }[]).find(m => m.person === 'jonathan')!.agents = ['art'];
  });
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
  revokeOwner(db, home);
  expect(record?.read('household', owner)).toBeUndefined();
  expect(app.operations.call('direct', owner, 'household.backupOff', {}, randomUUID())).toMatchObject({ code: 'denied' });
});
it('saves and clears rows only, leaves bundles/key/old files intact, and advertises generated bindings', async () => {
  const { home, db, call } = await setup();
  mkdirSync(join(home, 'backup')); writeFileSync(join(home, 'backup', 'drill.key'), 'private key');
  writeFileSync(join(home, 'backup', 'kept.bundle'), 'encrypted bundle sentinel');
  writeFileSync(join(home, 'household.json'), 'untouched old metadata');
  const before = db.document()!, disk = readFileSync(join(home, 'household.json'), 'utf8');
  const added = call('setBackup', { ...config, recipients: [...config.recipients, ...config.recipients] });
  expect(added).toMatchObject({ ok: true, value: { settings: config, state: 'awaiting-runner' } });
  expect(db.document()).toEqual({ ...before, backup: config });
  expect(readFileSync(join(home, 'household.json'), 'utf8')).toBe(disk);
  expect(readdirSync(join(home, 'backup'))).toEqual(['drill.key', 'kept.bundle']);
  expect(call('backupOff')).toMatchObject({ ok: true, value: { state: 'off', settings: null } });
  expect(db.document()).toEqual(before);
  expect(readFileSync(join(home, 'backup', 'drill.key'), 'utf8')).toBe('private key');
  expect(readFileSync(join(home, 'backup', 'kept.bundle'), 'utf8')).toBe('encrypted bundle sentinel');
  expect(householdCommands.filter(c => ['backup', 'setBackup', 'backupOff'].includes(c.name))).toEqual([
    { name: 'backup', write: false, positional: ['json'] }, { name: 'setBackup', write: true, positional: ['json'] }, { name: 'backupOff', write: true, positional: ['json'] },
  ]);
});
it('rejects credentials, bad schedule/keys/retention and targets inside the home including missing descendants of symlinks', async () => {
  const { home, call, db } = await setup(); const before = db.document();
  const outside = mkdtempSync(join(tmpdir(), 'backup-alias-'));
  cleanup.push(async () => rmSync(outside, { recursive: true, force: true }));
  const alias = join(outside, 'link'); symlinkSync(home, alias);
  mkdirSync(join(home, 'subdir'));
  const nested = join(outside, 'nested'); symlinkSync(join(home, 'subdir'), nested);
  const traversal = [`path:${nested}/../bundles`, `git:${nested}/../repo`, `git:file://${nested}/../repo`, `git:FILE://${nested}/%2E%2E/repo`];
  const dangling = join(outside, 'dangling'); symlinkSync(join(home, 'missing-parent'), dangling);
  for (const patch of [
    ...traversal.map(target => ({ target })),
    { target: `path:${home}/bundles` }, { target: `git:file://${home}/repo` }, { target: `git:FILE://${home}/repo` }, { target: `path:${alias}/missing/deep` }, { target: `path:${dangling}/deep` },
    { target: 'git:https://user:secret@example.com/repo' }, { target: 'git:https://example.com/repo?token=secret' },
    { target: 'git:ssh://user:secret@example.com/repo' }, { target: 'path:relative' }, { target: 'git:file:///tmp/%ZZ' }, { target: 'git:file:///tmp/%00' }, { target: 'git:-user@example.com:repo' },
    { at: '24:00' }, { tz: 'no/such-zone' }, { recipients: [] }, { recipients: ['private key'] }, { recipients: ['age1' + 'a'.repeat(40)] }, { recipients: [config.recipients[0].slice(0, -1) + 'a'] }, { recipients: ['ssh-ed25519 ' + 'A'.repeat(44)] }, { keep: 0 }, { keep: 91 }, { required: ['../secret'] },
    { alertCommand: 'never run' },
  ]) expect(call('setBackup', { ...config, ...patch })).toMatchObject({ ok: false, code: 'invalid' });
  expect(db.document()).toEqual(before);
  for (const target of [...traversal, `path:${alias}/missing/deep`, `git:FILE://${home}/repo`]) {
    db.change(home, raw => { raw.backup = { ...config, target }; });
    expect(call('backup')).toMatchObject({ ok: true, value: { settings: null, state: 'invalid' } });
  }
  for (const target of ['git:https://example.com/repo.git', 'git:git@example.com:repo', 'git:ssh://git@example.com/repo'])
    expect(call('setBackup', { ...config, target })).toMatchObject({ ok: true });
});

it('never creates a drill key or invokes any program, and rejects revoked-owner write receipt replay', async () => {
  const { app, home, call, db } = await setup();
  const id = randomUUID(), offId = randomUUID();
  expect(app.operations.call('direct', owner, 'household.setBackup', config, id)).toMatchObject({ ok: true, value: { state: 'awaiting-runner', message: expect.stringContaining('execution is not available') } });
  expect(app.operations.call('direct', owner, 'household.backupOff', {}, offId)).toMatchObject({ ok: true });
  expect(existsSync(join(home, 'backup'))).toBe(false);
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) expect(childProcess[name]).not.toHaveBeenCalled();
  revokeOwner(db, home);
  expect(app.operations.call('direct', owner, 'household.setBackup', config, id)).toMatchObject({ code: 'denied' });
  expect(app.operations.call('direct', owner, 'household.backupOff', {}, offId)).toMatchObject({ code: 'denied' });
  expect(call('backup')).toMatchObject({ code: 'denied' });
});
it('checks SSH key envelopes rather than only their prefix', () => {
  const field = (value: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(value.length); return Buffer.concat([size, value]); };
  const key = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(Buffer.from('969f57a75198e931e43be4f32b1bdbd070a5717dadb813fc674467e11dcc4c1b', 'hex'))]);
  const recipient = 'ssh-ed25519 ' + key.toString('base64') + ' fixture';
  expect(validBackupRecipient(recipient)).toBe(true);
  expect(validBackupRecipient('ssh-rsa ' + key.toString('base64'))).toBe(false);
  expect(validBackupRecipient('ssh-ed25519 ' + key.subarray(0, -1).toString('base64'))).toBe(false);
  expect(validBackupRecipient('ssh-ed25519 ' + Buffer.concat([key, Buffer.from('trailing')]).toString('base64'))).toBe(false);
});

it('publishes installed Live changes for save/off and removes retained owner records on revocation', async () => {
  const { app, home, db, call } = await setup();
  const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/live');
  cleanup.push(async () => { ws.terminate(); });
  const queue: unknown[] = [], waiting: ((message: unknown) => void)[] = [];
  ws.on('message', raw => { const message: unknown = JSON.parse(raw.toString()); const resolve = waiting.shift(); if (resolve) resolve(message); else queue.push(message); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiting.push(resolve));
  await once(ws, 'open'); ws.send(JSON.stringify({ kind: 'subscribe', type: 'household.backup' }));
  expect(await next()).toMatchObject({ kind: 'set', records: [{ id: 'household', state: 'off' }] });
  expect(call('setBackup', config)).toMatchObject({ ok: true });
  expect(await next()).toMatchObject({ kind: 'put', record: { settings: config, state: 'awaiting-runner' } });
  expect(call('backupOff')).toMatchObject({ ok: true });
  expect(await next()).toMatchObject({ kind: 'put', record: { settings: null, state: 'off' } });
  revokeOwner(db, home); app.live.changed([{ type: 'core.access', id: 'household' }]);
  expect(await next()).toMatchObject({ kind: 'set', records: [] });
});
