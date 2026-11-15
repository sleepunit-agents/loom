import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../kit', () => ({
  Split: (props: { list: ReactNode; reader: ReactNode }) => h('main', null, props.list, props.reader),
  ...Object.fromEntries(['List', 'Row', 'Empty', 'Error', 'Loading', 'Input', 'Button'].map(name => [name, (props: { children?: ReactNode }) => h(name, props, props.children)])),
}));
import Tempo, { TempoCard, type TempoSnapshot } from './index';
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


it('renders current trigger details inline and reflects changed words and pause state', async () => {
  await act(async () => { tree = create(h(TempoCard, { snapshot, triggerId: 'tr-1' })); });
  expect(JSON.stringify(tree.toJSON())).toContain('Review private delivery');
  const changed = { ...snapshot, pauses: [{ agent: 'art', since: '2026-11-14T00:00:00.000Z' }],
    triggers: snapshot.triggers.map(t => ({ ...t, instructions: 'New instructions' })) };
  await act(async () => tree.update(h(TempoCard, { snapshot: changed, triggerId: 'tr-1' })));
  expect(JSON.stringify(tree.toJSON())).toContain('New instructions');
  expect(JSON.stringify(tree.toJSON())).not.toContain('Review private delivery');
  expect(JSON.stringify(tree.toJSON())).toContain('Held · agent paused');
});

it.each(['loading', 'offline', 'denied', 'removed'] as const)('hides inline words and history when %s', async state => {
  const visible = { ...snapshot, events: [{ seq: 1, trigger: 'tr-1', at: '2026-11-14T00:00:00.000Z', event: 'set', note: 'Private history' }] };
  await act(async () => { tree = create(h(TempoCard, { snapshot: visible, triggerId: 'tr-1' })); });
  expect(JSON.stringify(tree.toJSON())).toContain('Private history');
  const unavailable = state === 'removed' ? { ...visible, triggers: [] } : { ...visible, status: state };
  await act(async () => tree.update(h(TempoCard, { snapshot: unavailable, triggerId: 'tr-1' })));
  expect(JSON.stringify(tree.toJSON())).not.toContain('Private history');
  expect(JSON.stringify(tree.toJSON())).not.toContain('Review private delivery');
});

const actions = () => ({ runNow: vi.fn(async (_id: string) => {}), stop: vi.fn(async (_id: string) => {}), pause: vi.fn(async (_agent: string) => {}), resume: vi.fn(async (_agent: string) => {}) });
const button = (label: string) => tree.root.findAllByType('Button').find((node: { props: { children: string } }) => node.props.children === label)!;

it('dispatches run, cancel and pause with the currently visible trigger and recipient IDs', async () => {
  const callbacks = actions();
  await act(async () => { tree = create(h(TempoCard, { snapshot, triggerId: 'tr-1', actions: callbacks })); });
  await act(async () => button('Run now').props.onClick());
  await act(async () => button('Cancel').props.onClick());
  await act(async () => button('Pause agent').props.onClick());
  expect(callbacks.runNow).toHaveBeenCalledExactlyOnceWith('tr-1');
  expect(callbacks.stop).toHaveBeenCalledExactlyOnceWith('tr-1');
  expect(callbacks.pause).toHaveBeenCalledExactlyOnceWith('art');
  const paused = { ...snapshot, pauses: [{ agent: 'art', since: '2026-11-14T00:00:00.000Z' }] };
  await act(async () => tree.update(h(TempoCard, { snapshot: paused, triggerId: 'tr-1', actions: callbacks })));
  expect(button('Run now').props.disabled).toBe(true);
  await act(async () => button('Resume agent').props.onClick());
  expect(callbacks.resume).toHaveBeenCalledExactlyOnceWith('art');
});

it('serializes clicks while an operation is pending and leaves state updates to the live snapshot', async () => {
  const callbacks = actions();
  let finish!: () => void;
  callbacks.runNow.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => { tree = create(h(TempoCard, { snapshot, triggerId: 'tr-1', actions: callbacks })); });
  await act(async () => { button('Run now').props.onClick(); button('Cancel').props.onClick(); });
  expect(callbacks.runNow).toHaveBeenCalledTimes(1);
  expect(callbacks.stop).not.toHaveBeenCalled();
  expect(button('Cancel').props.disabled).toBe(true);
  expect(JSON.stringify(tree.toJSON())).toContain('Waiting for Tempo');
  await act(async () => finish());
  expect(button('Cancel').props.disabled).toBe(false);
  expect(JSON.stringify(tree.toJSON())).toContain('standing');
});

it('reports a failed operation without exposing server error text and permits retry', async () => {
  const callbacks = actions();
  callbacks.stop.mockRejectedValueOnce(new Error('private server detail'));
  await act(async () => { tree = create(h(TempoCard, { snapshot, triggerId: 'tr-1', actions: callbacks })); });
  await act(async () => button('Cancel').props.onClick());
  expect(JSON.stringify(tree.toJSON())).toContain('Tempo could not complete');
  expect(JSON.stringify(tree.toJSON())).not.toContain('private server detail');
  await act(async () => button('Cancel').props.onClick());
  expect(callbacks.stop).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(tree.toJSON())).not.toContain('Tempo could not complete');
});

it.each(['loading', 'offline', 'denied', 'removed'] as const)('removes operation controls when %s', async state => {
  const callbacks = actions();
  await act(async () => { tree = create(h(TempoCard, { snapshot, triggerId: 'tr-1', actions: callbacks })); });
  const unavailable = state === 'removed' ? { ...snapshot, triggers: [] } : { ...snapshot, status: state };
  await act(async () => tree.update(h(TempoCard, { snapshot: unavailable, triggerId: 'tr-1', actions: callbacks })));
  expect(tree.root.findAllByType('Button')).toHaveLength(0);
});

it.each(['fired', 'stopped', 'failed'] as const)('offers no run or cancel for a %s trigger', async state => {
  await act(async () => { tree = create(h(TempoCard, { snapshot: { ...snapshot, triggers: snapshot.triggers.map(t => ({ ...t, state })) }, triggerId: 'tr-1', actions: actions() })); });
  expect(button('Run now')).toBeUndefined();
  expect(button('Cancel')).toBeUndefined();
});
