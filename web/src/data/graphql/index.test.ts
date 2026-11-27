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

// Keeping the last answer while the next variables load (the `keep` option).
import { useSelection } from './selection';
const jobs = 'query Jobs($agent: String!) { currentJobs(agent: $agent) { id } }', other = 'query Other($agent: String!) { lastAnswers(agent: $agent) { id } }';
type Jobs = { currentJobs: { id: string }[] };
function Kept({ agent, keep, document = jobs, pause }: { agent: string; keep?: boolean; document?: string; pause?: boolean }) {
  return createElement('p', null, JSON.stringify(useDataQuery<Jobs>(document, { agent }, { keep, pause })));
}
async function wired() {
  vi.stubGlobal('location', { protocol: 'https:', host: 'desk.invalid' });
  f.query.mockImplementation(() => ({ subscribe: (sink: (result: unknown) => void) => {
    const unsubscribe = vi.fn(); f.stops.push(unsubscribe); f.sinks.push(sink); return { unsubscribe };
  } }));
  f.client.mockReturnValue({ query: f.query });
  f.release(); await f.ready;
}
const shown = (tree: ReturnType<typeof create>) => JSON.parse(tree.toJSON().children[0]);
const answer = (id: string) => act(async () => { f.sinks.at(-1)!({ data: { currentJobs: [{ id }] } }); });
it('keeps the last answer while the next variables load, marked as settling, and replaces it with the answer', async () => {
  await wired(); let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(Kept, { agent: 'art', keep: true })); });
  expect(shown(tree)).toEqual({ status: 'loading' });
  await answer('first'); expect(shown(tree)).toEqual({ status: 'live', data: { currentJobs: [{ id: 'first' }] } });
  const stop = f.stops.at(-1)!;
  await act(async () => { tree.update(createElement(Kept, { agent: 'mark', keep: true })); });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(f.query.mock.calls.at(-1)).toEqual([expect.anything(), { agent: 'mark' }, { requestPolicy: 'network-only' }]);
  expect(shown(tree)).toEqual({ status: 'live', data: { currentJobs: [{ id: 'first' }] }, settling: true });
  // A second change before the first answers still shows what this hook last showed.
  await act(async () => { tree.update(createElement(Kept, { agent: 'june', keep: true })); });
  expect(shown(tree)).toEqual({ status: 'live', data: { currentJobs: [{ id: 'first' }] }, settling: true });
  await answer('third'); expect(shown(tree)).toEqual({ status: 'live', data: { currentJobs: [{ id: 'third' }] } });
  await act(async () => tree.unmount()); vi.unstubAllGlobals();
});
it.each([['the request fails', { error: new Error('Data selection refused') }], ['the feed goes offline', { error: new Error('Connection closed') }]])('drops the kept answer at once when %s, and keeps nothing from it afterwards', async (_name, failure) => {
  await wired(); let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(Kept, { agent: 'art', keep: true })); });
  await answer('private'); 
  await act(async () => { tree.update(createElement(Kept, { agent: 'mark', keep: true })); });
  expect(JSON.stringify(shown(tree))).toContain('private');
  await act(async () => { f.sinks.at(-1)!(failure); });
  expect(shown(tree)).toEqual({ status: 'offline' });
  await act(async () => { tree.update(createElement(Kept, { agent: 'june', keep: true })); });
  expect(shown(tree)).toEqual({ status: 'loading' });
  await act(async () => tree.unmount()); vi.unstubAllGlobals();
});
it('keeps nothing with the option off, across a remount, across documents, or through a pause', async () => {
  await wired(); let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(Kept, { agent: 'art' })); });
  await answer('plain');
  await act(async () => { tree.update(createElement(Kept, { agent: 'mark' })); });
  expect(shown(tree)).toEqual({ status: 'loading' });
  await answer('kept');
  // Turning the option off while a kept answer shows withdraws it.
  await act(async () => { tree.update(createElement(Kept, { agent: 'june', keep: true })); });
  expect(shown(tree).settling).toBe(true);
  await act(async () => { tree.update(createElement(Kept, { agent: 'june' })); });
  expect(shown(tree)).toEqual({ status: 'loading' });
  await answer('again');
  await act(async () => { tree.update(createElement(Kept, { agent: 'june', keep: true, document: other })); });
  expect(shown(tree)).toEqual({ status: 'loading' });
  await answer('other');
  await act(async () => tree.unmount());
  await act(async () => { tree = create(createElement(Kept, { agent: 'june', keep: true, document: other })); });
  expect(shown(tree)).toEqual({ status: 'loading' });
  await answer('remounted');
  const asked = f.query.mock.calls.length, stop = f.stops.at(-1)!;
  await act(async () => { tree.update(createElement(Kept, { agent: 'art', keep: true, document: other, pause: true })); });
  expect(shown(tree)).toEqual({ status: 'loading' }); expect(stop).toHaveBeenCalledTimes(1); expect(f.query).toHaveBeenCalledTimes(asked);
  await act(async () => { tree.update(createElement(Kept, { agent: 'art', keep: true, document: other })); });
  expect(shown(tree)).toEqual({ status: 'loading' }); expect(f.query).toHaveBeenCalledTimes(asked + 1);
  await act(async () => tree.unmount()); vi.unstubAllGlobals();
});
it('shows a kept selection as it was decoded, never through the next selection’s decoder', async () => {
  await wired(); let tree!: ReturnType<typeof create>;
  const selection = (agent: string) => ({ query: jobs, variables: { agent }, decode: (data: Record<string, unknown>) => `${agent}:${(data as Jobs).currentJobs[0].id}` });
  function Decoded({ pick }: { pick: ReturnType<typeof selection> }) { return createElement('p', null, JSON.stringify(useSelection(pick, { keep: true }))); }
  const art = selection('art'), mark = selection('mark');
  await act(async () => { tree = create(createElement(Decoded, { pick: art })); });
  await answer('one'); expect(shown(tree)).toEqual({ status: 'live', data: 'art:one' });
  await act(async () => { tree.update(createElement(Decoded, { pick: mark })); });
  expect(shown(tree)).toEqual({ status: 'live', data: 'art:one', settling: true });
  await answer('two'); expect(shown(tree)).toEqual({ status: 'live', data: 'mark:two' });
  await act(async () => tree.unmount()); vi.unstubAllGlobals();
});

// Remembering answers across an unmount, for a page that asks for it (./remembered.ts: the boards page).
import { Remembered, RememberedWatch, rememberedAnswers } from './remembered';
const under = (answers: ReturnType<typeof rememberedAnswers>, watch: ((hook: object, on: boolean) => void) | undefined, child: ReturnType<typeof createElement>) =>
  createElement(Remembered.Provider, { value: answers }, createElement(RememberedWatch.Provider, { value: watch }, child));
it('under a page that remembers, a hook mounted again shows its last answer at once, marked settling and told to its watcher, then the fresh answer', async () => {
  await wired(); let tree!: ReturnType<typeof create>;
  const answers = rememberedAnswers(), settling = new Set<object>(), watch = (hook: object, on: boolean) => { if (on) settling.add(hook); else settling.delete(hook); };
  const stored = vi.fn();
  vi.stubGlobal('localStorage', { setItem: stored, getItem: stored }); vi.stubGlobal('sessionStorage', { setItem: stored, getItem: stored }); vi.stubGlobal('indexedDB', { open: stored });
  await act(async () => { tree = create(under(answers, watch, createElement(Kept, { agent: 'art' }))); });
  expect(shown(tree)).toEqual({ status: 'loading' }); expect(settling.size).toBe(0);
  await answer('before'); expect(shown(tree)).toEqual({ status: 'live', data: { currentJobs: [{ id: 'before' }] } });
  await act(async () => tree.unmount());
  // Mounted again: the old answer at once, with no `keep`, and a new request all the same.
  const asked = f.query.mock.calls.length;
  await act(async () => { tree = create(under(answers, watch, createElement(Kept, { agent: 'art' }))); });
  expect(shown(tree)).toEqual({ status: 'live', data: { currentJobs: [{ id: 'before' }] }, settling: true });
  expect(settling.size).toBe(1);
  expect(f.query).toHaveBeenCalledTimes(asked + 1);
  expect(f.query.mock.calls.at(-1)![2]).toEqual({ requestPolicy: 'network-only' });
  await answer('after');
  expect(shown(tree)).toEqual({ status: 'live', data: { currentJobs: [{ id: 'after' }] } });
  expect(settling.size).toBe(0);
  // Another selection of the same document has nothing remembered.
  await act(async () => { tree.update(under(answers, watch, createElement(Kept, { agent: 'mark' }))); });
  expect(shown(tree)).toEqual({ status: 'loading' });
  await act(async () => tree.unmount());
  expect(stored).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
it.each([['the request is refused', { error: new Error('Data selection refused') }], ['the feed goes offline', { error: new Error('Connection closed') }]])('drops a remembered answer at once when %s, and remembers nothing of it', async (_name, failure) => {
  await wired(); let tree!: ReturnType<typeof create>;
  const answers = rememberedAnswers();
  await act(async () => { tree = create(under(answers, undefined, createElement(Kept, { agent: 'art' }))); });
  await answer('private');
  await act(async () => tree.unmount());
  await act(async () => { tree = create(under(answers, undefined, createElement(Kept, { agent: 'art' }))); });
  expect(JSON.stringify(shown(tree))).toContain('private');
  await act(async () => { f.sinks.at(-1)!(failure); });
  expect(shown(tree)).toEqual({ status: 'offline' });
  expect(answers.size).toBe(0);
  await act(async () => tree.unmount());
  await act(async () => { tree = create(under(answers, undefined, createElement(Kept, { agent: 'art' }))); });
  expect(shown(tree)).toEqual({ status: 'loading' });
  await act(async () => tree.unmount()); vi.unstubAllGlobals();
});
it('remembers nothing once the store is cleared, holds a bounded number of answers, and a hook with no such page above it is as it was', async () => {
  await wired(); let tree!: ReturnType<typeof create>;
  const answers = rememberedAnswers(2);
  await act(async () => { tree = create(under(answers, undefined, createElement(Kept, { agent: 'art' }))); });
  await answer('mine');
  await act(async () => tree.unmount());
  // The same selection outside the provider: loading, as ever.
  await act(async () => { tree = create(createElement(Kept, { agent: 'art', keep: true })); });
  expect(shown(tree)).toEqual({ status: 'loading' });
  await act(async () => tree.unmount());
  answers.clear();
  await act(async () => { tree = create(under(answers, undefined, createElement(Kept, { agent: 'art' }))); });
  expect(shown(tree)).toEqual({ status: 'loading' });
  await act(async () => tree.unmount());
  // The oldest answer goes when there are more than the store holds.
  for (const key of [1, 2, 3]) answers.set(key, { n: key }, undefined);
  expect(answers.size).toBe(2); expect(answers.get(1)).toBeUndefined(); expect(answers.get(3)).toEqual({ data: { n: 3 }, from: undefined });
  vi.unstubAllGlobals();
});
