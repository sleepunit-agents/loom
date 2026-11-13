import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from '../../../node_modules/react/index.js';
import { act, create, type ReactTestInstance } from '../../../node_modules/react-test-renderer/index.js';
import type { Snapshot, LiveRecord, CallState, Result } from '../../data';
const f = vi.hoisted(() => ({ snapshots: {} as Record<string, Snapshot>, listeners: new Set<() => void>(), call: vi.fn() }));
vi.mock('../../data', () => ({ useRecords: (type: string) => useSyncExternalStore(fn => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.snapshots[type]), call: f.call }));
vi.mock('../../lib/cojeev-motion/use-reduced-motion', () => ({ useReducedMotion: () => true }));
import BridgesApp from './index';
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
    'bridges.venue': { status: 'live', records: [{ id: 'art-discord', platform: 'discord', agent: 'art', workspace: 'house', bot: '100', tokenSecret: 'discord-token', appSecret: 'discord-app', only: ['300'], ignore: ['400'], botRoles: ['500'], enabled: true, connection: 'connected', received: 3, delivered: 2, held: 1 }] },
    'bridges.route': { status: 'live', records: [{ id: 'route', platform: 'discord', workspace: 'house', channel: '300', primary: 'art', parent: 'parent-id', pair: 'pair-id', peer: true, guest: false, readers: ['mark'], notes: ['house/rules'], changedAt: 123, connection: 'metadata-only' }] },
    'bridges.link': { status: 'live', records: [{ id: 'link', platform: 'discord', workspace: 'house', user: '200', person: 'jonathan', changedAt: 123 }] },
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
  await click('Slack'); await click('Peers enabled'); await change('Workspace ID', 'new-house'); await change('Channel ID', '400'); await change('Parent channel ID', '300'); await change('Primary agent', 'mark');
  await change('Paired webhook ID', '999'); await change('Reader agents', 'art\nmark'); await change('Note references', 'house/rules\nproject/brief');
  await click('Household route'); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putRoutes', { id: 'route', platform: 'slack', workspace: 'new-house', channel: '400', parent: '300', primary: 'mark', pair: '999', peer: false, guest: true, readers: ['art', 'mark'], notes: ['house/rules', 'project/brief'] });
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

it('blocks a second route or new route while another route write is pending', async () => {
  const answer = pendingWrite(); await draw('/p/bridges-preview/item/routes/route'); await submit();
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/new-route/another' })); });
  await change('Workspace ID', 'T1'); await change('Channel ID', 'D1');
  expect(button('Save route').props.disabled).toBe(true); await submit(); expect(f.call).toHaveBeenCalledTimes(1);
  await answer({ ok: true, value: { id: 'route' } });
  expect(button('Save route').props.disabled).toBe(false); await submit(); expect(f.call).toHaveBeenCalledTimes(2);
});
it('latches an observed edit and restore until reload, including removal confirmation', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/routes/route'); await click('Remove route');
  const original = f.snapshots['bridges.route'].records[0];
  await publish('bridges.route', [{ ...original, primary: 'new-agent' }]);
  await publish('bridges.route', [original]);
  expect(button('Confirm removal')).toBeUndefined(); expect(button('Remove route').props.disabled).toBe(true);
  await click('Remove route'); await submit(); expect(f.call).not.toHaveBeenCalled();
  await click('Try again'); await click('Remove route'); await click('Confirm removal');
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.removeRoutes', { id: 'route' });
});
it('New route generates distinct identities and keeps one identity for retries', async () => {
  const answer = pendingWrite(); const go = vi.fn();
  await act(async () => { tree = create(h(BridgesApp, { path: '/p/bridges-preview/item/routes/route', go })); });
  await click('New route'); const first = go.mock.calls[0][0] as string;
  await act(async () => { tree!.update(h(BridgesApp, { path: first, go })); });
  await change('Workspace ID', 'T1'); await change('Channel ID', 'D1'); await submit();
  const id = decodeURIComponent(first.split('/').at(-1)!);
  expect(id).toMatch(/^[a-f0-9-]{36}$/); expect(f.call.mock.calls[0][1]).toMatchObject({ id });
  await answer({ ok: false, code: 'unavailable', message: 'Try later' }); await submit();
  expect(f.call.mock.calls[1][1]).toMatchObject({ id });
  await click('New route'); expect(go.mock.calls.at(-1)![0]).not.toBe(first);
});
it('whitelists operation fields when reopening a newly saved route with live metadata', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/new-route/route'); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putRoutes', {
    id: 'route', platform: 'discord', workspace: 'house', channel: '300', parent: 'parent-id', primary: 'art', pair: 'pair-id',
    peer: true, guest: false, readers: ['mark'], notes: ['house/rules'],
  });
});

it('preserves untouched route strings and lists exactly on an unrelated edit', async () => {
  pendingWrite(); const route = { ...f.snapshots['bridges.route'].records[0], workspace: ' house ', channel: ' 300 ',
    parent: ' parent ', pair: ' pair ', readers: [' mark ', 'embedded\nreader'], notes: [' note ', 'embedded\nnote'] };
  await publish('bridges.route', [route]); await draw('/p/bridges-preview/item/routes/route');
  await change('Primary agent', 'new-primary'); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putRoutes', {
    id: route.id, platform: route.platform, workspace: route.workspace, channel: route.channel, parent: route.parent, pair: route.pair,
    primary: 'new-primary', peer: route.peer, guest: route.guest, readers: route.readers, notes: route.notes,
  });
});

it('edits every connection field with references only and strips live metadata', async () => {
  const answer = pendingWrite(); await draw('/p/bridges-preview/item/venues/art-discord');
  await click('Slack'); await change('Agent', 'mark'); await change('Workspace ID', 'T1'); await change('Bot ID', 'U1');
  await change('Token secret name', 'slack-token'); await change('App secret name', 'slack-app');
  await change('Only channels', 'D1\n\nG1'); await change('Ignored channels', 'G2'); await change('Bot role IDs', 'R1\nR2');
  await click('Connection enabled'); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putVenues', { id: 'art-discord', platform: 'slack', agent: 'mark', workspace: 'T1', bot: 'U1', tokenSecret: 'slack-token', appSecret: 'slack-app', enabled: false, only: ['D1', 'G1'], ignore: ['G2'], botRoles: ['R1', 'R2'] });
  await submit(); expect(f.call).toHaveBeenCalledTimes(1); expect(button('Save connection').props.disabled).toBe(true); expect(text()).toContain('Saving connection…');
  await answer({ ok: false, code: 'denied', message: 'Owner required' }); expect(text()).toContain('denied: Owner required');
});
it('preserves unusual connection strings and list entries on an unrelated edit', async () => {
  pendingWrite(); const v = { ...f.snapshots['bridges.venue'].records[0], workspace: ' house ', tokenSecret: ' token ', appSecret: ' app ', only: [' a ', 'b\nc'], ignore: [' d '], botRoles: [' e\nf '] };
  await publish('bridges.venue', [v]); await draw('/p/bridges-preview/item/venues/art-discord'); await change('Agent', 'mark'); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putVenues', { id: v.id, platform: v.platform, workspace: v.workspace, bot: v.bot, agent: 'mark', tokenSecret: v.tokenSecret, appSecret: v.appSecret, enabled: v.enabled, only: v.only, ignore: v.ignore, botRoles: v.botRoles });
});
it('creates distinct connections with stable retry ids and required identity fields', async () => {
  const answer = pendingWrite(); const go = vi.fn();
  await act(async () => { tree = create(h(BridgesApp, { path: '/p/bridges-preview', go })); }); await click('New connection');
  const first = go.mock.calls[0][0] as string;
  await act(async () => { tree!.update(h(BridgesApp, { path: first, go })); });
  for (const [label, value] of [['Agent', 'art'], ['Workspace ID', 'T1'], ['Bot ID', 'U1'], ['Token secret name', 'token']]) {
    await submit(); expect(f.call).not.toHaveBeenCalled(); await change(label, value);
  }
  await click('Slack'); await submit(); const id = decodeURIComponent(first.split('/').at(-1)!); expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putVenues', { id, platform: 'slack', agent: 'art', workspace: 'T1', bot: 'U1', tokenSecret: 'token', appSecret: undefined, enabled: true, only: [], ignore: [], botRoles: [] });
  await answer({ ok: false, code: 'unavailable', message: 'Try later' }); await submit(); expect(f.call.mock.calls[1][1]).toMatchObject({ id });
  await click('New connection'); expect(go.mock.calls.at(-1)![0]).not.toBe(first);
});
it('confirms connection removal and keeps its pending request through navigation', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/venues/art-discord'); await click('Remove connection'); expect(f.call).not.toHaveBeenCalled();
  await click('Keep connection'); expect(button('Confirm removal')).toBeUndefined(); await click('Remove connection'); await click('Confirm removal');
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.removeVenues', { id: 'art-discord' }); expect(text()).toContain('Removing connection…');
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/routes/route' })); }); await submit(); expect(f.call).toHaveBeenCalledTimes(1); expect(text()).toContain('Another setup change is pending…');
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/venues/art-discord' })); });
  expect(button('Remove connection').props.disabled).toBe(true); await submit(); expect(f.call).toHaveBeenCalledTimes(1);
});
it('blocks connection writes while a route write is pending, even for the same id', async () => {
  const answer = pendingWrite(); await draw('/p/bridges-preview/item/routes/route'); await submit();
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/new-venue/route' })); });
  await change('Agent', 'art'); await change('Workspace ID', 'T1'); await change('Bot ID', 'U1'); await change('Token secret name', 'token');
  expect(button('Save connection').props.disabled).toBe(true); await submit(); expect(f.call).toHaveBeenCalledTimes(1);
  await answer({ ok: true, value: { id: 'route' } }); await submit(); expect(f.call).toHaveBeenCalledTimes(2);
});
it('latches setup changes until connection reload and ignores traffic-only changes', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/venues/art-discord'); const original = f.snapshots['bridges.venue'].records[0];
  await publish('bridges.venue', [{ ...original, received: 10, connection: 'backoff' }]); expect(button('Save connection').props.disabled).toBe(false);
  await click('Remove connection'); await publish('bridges.venue', [{ ...original, bot: 'new-bot' }]); await publish('bridges.venue', [original]);
  expect(button('Confirm removal')).toBeUndefined(); await submit(); expect(f.call).not.toHaveBeenCalled(); expect(button('Remove connection').props.disabled).toBe(true);
  await click('Try again'); await click('Remove connection'); await click('Confirm removal'); expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.removeVenues', { id: 'art-discord' });
});
it.each(['offline', 'denied'] as const)('clears connection controls on %s', async status => {
  await draw('/p/bridges-preview/item/venues/art-discord'); await publish('bridges.venue', f.snapshots['bridges.venue'].records as LiveRecord[], status);
  expect(button('Save connection')).toBeUndefined(); expect(button('New connection')).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
});
it('whitelists a saved connection reopened through its creation URL', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/new-venue/art-discord'); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putVenues', { id: 'art-discord', platform: 'discord', agent: 'art', workspace: 'house', bot: '100', tokenSecret: 'discord-token', appSecret: 'discord-app', enabled: true, only: ['300'], ignore: ['400'], botRoles: ['500'] });
});

it.each(['Only channels', 'Ignored channels', 'Bot role IDs'])('normalizes modified-and-restored %s while preserving other connection lists', async label => {
  pendingWrite(); const v = { ...f.snapshots['bridges.venue'].records[0], only: ['a\nb'], ignore: ['c\nd'], botRoles: ['e\nf'] };
  await publish('bridges.venue', [v]); await draw('/p/bridges-preview/item/venues/art-discord');
  const key = label === 'Only channels' ? 'only' : label === 'Ignored channels' ? 'ignore' : 'botRoles';
  await change(label, 'temporary'); await change(label, v[key].join('\n')); await submit();
  expect(f.call.mock.calls[0][1]).toMatchObject({ only: v.only, ignore: v.ignore, botRoles: v.botRoles, [key]: v[key][0].split('\n') });
});
it.each(['Reader agents', 'Note references'])('normalizes modified-and-restored route %s', async label => {
  pendingWrite(); await publish('bridges.route', [{ ...f.snapshots['bridges.route'].records[0], readers: ['a\nb'], notes: ['c\nd'] }]);
  await draw('/p/bridges-preview/item/routes/route'); const key = label === 'Reader agents' ? 'readers' : 'notes'; const raw = key === 'readers' ? 'a\nb' : 'c\nd';
  await change(label, 'temporary'); await change(label, raw); await submit(); expect(f.call.mock.calls[0][1]).toMatchObject({ [key]: raw.split('\n') });
});

it('edits all person-link fields with exact strings and no live metadata', async () => {
  const answer = pendingWrite(); await draw('/p/bridges-preview/item/links/link');
  await click('Slack'); await change('Workspace ID', ' T1 '); await change('Platform user ID', ' U1 '); await change('Person ID', ' mark '); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putLinks', { id: 'link', platform: 'slack', workspace: ' T1 ', user: ' U1 ', person: ' mark ' });
  expect(text()).toContain('Saving person link…'); await submit(); expect(f.call).toHaveBeenCalledTimes(1);
  await answer({ ok: false, code: 'denied', message: 'Owner required' }); expect(text()).toContain('denied: Owner required');
  expect(button('Save person link').props.disabled).toBe(false);
});
it('creates distinct person links with stable retries and requires every identity field', async () => {
  const answer = pendingWrite(); const go = vi.fn();
  await draw('/p/bridges-preview'); await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/links/link', go })); });
  await click('New person link'); const first = go.mock.calls[0][0] as string;
  await act(async () => { tree!.update(h(BridgesApp, { path: first, go })); });
  for (const [label, value] of [['Workspace ID', 'T1'], ['Platform user ID', 'U1'], ['Person ID', 'mark']]) {
    await submit(); expect(f.call).not.toHaveBeenCalled(); await change(label, value);
  }
  await click('Slack'); await submit(); const id = decodeURIComponent(first.split('/').at(-1)!); expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putLinks', { id, platform: 'slack', workspace: 'T1', user: 'U1', person: 'mark' });
  await answer({ ok: false, code: 'unavailable', message: 'Try later' }); await submit(); expect(f.call.mock.calls[1][1]).toMatchObject({ id });
  await click('New person link'); expect(go.mock.calls.at(-1)![0]).not.toBe(first);
});
it('whitelists saved person links reopened by their creation URL and preserves untouched identifiers', async () => {
  pendingWrite(); await publish('bridges.link', [{ ...f.snapshots['bridges.link'].records[0], workspace: ' house ', user: ' 200\n ', person: ' jonathan ' }]);
  await draw('/p/bridges-preview/item/new-link/link'); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putLinks', { id: 'link', platform: 'discord', workspace: ' house ', user: ' 200\n ', person: ' jonathan ' });
});
it('confirms person-link removal and retains its pending request across navigation and tables', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/links/link'); await click('Remove person link'); expect(f.call).not.toHaveBeenCalled();
  await click('Keep person link'); expect(button('Confirm removal')).toBeUndefined(); await click('Remove person link'); await click('Confirm removal');
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.removeLinks', { id: 'link' }); expect(text()).toContain('Removing person link…');
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/routes/route' })); }); await submit(); expect(f.call).toHaveBeenCalledTimes(1);
  expect(text()).toContain('Another setup change is pending…');
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/links/link' })); });
  expect(button('Remove person link').props.disabled).toBe(true); await click('Remove person link'); await submit(); expect(f.call).toHaveBeenCalledTimes(1);
});
it('blocks person links while a same-id connection write is pending without mixing request feedback', async () => {
  const answer = pendingWrite(); await draw('/p/bridges-preview/item/venues/art-discord'); await submit();
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/new-link/art-discord' })); });
  await change('Workspace ID', 'T1'); await change('Platform user ID', 'U1'); await change('Person ID', 'mark'); await submit(); expect(f.call).toHaveBeenCalledTimes(1);
  expect(text()).toContain('Another setup change is pending…'); expect(text()).not.toContain('Saving person link…');
  await answer({ ok: true, value: { id: 'art-discord' } }); await submit(); expect(f.call).toHaveBeenCalledTimes(2);
});
it('latches live person-link changes including edit-restore until explicitly reloaded', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/links/link'); await click('Remove person link'); const original = f.snapshots['bridges.link'].records[0];
  await publish('bridges.link', [{ ...original, person: 'mark' }]); await publish('bridges.link', [original]);
  expect(text()).toContain('This person link changed'); expect(button('Confirm removal')).toBeUndefined();
  await submit(); expect(f.call).not.toHaveBeenCalled(); expect(button('Remove person link').props.disabled).toBe(true);
  await click('Try again'); await change('Person ID', 'replacement'); await submit();
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.putLinks', { id: 'link', platform: 'discord', workspace: 'house', user: '200', person: 'replacement' });
});
it.each(['offline', 'denied'] as const)('clears person-link details and creation controls on %s', async status => {
  await draw('/p/bridges-preview/item/links/link'); await publish('bridges.link', f.snapshots['bridges.link'].records as LiveRecord[], status);
  expect(button('Save person link')).toBeUndefined(); expect(button('New person link')).toBeUndefined(); expect(text()).not.toContain('jonathan'); expect(f.call).not.toHaveBeenCalled();
});
it('clears evicted person-link details', async () => {
  await draw('/p/bridges-preview/item/links/link'); await publish('bridges.link', []);
  expect(button('Save person link')).toBeUndefined(); expect(text()).toContain('no longer in view');
});
it.each([false, true])('clears an evicted saved person link on its creation URL (navigate=%s)', async navigateAway => {
  const answer = pendingWrite(); await draw('/p/bridges-preview/item/new-link/new-id');
  await change('Workspace ID', 'house'); await change('Platform user ID', '201'); await change('Person ID', 'mark'); await submit();
  await publish('bridges.link', [{ id: 'new-id', platform: 'discord', workspace: 'house', user: '201', person: 'mark' }]);
  await answer({ ok: true, value: { id: 'new-id' } });
  expect(button('Save person link')).toBeDefined();
  if (navigateAway) await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/routes/route' })); });
  await publish('bridges.link', []);
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/new-link/new-id' })); });
  expect(button('Save person link')).toBeUndefined(); expect(text()).toContain('no longer in view'); expect(text()).not.toContain('Person ID');
  expect(f.call).toHaveBeenCalledTimes(1);
});
it.each([
  ['links/link', 'bridges.link', 'person', 'mark', 'Save person link'],
  ['routes/route', 'bridges.route', 'primary', 'mark', 'Save route'],
  ['venues/art-discord', 'bridges.venue', 'bot', 'replacement', 'Save connection'],
])('keeps the stale latch across navigation for %s', async (item, type, field, value, save) => {
  pendingWrite(); await draw(`/p/bridges-preview/item/${item}`); const original = f.snapshots[type].records[0];
  await publish(type, [{ ...original, [field]: value }]); await publish(type, [original]);
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/sends/reply' })); });
  await act(async () => { tree!.update(h(BridgesApp, { path: `/p/bridges-preview/item/${item}` })); });
  expect(button(save).props.disabled).toBe(true); await submit(); expect(f.call).not.toHaveBeenCalled();
  await click('Try again'); expect(button(save).props.disabled).toBe(false); await submit(); expect(f.call).toHaveBeenCalledTimes(1);
});
it.each([
  ['new-link/link', 'bridges.link', 'Save person link'],
  ['new-route/route', 'bridges.route', 'Save route'],
  ['new-venue/art-discord', 'bridges.venue', 'Save connection'],
])('does not resurrect an evicted saved creation while another view was open: %s', async (item, type, save) => {
  await draw('/p/bridges-preview/item/sends/reply'); await publish(type, []);
  await act(async () => { tree!.update(h(BridgesApp, { path: `/p/bridges-preview/item/${item}` })); });
  expect(button(save)).toBeUndefined(); expect(text()).toContain('no longer in view'); expect(f.call).not.toHaveBeenCalled();
});
it('remembers a successful link creation even if no saved record arrived before navigation', async () => {
  const answer = pendingWrite(); await draw('/p/bridges-preview/item/new-link/new-id');
  await change('Workspace ID', 'house'); await change('Platform user ID', '201'); await change('Person ID', 'mark'); await submit();
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/sends/reply' })); });
  await answer({ ok: true, value: { id: 'new-id' } });
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/new-link/new-id' })); });
  expect(button('Save person link')).toBeUndefined(); expect(text()).toContain('no longer in view'); expect(f.call).toHaveBeenCalledTimes(1);
});
it('observes a newly saved link arriving only after its creation editor unmounted', async () => {
  pendingWrite(); await draw('/p/bridges-preview/item/new-link/new-id');
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/sends/reply' })); });
  await publish('bridges.link', [{ id: 'new-id', platform: 'slack', workspace: 'T1', user: 'U1', person: 'mark' }]); await publish('bridges.link', []);
  await act(async () => { tree!.update(h(BridgesApp, { path: '/p/bridges-preview/item/new-link/new-id' })); });
  expect(button('Save person link')).toBeUndefined(); expect(text()).toContain('no longer in view');
});
it.each([
  ['new-link/same-id', 'bridges.link', 'Save person link', 'Person ID', 'person', 'mark', { id: 'same-id', platform: 'slack', workspace: 'T1', user: 'U1', person: 'other-person' }],
  ['new-route/same-id', 'bridges.route', 'Save route', 'Primary agent', 'primary', 'mark', { id: 'same-id', platform: 'slack', workspace: 'T1', channel: 'G1', primary: 'other-agent', peer: false, guest: false, readers: [], notes: [] }],
  ['new-venue/same-id', 'bridges.venue', 'Save connection', 'Agent', 'agent', 'mark', { id: 'same-id', platform: 'slack', workspace: 'T1', bot: 'U1', agent: 'other-agent', tokenSecret: 'reference', enabled: true, only: [], ignore: [], botRoles: [] }],
] as const)('blocks a creation draft when another window first creates that id: %s', async (item, type, save, label, field, draft, incoming) => {
  pendingWrite(); await draw(`/p/bridges-preview/item/${item}`); await change(label, draft);
  await publish(type, [incoming]);
  expect(button(save).props.disabled).toBe(true); await submit(); expect(f.call).not.toHaveBeenCalled();
  await click('Try again'); expect(button(save).props.disabled).toBe(false); await submit();
  expect(f.call.mock.calls[0][1]).toMatchObject({ id: 'same-id', [field]: incoming[field] });
});

it.each(['held', 'uncertain'])('confirms %s dismissal with observed state and metadata only', async state => {
  pendingWrite();
  await publish('bridges.send', [{ ...f.snapshots['bridges.send'].records[0], state, remoteId: 'partial-receipt' }]);
  await draw('/p/bridges-preview/item/sends/reply');
  await click('Dismiss this send'); expect(f.call).not.toHaveBeenCalled();
  expect(text()).toContain('does not confirm delivery');
  await click('Keep for review'); expect(button('Confirm dismissal')).toBeUndefined();
  await click('Dismiss this send'); await click('Confirm dismissal');
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.dismissSend', { id: 'reply', state });
  expect(button('Dismiss this send').props.disabled).toBe(true);
  await click('Dismiss this send'); expect(f.call).toHaveBeenCalledTimes(1);
  expect(button('Release this send')).toBeUndefined();
});
it('retains pending dismissal, errors and accepted acknowledgement across navigation', async () => {
  const answer = pendingWrite();
  await publish('bridges.send', [{ ...f.snapshots['bridges.send'].records[0], state: 'uncertain' }]);
  await draw('/p/bridges-preview/item/sends/reply'); await click('Dismiss this send'); await click('Confirm dismissal');
  const navigate = (path: string) => act(async () => { tree!.update(h(BridgesApp, { path })); });
  await navigate('/p/bridges-preview/item/routes/route'); await navigate('/p/bridges-preview/item/sends/reply');
  expect(button('Dismiss this send').props.disabled).toBe(true); expect(text()).toContain('Dismissing send');
  await answer({ ok: false, code: 'conflict', message: 'Send state changed' });
  expect(text()).toContain('conflict: Send state changed');
  await navigate('/p/bridges-preview'); await navigate('/p/bridges-preview/item/sends/reply');
  expect(text()).toContain('conflict: Send state changed');
  await click('Dismiss this send'); await click('Confirm dismissal');
  expect(f.call).toHaveBeenCalledTimes(2);
  await answer({ ok: true, value: { id: 'reply' } });
  expect(text()).toContain('Dismissal accepted'); expect(button('Dismiss this send').props.disabled).toBe(true);
  await publish('bridges.send', []);
  expect(text()).toContain('no longer in view'); expect(button('Dismiss this send')).toBeUndefined();
});
it.each(['pending', 'sending', 'sent', 'dismissed'])('offers no dismissal for %s sends', async state => {
  await publish('bridges.send', [{ ...f.snapshots['bridges.send'].records[0], state }]);
  await draw('/p/bridges-preview/item/sends/reply'); expect(button('Dismiss this send')).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
});
it.each(['offline', 'denied'] as const)('drops dismissal confirmation on %s and requires fresh confirmation on reconnect', async status => {
  const records = [{ ...f.snapshots['bridges.send'].records[0], state: 'held' }];
  await publish('bridges.send', records); await draw('/p/bridges-preview/item/sends/reply'); await click('Dismiss this send');
  await publish('bridges.send', records, status);
  expect(button('Confirm dismissal')).toBeUndefined(); expect(button('Dismiss this send')).toBeUndefined();
  await publish('bridges.send', records);
  expect(button('Confirm dismissal')).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
});
it('invalidates confirmation when observed send state changes, including edit and restore', async () => {
  pendingWrite(); const original = { ...f.snapshots['bridges.send'].records[0], state: 'held' };
  await publish('bridges.send', [original]); await draw('/p/bridges-preview/item/effects/bridges%3Areply'); await click('Dismiss this send');
  await publish('bridges.send', [{ ...original, state: 'uncertain' }]); expect(button('Confirm dismissal')).toBeUndefined();
  await publish('bridges.send', [original]); expect(button('Confirm dismissal')).toBeUndefined();
  await click('Dismiss this send'); await click('Confirm dismissal');
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.dismissSend', { id: 'reply', state: 'held' });
});
it('does not offer dismissal for an orphan staging effect or an evicted send', async () => {
  await publish('bridges.send', [{ ...f.snapshots['bridges.send'].records[0], state: 'held' }]);
  await draw('/p/bridges-preview/item/effects/bridges%3Areply'); await click('Dismiss this send');
  await publish('bridges.send', []); expect(button('Confirm dismissal')).toBeUndefined(); expect(button('Dismiss this send')).toBeUndefined();
  expect(button('Release this send')).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
});
it.each([{ remoteId: 'new-receipt' }, { venue: 'other-connection' }, { incoming: 'other-intake' }])('invalidates same-state confirmation when metadata changes: %j', async update => {
  pendingWrite(); const original = { ...f.snapshots['bridges.send'].records[0], state: 'uncertain' };
  await publish('bridges.send', [original]); await draw('/p/bridges-preview/item/sends/reply'); await click('Dismiss this send');
  await publish('bridges.send', [{ ...original, ...update }]);
  expect(button('Confirm dismissal')).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
  await click('Dismiss this send'); await click('Confirm dismissal');
  expect(f.call).toHaveBeenCalledExactlyOnceWith('bridges.dismissSend', { id: 'reply', state: 'uncertain' });
});
