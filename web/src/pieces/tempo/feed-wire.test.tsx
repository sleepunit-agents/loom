import { createElement as h } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ create: vi.fn(), subscribe: vi.fn(), close: undefined as undefined | ((event: {code: number}) => void) }));
vi.mock('graphql-ws', () => ({ createClient: (options: {on: {closed: (event: {code: number}) => void}}) => {
  wire.create(); wire.close = options.on.closed;
  return { subscribe: wire.subscribe, dispose: vi.fn() };
} }));
vi.mock('./index', () => ({ default: (props: unknown) => h('tempo', props), TempoCard: (props: unknown) => h('card', props) }));
import { TempoApp, tempoQuery } from './feed';
import { useQuery } from '../../data/query';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
it('shares the window connection with another app and clears both readers on access loss', async () => {
  vi.stubGlobal('location', {protocol: 'https:', host: 'loom.test'});
  const sinks = new Map<string, {next(value: unknown): void}>();
  wire.subscribe.mockImplementation((request, sink) => { sinks.set(request.variables.query, sink); return () => {}; });
  const other = { query: 'query OtherApp { agents { id } }', decode: (data: Record<string, unknown>) => data.agents };
  function OtherApp() { const feed = useQuery(other); return h('other-app', {status: feed.status, data: feed.data}); }
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { tree = create(h('div', null, h(TempoApp, {timezone: 'UTC'}), h(OtherApp))); });
    expect(wire.create).toHaveBeenCalledOnce();
    expect(sinks.size).toBe(2);
    const push = (query: string, value: unknown) => sinks.get(query)!.next({data: {observe: {revision: 1, patches: [{path: [], removed: false, value}]}}});
    await act(async () => {
      push(tempoQuery, {triggers: [], triggerLog: [{seq: 1, trigger: 't', event: 'set', at: '2026-11-14T00:00:00Z', note: 'Private'}], agentPauses: []});
      push(other.query, {agents: [{id: 'art'}]});
    });
    expect(tree!.root.findByType('tempo').props.snapshot.events).toHaveLength(1);
    expect(tree!.root.findByType('other-app').props.data).toEqual([{id: 'art'}]);
    await act(async () => wire.close!({code: 4403}));
    expect(tree!.root.findByType('tempo').props.snapshot).toMatchObject({status: 'denied', triggers: [], events: [], pauses: []});
    expect(tree!.root.findByType('other-app').props).toMatchObject({status: 'denied', data: undefined});
  } finally {
    if (tree) await act(async () => tree!.unmount());
    vi.unstubAllGlobals();
  }
});
