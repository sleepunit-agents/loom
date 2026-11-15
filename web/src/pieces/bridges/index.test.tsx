import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import type { DataQuerySnapshot } from '../../data/graphql';
import type { BridgesData } from './data';
import { bridgesQuery } from './data';
import BridgesApp from './index';
const feed = vi.hoisted(() => ({ query: { status: 'loading' } as DataQuerySnapshot<BridgesData>, hook: vi.fn() }));
vi.mock('../../data/graphql', () => ({ useDataQuery: (query: string) => { feed.hook(query); return feed.query; } }));
vi.mock('../../data', () => ({ useRecords() { throw Error('Legacy records used'); }, call() { throw Error('Legacy command used'); } }));
vi.mock('../../kit', () => ({
  Split: (p: any) => h('main', {}, ...p.folders.map((f: any) => h('button', { key: f.id, onClick: () => p.onFolder(f.id) }, f.label)), p.list, p.reader ?? p.blank, h('button', { onClick: p.onBack }, p.backLabel)),
  List: (p: any) => h('div', {}, p.children), Row: (p: any) => h('button', { onClick: p.onClick }, p.title, p.meta, p.status),
  Empty: (p: any) => h('p', {}, p.title), Error: (p: any) => h('p', { role: 'alert' }, p.text), Loading: (p: any) => h('p', {}, p.label),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: any;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; feed.hook.mockClear(); });
const text = () => JSON.stringify(tree.toJSON());
function data(): BridgesData {
  return { homeComms: { member: 'jonathan' }, bridgeActivity: [{ id: 'connection', received: 12, delivered: 10, held: 2 }], bridgeConnections: [{ id: 'connection', platform: 'slack', agent: 'art', workspace: 'Pond workspace', botUser: 'U-BOT', tokenSecret: 'bot-token', appSecret: 'app-token', enabled: true, state: 'connected', stateAt: '2026-11-14T12:00:00.000Z' }], bridgeChannelFilters: [], bridgeChannels: [], bridgePeople: [], bridgeSends: [] };
}
async function draw(path = '/p/bridges-preview', go = vi.fn()) {
  await act(async () => { const app = h(BridgesApp, { path, go }); if (tree) tree.update(app); else tree = create(app); });
  return go;
}
it('the registered app reads generated rows itself and selects a connection through tile navigation', async () => {
  feed.query = { status: 'live', data: data() }; const go = await draw();
  expect(feed.hook).toHaveBeenCalledWith(bridgesQuery); expect(text()).toContain('Pond workspace');
  const row = tree.root.findAllByType('button').find((b: any) => b.children.includes('art · slack'));
  await act(async () => row.props.onClick());
  expect(go).toHaveBeenCalledWith('/p/bridges-preview/item/connections/connection');
  await draw(go.mock.calls[0][0], go); expect(text()).toContain('Bot token: '); expect(text()).toContain('bot-token'); expect(text()).toContain('12');
});
it.each(['loading', 'offline', 'denied'] as const)('hides retained rows while %s', async status => {
  feed.query = { status: 'live', data: data() }; await draw(); expect(text()).toContain('Pond workspace');
  feed.query = { status, data: data() }; await draw(); expect(text()).not.toContain('Pond workspace'); expect(text()).not.toContain('bot-token');
});
it('requires the query member and drops a previous reader on a new principal', async () => {
  const initial = data(); feed.query = { status: 'live', data: initial }; await draw('/p/bridges-preview/item/connections/connection');
  expect(text()).toContain('bot-token');
  feed.query = { status: 'live', data: { ...initial, homeComms: null } }; await draw(); expect(text()).not.toContain('Pond workspace');
  feed.query = { status: 'live', data: { ...initial, homeComms: { member: 'other' }, bridgeConnections: [] } }; await draw();
  expect(text()).not.toContain('Pond workspace'); expect(text()).not.toContain('bot-token');
});
it('handles malformed selection ids without guessing a record', async () => {
  feed.query = { status: 'live', data: data() }; await draw('/p/bridges-preview/item/connections/%');
  expect(text()).toContain('Choose an item'); expect(text()).not.toContain('Bot token: ');
});
