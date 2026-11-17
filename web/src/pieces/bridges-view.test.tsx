import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import { BridgesView, bridgePlaceKey, bridgePersonKey, type BridgesSnapshot, type BridgeFolder, type BridgeSelection } from './bridges-view';
import BridgesApp from './bridges';

vi.mock('../data', () => ({
  useRecords: () => { throw new Error('Shared Bridges must not subscribe to legacy records'); },
  call: () => { throw new Error('Shared Bridges must not issue legacy commands'); },
}));

// Dynamic renderer props, confined to the test boundary.
vi.mock('../kit', () => ({
  Split: (p: any) => h('main', {}, ...p.folders.map((f: any) => h('button', { key: f.id, onClick: () => p.onFolder(f.id) }, f.label)), p.list, p.reader ?? p.blank,
    h('button', { onClick: p.onBack }, p.backLabel)),
  List: (p: any) => h('div', {}, p.children),
  Row: (p: any) => h('button', { onClick: p.onClick, 'aria-current': p.selected }, p.title, p.meta, p.status),
  Empty: (p: any) => h('p', {}, p.title),
  Error: (p: any) => h('p', { role: 'alert' }, p.text),
  Loading: (p: any) => h('p', { role: 'status' }, p.label),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: any;
afterEach(async () => { await act(async () => tree?.unmount()); });
const text = () => JSON.stringify(tree.toJSON());
const select = vi.fn(), changeFolder = vi.fn();
function snapshot(): BridgesSnapshot {
  return {
    status: 'live', member: 'jonathan',
    connections: [{ id: 'c-1', platform: 'slack', agent: 'art', workspace: 'T-POND', botUser: 'U-BOT', tokenSecret: 'slack-bot-token', appSecret: 'slack-app-token', enabled: true, state: 'backoff', stateAt: '2026-11-14T22:00:00.000Z' }],
    filters: [{ connection: 'c-1', channel: 'only-here', rule: 'only' }, { connection: 'c-1', channel: 'skip-here', rule: 'ignore' }, { connection: 'other', channel: 'OTHER-FILTER', rule: 'only' }],
    channels: [{ platform: 'slack', workspace: 'T-POND', channel: 'C-1', answers: 'art', botsMayTalk: false }],
    people: [{ platform: 'slack', workspace: 'T-POND', user: 'U-1', member: 'jonathan' }],
    sends: (['pending', 'held', 'sending', 'uncertain', 'sent', 'dismissed'] as const).map(state => ({ id: state, incoming: 'in-1', connection: 'c-1', channel: 'C-1', thread: 'thread-1', text: `Reply ${state}`, state, createdAt: '2026-11-14T22:00:00.000Z' })),
    activity: [{ connection: 'c-1', received: 12, delivered: 10, held: 2 }],
  };
}
async function draw(s = snapshot(), folder: BridgeFolder = 'connections', selected?: BridgeSelection, cards?: Parameters<typeof BridgesView>[0]['cards']) {
  const element = h(BridgesView, { snapshot: s, member: 'jonathan', folder, selected, select, changeFolder, cards });
  await act(async () => { if (tree) tree.update(element); else tree = create(element); });
}
afterEach(() => { tree = undefined; select.mockClear(); changeFolder.mockClear(); });
it('shows connection state, separate filters, stored names and supplied activity without writing', async () => {
  const connection = vi.fn(id => h('p', {}, `Editor for ${id}`));
  await draw(snapshot(), 'connections', { folder: 'connections', id: 'c-1' }, { connection });
  expect(text()).toContain('backoff');
  expect(text()).toContain('12'); expect(text()).toContain('received');
  expect(text()).toContain('only-here'); expect(text()).toContain('skip-here');
  expect(text()).not.toContain('OTHER-FILTER');
  expect(text()).toContain('slack-bot-token'); expect(text()).toContain('slack-app-token');
  expect(connection).toHaveBeenCalledWith('c-1');
  expect(select).not.toHaveBeenCalled();
});
it.each(['offline', 'error', 'loading', 'member'] as const)('removes retained data and review controls on %s', async mode => {
  const connection = vi.fn(() => h('button', {}, 'Approval editor'));
  const s = snapshot();
  await draw(s, 'connections', { folder: 'connections', id: 'c-1' }, { connection });
  expect(text()).toContain('Approval editor'); connection.mockClear();
  await draw({ ...s, ...(mode === 'member' ? { member: 'another-member' } : { status: mode }) }, 'connections', { folder: 'connections', id: 'c-1' }, { connection });
  expect(text()).not.toContain('T-POND'); expect(text()).not.toContain('Approval editor');
  expect(connection).not.toHaveBeenCalled();
  expect(tree.root.findAllByType('button')).toHaveLength(0);
});
it('shows pending, sending, held and uncertain sends, and leaves completed sends out', async () => {
  await draw(snapshot(), 'sends');
  const output = text();
  for (const state of ['pending', 'held', 'sending', 'uncertain']) expect(output).toContain(`Reply ${state}`);
  for (const state of ['sent', 'dismissed']) expect(output).not.toContain(`Reply ${state}`);
  const send = vi.fn(id => h('p', {}, `Review ${id}`));
  await draw(snapshot(), 'sends', { folder: 'sends', id: 'uncertain' }, { send });
  expect(text()).toContain('Delivery could not be confirmed'); expect(send).toHaveBeenCalledWith('uncertain');
  await draw(snapshot(), 'sends', { folder: 'sends', id: 'held' });
  expect(text()).toContain('waits for a person');
});
it('closes a reviewed send when a live update completes it', async () => {
  const s = snapshot(), send = vi.fn(() => h('button', {}, 'Review send'));
  await draw(s, 'sends', { folder: 'sends', id: 'held' }, { send });
  expect(text()).toContain('Review send'); send.mockClear();
  await draw({ ...s, sends: s.sends.map(row => row.id === 'held' ? { ...row, state: 'sent' } : row) }, 'sends', { folder: 'sends', id: 'held' }, { send });
  expect(text()).not.toContain('Review send'); expect(text()).toContain('no longer available');
  expect(send).not.toHaveBeenCalled();
});
it('uses platform and workspace in selections for channel rules and person links', async () => {
  const s = snapshot();
  s.channels = [...s.channels, { ...s.channels[0], workspace: 'T-OTHER', answers: 'another-agent', botsMayTalk: true }];
  s.people = [...s.people, { ...s.people[0], workspace: 'T-OTHER', member: 'another-member' }];
  await draw(s, 'channels', { folder: 'channels', id: bridgePlaceKey(s.channels[1]) });
  expect(tree.root.findByType('article').findByType('h1').children).toEqual(['C-1']);
  expect(tree.root.findByType('article').findAllByType('p').some((p: any) => p.children.includes('another-agent'))).toBe(true);
  expect(bridgePlaceKey(s.channels[0])).not.toBe(bridgePlaceKey(s.channels[1]));
  expect(bridgePersonKey(s.people[0])).not.toBe(bridgePersonKey(s.people[1]));
  await draw(s, 'people', { folder: 'people', id: bridgePersonKey(s.people[1]) });
  expect(tree.root.findByType('article').findByType('h1').children).toEqual(['another-member']);
});
it('navigates by stable ids, clears selection on folder change, and ignores selections from another folder', async () => {
  await draw();
  await act(async () => tree.root.findAllByType('button').find((b: any) => b.children.includes('art · slack')).props.onClick());
  expect(select).toHaveBeenCalledWith({ folder: 'connections', id: 'c-1' });
  await act(async () => tree.root.findAllByType('button').find((b: any) => b.children.includes('Person links')).props.onClick());
  expect(select).toHaveBeenLastCalledWith(undefined); expect(changeFolder).toHaveBeenCalledWith('people');
  await draw(snapshot(), 'people', { folder: 'connections', id: 'c-1' });
  expect(tree.root.findAllByType('article')).toHaveLength(0);
});
it('shows useful empty folders without inventing a connection or counts', async () => {
  await draw({ ...snapshot(), connections: [], activity: [], channels: [], people: [], sends: [], filters: [] });
  expect(text()).toContain('No connections'); expect(text()).not.toContain('received');
});
it('mounts shared snapshots through the shipped Bridges app without legacy queries or commands', async () => {
  await act(async () => { tree = create(h(BridgesApp, { shared: {
    snapshot: snapshot(), member: 'jonathan', folder: 'connections', selected: { folder: 'connections', id: 'c-1' }, select, changeFolder,
  } })); });
  expect(text()).toContain('T-POND'); expect(text()).toContain('slack-bot-token');
});
