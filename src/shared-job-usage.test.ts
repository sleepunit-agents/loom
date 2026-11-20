import { afterEach, expect, it } from 'vitest';
import { bodyCredentials, bodyFixture } from '../test/fixtures/conversation-body.js';
import { eq } from 'drizzle-orm';
import { jobs, jobUsage, modelAccountBoxes, modelAccountLogins, modelAccounts } from './core/data/schema.js';
import { Jobs } from './runtime/jobs.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
it('accepts one report bound to its credential and preserves it across job completion', async () => {
  const f = await bodyFixture(clean);
  const report = { source: 'transcript', tokensIn: 0, tools: { Read: 2 }, model: 'observed' };
  for (const token of [bodyCredentials.member, bodyCredentials.runner, bodyCredentials.agent])
    expect((await f.call('usage', report, 'unbound', token)).status).toBe(403);
  for (const bad of [{ job: 'other' }, { words: 'private' }, { cacheRead: -1 }, { tokensOut: 2 ** 55 },
    { tools: Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['tool' + i, 1])) }])
    expect((await f.call('usage', { ...report, ...bad }, 'invalid')).ok).toBe(false);
  expect(f.db.select().from(jobUsage).all()).toEqual([]);
  expect(await (await f.call('usage', report, 'first')).json()).toMatchObject({ value: { saved: true } });
  expect(await (await f.call('usage', { ...report, tokensIn: 100 }, 'second')).json()).toMatchObject({ value: { saved: false } });
  new Jobs(f.db, () => new Date(f.clock.now()).toISOString()).stop('job', 'alice', 'reset');
  expect((await f.call('usage', report, 'first')).status).toBe(401);
  expect(f.db.select().from(jobUsage).all()).toMatchObject([{ job: 'job', ...report, tokensOut: null }]);
});

it('rejects contradictory or empty reports and ends normally with unknown counters', async () => {
  const f = await bodyFixture(clean);
  for (const report of [
    { source: 'none', modelCalls: 0 }, { source: 'none', tools: {} },
    { source: 'report', toolCalls: 3, tools: { Read: 1, Write: 1 } },
    { source: 'report', wallMs: 5 }, { source: 'transcript', tools: { Read: Number.MAX_SAFE_INTEGER, Write: 1 } },
  ]) expect((await f.call('usage', report, 'bad')).ok).toBe(false);
  new Jobs(f.db, () => new Date(f.clock.now()).toISOString()).finish('job', 'box', 0);
  expect(f.db.select().from(jobUsage).all()).toMatchObject([{ job: 'job', source: 'none', modelCalls: null, toolCalls: null, tools: null }]);
});

it('takes words back from the model as proof that the watched house sign-in still works, and nothing less', async () => {
  const at = '2026-11-01T00:00:00.000Z';
  const place = (f: Awaited<ReturnType<typeof bodyFixture>>) => {
    f.db.insert(modelAccounts).values({ id: 'sub', owner: 'alice', provider: 'provider', label: 'Subscription', hasRoom: true }).run();
    f.db.insert(modelAccountBoxes).values({ account: 'sub', box: 'box' }).run();
    // What the machine's worker last read: signed in, with an end.
    f.db.insert(modelAccountLogins).values({ account: 'sub', box: 'box', harness: 'claude', place: 'containers', state: 'signed-in', expiresAt: '2026-12-14T12:30:00.000Z', checkedAt: at, since: at, learnedFrom: 'check' }).run();
    f.db.update(jobs).set({ account: 'sub', harness: 'claude' }).where(eq(jobs.id, 'job')).run();
    return f;
  };
  const record = (f: Awaited<ReturnType<typeof bodyFixture>>) => f.db.select().from(modelAccountLogins).all();
  const untouched = [{ learnedFrom: 'check', checkedAt: at, expiresAt: '2026-12-14T12:30:00.000Z' }];
  // A call that was made and got no words back proves nothing: a provider's refusal is counted as a call too.
  const refused = place(await bodyFixture(clean));
  expect(await (await refused.call('usage', { source: 'transcript', tokensIn: 40, tokensOut: 0, modelCalls: 1 }, 'refused')).json()).toMatchObject({ value: { saved: true } });
  expect(record(refused)).toMatchObject(untouched);
  // A job loom did not place under an account proves nothing about one, and adds no record.
  const unplaced = await bodyFixture(clean);
  expect(await (await unplaced.call('usage', { source: 'transcript', tokensOut: 12, modelCalls: 1 }, 'unplaced')).json()).toMatchObject({ value: { saved: true } });
  expect(record(unplaced)).toEqual([]);
  const f = place(await bodyFixture(clean));
  expect(await (await f.call('usage', { source: 'transcript', tokensIn: 40, tokensOut: 12, modelCalls: 1 }, 'answered')).json()).toMatchObject({ value: { saved: true } });
  expect(record(f)).toMatchObject([{ account: 'sub', box: 'box', harness: 'claude', place: 'containers', state: 'signed-in', expiresAt: '2026-12-14T12:30:00.000Z', learnedFrom: 'job', since: at }]);
  expect(record(f)[0].checkedAt).not.toBe(at);
});
