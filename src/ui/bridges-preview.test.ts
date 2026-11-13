import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from '../../web/node_modules/react/index.js';
import { act, create, type ReactTestInstance } from '../../web/node_modules/react-test-renderer/index.js';
import type { Snapshot, LiveRecord, CallState, Result } from '../../web/src/data';
const f = vi.hoisted(() => ({ snapshots: {} as Record<string, Snapshot>, listeners: new Set<() => void>(), call: vi.fn() }));
vi.mock('../../web/src/data', () => ({ useRecords: (type: string) => useSyncExternalStore(fn => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.snapshots[type]), call: f.call }));
vi.mock('../../web/src/lib/cojeev-motion/use-reduced-motion', () => ({ useReducedMotion: () => true }));
import BridgesApp from '../../web/src/pieces/bridges';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let tree: ReturnType<typeof create> | undefined;
const words = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(words).join('');
const text = () => JSON.stringify(tree!.toJSON());
const button = (label: string) => tree!.root.findAllByType('button').find(b => words(b) === label)!;
const click = (label: string) => act(async () => { button(label).props.onClick({ preventDefault() {} }); });
const draw = (path = '/p/bridges-preview') => act(async () => { tree = create(h(BridgesApp, { path })); });
const publish = (type: string, records: LiveRecord[], status: Snapshot['status'] = 'live') => act(async () => { f.snapshots[type] = { records, status }; f.listeners.forEach(fn => fn()); });
beforeEach(() => {
  f.call.mockReset(); f.listeners.clear();
  f.snapshots = {
    'bridges.venue': { status: 'live', records: [{ id: 'art-discord', platform: 'discord', agent: 'art', workspace: 'house', bot: '100', enabled: true, connection: 'connected', received: 3, delivered: 2, held: 1 }] },
    'bridges.route': { status: 'live', records: [{ id: 'route', platform: 'discord', workspace: 'house', channel: '300', primary: 'art', peer: true, guest: false, readers: ['mark'], notes: ['house/rules'] }] },
    'bridges.send': { status: 'live', records: [{ id: 'reply', venue: 'art-discord', incoming: 'receipt', state: 'pending', created: 0 }] },
    'core.effect': { status: 'live', records: [{ id: 'bridges:reply', kind: 'bridge-send', title: 'Bridge reply via art-discord', state: 'due' }, { id: 'wake', kind: 'wake', title: 'Hidden wake', state: 'due' }] },
  };
});
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; });
it('reads live status, daily counts and routes from the shared records', async () => {
  await draw('/p/bridges-preview/item/venues/art-discord');
  expect(text()).toContain('3 received'); expect(text()).toContain('2 delivered'); expect(text()).toContain('connected');
  await publish('bridges.venue', [{ ...f.snapshots['bridges.venue'].records[0], connection: 'backoff', received: 4 }]);
  expect(text()).toContain('backoff'); expect(text()).toContain('4 received');
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/routes/route' })); });
  expect(text()).toContain('Peers enabled'); expect(text()).toContain('mark');
  expect(f.call).not.toHaveBeenCalled();
});
it('retains one release request, disables it pending, and shows rejection inline', async () => {
  let state: CallState = { pending: true, status: 'pending' };
  const listeners = new Set<() => void>();
  f.call.mockReturnValue({ id: 'one-id', result: new Promise(() => {}), subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getSnapshot: () => state });
  await draw('/p/bridges-preview/item/sends/reply');
  await click('Release this send');
  expect(f.call).toHaveBeenCalledExactlyOnceWith('core.releaseEffect', { id: 'bridges:reply' });
  expect(button('Release this send').props.disabled).toBe(true);
  await click('Release this send'); expect(f.call).toHaveBeenCalledTimes(1);
  const answer = (result: Result) => act(async () => { state = { pending: false, status: 'done', result }; listeners.forEach(fn => fn()); });
  await answer({ ok: false, code: 'conflict', message: 'Effect is not held' });
  expect(text()).toContain('conflict: Effect is not held');
  await answer({ ok: true, value: {} }); expect(text()).toContain('Release accepted');
  expect(button('Release this send').props.disabled).toBe(true);
});
it.each(['sends/reply', 'effects/bridges%3Areply'])('never offers replay for an uncertain send in %s', async item => {
  await publish('bridges.send', [{ ...f.snapshots['bridges.send'].records[0], state: 'uncertain' }]);
  await draw(`/p/bridges-preview/item/${item}`);
  expect(text()).toContain('review required'); expect(text()).toContain('cannot resend');
  expect(button('Release this send')).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
});
it.each(['offline', 'denied'] as const)('clears details and release controls on %s', async status => {
  await draw('/p/bridges-preview/item/sends/reply'); expect(button('Release this send')).toBeDefined();
  // Even a stale record supplied with a lost subscription is not actionable.
  await publish('core.effect', f.snapshots['core.effect'].records as LiveRecord[], status);
  expect(button('Release this send')).toBeUndefined(); expect(text()).not.toContain('receipt');
  expect(tree!.root.findAllByProps({ role: 'alert' }).length).toBeGreaterThan(0);
});
it('filters non-bridge effects and removes completed or evicted detail', async () => {
  await draw('/p/bridges-preview/item/effects/bridges%3Areply'); expect(text()).not.toContain('Hidden wake');
  await publish('core.effect', []); expect(text()).toContain('no longer in view'); expect(button('Release this send')).toBeUndefined();
});

function pendingWrite() {
  let state: CallState = { pending: true, status: 'pending' };
  const listeners = new Set<() => void>();
  f.call.mockReturnValue({ id: 'route-write', result: new Promise(() => {}), subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getSnapshot: () => state });
  return (result: Result) => act(async () => { state = { pending: false, status: 'done', result }; listeners.forEach(fn => fn()); });
}
const change = (label: string, value: string) => act(async () => {
  const node = tree!.root.findAll(n => (n.type === 'input' || n.type === 'textarea') && n.props['aria-label'] === label)[0];
  node.props.onChange({ target: { value } });
});
const submit = () => act(async () => { tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
it('edits all route fields through the existing operation and retains one pending request', async () => {
  const answer = pendingWrite();
  await draw('/p/bridges-preview/item/routes/route');
  await change('Channel ID', '400'); await change('Parent channel ID', '300'); await change('Primary agent', 'mark');
  await change('Paired webhook ID', '999'); await change('Reader agents', 'art\nmark'); await change('Note references', 'house/rules\nproject/brief');
  await click('Household route'); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putRoutes', { id: 'route', platform: 'discord', workspace: 'house', channel: '400', parent: '300', primary: 'mark', pair: '999', peer: true, guest: true, readers: ['art', 'mark'], notes: ['house/rules', 'project/brief'] });
  expect(button('Save route').props.disabled).toBe(true); await submit(); expect(f.call).toHaveBeenCalledTimes(1);
  await answer({ ok: false, code: 'denied', message: 'Owner required' });
  expect(text()).toContain('denied: Owner required'); expect(button('Save route').props.disabled).toBe(false);
});
it('keeps the pending route lock after navigating away and back', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/routes/route'); await submit();
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/venues/art-discord' })); });
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/routes/route' })); });
  expect(button('Save route').props.disabled).toBe(true); await submit(); expect(f.call).toHaveBeenCalledTimes(1);
});
it('requires reloading a changed route before overwriting it', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/routes/route'); await change('Primary agent', 'old-draft');
  await publish('bridges.route', [{ ...f.snapshots['bridges.route'].records[0], primary: 'new-agent', notes: ['new/note'] }]);
  expect(text()).toContain('This route changed'); await submit(); expect(f.call).not.toHaveBeenCalled();
  await click('Try again'); await submit();
  expect(f.call.mock.calls[0]).toEqual(['bridges.putRoutes', expect.objectContaining({ primary: 'new-agent', notes: ['new/note'] })]);
});
it('creates a route with a stable id, requires its address and allows Slack selection', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/new-route/new-id');
  await submit(); expect(f.call).not.toHaveBeenCalled();
  await change('Workspace ID', 'T1'); await change('Channel ID', 'G1'); await click('Slack'); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putRoutes', { id: 'new-id', platform: 'slack', workspace: 'T1', channel: 'G1', parent: undefined, primary: undefined, pair: undefined, peer: false, guest: false, readers: [], notes: [] });
});
it('confirms removal and never dispatches removal twice while pending', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/routes/route');
  await click('Remove route'); expect(f.call).not.toHaveBeenCalled();
  await click('Keep route'); expect(button('Confirm removal')).toBeUndefined();
  await click('Remove route'); await click('Confirm removal');
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.removeRoutes', { id: 'route' });
  expect(button('Remove route').props.disabled).toBe(true);
});
it.each(['offline', 'denied'] as const)('hides route editing and creation on %s', async status => {
  await draw('/p/bridges-preview/item/routes/route');
  await publish('bridges.route', f.snapshots['bridges.route'].records as LiveRecord[], status);
  expect(button('Save route')).toBeUndefined(); expect(button('New route')).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
});
