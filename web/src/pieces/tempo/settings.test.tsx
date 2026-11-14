import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../kit', () => Object.fromEntries(['Empty', 'Error', 'Loading'].map(name => [name,
  (props: { children?: ReactNode }) => h(name, props, props.children)])));
import { TempoSettingsChangeCard, type TempoSettingsSnapshot } from './settings';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const snapshot: TempoSettingsSnapshot = { status: 'live', change: {
  who: { kind: 'person', id: 'jonathan' },
  before: { settleSeconds: 5, dimDays: 1, muteDays: 7 },
  after: { settleSeconds: 60, dimDays: 2, muteDays: 3 },
} };
it('shows the persisted recipient and all exact before/after timings without save controls', async () => {
  await act(async () => { tree = create(h(TempoSettingsChangeCard, { snapshot })); });
  const text = JSON.stringify(tree.toJSON());
  expect(text).toContain('jonathan');
  expect(tree.root.findAllByType('td').map((cell: { props: { children: string } }) => cell.props.children))
    .toEqual(['5 seconds', '60 seconds', '1 day', '2 days', '7 days', '3 days']);
  expect(tree.root.findAllByType('button')).toHaveLength(0);
});
it.each(['loading', 'offline', 'denied', 'removed'] as const)('removes proposal details when %s', async status => {
  await act(async () => { tree = create(h(TempoSettingsChangeCard, { snapshot })); });
  const next: TempoSettingsSnapshot = status === 'removed' ? { status: 'live', change: null } : { ...snapshot, status };
  await act(async () => tree.update(h(TempoSettingsChangeCard, { snapshot: next })));
  expect(JSON.stringify(tree.toJSON())).not.toContain('jonathan');
  expect(tree.root.findAllByType('table')).toHaveLength(0);
});
