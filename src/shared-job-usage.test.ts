import { afterEach, expect, it } from 'vitest';
import { bodyCredentials, bodyFixture } from '../test/fixtures/conversation-body.js';
import { jobUsage } from './core/data/schema.js';
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
