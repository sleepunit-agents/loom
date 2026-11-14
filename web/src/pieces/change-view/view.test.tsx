import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../kit', () => ({
  ...Object.fromEntries(['List', 'Row', 'Empty', 'Error', 'Loading', 'Button', 'Input'].map(name => [name, (props: { children?: ReactNode }) => h(name, props, props.children)])),
  Split: (props: { list?: ReactNode; reader?: ReactNode; listTop?: ReactNode }) => h('Split', {}, props.listTop, props.list, props.reader),
}));
import Changes, { ChangeCard, type ChangeActions } from './index';
import { rows, type Change, type ChangeSnapshot } from './model';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const change: Change = { id: 'github:house/pond#1', repository: 'house/pond', number: 1, title: 'Pump order script', body: '', url: 'https://github.com/house/pond/pull/1',
  state: 'open', draft: false, authorLogin: 'art', project: 'pond', agent: 'art', branch: 'pump', headCommit: 'a'.repeat(40), baseBranch: 'next',
  checks: 'passing', review: 'approved', mergeable: 'yes', waitingOn: 'you', openedAt: '2026-11-14T20:00:00Z', updatedAt: '2026-11-14T20:00:00Z', closedAt: null };
const snapshot: ChangeSnapshot = { status: 'live', changes: [change], checks: [{ change: change.id, name: 'Lint', state: 'running' }],
  people: [{ change: change.id, login: 'reviewer', role: 'requested' }], links: [{ change: change.id, task: 't-1' }], tasks: [{ id: 't-1', title: 'Order pump', status: 'open' }], sync: null, timezone: 'America/Chicago' };
const buttons = () => tree.root.findAllByType('Button');
async function select() { await act(async () => { tree.root.findAllByType('Row').find((r: { props: { title: string } }) => r.props.title === change.title).props.onClick(); }); }

it('keeps chat a current reference card that opens the tile without offering merge controls', async () => {
  const open = vi.fn();
  await act(async () => { tree = create(h(ChangeCard, { id: change.id, snapshot, open })); });
  expect(buttons().map((b: { props: { children: string } }) => b.props.children)).toEqual(['Open']);
  await act(async () => { buttons()[0].props.onClick(); });
  expect(open).toHaveBeenCalledExactlyOnceWith(change.id);
  await act(async () => { tree.update(h(ChangeCard, { id: change.id, snapshot: { ...snapshot, status: 'offline' }, open })); });
  expect(buttons()).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).not.toContain(change.title);
});

it('shows checks, people and tasks and binds a merge answer to the current head', async () => {
  const answer = vi.fn(async () => {}), openTask = vi.fn();
  const actions: ChangeActions = { refresh: vi.fn(), answer,
    always: { change: change.id, head: change.headCommit, project: 'pond', run: vi.fn() } };
  await act(async () => { tree = create(h(Changes, { snapshot, actions, openTask })); });
  await select();
  const words = JSON.stringify(tree.toJSON());
  expect(words).toContain('Lint'); expect(words).toContain('reviewer'); expect(words).toContain('Order pump');
  expect(buttons().map((b: { props: { children: ReactNode } }) => b.props.children).flat()).toContain('Always for ');
  await act(async () => { buttons().find((b: { props: { children: string } }) => b.props.children === 'Yes, merge it').props.onClick(); });
  expect(answer).toHaveBeenCalledExactlyOnceWith(change.id, change.headCommit, 'yes');
  const next = { ...snapshot, changes: [{ ...change, headCommit: 'b'.repeat(40) }] };
  await act(async () => { tree.update(h(Changes, { snapshot: next, actions, openTask })); });
  expect(buttons().map((b: { props: { children: ReactNode } }) => b.props.children).flat()).not.toContain('Always for ');
  await act(async () => { buttons().find((b: { props: { children: string } }) => b.props.children === 'Not yet').props.onClick(); });
  expect(answer).toHaveBeenLastCalledWith(change.id, 'b'.repeat(40), 'no');
  await act(async () => { tree.root.findAllByType('Row').find((r: { props: { title: string } }) => r.props.title === 'Order pump').props.onClick(); });
  expect(openTask).toHaveBeenCalledExactlyOnceWith('t-1');
});

it('orders by who is waiting, filters projects and puts finished work last', () => {
  const s = { ...snapshot, changes: [
    { ...change, id: 'done', waitingOn: 'done' as const, state: 'merged' as const },
    { ...change, id: 'ci', waitingOn: 'ci' as const, project: 'loom' }, change,
    { ...change, id: 'agent', waitingOn: 'agent' as const },
  ] };
  expect(rows(s, 'all', '').map(c => c.id)).toEqual([change.id, 'agent', 'ci', 'done']);
  expect(rows(s, 'you', 'pump').map(c => c.id)).toEqual([change.id]);
  expect(rows(s, 'project:loom', '').map(c => c.id)).toEqual(['ci']);
  expect(rows({ ...s, status: 'denied' }, 'all', '')).toEqual([]);
});
