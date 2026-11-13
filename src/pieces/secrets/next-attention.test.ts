import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { fixture } from '../../fixture.js';
import { FakeClock, type Result, type Viewer } from '../../core/index.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { readSecretPolicy } from './policy.js';
import { grantsRole } from './index.js';
import type { GrantRequest } from './role.js';
import type { Ask } from '../attention/role.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const agent: Viewer = { kind: 'agent', id: 'pond-bot' };
const homes: string[] = [], apps: Awaited<ReturnType<typeof startLoom>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function value<T>(r: Result): T { expect(r.ok).toBe(true); if (!r.ok) throw Error(r.code); return r.value as T; }
async function setup(existing?: string) {
  const home = existing ?? mkdtempSync(join(tmpdir(), 'secrets-next-attention-'));
  if (!existing) { homes.push(home); fixture(home); }
  const clock = new FakeClock(1_800_000_000_000);
  const app = await startLoom({ home, next: true, staging: true, host: '127.0.0.1', port: 0, clock, stdout() {} }); apps.push(app);
  const call = (op: string, input: unknown, viewer = owner, id = randomUUID()) => app.operations.call('direct', viewer, op, input, id);
  const may = () => grantsRole(app.db).mayUse(agent.id, { kind: 'secret', target: 'api-key' }, clock.now(), { house: 'h-1' });
  if (!existing) value(call('secrets.describe', { name: 'api-key', description: '' }));
  const request = () => value<GrantRequest>(call('secrets.requestHouse', { agent: agent.id, target: 'api-key', scope: { house: 'h-1' }, why: 'deploy', minutes: 2 }, agent));
  const ask = (id: string) => value<Ask>(call('attention.get', { id }));
  return { app, home, clock, call, may, request, ask };
}
it('normal next root creates managed household asks without holder configuration and attributes the real answer', async () => {
  const { app, call, request, ask, may, clock } = await setup();
  const r = request();
  expect(request()).toEqual(r);
  expect(r.attentionManaged).toBe(true);
  expect(ask(r.id)).toMatchObject({ state: 'open', sourceManaged: true, source: { kind: 'piece', id: 'secrets' } });
  expect(may()).toBe(false);
  for (const viewer of [agent, { kind: 'member', id: 'pollock' }, { kind: 'runner', id: 'one' }, { kind: 'service', id: 'secrets' }] as Viewer[]) {
    expect(call('attention.answer', { id: r.id, answer: { kind: 'yes' } }, viewer)).toMatchObject({ ok: false, code: 'denied' });
  }
  const household = new HouseholdDatabase(app.db);
  const document = household.document()!;
  app.db.transaction(() => household.replace('', { ...document, members: [...(document.members as Array<Record<string, unknown>>), { person: 'dana', role: 'owner', agents: '*' }] }))();
  value(call('attention.answer', { id: r.id, answer: { kind: 'yes' } }, { kind: 'member', id: 'dana' }));
  expect(ask(r.id).answer?.by).toEqual({ kind: 'member', id: 'dana' });
  expect(value<{requests: GrantRequest[]; grants: {by: string}[]}>(call('secrets.list', {}))).toMatchObject({ requests: [{ state: 'allowed', by: 'dana' }], grants: [{ by: 'dana' }] });
  expect(may()).toBe(true);
  expect(call('attention.answer', { id: r.id, answer: { kind: 'no' } })).toMatchObject({ ok: false, code: 'conflict' });
  clock.advance(120_000); expect(may()).toBe(false);
  expect(readSecretPolicy(app.db)).toEqual({ default: 'ask', secrets: {} });
});
it.each(['no', 'done', 'dismiss'] as const)('root %s answer denies without adding Always permission', async kind => {
  const { call, request, may, app } = await setup();
  const r = request();
  const policy = app.db.prepare("SELECT * FROM secrets_meta WHERE key='policy'").all();
  value(call('attention.answer', { id: r.id, answer: { kind } }));
  expect(may()).toBe(false);
  expect(value<{requests: GrantRequest[]}>(call('secrets.list', {})).requests[0]).toMatchObject({ state: 'denied', by: 'jonathan' });
  expect(app.db.prepare("SELECT * FROM secrets_meta WHERE key='policy'").all()).toEqual(policy);
});
it('root reconnects a persisted managed request on restart and rolls back failed answers and retry receipts', async () => {
  const first = await setup(); const r = first.request();
  await first.app.close();
  const { app, call, ask, may } = await setup(first.home);
  const rows = () => app.db.prepare('SELECT * FROM core_operations ORDER BY viewer,id').all();
  const before = rows(); const changed = vi.spyOn(app.live, 'changed');
  app.db.exec("CREATE TRIGGER reject_grant BEFORE INSERT ON secrets_grants BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  const input = { id: r.id, answer: { kind: 'yes' } };
  expect(call('attention.answer', input, owner, 'retry-answer')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(ask(r.id).state).toBe('open'); expect(may()).toBe(false); expect(rows()).toEqual(before); expect(changed).not.toHaveBeenCalled();
  app.db.exec('DROP TRIGGER reject_grant');
  value(call('attention.answer', input, owner, 'retry-answer')); expect(may()).toBe(true);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0]).toEqual(expect.arrayContaining([{ type: 'attention.ask', id: r.id }, { type: 'secret.request', id: r.id }]));
});
it('root direct denial resolves the managed ask and prevents later Attention approval', async () => {
  const { call, request, ask, may } = await setup(); const r = request();
  value(call('secrets.answer', { id: r.id, allow: false }));
  expect(ask(r.id)).toMatchObject({ state: 'resolved', resolution: 'Grant request denied' });
  expect(call('attention.answer', { id: r.id, answer: { kind: 'yes' } })).toMatchObject({ ok: false, code: 'conflict' });
  expect(may()).toBe(false);
});
