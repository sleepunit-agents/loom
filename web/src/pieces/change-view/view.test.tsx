import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../kit', () => ({
  ...Object.fromEntries(['List', 'Row', 'NoteRow', 'Empty', 'Error', 'Loading', 'Button', 'LinkButton', 'Actions', 'Search', 'Input', 'Textarea', 'Field', 'Fields', 'Reader', 'Meta', 'Title', 'Facts', 'Fact', 'Section', 'Disclosure', 'Clamp', 'Body', 'Chip', 'RefCard', 'Markdown'].map(name => [name, (props: { children?: ReactNode }) => h(name, props, props.children)])),
  Split: (props: { list?: ReactNode; reader?: ReactNode; listTop?: ReactNode; listAction?: ReactNode; folders?: unknown; listTitle?: ReactNode; listCount?: number; backLabel?: string }) => h('Split', { folders: props.folders, listTitle: props.listTitle, listCount: props.listCount, backLabel: props.backLabel }, props.listAction, props.listTop, props.list, props.reader),
}));
import Changes, { ChangeCard, type ChangeActions } from './index';
import { rows, summary, type Change, type ChangeSnapshot } from './model';
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
  expect(buttons().map((b: { props: { children: ReactNode } }) => b.props.children).flat()).toContain('Always for pond');
  await act(async () => { buttons().find((b: { props: { children: string } }) => b.props.children === 'Yes, merge it').props.onClick(); });
  expect(answer).toHaveBeenCalledExactlyOnceWith(change.id, change.headCommit, 'yes');
  const next = { ...snapshot, changes: [{ ...change, headCommit: 'b'.repeat(40) }] };
  await act(async () => { tree.update(h(Changes, { snapshot: next, actions, openTask })); });
  expect(buttons().map((b: { props: { children: ReactNode } }) => b.props.children).flat()).not.toContain('Always for pond');
  await act(async () => { buttons().find((b: { props: { children: string } }) => b.props.children === 'Not yet').props.onClick(); });
  expect(answer).toHaveBeenLastCalledWith(change.id, 'b'.repeat(40), 'no');
  // A linked task is its title and its id as a chip that opens it.
  await act(async () => { tree.root.findAllByType('Chip').find((c: { props: { children: string } }) => c.props.children === 't-1').props.onClick(); });
  expect(openTask).toHaveBeenCalledExactlyOnceWith('t-1');
});

it('says every state in plain words, keeps a row to one short state, and puts developer facts behind Details', async () => {
  const long = Array.from({ length: 30 }, (_, n) => `Line ${n}`).join('\n');
  const s: ChangeSnapshot = { ...snapshot, changes: [{ ...change, body: long, checks: 'failing', review: 'not_required' }, { ...change, id: 'c-ci', title: 'CI', waitingOn: 'ci', checks: 'none' },
    { ...change, id: 'c-agent', title: 'Agent', waitingOn: 'agent' }, { ...change, id: 'c-red', title: 'Red', waitingOn: 'author', checks: 'failing' }, { ...change, id: 'c-done', title: 'Done', waitingOn: 'done', state: 'merged' }],
    checks: [{ change: change.id, name: 'Lint', state: 'failing' }, { change: change.id, name: 'Build', state: 'running' }], people: [], links: [], tasks: [],
    sync: { readAt: '2026-11-14T20:31:00Z', failed: true, nextAt: null } };
  expect(summary(s.changes[0])).toBe('Checks failing · No review needed · Waiting on you');
  expect(summary(s.changes[1])).toBe('No checks · Approved · Waiting on the checks');
  expect(summary(s.changes[2], id => ({ art: 'Art' })[id] ?? id)).toBe('Checks passing · Approved · Waiting on Art');
  expect(summary({ ...s.changes[4], draft: true })).toBe('Merged · Draft');
  await act(async () => { tree = create(h(Changes, { snapshot: s, actions: { refresh: vi.fn(), answer: vi.fn() }, names: { art: 'Art' } })); });
  expect(tree.root.findAllByType('Row').map((r: { props: { status: string } }) => r.props.status)).toEqual(['Waiting on you', 'Waiting on Art', 'Waiting on the checks', 'Checks failing', 'Merged']);
  // The list's head: the folder and its count, Refresh as its one quiet action, and when GitHub was last read, briefly.
  const split = tree.root.findByType('Split');
  expect(split.props).toMatchObject({ listTitle: 'All changes', listCount: 5, backLabel: 'Back to Changes' });
  expect((split.props.folders as { id: string; count?: number }[]).map(f => [f.id, f.count])).toEqual([['all', 5], ['you', 1], ['lately', undefined], ['project:pond', 5]]);
  const text = JSON.stringify(tree.toJSON());
  expect(text).toContain('Last read '); expect(text).not.toContain('America/Chicago');
  expect(tree.root.findAllByType('NoteRow').map((n: { props: { title: string } }) => n.props.title)).toEqual(['GitHub read failed']);
  expect(buttons().map((b: { props: { children: string; variant?: string } }) => [b.props.children, b.props.variant])).toEqual([['Refresh', undefined]]);
  await select();
  const sections = () => tree.root.findAllByType('Section').map((n: { props: { label: string } }) => n.props.label);
  // No heading over nothing: nobody is on it and no task is linked.
  expect(sections()).toEqual(['Checks', 'Review', 'Merge answer', 'Description']);
  const words = JSON.stringify(tree.toJSON());
  for (const raw of ['not_required', 'CI ', 'Mergeable: ', 'a'.repeat(40) + '"]']) expect(words).not.toContain(raw);
  for (const plain of ['Checks failing', 'No review needed']) expect(words).toContain(plain);
  expect(tree.root.findAllByType('Fact').slice(0, 2).map((n: { props: { label: string; children: string } }) => [n.props.label, n.props.children])).toEqual([['Failing', 'Lint'], ['Running', 'Build']]);
  expect(tree.root.findAllByType('Meta').map((n: { props: { children: unknown } }) => [n.props.children].flat().join(''))).toContain('art · pump into next');
  expect(tree.root.findByType('Clamp').props.long).toBe(true); expect(tree.root.findByType('Markdown').props.text).toBe(long);
  const details = tree.root.findByType('Disclosure'); expect(details.props.label).toBe('Details');
  const commit = details.findByProps({ title: 'a'.repeat(40) }); expect(commit.props.children).toBe('aaaaaaaa');
  expect(buttons().filter((b: { props: { variant?: string } }) => b.props.variant === 'primary').map((b: { props: { children: string } }) => b.props.children)).toEqual(['Yes, merge it']);
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
