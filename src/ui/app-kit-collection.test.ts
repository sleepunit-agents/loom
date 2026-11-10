import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from '../../web/node_modules/react/index.js';
import { act, create } from '../../web/node_modules/react-test-renderer/index.js';
const h = vi.hoisted(() => ({ csrf: 'one', start: vi.fn() }));
vi.mock('../../web/src/blocks', () => ({ useEnv: () => ({ ctx: { csrf: h.csrf } }) }));
vi.mock('../../web/src/page', () => ({ collectionsRuntime: h.start }));
import { useCollection } from '../../web/src/kit/use-collection';
import type { QuerySpec, ViewState } from '../../web/src/collections/runtime';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let result: ReturnType<typeof useCollection>;
function Probe({ name = 'loom/test@^1', query = {} }: { name?: string; query?: Omit<QuerySpec, 'type'> }) { result = useCollection(name, query); return null; }
function fixture() {
  const state: ViewState = { keys: ['b', 'a'], withheld: [], status: 'live', more: true, coverage: { complete: false } };
  const records = new Map([['a', { key: 'a' }], ['b', { key: 'b' }]]);
  const handles: Array<{ notify: () => void; close: ReturnType<typeof vi.fn>; more: ReturnType<typeof vi.fn> }> = [];
  const runtime = {
    isCleared: () => false,
    view: vi.fn((_spec: QuerySpec, notify: () => void) => { const handle = { notify, close: vi.fn(), more: vi.fn() }; handles.push(handle); return { state: () => state, ...handle }; }),
    records: vi.fn(() => records),
  };
  h.start.mockResolvedValue({ runtime });
  return { state, records, handles, runtime };
}
describe('app kit scoped collection lifetime with React effects', () => {
  beforeEach(() => { h.csrf = 'one'; h.start.mockReset(); });
  it('passes the whole query, orders rows, publishes stale/error/denied and closes', async () => {
    const f = fixture(); let tree!: ReturnType<typeof create>;
    const query: Omit<QuerySpec, 'type'> = { where: [['owner', '=', 'art']], order: [['updated', 'desc']], limit: 7, fields: ['title'], aggregates: ['count'] };
    await act(async () => { tree = create(createElement(Probe, { query })); });
    expect(f.runtime.view).toHaveBeenCalledWith({ ...query, type: 'loom/test@^1' }, expect.any(Function));
    expect(f.runtime.records).toHaveBeenCalledWith('loom/test@^1');
    expect(result.rows.map((r) => r.key)).toEqual(['b', 'a']); expect(result.coverage?.complete).toBe(false);
    result.loadMore(); expect(f.handles[0].more).toHaveBeenCalledOnce();
    await act(async () => { f.state.status = 'stale'; f.handles[0].notify(); });
    expect(result.stale).toBe(true); expect(result.loading).toBe(false);
    await act(async () => { f.state.status = 'error'; f.state.error = 'Provider did not answer'; f.handles[0].notify(); });
    expect(result.error).toBe('Provider did not answer');
    await act(async () => { f.state.status = 'live'; delete f.state.error; f.handles[0].notify(); });
    expect(result.stale).toBe(false); expect(result.error).toBeUndefined();
    await act(async () => { f.state.status = 'denied'; f.state.keys = []; f.records.clear(); f.handles[0].notify(); });
    expect(result.status).toBe('denied'); expect(result.rows).toEqual([]);
    await act(async () => tree.unmount()); expect(f.handles[0].close).toHaveBeenCalledOnce();
  });
  it('replaces subscriptions on query, record type and CSRF changes, never committing old rows', async () => {
    const f = fixture(); let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(createElement(Probe, { query: { limit: 1 } })); });
    await act(async () => { tree.update(createElement(Probe, { name: 'loom/other@^1', query: { limit: 2, where: [['x', '=', true]] } })); });
    expect(f.handles[0].close).toHaveBeenCalledOnce();
    expect(f.runtime.view).toHaveBeenLastCalledWith({ type: 'loom/other@^1', limit: 2, where: [['x', '=', true]] }, expect.any(Function));
    expect(f.runtime.records).toHaveBeenLastCalledWith('loom/other@^1');
    h.csrf = 'two';
    await act(async () => { tree.update(createElement(Probe, { name: 'loom/other@^1', query: { limit: 2, where: [['x', '=', true]] } })); });
    expect(f.handles[1].close).toHaveBeenCalledOnce(); expect(h.start).toHaveBeenCalledTimes(3);
    expect(h.start.mock.calls[2][0]()).toBe('two');
    await act(async () => tree.unmount());
  });
  it('does not attach after unmount while the chunk is loading', async () => {
    let resolve!: (v: unknown) => void; h.start.mockReturnValue(new Promise((r) => { resolve = r; }));
    let tree!: ReturnType<typeof create>; await act(async () => { tree = create(createElement(Probe)); });
    expect(result.loading).toBe(true); await act(async () => tree.unmount());
    const view = vi.fn(); await act(async () => resolve({ runtime: { view } })); expect(view).not.toHaveBeenCalled();
  });
  it('surfaces chunk failure as error', async () => {
    h.start.mockRejectedValue(new Error('chunk missing')); let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(createElement(Probe)); });
    expect(result).toMatchObject({ status: 'error', loading: false, rows: [], error: 'Couldn’t load this. Try again.' });
    await act(async () => tree.unmount());
  });
  it('reports missing credentials without requesting data', async () => {
    h.csrf = ''; let tree!: ReturnType<typeof create>; await act(async () => { tree = create(createElement(Probe)); });
    expect(result).toMatchObject({ status: 'denied', loading: false }); expect(h.start).not.toHaveBeenCalled(); await act(async () => tree.unmount());
  });
  it('does not subscribe to a cleared runtime', async () => {
    const view = vi.fn(); h.start.mockResolvedValue({ runtime: { isCleared: () => true, view } }); let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(createElement(Probe)); });
    expect(view).not.toHaveBeenCalled(); expect(result.status).toBe('denied'); await act(async () => tree.unmount());
  });
});

it('never renders previous rows during a delayed query replacement, denial, or late old startup', async () => {
  const observations: Array<{ status: string; keys: string[] }> = [];
  function Observe({ limit }: { limit: number }) {
    const value = useCollection('loom/test@^1', { limit });
    observations.push({ status: value.status, keys: value.rows.map((r) => r.key) }); return null;
  }
  const f = fixture(); let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(Observe, { limit: 1 })); });
  expect(observations.at(-1)?.keys).toEqual(['b', 'a']);
  let resolve!: (v: unknown) => void;
  h.start.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  observations.length = 0;
  await act(async () => tree.update(createElement(Observe, { limit: 2 })));
  expect(observations.every((v) => v.keys.length === 0)).toBe(true);
  h.csrf = '';
  await act(async () => tree.update(createElement(Observe, { limit: 2 })));
  expect(observations.at(-1)).toEqual({ status: 'denied', keys: [] });
  const view = vi.fn(); await act(async () => resolve({ runtime: { view } })); expect(view).not.toHaveBeenCalled();
  h.csrf = 'new'; h.start.mockResolvedValueOnce({ runtime: { isCleared: () => true } });
  await act(async () => tree.update(createElement(Observe, { limit: 3 })));
  expect(observations.at(-1)).toEqual({ status: 'denied', keys: [] });
  await act(async () => tree.unmount());
});
