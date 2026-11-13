import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { fixtureSharing } from '../../fixture.js';
import { FakeClock, type Viewer, type Result } from '../../core/index.js';
import { installAttention } from '../attention/index.js';
import type { Ask } from '../attention/role.js';
import { installSecrets, grantsRole, type GrantAttention } from './index.js';
import { secretGrantAttention } from './attention.js';
import { installSecretValues } from './values.js';
import type { GrantRequest } from './role.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const agent: Viewer = { kind: 'agent', id: 'pond-bot' };
const homes: string[] = [], closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const value = <T>(result: Result): T => { expect(result.ok).toBe(true); if (!result.ok) throw Error(result.code); return result.value as T; };
async function setup(existingHome?: string, connected = true) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'loom-secret-attention-')); if (!existingHome) homes.push(home);
  const clock = new FakeClock();
  const sharing = () => ({ ...fixtureSharing(), members: { ...fixtureSharing().members, dana: { owner: true, agents: [] } }, services: { reader: { types: ['attention.ask'], operations: ['attention.answer', 'attention.raise', 'attention.resolve'] } } });
  let connector: GrantAttention | undefined;
  const app = await startLoom({ home, clock, sharing, install: a => {
    const sources = installAttention(a.db, a.operations, a.live, sharing);
    const attention = connected ? secretGrantAttention(sources, a.operations) : undefined;
    connector = attention;
    installSecrets(a.db, a.operations, a.live, sharing, attention);
    installSecretValues(a.db, a.operations, sharing, { names: () => [], set() {}, remove() {}, rotate() {}, handTo() {} }, attention);
  } }); closes.push(app.close);
  let seq = 0; const session = randomUUID();
  const call = (name: string, input: unknown, viewer = owner, id = `op-${session}-${++seq}`) => app.operations.call('direct', viewer, name, input, id);
  if (!existingHome) value(call('secrets.describe', { name: 'api-key', description: '' }));
  const request = (house = 'h-1') => value<GrantRequest>(call('secrets.requestHouse', { agent: agent.id, target: 'api-key', scope: { house }, why: 'deploy', minutes: 2 }, agent));
  const ask = (id: string) => value<Ask>(call('attention.get', { id }));
  const may = (house = 'h-1') => grantsRole(app.db).mayUse(agent.id, { kind: 'secret', target: 'api-key' }, clock.now(), { house });
  return { home, app, call, request, ask, may, clock, connector: connector! };
}
it('raises a household ask from an agent request and atomically applies only the first household answer', async () => {
  const { app, call, request, ask, may, clock } = await setup();
  const r = request();
  expect(request()).toEqual(r);
  expect(app.db.prepare('SELECT * FROM attention_asks').all()).toHaveLength(1);
  expect(ask(r.id)).toMatchObject({ id: r.id, state: 'open', sourceManaged: true, source: { kind: 'piece', id: 'secrets' }, answers: 'yes-no' });
  for (const key of ['agent', 'project', 'member']) expect(ask(r.id)).not.toHaveProperty(key);
  expect(may()).toBe(false);
  for (const viewer of [agent, { kind: 'member', id: 'pollock' }, { kind: 'runner', id: 'one' }, { kind: 'service', id: 'reader' }] as Viewer[]) {
    expect(call('attention.answer', { id: r.id, answer: { kind: 'yes' } }, viewer)).toMatchObject({ ok: false, code: 'denied' });
  }
  const changed = vi.spyOn(app.live, 'changed');
  const answer = { id: r.id, answer: { kind: 'yes' } };
  const secondOwner: Viewer = { kind: 'member', id: 'dana' };
  expect(value<Ask>(call('attention.answer', answer, secondOwner, 'answer-once')).answer).toMatchObject({ kind: 'yes', by: secondOwner });
  const stored = value<{requests: GrantRequest[]; grants: {by: string}[]}>(call('secrets.list', {}));
  expect(stored.requests[0].by).toBe('dana'); expect(stored.grants[0].by).toBe('dana');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0]).toEqual(expect.arrayContaining([{ type: 'attention.ask', id: r.id }, { type: 'secret.request', id: r.id }]));
  expect(may()).toBe(true); expect(may('h-2')).toBe(false);
  expect(call('attention.answer', { id: r.id, answer: { kind: 'no' } })).toMatchObject({ ok: false, code: 'conflict' });
  expect(call('secrets.answer', { id: r.id, allow: false })).toMatchObject({ ok: false, code: 'conflict' });
  clock.advance(120_000); expect(may()).toBe(false);
  expect(call('attention.answer', answer, secondOwner, 'answer-once').ok).toBe(true);
  expect(may()).toBe(false);
});
it('rolls back ask, grant, request and nested retry receipt if applying an answer fails, then retries cleanly', async () => {
  const { app, call, request, ask, may } = await setup();
  const r = request();
  const before = app.db.prepare('SELECT * FROM core_operations ORDER BY viewer,id').all();
  app.db.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON secrets_grants BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  const changed = vi.spyOn(app.live, 'changed');
  const input = { id: r.id, answer: { kind: 'yes' } };
  expect(call('attention.answer', input, owner, 'retry-answer')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(ask(r.id).state).toBe('open'); expect(may()).toBe(false);
  expect(value<{requests: GrantRequest[]}>(call('secrets.list', {})).requests[0].state).toBe('pending');
  expect(app.db.prepare('SELECT * FROM core_operations ORDER BY viewer,id').all()).toEqual(before);
  expect(changed).not.toHaveBeenCalled();
  app.db.exec('DROP TRIGGER fail_grant');
  expect(call('attention.answer', input, owner, 'retry-answer').ok).toBe(true); expect(may()).toBe(true);
});
it('resolves on direct secret answers and removal; public operations cannot forge or detach a managed ask', async () => {
  const { call, request, ask, may } = await setup();
  const r = request();
  for (const id of [r.id, 'forged']) {
    expect(call('attention.raise', { id, ask: 'Forged?', answers: 'yes-no', source: { kind: 'piece', id: 'secrets' } })).toMatchObject({ ok: false, code: 'denied' });
  }
  expect(call('attention.resolve', { id: r.id, reason: 'Skip the grant' })).toMatchObject({ ok: false, code: 'denied' });
  expect(call('attention.raise', { id: r.id, ask: 'Other source', source: { kind: 'piece', id: 'other' } })).toMatchObject({ ok: false, code: 'denied' });
  value(call('secrets.answer', { id: r.id, allow: false }));
  expect(ask(r.id)).toMatchObject({ state: 'resolved', resolution: 'Grant request denied' }); expect(may()).toBe(false);
  const next = request('h-2');
  value(call('secrets.remove', { name: 'api-key', writeId: randomUUID() }));
  expect(ask(next.id)).toMatchObject({ state: 'resolved', resolution: 'Grant request cancelled' });
  expect(call('attention.answer', { id: next.id, answer: { kind: 'yes' } })).toMatchObject({ ok: false, code: 'conflict' });
});
it.each(['no', 'dismiss', 'done'] as const)('treats %s as no permission and never revives it', async kind => {
  const { call, request, may } = await setup(); const r = request();
  value(call('attention.answer', { id: r.id, answer: { kind } }));
  expect(may()).toBe(false);
  expect(call('secrets.answer', { id: r.id, allow: true })).toMatchObject({ ok: false, code: 'conflict' });
});
it('does not leak an orphan request if raising attention fails', async () => {
  const { app, call } = await setup();
  app.db.exec("CREATE TRIGGER fail_ask BEFORE INSERT ON attention_asks BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  expect(call('secrets.requestHouse', { agent: agent.id, target: 'api-key', scope: { house: 'h-1' }, why: 'work' }, agent, 'request-retry')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(app.db.prepare('SELECT * FROM secrets_requests').all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM attention_asks').all()).toEqual([]);
  expect(app.db.prepare("SELECT * FROM core_operations WHERE name='secrets.requestHouse'").all()).toEqual([]);
});
it('rolls back cancellation and direct answers when attention cannot resolve, and retries the same write', async () => {
  const { app, call, request, ask, may } = await setup(); const r = request();
  const snapshot = () => ['attention_asks', 'secrets_names', 'secrets_requests', 'secrets_grants', 'secrets_meta', 'secrets_changes', 'core_operations'].map(t => app.db.prepare(`SELECT * FROM ${t}`).all());
  const before = snapshot();
  app.db.exec("CREATE TRIGGER fail_resolve BEFORE UPDATE ON attention_asks BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  const changed = vi.spyOn(app.live, 'changed');
  const remove = { name: 'api-key', writeId: randomUUID() };
  expect(call('secrets.remove', remove, owner, 'remove-retry')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(snapshot()).toEqual(before); expect(changed).not.toHaveBeenCalled();
  expect(call('secrets.answer', { id: r.id, allow: true, always: true }, owner, 'always-retry')).toMatchObject({ ok: false, code: 'unavailable' });
  expect(snapshot()).toEqual(before); expect(may()).toBe(false);
  app.db.exec('DROP TRIGGER fail_resolve');
  expect(call('secrets.answer', { id: r.id, allow: true, always: true }, owner, 'always-retry').ok).toBe(true);
  expect(ask(r.id)).toMatchObject({ state: 'resolved', resolution: 'Grant request allowed' }); expect(may()).toBe(true);
  expect(call('secrets.remove', remove, owner, 'remove-retry').ok).toBe(true); expect(may()).toBe(false);
});
it('fails closed for direct answers and removal after restart without the secrets connector', async () => {
  const first = await setup(); const r = first.request();
  expect(r.attentionManaged).toBe(true);
  await first.app.close(); closes.pop();
  const { app, call, ask, may } = await setup(first.home, false);
  const snapshot = () => ['attention_asks', 'secrets_names', 'secrets_requests', 'secrets_grants', 'secrets_meta', 'secrets_changes', 'core_operations'].map(t => app.db.prepare(`SELECT * FROM ${t}`).all());
  const before = snapshot(); const changed = vi.spyOn(app.live, 'changed');
  expect(call('secrets.answer', { id: r.id, allow: true, always: true })).toMatchObject({ ok: false, code: 'unavailable' });
  expect(snapshot()).toEqual(before); expect(may()).toBe(false);
  expect(call('secrets.remove', { name: 'api-key', writeId: randomUUID() })).toMatchObject({ ok: false, code: 'unavailable' });
  expect(snapshot()).toEqual(before); expect(changed).not.toHaveBeenCalled();
  expect(ask(r.id).state).toBe('open');
});
it.each(['invalid', 'async'] as const)('rejects %s resolution acknowledgment without committing the answer', async mode => {
  const { app, call, request, ask, connector, may } = await setup(); const r = request();
  connector.resolve = (mode === 'async' ? async () => { throw Error('fixture'); } : () => undefined) as unknown as NonNullable<GrantAttention['resolve']>;
  const changed = vi.spyOn(app.live, 'changed');
  expect(call('secrets.answer', { id: r.id, allow: true })).toMatchObject({ ok: false, code: 'unavailable' });
  expect(ask(r.id).state).toBe('open'); expect(may()).toBe(false);
  expect(value<{requests: GrantRequest[]}>(call('secrets.list', {})).requests[0].state).toBe('pending');
  expect(app.db.prepare("SELECT * FROM core_operations WHERE name='secrets.answer'").all()).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
});
