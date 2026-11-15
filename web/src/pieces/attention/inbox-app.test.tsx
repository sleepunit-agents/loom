import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
import type { InboxItem } from '../inbox-view/model';
const f = vi.hoisted(() => ({ status: 'live', data: {} as Record<string, unknown>, requests: [] as { variables: Record<string, unknown> }[], call: vi.fn(), records: vi.fn() }));
vi.mock('../../data/query', () => ({ useQuery(selection: { variables: Record<string, unknown>; decode(value: Record<string, unknown>): unknown }) {
  f.requests.push(selection);
  return { status: f.status, data: f.status === 'live' ? selection.decode({ ...f.data,
    inboxItems: selection.variables.onlyErrors ? undefined : f.data.inboxItems,
    inboxItem: selection.variables.hasItem ? f.data.inboxItem : null }) : undefined };
} }));
vi.mock('../../data', () => ({ callOnce: (name: string, input: unknown) => f.call(name, input), call: vi.fn(), useRecords: f.records }));
vi.mock('../../kit', () => Object.fromEntries(['Split','Row','Empty','Error','Loading','Button','Input','Textarea'].map(name => [name,
  (props: { children?: ReactNode; folder?: string; folders?: unknown; onFolder?: (id: string) => void; listTop?: ReactNode; list?: ReactNode; reader?: ReactNode; search?: ReactNode }) => name === 'Split'
    ? h(name, { folder: props.folder, folders: props.folders, onFolder: props.onFolder }, props.listTop, props.list, props.reader, props.search)
    : h(name, props, props.children)])));
import InboxApp from './index';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); vi.useRealTimers(); f.requests = []; f.call.mockReset(); f.records.mockReset(); });
function row(extra: Partial<InboxItem> = {}): InboxItem {
  return { id: 'in-1', source: 'thread', agent: 'art', at: '2026-11-14T18:00:00.000Z', state: 'waiting', volume: 'full', answers: 'yes-no', refs: [], read: false, body: { words: 'Buy the pump?', ifYes: 'Order it', ifNo: 'Skip it' }, ...extra };
}
function setup(item = row(), items = [item]) {
  f.status = 'live'; f.requests = []; f.records.mockClear(); f.call.mockImplementation(() => ({ result: Promise.resolve({ ok: true, value: { saved: true } }) }));
  f.data = { inboxItems: items, inboxItem: item, inboxFolders: { needs: 130, answered: 12, fyi: 8, all: 150, agents: [{ id: 'art', count: 149 }, { id: 'mark', count: 1 }] },
    inboxActionResults: [{ id: 'result-1', at: item.at, ok: false, text: 'Action failed', page: '/p/tasks-preview', readAt: null }] };
}
const button = (name: string) => tree.root.findAllByType('Button').find((node: { props: { children: unknown } }) => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children) === name);
const text = () => JSON.stringify(tree.toJSON());
it('mounts shared Inbox, server folder totals and actual authenticated read/answer operations', async () => {
  setup(); const go = vi.fn();
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go })); });
  expect(text()).toContain('Buy the pump?');
  expect(tree.root.findByType('Split').props.folders).toContainEqual({ id: 'needs', label: 'Needs you', count: 130 });
  expect(tree.root.findByType('Split').props.folders).toContainEqual({ id: 'agent:mark', label: 'mark', count: 1 });
  expect(f.records).not.toHaveBeenCalled();
  expect(f.call).toHaveBeenCalledWith('inbox.read', { item: 'in-1' });
  await act(async () => { button('Yes').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('inbox.answer', { item: 'in-1', answer: 'yes' });
  expect(f.requests.at(-1)?.variables).toMatchObject({ folder: 'needs', offset: 0, search: '', id: 'in-1', hasItem: true });
});
it('consumes whole-mailbox search without locally discarding source matches, pages and resets the cursor on search', async () => {
  const selected = row({ read: true, body: { words: 'Different display text' }, sourceId: 'needle' });
  setup(selected, Array.from({ length: 51 }, (_, n) => row({ id: `in-${n}`, read: true })));
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview', go: vi.fn() })); });
  expect(tree.root.findAllByType('Row')).toHaveLength(50);
  await act(async () => { button('Next page').props.onClick(); });
  expect(f.requests.at(-1)?.variables.offset).toBe(50);
  f.data.inboxItems = [selected];
  await act(async () => { tree.root.findByType('Input').props.onChange({ target: { value: 'needle' } }); });
  expect(f.requests.at(-1)?.variables).toMatchObject({ search: 'needle', offset: 0 });
  expect(text()).toContain('Different display text'); expect(button('Next page').props.disabled).toBe(true);
});
it('opens source-owned questions and dismisses actual action notices without central answers', async () => {
  setup(row({ source: 'task', sourceId: 't-1', read: true })); const go = vi.fn();
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go })); });
  expect(button('Yes')).toBeUndefined();
  await act(async () => { button('Open task').props.onClick(); });
  expect(go).toHaveBeenCalledWith('/p/tasks-preview/task/t-1');
  await act(async () => { tree.root.findByType('Split').props.onFolder('errors'); });
  expect(f.requests.at(-1)?.variables.onlyErrors).toBe(true);
  expect(text()).toContain('Action failed');
  await act(async () => { button('Dismiss notice').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('inbox.dismissResult', { id: 'result-1' });
});
it('withdraws private question and answer words at their independent deadlines and on access loss', async () => {
  vi.useFakeTimers(); const now = Date.parse('2026-11-14T18:00:00.000Z'); vi.setSystemTime(now);
  setup(row({ thread: 'th:private', read: true, state: 'answered', body: { words: 'PRIVATE QUESTION' }, answerText: 'PRIVATE ANSWER', answer: 'words',
    bodyKeepUntil: new Date(now + 1000).toISOString(), answerKeepUntil: new Date(now + 2000).toISOString() }));
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go: vi.fn() })); });
  expect(text()).toContain('PRIVATE QUESTION'); expect(text()).toContain('PRIVATE ANSWER');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(text()).not.toContain('PRIVATE QUESTION'); expect(text()).toContain('PRIVATE ANSWER');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(text()).not.toContain('PRIVATE ANSWER');
  f.status = 'denied'; await act(async () => { tree.update(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go: vi.fn() })); });
  expect(tree.root.findAllByType('Row')).toHaveLength(0); expect(button('Yes')).toBeUndefined(); expect(text()).not.toContain('Buy the pump');
});
