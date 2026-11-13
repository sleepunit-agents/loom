import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { fixture, fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { grantsRole, installSecrets } from './index.js';
import { installSecretValues } from './values.js';
import { readSecretPolicy } from './policy.js';
import type { GrantRequest } from './role.js';
import type { KeyHolder } from './keyholder.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const agent: Viewer = { kind: 'agent', id: 'pond-bot' };
const snapshot = (db: {prepare(sql: string): {all(): unknown}}) => ['secrets_names', 'secrets_grants', 'secrets_requests', 'secrets_meta', 'core_operations'].map(t => db.prepare(`SELECT * FROM ${t}`).all());
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'loom-secret-remove-')); homes.push(home); fixture(home);
  const removed = new Map<string, string>();
  const holder: KeyHolder = { names: () => [], set() {}, handTo() {}, rotate() {}, remove: vi.fn((name, id) => {
    if (removed.has(id) && removed.get(id) !== name) throw Error('write id conflict');
    removed.set(id, name);
  }) };
  const clock = new FakeClock();
  const app = await startLoom({ home, next: true, staging: true, clock, sharing: fixtureSharing, install: a => {
    installSecrets(a.db, a.operations, a.live, fixtureSharing, { raise: () => ({ raised: true }) });
    installSecretValues(a.db, a.operations, fixtureSharing, holder, Buffer.alloc(32, 1));
  } }); closes.push(app.close);
  let seq = 0;
  const call = (name: string, input: unknown, viewer = owner, id = `op-${++seq}`) => app.operations.call('direct', viewer, `secrets.${name}`, input, id);
  const request = (house: string, target = 'api-key') => {
    const r = call('requestHouse', { agent: agent.id, target, scope: { house }, why: 'deploy' }, agent);
    expect(r.ok).toBe(true); return r.ok ? r.value as GrantRequest : undefined!;
  };
  call('describe', { name: 'api-key', description: 'token' });
  return { app, clock, call, request, holder, removed };
}
it('removes all secret scopes and pending access without touching another resource; re-add starts by asking', async () => {
  const { app, clock, call, request, holder } = await setup();
  const first = request('h-1'); call('answer', { id: first.id, allow: true });
  const carried = request('h-2'); expect(carried.carriedFrom).toBe(first.id);
  const pending = request('h-3');
  call('grant', { agent: 'art', kind: 'secret', target: 'api-key' });
  call('grant', { agent: 'art', kind: 'piece', target: 'api-key' });
  call('grant', { agent: 'art', kind: 'secret', target: 'other-key' });
  call('policy', { default: 'auto', secrets: { 'api-key': { grant: 'auto', agents: [agent.id], houses: ['art'], minutes: 30 }, 'other-key': { grant: 'never' } } });
  const originals = (app.db.prepare('SELECT record FROM secrets_requests').all() as {record: string}[]).map(r => JSON.parse(r.record));
  const input = { name: 'api-key', writeId: randomUUID() };
  const changed = vi.spyOn(app.live, 'changed');
  expect(call('remove', input)).toEqual({ ok: true, value: { removed: true } });
  expect(holder.remove).toHaveBeenCalledWith(input.name, `remove:jonathan:${input.writeId}`);
  expect(app.db.prepare('SELECT * FROM secrets_names').all()).toEqual([]);
  expect(app.db.prepare("SELECT * FROM secrets_grants WHERE kind='secret' AND target='api-key'").all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM secrets_grants').all()).toHaveLength(2);
  const requests = app.db.prepare('SELECT record FROM secrets_requests').all() as {record: string}[];
  expect(requests.map(r => JSON.parse(r.record))).toEqual(originals.map(r => ({...r, state: r.state === 'pending' ? 'cancelled' : 'revoked'})));
  expect(readSecretPolicy(app.db)).toEqual({ default: 'auto', secrets: { 'api-key': { grant: 'ask', houses: ['art'], minutes: 30 }, 'other-key': { grant: 'never' } } });
  expect(grantsRole(app.db).mayUse(agent.id, {kind: 'secret', target: 'api-key'}, clock.now(), {house: 'h-2'})).toBe(false);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0]).toHaveLength(9);
  expect(changed.mock.calls[0][0]).toContainEqual({type: 'secret.name', id: 'api-key'});
  expect(changed.mock.calls[0][0]).toContainEqual({type: 'secret.request', id: pending.id});
  expect(call('answer', { id: pending.id, allow: true })).toMatchObject({ ok: false, code: 'conflict' });
  call('describe', { name: 'api-key', description: 'new' });
  expect(request('h-1').state).toBe('pending');
  // A duplicate stable write through a new operation must not remove a later addition.
  changed.mockClear();
  expect(call('remove', input)).toEqual({ ok: true, value: { removed: true } });
  expect(holder.remove).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
  expect(call('remove', { ...input, name: 'other-key' })).toMatchObject({ ok: false, code: 'conflict' });
  expect(app.db.prepare('SELECT id FROM secrets_names').all()).toEqual([{id: 'api-key'}]);
});
it('denies nonowners, missing names and injected fields before touching the holder; redacts holder failure', async () => {
  const { app, call, holder } = await setup();
  const input = { name: 'api-key', writeId: randomUUID() };
  for (const viewer of [agent, {kind: 'member', id: 'pollock'}, {kind: 'runner', id: 'one'}, {kind: 'service', id: 'keyholder'}] as Viewer[]) {
    expect(call('remove', input, viewer)).toMatchObject({ ok: false, code: 'denied' });
  }
  expect(call('remove', {...input, name: 'missing'})).toMatchObject({ ok: false, code: 'not-found' });
  for (const invalid of [
    {...input, value: 'SENTINEL'}, {...input, name: '../key'}, {...input, name: ''},
    {writeId: input.writeId}, {name: input.name}, {...input, writeId: ''}, {...input, writeId: 'not-a-uuid'},
  ]) expect(call('remove', invalid)).toMatchObject({ ok: false, code: 'invalid' });
  expect(holder.remove).not.toHaveBeenCalled();
  vi.mocked(holder.remove).mockImplementation(() => { throw Error('SENTINEL'); });
  const before = app.db.prepare('SELECT * FROM secrets_names').all();
  expect(call('remove', input)).toEqual({ ok: false, code: 'unavailable', message: 'Key holder could not remove the secret' });
  expect(app.db.prepare('SELECT * FROM secrets_names').all()).toEqual(before);
  expect(JSON.stringify(app.db.prepare('SELECT * FROM core_operations').all())).not.toContain('SENTINEL');
});
it('rolls metadata and Live back after holder success, retries the same write id, and preserves never', async () => {
  const { app, call, request, holder, removed } = await setup();
  const pending = request('h-4');
  call('grant', { agent: agent.id, kind: 'secret', target: 'api-key' });
  call('policy', { secrets: { 'api-key': {grant: 'never', houses: ['art']} } });
  const rows = () => snapshot(app.db);
  const before = rows(), changed = vi.spyOn(app.live, 'changed');
  app.db.exec("CREATE TRIGGER reject_remove BEFORE DELETE ON secrets_names BEGIN SELECT RAISE(ABORT, 'failure'); END");
  const input = { name: 'api-key', writeId: randomUUID() };
  expect(call('remove', input, owner, 'retry-remove')).toMatchObject({ok: false, code: 'unavailable'});
  expect(removed.size).toBe(1); expect(rows()).toEqual(before); expect(changed).not.toHaveBeenCalled();
  app.db.exec('DROP TRIGGER reject_remove');
  expect(call('remove', input, owner, 'retry-remove')).toEqual({ok: true, value: {removed: true}});
  expect(removed.size).toBe(1); expect(holder.remove).toHaveBeenCalledTimes(2);
  expect(readSecretPolicy(app.db).secrets['api-key']).toEqual({grant: 'never', houses: ['art']});
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0]).toHaveLength(4);
  expect(changed.mock.calls[0][0]).toContainEqual({type: 'secret.request', id: pending.id});
});
it('removal overrides inherited auto but preserves ask and never policy and separate start mappings', async () => {
  const { app, call } = await setup();
  for (const rule of [undefined, { houses: ['art'] }, {grant: 'ask' as const, houses: ['art']}, {grant: 'never' as const, houses: ['art']}]) {
    call('describe', {name: 'api-key', description: ''});
    call('policy', {default: 'auto', secrets: rule ? {'api-key': rule} : {}});
    expect(call('remove', {name: 'api-key', writeId: randomUUID()}).ok).toBe(true);
    expect(readSecretPolicy(app.db).secrets['api-key']).toEqual({...rule, grant: rule?.grant ?? 'ask'});
  }
});
it('rejects an asynchronous holder before committing metadata', async () => {
  const { app, call, holder } = await setup();
  vi.mocked(holder.remove).mockImplementation(async () => { throw Error('SENTINEL'); });
  const before = app.db.prepare('SELECT * FROM secrets_names').all();
  expect(call('remove', {name: 'api-key', writeId: randomUUID()})).toEqual({ok: false, code: 'unavailable', message: 'Key holder could not remove the secret'});
  expect(app.db.prepare('SELECT * FROM secrets_names').all()).toEqual(before);
});

it('suppresses successful holder output and rolls back even after removal and auto-policy cleanup', async () => {
  const {app, call, request, holder} = await setup();
  const pending = request('h-9');
  call('grant', {agent: agent.id, kind: 'secret', target: 'api-key'});
  call('policy', {secrets: {'api-key': {grant: 'auto', agents: [agent.id]}}});
  vi.mocked(holder.remove).mockImplementation(() => 'HOLDER-OUTPUT-SENTINEL');
  const rows = () => snapshot(app.db);
  const before = rows(), changed = vi.spyOn(app.live, 'changed');
  // Fail after name/policy/request/grant deletion and the stable write receipt.
  app.db.exec("CREATE TRIGGER reject_remove_receipt BEFORE INSERT ON core_operations WHEN NEW.name='secrets.remove' BEGIN SELECT RAISE(ABORT, 'failure'); END");
  const input = {name: 'api-key', writeId: randomUUID()};
  expect(call('remove', input, owner, 'last-write-retry')).toMatchObject({ok: false, code: 'unavailable'});
  expect(rows()).toEqual(before); expect(changed).not.toHaveBeenCalled();
  app.db.exec('DROP TRIGGER reject_remove_receipt');
  const result = call('remove', input, owner, 'last-write-retry');
  expect(result).toEqual({ok: true, value: {removed: true}});
  expect(JSON.stringify([result, rows(), changed.mock.calls])).not.toContain('HOLDER-OUTPUT-SENTINEL');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0]).toHaveLength(5);
  expect(changed.mock.calls[0][0]).toContainEqual({type: 'secret.request', id: pending.id});
});
