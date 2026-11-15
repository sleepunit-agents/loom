import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
const f = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, transport: vi.fn(), client: vi.fn(), query: vi.fn(), stops: [] as ReturnType<typeof vi.fn>[], sinks: [] as ((result: unknown) => void)[] };
});
vi.mock('./client', async () => {
  await f.ready;
  return { browserQueryTransport: f.transport, generatedDataClient: f.client };
});
import { useDataQuery } from './index';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('shares deferred startup, cancels unmounted selections, and clears both consumers on access loss', async () => {
  vi.stubGlobal('location', { protocol: 'https:', host: 'desk.invalid' });
  f.query.mockImplementation(() => ({ subscribe: (sink: (result: unknown) => void) => {
    const unsubscribe = vi.fn(); f.stops.push(unsubscribe); f.sinks.push(sink); return { unsubscribe };
  } }));
  f.client.mockReturnValue({ query: f.query });
  function Read({ agent }: { agent: string }) {
    const value = useDataQuery<{ currentJobs: { id: string }[] }>('query Jobs($agent: String!) { currentJobs(agent: $agent) { id } }', { agent });
    return createElement('p', null, JSON.stringify(value));
  }
  let abandoned: ReturnType<typeof create>, live: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { abandoned = create(createElement(Read, { agent: 'gone' })); });
    expect(f.query).not.toHaveBeenCalled();
    await act(async () => abandoned.unmount());
    await act(async () => { f.release(); await f.ready; });
    expect(f.query).not.toHaveBeenCalled();
    await act(async () => { live = create(createElement('div', null, createElement(Read, { agent: 'art' }), createElement(Read, { agent: 'mark' }))); });
    expect(f.transport).toHaveBeenCalledExactlyOnceWith('wss://desk.invalid/graphql');
    expect(f.client).toHaveBeenCalledTimes(1); expect(f.query).toHaveBeenCalledTimes(2);
    await act(async () => { for (const sink of f.sinks) sink({ data: { currentJobs: [{ id: 'job' }] } }); });
    expect(JSON.stringify(live.toJSON())).toContain('job');
    await act(async () => { for (const sink of f.sinks) sink({ error: new Error('Access revoked') }); });
    const state = JSON.stringify(live.toJSON()); expect(state).toContain('offline'); expect(state).not.toContain('job');
    await act(async () => live!.unmount()); live = undefined;
    expect(f.stops.every(stop => stop.mock.calls.length === 1)).toBe(true);
  } finally { if (live) await act(async () => live!.unmount()); vi.unstubAllGlobals(); }
});
