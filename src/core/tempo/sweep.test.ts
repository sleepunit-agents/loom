import { expect, it } from 'vitest';
import { FakeClock } from '../clock.js';
import { Sweep, type SweepDelivery } from './sweep.js';
it('does nothing with no open items and combines contributing parts in one recipient delivery', () => {
  const clock = new FakeClock(), deliveries: SweepDelivery[] = [];
  const sweep = new Sweep(clock, delivery => { deliveries.push(delivery); });
  const who = { kind: 'agent' as const, id: 'art' };
  sweep.register({ name: 'Empty', open: () => [] });
  expect(sweep.run(who, 'morning')).toEqual([]); expect(deliveries).toEqual([]);
  const stop = sweep.register({ name: 'Tasks', open: recipient => recipient.id === 'art' ? [
    { id: 't-new', words: 'New task', openedAt: new Date(clock.now() - 3_600_000).toISOString() },
    { id: 't-old', words: 'Old task', openedAt: new Date(clock.now() - 3 * 86_400_000).toISOString() },
  ] : [] });
  sweep.register({ name: 'Approvals', open: recipient => recipient.id === 'art' ? [{ id: 'a-1', words: 'A question', openedAt: new Date(clock.now() - 120_000).toISOString() }] : [] });
  expect(sweep.run(who, 'noon')).toMatchObject([{ part: 'Tasks', count: 2, ageMs: 3 * 86_400_000 }, { part: 'Approvals', count: 1 }]);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].words).toContain('Tasks: 2 open, oldest 3 days');
  expect(deliveries[0].words).toContain('- t-old: Old task (3 days)');
  expect(deliveries[0].words).toContain('- t-new: New task (1 hours)');
  expect(deliveries[0].summaries[0].items.map(i => i.id)).toEqual(['t-old', 't-new']);
  sweep.run({ kind: 'agent', id: 'mark' }, 'noon'); expect(deliveries).toHaveLength(1);
  stop(); expect(sweep.run(who, 'evening')).toMatchObject([{ part: 'Approvals' }]);
  expect(deliveries[1].id).not.toBe(deliveries[0].id);
});
