import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../kit', () => ({
  Split: (props: { list: ReactNode; reader: ReactNode }) => h('main', null, props.list, props.reader),
  ...Object.fromEntries(['List', 'Row', 'Empty', 'Error', 'Loading', 'Input'].map(name => [name, (props: { children?: ReactNode }) => h(name, props, props.children)])),
}));
import Tempo, { type TempoSnapshot } from './index';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const snapshot: TempoSnapshot = {
  status: 'live', timezone: 'America/Chicago', pauses: [], events: [],
  triggers: [{ id: 'tr-1', ownerKind: 'household', owner: null, sourceKind: 'answer', watches: 'approval:a-1',
    times: null, days: null, lifespan: 'once', targetKind: 'inbox', target: null, toKind: 'agent', to: 'art',
    project: null, instructions: 'Review private delivery', file: null, note: 'Delivery', enabled: true,
    state: 'standing', nextDueAt: null, lastFiredAt: null, createdAt: '2026-11-14T00:00:00.000Z', changedAt: '2026-11-14T00:00:00.000Z' }],
};

it.each(['loading', 'offline', 'denied'] as const)('clears visible rows and selected words when snapshot becomes %s', async status => {
  await act(async () => { tree = create(h(Tempo, { snapshot })); });
  await act(async () => tree.root.findByType('Row').props.onClick());
  expect(JSON.stringify(tree.toJSON())).toContain('Review private delivery');
  await act(async () => tree.update(h(Tempo, { snapshot: { ...snapshot, status } })));
  expect(tree.root.findAllByType('Row')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).not.toContain('Review private delivery');
});

it('drops a selected trigger when it disappears from the live query', async () => {
  await act(async () => { tree = create(h(Tempo, { snapshot })); });
  await act(async () => tree.root.findByType('Row').props.onClick());
  await act(async () => tree.update(h(Tempo, { snapshot: { ...snapshot, triggers: [] } })));
  expect(JSON.stringify(tree.toJSON())).not.toContain('Review private delivery');
});
