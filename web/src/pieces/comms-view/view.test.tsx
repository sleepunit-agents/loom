import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Children, createElement as h, type ReactNode } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../kit', () => Object.fromEntries(['Split', 'Row', 'Empty', 'Error', 'Loading', 'Button', 'Input', 'Textarea'].map(name => [name, (props: { children?: ReactNode; list?: ReactNode; reader?: ReactNode; search?: ReactNode; listTop?: ReactNode }) => name === 'Split' ? h(name, { label: 'Comms' }, props.listTop, props.search, props.list, props.reader) : h(name, props, props.children)])));
import { CommsView } from './index';
import { threadRows, type CommsActions, type CommsDetail, type CommsSnapshot } from './model';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('window',new EventTarget());
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
});
afterEach(async () => { await act(async () => tree?.unmount()); vi.unstubAllGlobals(); });
const thread = { id: 'th:pump', conversation: 'cv-pump', title: 'Private pump', agent: 'art', project: 'pond', member: 'alice', pinned: false, lastAt: '2026-11-14T20:00:00Z', readSeq: 0, working: true, stopRequested: false };
const snapshot: CommsSnapshot = { status: 'live', member: 'alice', threads: [thread], agents: [{ id: 'art', name: 'Art' }] };
const detail: CommsDetail = { status: 'live', thread, refs: [{ ref: 't-12', messageSeq: 2 }], messages: [
  { thread: thread.id, seq: 1, kind: 'message', sender: 'alice', at: thread.lastAt, words: 'Find the pump', delivery: 'delivered' },
  { thread: thread.id, seq: 2, kind: 'reply', sender: 'art', at: thread.lastAt, words: 'Three pumps fit' },
  { thread: thread.id, seq: 3, kind: 'card', sender: 'art', at: thread.lastAt, words: 'Looked up pumps', tool: 'Search', cardState: 'done' },
  { thread: thread.id, seq: 4, kind: 'ask', sender: 'art', at: thread.lastAt, words: 'PRIVATE ENVELOPE', inboxItem: 'in-ask' },
] };
const actions = (): CommsActions => ({ open: vi.fn(async () => {}), send: vi.fn(async () => {}), read: vi.fn(async () => {}), change: vi.fn(async () => {}) });
const named = (label: string) => tree.root.findAllByType('Button').find((button: { props: { children: string } }) => Children.toArray(button.props.children).join('') === label);
async function draw(a = actions(), d = detail, s = snapshot) { await act(async () => { tree = create(h(CommsView, { snapshot: s, detail: d, selected: thread.id, select: vi.fn(), actions: a })); }); }
it('shows canonical messages/progress, shared question/work slots and marks the displayed sequence read', async () => {
  const a = actions(), question = vi.fn((id: string) => h('p', null, `Question ${id}`)), work = vi.fn(() => h('p', null, 'Pump task'));
  await act(async () => { tree = create(h(CommsView, { snapshot, detail, selected: thread.id, select: vi.fn(), actions: a, cards: { question, work } })); });
  const text = JSON.stringify(tree.toJSON());
  for (const words of ['Private pump', 'Three pumps fit', 'Search', 'done', 'Question in-ask', 'Pump task']) expect(text).toContain(words);
  expect(text).not.toContain('PRIVATE ENVELOPE');
  expect(a.read).toHaveBeenCalledExactlyOnceWith(thread.id, 4);
  expect(work).toHaveBeenCalledWith(detail.refs, thread.conversation);
});
it('keeps the same message client id and draft for retries, and prevents repeated send taps', async () => {
  const a = actions(); let reject!: (error: Error) => void;
  a.send = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  await draw(a);
  await act(async () => { tree.root.findByType('Textarea').props.onChange({ target: { value: 'Can you order it?' } }); });
  await act(async () => { const send = named('Send'); send.props.onClick(); send.props.onClick(); });
  expect(a.send).toHaveBeenCalledTimes(1);
  const id = vi.mocked(a.send).mock.calls[0][2];
  await act(async () => { reject(new Error('private detail')); });
  expect(JSON.stringify(tree.toJSON())).not.toContain('private detail');
  expect(tree.root.findByType('Textarea').props.value).toBe('Can you order it?');
  a.send = vi.fn(async () => {});
  await act(async () => { tree.update(h(CommsView, { snapshot, detail, selected: thread.id, select: vi.fn(), actions: a })); });
  await act(async () => { named('Send').props.onClick(); });
  expect(a.send).toHaveBeenCalledExactlyOnceWith(thread.id, 'Can you order it?', id);
  expect(tree.root.findByType('Textarea').props.value).toBe('');
});
it('routes thread changes by their real id and only offers Stop while work is running', async () => {
  const a = actions(); await draw(a);
  await act(async () => { named('Pin').props.onClick(); });
  expect(a.change).toHaveBeenLastCalledWith(thread.id, { change: 'pin', pinned: true });
  await act(async () => { named('Stop').props.onClick(); });
  expect(a.change).toHaveBeenLastCalledWith(thread.id, { change: 'stop' });
  await act(async () => { named('Rename').props.onClick(); });
  const input = tree.root.findAllByType('Input').find((node: { props: { 'aria-label': string } }) => node.props['aria-label'] === 'Conversation title');
  await act(async () => { input.props.onChange({ target: { value: 'New name' } }); });
  await act(async () => { named('Save title').props.onClick(); });
  expect(a.change).toHaveBeenLastCalledWith(thread.id, { change: 'rename', title: 'New name' });
  await act(async () => { tree.update(h(CommsView, { snapshot, detail: { ...detail, thread: { ...thread, working: false } }, selected: thread.id, select: vi.fn(), actions: a })); });
  expect(named('Stop')).toBeUndefined();
});
it('withdraws private thread titles/messages/composer on query loss and never substitutes a different thread', async () => {
  const a = actions(); await draw(a);
  for (const status of ['loading', 'offline', 'denied'] as const) {
    await act(async () => { tree.update(h(CommsView, { snapshot: { ...snapshot, status }, detail, selected: thread.id, select: vi.fn(), actions: a })); });
    expect(JSON.stringify(tree.toJSON())).not.toContain('Private pump'); expect(JSON.stringify(tree.toJSON())).not.toContain('Three pumps fit');
    expect(tree.root.findAllByType('Textarea')).toHaveLength(0);
  }
  await act(async () => { tree.update(h(CommsView, { snapshot, detail: { ...detail, status: 'denied' }, selected: thread.id, select: vi.fn(), actions: a })); });
  expect(JSON.stringify(tree.toJSON())).not.toContain('Private pump');
  await act(async () => { tree.update(h(CommsView, { snapshot, detail: { ...detail, thread: { ...thread, id: 'th:other' } }, selected: thread.id, select: vi.fn(), actions: a })); });
  expect(tree.root.findAllByType('article')).toHaveLength(0);
});
it('pins first, filters archives/search, and never lists stale snapshots', () => {
  const s = { ...snapshot, threads: [thread, { ...thread, id: 'pinned', pinned: true }, { ...thread, id: 'archive', archivedAt: thread.lastAt }] };
  expect(threadRows(s, false, 'pump pond').map(row => row.id)).toEqual(['pinned', thread.id]);
  expect(threadRows(s, true, '').map(row => row.id)).toEqual(['archive']);
  expect(threadRows({ ...s, status: 'denied' }, false, '')).toEqual([]);
});
it('keeps a new thread id on retry and fences completed navigation after member changes', async () => {
  const a = actions(), select = vi.fn(); let reject!: (error: Error) => void;
  a.open = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  await act(async () => { tree = create(h(CommsView, { snapshot, select, actions: a })); });
  await act(async () => { const button = named('Chat with Art'); button.props.onClick(); button.props.onClick(); });
  expect(a.open).toHaveBeenCalledTimes(1); const id = vi.mocked(a.open).mock.calls[0][1];
  await act(async () => { reject(new Error('failed')); });
  let finish!: () => void; a.open = vi.fn(() => new Promise<void>(yes => { finish = yes; }));
  await act(async () => { tree.update(h(CommsView, { snapshot, select, actions: a })); });
  await act(async () => { named('Chat with Art').props.onClick(); });
  expect(a.open).toHaveBeenCalledExactlyOnceWith('art', id);
  await act(async () => { tree.update(h(CommsView, { snapshot: { ...snapshot, member: 'bob' }, select, actions: a })); });
  await act(async () => { finish(); });
  expect(select).not.toHaveBeenCalled();
});

it('shows work filed from the conversation even when no task or pull request was mentioned', async () => {
  const work = vi.fn(() => h('p', null, 'Task created here'));
  await act(async () => { tree = create(h(CommsView, { snapshot, detail: { ...detail, refs: [] }, selected: thread.id, select: vi.fn(), cards: { work } })); });
  expect(work).toHaveBeenCalledWith([], thread.conversation);
  expect(JSON.stringify(tree.toJSON())).toContain('Task created here');
});

it('keeps unsent words across loading and navigation, partitioned by member and thread', async () => {
  const a = actions(); await draw(a);
  await act(async () => { tree.root.findByType('Textarea').props.onChange({ target: { value: 'Unsent diagnostic draft' } }); });
  const update = async (s = snapshot, d = detail, selected = thread.id) => act(async () => {
    tree.update(h(CommsView, { snapshot: s, detail: d, selected, select: vi.fn(), actions: a }));
  });
  await update({ ...snapshot, status: 'loading' });
  expect(tree.root.findAllByType('Textarea')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).not.toContain('Unsent diagnostic draft');
  await update();
  expect(tree.root.findByType('Textarea').props.value).toBe('Unsent diagnostic draft');
  const other = { ...thread, id: 'th:other', conversation: 'cv-other' };
  await update({ ...snapshot, threads: [other] }, { ...detail, thread: other, messages: [] }, other.id);
  expect(tree.root.findByType('Textarea').props.value).toBe('');
  await update({ ...snapshot, member: 'bob', threads: [{ ...thread, member: 'bob' }] }, { ...detail, thread: { ...thread, member: 'bob' } });
  expect(tree.root.findByType('Textarea').props.value).toBe('');
  await update();
  expect(tree.root.findByType('Textarea').props.value).toBe('Unsent diagnostic draft');
  expect(a.send).not.toHaveBeenCalled();
});
it('keeps a failed send identity across refresh and clears only acknowledged words', async () => {
  const a = actions(); a.send = vi.fn(async () => { throw new Error('uncertain delivery'); });
  await draw(a);
  await act(async () => { tree.root.findByType('Textarea').props.onChange({ target: { value: 'Send once' } }); });
  await act(async () => { named('Send').props.onClick(); });
  const id = vi.mocked(a.send).mock.calls[0][2];
  await act(async () => { tree.unmount(); });
  await draw(a);
  expect(tree.root.findByType('Textarea').props.value).toBe('Send once');
  a.send = vi.fn(async () => {});
  await act(async () => { named('Send').props.onClick(); });
  expect(a.send).toHaveBeenCalledExactlyOnceWith(thread.id, 'Send once', id);
  expect(tree.root.findByType('Textarea').props.value).toBe('');
  await act(async () => { tree.unmount(); });
  await draw(a);
  expect(tree.root.findByType('Textarea').props.value).toBe('');
});

it('clears a remounted composer when its earlier send acknowledges, preserving later edits', async () => {
 const a=actions();let finish!:()=>void;a.send=vi.fn(()=>new Promise<void>(yes=>{finish=yes;}));await draw(a);
 await act(async()=>tree.root.findByType('Textarea').props.onChange({target:{value:'Sending before refresh'}}));
 await act(async()=>named('Send').props.onClick());
 const update=async(status:CommsSnapshot['status'])=>act(async()=>tree.update(h(CommsView,{snapshot:{...snapshot,status},detail,selected:thread.id,select:vi.fn(),actions:a})));
 await update('loading');await update('live');
 expect(tree.root.findByType('Textarea').props.value).toBe('Sending before refresh');
 await act(async()=>finish());
 expect(tree.root.findByType('Textarea').props.value).toBe('');
 await act(async()=>tree.root.findByType('Textarea').props.onChange({target:{value:'Second send'}}));
 await act(async()=>named('Send').props.onClick());await update('loading');await update('live');
 await act(async()=>tree.root.findByType('Textarea').props.onChange({target:{value:'Newer unsent words'}}));
 await act(async()=>finish());
 expect(tree.root.findByType('Textarea').props.value).toBe('Newer unsent words');
});

it('reads a terminal thread without offering to send or stop it', async () => {
  const a = actions();
  await draw(a);
  await act(async () => { tree.update(h(CommsView, { snapshot, detail: { ...detail, thread: { ...thread, venue: 'terminal' } },
    selected: thread.id, select: vi.fn(), actions: a })); });
  expect(named('Send')).toBeUndefined();
  expect(named('Stop')).toBeUndefined();
  expect(tree.root.findAllByType('Textarea')).toHaveLength(0);
});
