import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import type { DataQuerySnapshot } from '../../data/graphql';
import type { TempoData } from './feed';
const state = vi.hoisted(() => ({ feed: { status: 'loading' } as DataQuerySnapshot<TempoData>, query: vi.fn() }));
vi.mock('../../data/graphql', () => ({ useDataQuery: (query: string) => { state.query(query); return state.feed; } }));
vi.mock('./index', () => ({ default: (props: unknown) => h('tempo', props), TempoCard: (props: unknown) => h('card', props) }));
import { TempoApp, LiveTempoCard, tempoQuery } from './feed';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const data: TempoData = { triggers: [], triggerLog: [{ seq: 1, trigger: 'tr-1', at: '2026-11-14T00:00:00Z', event: 'set', note: 'Private' }], agentPauses: [{ agent: 'art', since: '2026-11-14T00:00:00Z' }] };
it('binds the tile and inline card to the same generated selection and root actions', async () => {
  state.feed = { status: 'live', data };
  const actions = { runNow: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  await act(async () => { tree = create(h(TempoApp, { timezone: 'America/Chicago', actions })); });
  expect(state.query).toHaveBeenCalledWith(tempoQuery);
  expect(tree.root.findByType('tempo').props).toMatchObject({ snapshot: { status: 'live', events: data.triggerLog, pauses: data.agentPauses, timezone: 'America/Chicago' }, actions });
  await act(async () => tree.update(h(LiveTempoCard, { triggerId: 'tr-1', timezone: 'America/Chicago', actions })));
  expect(tree.root.findByType('card').props).toMatchObject({ triggerId: 'tr-1', actions, snapshot: { events: data.triggerLog } });
});
it.each(['loading', 'offline', 'denied'] as const)('drops retained data immediately on %s', async status => {
  state.feed = { status: 'live', data };
  await act(async () => { tree = create(h(TempoApp, { timezone: 'UTC' })); });
  state.feed = { status, data };
  await act(async () => tree.update(h(TempoApp, { timezone: 'UTC' })));
  expect(tree.root.findByType('tempo').props.snapshot).toEqual({ status, triggers: [], events: [], pauses: [], timezone: 'UTC' });
});
it('clears rows on a new live selection and treats a missing payload as loading', async () => {
  state.feed = { status: 'live', data };
  await act(async () => { tree = create(h(TempoApp, { timezone: 'UTC' })); });
  state.feed = { status: 'live', data: { triggers: [], triggerLog: [], agentPauses: [] } };
  await act(async () => tree.update(h(TempoApp, { timezone: 'UTC' })));
  expect(tree.root.findByType('tempo').props.snapshot.events).toEqual([]);
  state.feed = { status: 'live' };
  await act(async () => tree.update(h(TempoApp, { timezone: 'UTC' })));
  expect(tree.root.findByType('tempo').props.snapshot.status).toBe('loading');
});
it('uses the household timezone from the shared selection rather than the browser fallback', async () => {
 state.feed={status:'live',data:{...data,tempoTimezone:'America/Chicago'}};
 await act(async()=>{tree=create(h(TempoApp,{timezone:'Asia/Tokyo'}));});
 expect(tree.root.findByType('tempo').props.snapshot.timezone).toBe('America/Chicago');
});
