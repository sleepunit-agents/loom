import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Children, createElement as h, useEffect, type ReactNode } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
// The kit as plain elements named for its parts, so a test can find a part and call what it was given.
// The kit's Menu is the real one (over the mocked Button), so what is behind More is still seen.
vi.mock('../../components/ui/button', () => ({ Button: (props: { children?: ReactNode }) => h('Button', props, props.children) }));
vi.mock('../../kit', async () => ({ Menu: (await vi.importActual<typeof import('../../kit/menu')>('../../kit/menu')).Menu, ...Object.fromEntries(['RefCard','Split', 'Row', 'Empty', 'Error', 'Loading', 'Button', 'LinkButton', 'Input', 'Textarea', 'Actions', 'Search', 'Pager', 'Head', 'Title', 'Meta', 'Chips', 'Chip'].map(name => [name, (props: { children?: ReactNode; list?: ReactNode; reader?: ReactNode; search?: ReactNode; listTop?: ReactNode; listAction?: ReactNode; listTitle?: ReactNode; listCount?: number }) => name === 'Split'
  ? h(name, { label: 'Comms', listTitle: props.listTitle, listCount: props.listCount }, h('ListAction', null, props.listAction), props.listTop, props.search, props.list, props.reader)
  // (A row's icon is an element: drawn as a child, so the tree still prints.)
  : name === 'Row' ? h(name, { ...props, icon: undefined }, (props as { icon?: ReactNode }).icon)
  // (So is what a head carries at its sides.)
  : name === 'Head' ? h('header', null, (props as { leading?: ReactNode }).leading, props.children, (props as { actions?: ReactNode }).actions) : h(name, props, props.children)])) }));
import { CommsView } from './index';
import { briefTime, fullTime } from '../../kit/time';
import { threadRows, type CommsActions, type CommsDetail, type CommsSnapshot } from './model';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('window',new EventTarget());
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
});
afterEach(async () => { await act(async () => tree?.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });
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
const press = async (label: string) => act(async () => { named(label).props.onClick(); });
/** Send is the bar's submit button: sending is submitting its form. */
const send = () => { void tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); };
const classed = (name: string) => tree.root.findAll((node: { type: unknown; props: { className?: string } }) => typeof node.type === 'string' && node.props.className === name);
type Drawn = { children: (Drawn | string)[] };
const words = (node: Drawn): string => node.children.map(child => typeof child === 'string' ? child : words(child)).join('');
const key = (extra: object = {}) => ({ key: 'Enter', preventDefault: vi.fn(), currentTarget: { closest: () => null }, ...extra });
async function draw(a = actions(), d = detail, s = snapshot) { await act(async () => { tree = create(h(CommsView, { snapshot: s, detail: d, selected: thread.id, select: vi.fn(), actions: a })); }); }
it('shows canonical messages/progress, shared question/work slots and marks the displayed sequence read', async () => {
  const a = actions(), question = vi.fn((id: string) => h('p', null, `Question ${id}`)), work = vi.fn(() => h('p', null, 'Pump task'));
  await act(async () => { tree = create(h(CommsView, { snapshot, detail, selected: thread.id, select: vi.fn(), actions: a, cards: { question, work } })); });
  const text = JSON.stringify(tree.toJSON());
  for (const words of ['Private pump', 'Three pumps fit', 'Looked up pumps', 'done', 'Question in-ask', 'Pump task']) expect(text).toContain(words);
  expect(text).not.toContain('PRIVATE ENVELOPE');
  expect(a.read).toHaveBeenCalledExactlyOnceWith(thread.id, 4);
  expect(work).toHaveBeenCalledWith(detail.refs, thread.conversation);
});
it('keeps the same message client id and draft for retries, and prevents repeated send taps', async () => {
  const a = actions(); let reject!: (error: Error) => void;
  a.send = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  await draw(a);
  await act(async () => { tree.root.findByType('Textarea').props.onChange({ target: { value: 'Can you order it?' } }); });
  await act(async () => { void send(); void send(); });
  expect(a.send).toHaveBeenCalledTimes(1);
  const id = vi.mocked(a.send).mock.calls[0][2];
  await act(async () => { reject(new Error('private detail')); });
  expect(JSON.stringify(tree.toJSON())).not.toContain('private detail');
  expect(tree.root.findByType('Textarea').props.value).toBe('Can you order it?');
  a.send = vi.fn(async () => {});
  await act(async () => { tree.update(h(CommsView, { snapshot, detail, selected: thread.id, select: vi.fn(), actions: a })); });
  await act(async () => { send(); });
  expect(a.send).toHaveBeenCalledExactlyOnceWith(thread.id, 'Can you order it?', id);
  expect(tree.root.findByType('Textarea').props.value).toBe('');
});
it('routes thread changes by their real id and only offers Stop while work is running', async () => {
  const a = actions(); await draw(a);
  await press('More'); await press('Pin');
  expect(a.change).toHaveBeenLastCalledWith(thread.id, { change: 'pin', pinned: true });
  await press('Stop');
  expect(a.change).toHaveBeenLastCalledWith(thread.id, { change: 'stop' });
  await press('More'); await press('Rename');
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
  await act(async () => { const button = named('New'); button.props.onClick(); button.props.onClick(); });
  expect(a.open).toHaveBeenCalledTimes(1); const id = vi.mocked(a.open).mock.calls[0][1];
  await act(async () => { reject(new Error('failed')); });
  let finish!: () => void; a.open = vi.fn(() => new Promise<void>(yes => { finish = yes; }));
  await act(async () => { tree.update(h(CommsView, { snapshot, select, actions: a })); });
  await act(async () => { named('New').props.onClick(); });
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
  await act(async () => { send(); });
  const id = vi.mocked(a.send).mock.calls[0][2];
  await act(async () => { tree.unmount(); });
  await draw(a);
  expect(tree.root.findByType('Textarea').props.value).toBe('Send once');
  a.send = vi.fn(async () => {});
  await act(async () => { send(); });
  expect(a.send).toHaveBeenCalledExactlyOnceWith(thread.id, 'Send once', id);
  expect(tree.root.findByType('Textarea').props.value).toBe('');
  await act(async () => { tree.unmount(); });
  await draw(a);
  expect(tree.root.findByType('Textarea').props.value).toBe('');
});

it('clears a remounted composer when its earlier send acknowledges, preserving later edits', async () => {
 const a=actions();let finish!:()=>void;a.send=vi.fn(()=>new Promise<void>(yes=>{finish=yes;}));await draw(a);
 await act(async()=>tree.root.findByType('Textarea').props.onChange({target:{value:'Sending before refresh'}}));
 await act(async()=>send());
 const update=async(status:CommsSnapshot['status'])=>act(async()=>tree.update(h(CommsView,{snapshot:{...snapshot,status},detail,selected:thread.id,select:vi.fn(),actions:a})));
 await update('loading');await update('live');
 expect(tree.root.findByType('Textarea').props.value).toBe('Sending before refresh');
 await act(async()=>finish());
 expect(tree.root.findByType('Textarea').props.value).toBe('');
 await act(async()=>tree.root.findByType('Textarea').props.onChange({target:{value:'Second send'}}));
 await act(async()=>send());await update('loading');await update('live');
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
  expect(JSON.stringify(tree.toJSON())).toContain('This conversation happens in a terminal. Reply there.');
});

// ---- the conversation as its page on the how-it-works site draws it ----
const at = (minute: number) => `2026-11-14T20:${String(minute).padStart(2, '0')}:00Z`;
const talk: CommsDetail = { ...detail, refs: [{ ref: 't-2190', messageSeq: 3 }], messages: [
  { thread: thread.id, seq: 1, kind: 'message', sender: 'alice', at: at(0), words: 'Can you find a pump?', delivery: 'delivered' },
  { thread: thread.id, seq: 2, kind: 'message', sender: 'alice', at: at(1), words: 'One that fits the old hose', delivery: 'sending' },
  { thread: thread.id, seq: 3, kind: 'reply', sender: 'art', at: at(2), words: 'Three fit. I filed t-2190.' },
  { thread: thread.id, seq: 4, kind: 'reply', sender: 'art', at: at(3), words: 'The middle one is in stock.' },
  { thread: thread.id, seq: 5, kind: 'card', sender: 'art', at: at(4), words: 'Looked up three pumps', tool: 'web_search', cardState: 'done' },
  { thread: thread.id, seq: 6, kind: 'card', sender: 'art', at: at(4), words: null, tool: 'Search', cardState: 'running' },
  { thread: thread.id, seq: 7, kind: 'message', sender: 'alice', at: at(30), words: 'Order it', delivery: 'failed' },
] };
it('draws the person on the right and the agent on the left, one name and one brief time for each run of messages', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-19T18:00:00Z'));
  await act(async () => { tree = create(h(CommsView, { snapshot, detail: talk, selected: thread.id, select: vi.fn(), actions: actions(), zone: 'America/Chicago' })); });
  const groups = classed('comms-group');
  expect(groups.map((group: { props: { 'data-side': string } }) => group.props['data-side'])).toEqual(['me', 'them', 'me']);
  // One line of who and when per group: two messages a minute apart share it; a third, half an hour on, starts another.
  const who = classed('comms-group__who').map((line: { findByType(type: string): { children: string[] }; findAllByType(type: string): { children: string[] }[] }) => [line.findByType('span').children.join(''), line.findByType('time').children.join('')]);
  expect(who).toEqual([['You', 'Nov 14, 2:00 PM'], ['Art', 'Nov 14, 2:02 PM'], ['You', 'Nov 14, 2:30 PM']]);
  expect(groups.map((group: { findAll(match: (node: { props: { className?: string } }) => boolean): unknown[] }) => group.findAll(node => node.props.className === 'comms-msg').length)).toEqual([2, 2, 1]);
  // Each message still says who and when to a screen reader, in a log that announces politely.
  expect(classed('comms-sr').map((node: { children: string[] }) => node.children.join(''))).toContain('Art, Nov 14, 2026, 2:03 PM: ');
  expect(tree.root.findByProps({ role: 'log' }).props).toMatchObject({ 'aria-live': 'polite', 'aria-label': 'Messages' });
  const text = JSON.stringify(tree.toJSON());
  for (const raw of ['America/Chicago', ' CT', '· delivered', 'reply', 'alice']) expect(text).not.toContain(raw);
  expect(text).not.toMatch(/\d:\d\d:\d\d [AP]M/);
});
it('draws a tool step as one progress line in plain words, and a delivery only when it says something', async () => {
  await act(async () => { tree = create(h(CommsView, { snapshot, detail: talk, selected: thread.id, select: vi.fn(), actions: actions() })); });
  const steps = classed('comms-step');
  expect(steps.map((step: { props: { 'data-state': string }; findAllByType(type: string): { children: string[] }[] }) => [step.props['data-state'], step.findAllByType('span').at(-1)!.children.join('')]))
    .toEqual([['done', 'Looked up three pumps · done'], ['running', 'Search · in progress']]);
  expect(JSON.stringify(tree.toJSON())).not.toContain('web_search');
  expect(JSON.stringify(tree.toJSON())).toContain('Send a follow-up here to retry delivery of your waiting messages.');
  expect(classed('comms-delivery').map((line: { props: { 'data-state': string }; children: string[] }) => [line.props['data-state'], line.children.join('')])).toEqual([['sending', 'Sending…'], ['failed', 'Not delivered']]);
});
it('draws a reference in a message as a chip that opens its page where the app knows how', async () => {
  const opened = vi.fn(), openRef = vi.fn((ref: string) => ref === 't-2190' ? () => opened(ref) : undefined);
  const mineToo: CommsDetail = { ...talk, refs: [{ ref: 't-2190', messageSeq: 1 }, { ref: 'github:owner/repo#12', messageSeq: 1 }],
    messages: [{ ...talk.messages[0], words: 'See t-2190 and github:owner/repo#12, not at-21900.' }] };
  await act(async () => { tree = create(h(CommsView, { snapshot, detail: mineToo, selected: thread.id, select: vi.fn(), actions: actions(), cards: { openRef } })); });
  const chips = tree.root.findByProps({ 'data-comms-scroll': '' }).findAllByType('Chip');
  expect(chips.map((chip: { props: { children: string } }) => chip.props.children)).toEqual(['t-2190', 'github:owner/repo#12']);
  expect(chips[1].props.onClick).toBeUndefined();
  await act(async () => { chips[0].props.onClick(); }); expect(opened).toHaveBeenCalledExactlyOnceWith('t-2190');
});
it('keeps Pin, Archive, Rename and Delete behind one More menu, Stop beside it, and Delete behind its confirmation', async () => {
  const a = actions(); await draw(a);
  for (const label of ['Pin', 'Archive', 'Rename', 'Delete']) expect(named(label)).toBeUndefined();
  expect(named('Stop')).toBeDefined(); expect(named('More').props).toMatchObject({ 'aria-expanded': false });
  await press('More');
  expect(named('More').props['aria-expanded']).toBe(true);
  const menu = tree.root.findByProps({ className: 'loom-kit-menu__box' });
  expect(menu.findAllByType('Button').map((button: { props: { children: string } }) => button.props.children)).toEqual(['Pin', 'Archive', 'Rename', 'Delete']);
  expect(named('Delete').props.variant).toBe('danger-quiet');
  // Escape closes it without choosing, and the surrounding reader never hears that Escape.
  const escape = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
  await act(async () => { tree.root.findByProps({ className: 'loom-kit-menu' }).props.onKeyDown(escape); });
  expect(named('Pin')).toBeUndefined(); expect(escape.preventDefault).toHaveBeenCalled(); expect(escape.stopPropagation).toHaveBeenCalled();
  await press('More'); await press('Delete');
  expect(named('Pin')).toBeUndefined(); expect(a.change).not.toHaveBeenCalled();
  expect(JSON.stringify(tree.toJSON())).toContain('Delete this thread and its private words?');
  await press('Keep thread'); expect(named('Delete thread')).toBeUndefined(); expect(a.change).not.toHaveBeenCalled();
  await press('More'); await press('Delete'); await press('Delete thread');
  expect(a.change).toHaveBeenCalledExactlyOnceWith(thread.id, { change: 'delete' });
});
it('starts a conversation from the list header: New alone with one agent, a menu of agents with more', async () => {
  const a = actions(), select = vi.fn();
  await act(async () => { tree = create(h(CommsView, { snapshot, select, actions: a })); });
  const action = () => tree.root.findByType('ListAction');
  expect(action().findAllByType('Button').map((button: { props: { children: string; 'aria-label': string } }) => [button.props.children, button.props['aria-label']])).toEqual([['New', 'New conversation with Art']]);
  expect(JSON.stringify(tree.toJSON())).not.toContain('<details'); expect(tree.root.findAllByType('details')).toHaveLength(0);
  expect(tree.root.findByType('Split').props).toMatchObject({ listTitle: 'Threads', listCount: 1 });
  await act(async () => { tree.update(h(CommsView, { snapshot: { ...snapshot, agents: [...snapshot.agents, { id: 'mark', name: 'Mark' }] }, select, actions: a })); });
  expect(named('Chat with Mark')).toBeUndefined();
  await act(async () => { action().findByType('Button').props.onClick(); });
  expect(action().findAllByType('Button').map((button: { props: { children: ReactNode } }) => Children.toArray(button.props.children).join(''))).toEqual(['New', 'Chat with Art', 'Chat with Mark']);
  await act(async () => { named('Chat with Mark').props.onClick(); });
  expect(a.open).toHaveBeenCalledExactlyOnceWith('mark', expect.stringMatching(/^th:/)); expect(named('Chat with Mark')).toBeUndefined();
});
it('says a status on a row only when it says something, and marks an unread one', async () => {
  const rows = [thread, { ...thread, id: 'th:quiet', working: false, unread: true }, { ...thread, id: 'th:pinned', working: false, pinned: true }];
  await act(async () => { tree = create(h(CommsView, { snapshot: { ...snapshot, threads: rows }, select: vi.fn() })); });
  const drawn = Object.fromEntries(tree.root.findAllByType('Row').map((row: { key: string; props: { status?: string; unread?: boolean; meta: string } }) => [row.props.status ?? '', [row.props.unread, row.props.meta]]));
  expect(drawn).toEqual({ Pinned: [undefined, 'Art · pond'], Working: [undefined, 'Art · pond'], '': [true, 'Art · pond'] });
  expect(JSON.stringify(tree.toJSON())).not.toContain('Ready');
});
it('heads the thread with its title, who it is with, its project as a chip and a state only when there is one', async () => {
  await draw();
  const head = tree.root.findByType('header');
  expect(head.findByType('Title').props.children).toBe('Private pump');
  expect(words(head.findByType('Meta'))).toBe('with Art pond · Working');
  expect(head.findByType('Chip').props.children).toBe('pond');
  await act(async () => { tree.update(h(CommsView, { snapshot, detail: { ...detail, thread: { ...thread, working: false } }, selected: thread.id, select: vi.fn(), actions: actions() })); });
  expect(words(tree.root.findByType('header').findByType('Meta'))).toBe('with Art pond');
  // A question that waits on this person says so in the head, for as long as its card says it is waiting.
  const question = (id: string, note: (id: string, waiting: boolean) => void) => h(Waiter, { id, note });
  await act(async () => { tree.update(h(CommsView, { snapshot, detail: { ...detail, thread: { ...thread, working: false } }, selected: thread.id, select: vi.fn(), actions: actions(), cards: { question } })); });
  expect(words(tree.root.findByType('header').findByType('Meta'))).toBe('with Art pond · Waiting on you');
});
function Waiter({ id, note }: { id: string; note(id: string, waiting: boolean): void }) { useEffect(() => { note(id, true); return () => note(id, false); }, [id]); return h('p', null, `Question ${id}`); }
it('keeps the message bar under the messages: one line named for the agent, Send as the one filled button', async () => {
  await draw();
  const body = tree.root.findByProps({ className: 'comms__body' });
  const parts = body.children.map((child: { props: { className: string } }) => child.props.className);
  expect(parts[0]).toBe('comms__stream'); expect(parts.at(-1)).toBe('comms__compose');
  // The messages are the one box that scrolls; the bar is outside it, after it.
  const scroller = tree.root.findByProps({ 'data-comms-scroll': '' });
  expect(scroller.findAllByType('form')).toHaveLength(0); expect(body.findByProps({ className: 'comms__compose' }).findAllByType('form')).toHaveLength(1);
  const box = tree.root.findByType('Textarea');
  expect(box.props).toMatchObject({ 'aria-label': 'Message Art', placeholder: 'Message Art', rows: 1 });
  expect(tree.root.findAllByType('label')).toHaveLength(0);
  expect(tree.root.findAllByType('Button').filter((button: { props: { variant?: string } }) => button.props.variant === 'primary').map((button: { props: { children: string; type: string } }) => [button.props.children, button.props.type])).toEqual([['Send', 'submit']]);
  // The sheet is what pins it: in a tile the reader holds still and the messages scroll inside it, keeping their scrollbar's place.
  const css = readFileSync(new URL('./comms.css', import.meta.url), 'utf8');
  expect(css).toMatch(/\.next-page > \.loom-split\.loom-comms > \.loom-split__reader \{[^}]*overflow: hidden/);
  expect(css).toMatch(/\.comms-msgs \{[^}]*overflow-y: auto[^}]*scrollbar-gutter: stable/);
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
});
it('sends on Enter and makes a new line on Shift+Enter; on the phone shell Enter is a new line and the button sends', async () => {
  const a = actions(); await draw(a);
  const type = async (words: string) => act(async () => { tree.root.findByType('Textarea').props.onChange({ target: { value: words } }); });
  const down = async (event: ReturnType<typeof key>) => { await act(async () => { tree.root.findByType('Textarea').props.onKeyDown(event); }); return event; };
  await type('First');
  const shifted = await down(key({ shiftKey: true }));
  expect(a.send).not.toHaveBeenCalled(); expect(shifted.preventDefault).not.toHaveBeenCalled();
  await down(key({ nativeEvent: { isComposing: true } })); expect(a.send).not.toHaveBeenCalled();
  const entered = await down(key());
  expect(a.send).toHaveBeenCalledExactlyOnceWith(thread.id, 'First', expect.any(String)); expect(entered.preventDefault).toHaveBeenCalled();
  expect(tree.root.findByType('Textarea').props.value).toBe('');
  await type('Second');
  const phone = { closest: (selector: string) => selector === '[data-shell="phone"]' ? {} : null };
  const tapped = await down(key({ currentTarget: phone }));
  expect(a.send).toHaveBeenCalledTimes(1); expect(tapped.preventDefault).not.toHaveBeenCalled();
  await down(key({ currentTarget: phone, ctrlKey: true })); expect(a.send).toHaveBeenCalledTimes(2);
  await type('Third'); await act(async () => { send(); });
  expect(a.send).toHaveBeenLastCalledWith(thread.id, 'Third', expect.any(String));
});
it('says why in one quiet line where the bar would be, when a conversation cannot be written to', async () => {
  const off = async (extra: object, a: CommsActions | undefined = actions()) => {
    await act(async () => { tree = create(h(CommsView, { snapshot, detail: { ...detail, thread: { ...thread, ...extra } }, selected: thread.id, select: vi.fn(), actions: a })); });
    const lines = classed('loom-composer__off').map((line: { children: string[] }) => line.children.join(''));
    expect(tree.root.findAllByType('Textarea')).toHaveLength(0); await act(async () => tree.unmount());
    return lines;
  };
  expect(await off({ venue: 'terminal' })).toEqual(['This conversation happens in a terminal. Reply there.']);
  expect(await off({ archivedAt: thread.lastAt })).toEqual(['This conversation is archived. Restore it from More to write here.']);
  expect(await off({ member: 'bob' })).toEqual(['This is someone else’s conversation, so you can read it but not write in it.']);
  await draw(); expect(classed('loom-composer__off')).toHaveLength(0);
});
it('loads earlier messages above the ones shown, holding what the person is looking at where it is', async () => {
  const scroll = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, firstElementChild: null, addEventListener() {}, removeEventListener() {} };
  const earlier = { status: 'loading' as const, messages: [] as CommsDetail['messages'], refs: [], hasEarlier: false };
  let page = earlier as { status: 'loading' | 'live'; messages: CommsDetail['messages']; refs: CommsDetail['refs']; hasEarlier: boolean };
  const asked: number[] = [];
  const view = () => h(CommsView, { snapshot, detail, selected: thread.id, select: vi.fn(), actions: actions(),
    messageNavigation: { hasEarlier: true, page: (before: number, draw: (page: typeof earlier) => ReactNode) => { asked.push(before); return draw(page as typeof earlier); } } });
  await act(async () => { tree = create(view(), { createNodeMock: (node: { props: Record<string, unknown> }) => node.props['data-comms-scroll'] === '' ? scroll : null }); });
  expect(asked).toEqual([]); expect(named('Latest messages')).toBeUndefined();
  // The person has scrolled to the top and asks for more: 1000 from the bottom.
  scroll.scrollTop = 0;
  await press('Earlier messages');
  expect(asked.at(-1)).toBe(1); expect(tree.root.findAllByType('Loading')).toHaveLength(1);
  expect(JSON.stringify(tree.toJSON())).toContain('Three pumps fit');
  page = { status: 'live', hasEarlier: true, refs: [], messages: [{ thread: thread.id, seq: -1, kind: 'reply', sender: 'art', at: thread.lastAt, words: 'EARLIER WORDS' }] };
  scroll.scrollHeight = 1400;
  await act(async () => { tree.update(view()); });
  // The page is 400 taller above: the view moves down by that much, so the same messages are under the eye.
  expect(scroll.scrollTop).toBe(400);
  const text = JSON.stringify(tree.toJSON());
  expect(text.indexOf('EARLIER WORDS')).toBeGreaterThan(-1); expect(text.indexOf('EARLIER WORDS')).toBeLessThan(text.indexOf('Find the pump'));
  // Above the earlier page, the way to the one before it; the newest messages never left.
  expect(named('Earlier messages')).toBeDefined(); expect(text).toContain('Three pumps fit');
  expect(tree.root.findByProps({ role: 'log' }).findAll((node: { props: { children?: unknown } }) => node.props.children === 'EARLIER WORDS')).toHaveLength(0);
});

it('says a time briefly: the time alone today, a short date with it on another day, the date and year before this year', () => {
  const now = Date.parse('2026-11-19T20:31:07Z');
  expect(briefTime('2026-11-19T20:31:07Z', 'America/Chicago', now)).toBe('2:31 PM');
  expect(briefTime('2026-11-14T20:31:07Z', 'America/Chicago', now)).toBe('Nov 14, 2:31 PM');
  expect(briefTime('2025-11-14T20:31:07Z', 'America/Chicago', now)).toBe('Nov 14, 2025');
  // The day is the zone's own: in Tokyo it is already the 20th, so a time on the 19th there is another day, and one after midnight there is today.
  expect(briefTime('2026-11-19T14:15:00Z', 'Asia/Tokyo', now)).toBe('Nov 19, 11:15 PM');
  expect(briefTime('2026-11-19T15:15:00Z', 'Asia/Tokyo', now)).toBe('12:15 AM');
  expect(fullTime('2026-11-19T20:31:07Z', 'America/Chicago')).toBe('Nov 19, 2026, 2:31 PM');
  // A zone the device does not know falls back to the device's own, and a stamp that is no date says nothing.
  expect(briefTime('2026-11-19T20:31:07Z', 'Not/AZone', now)).toMatch(/^(Nov \d+, )?\d{1,2}:31 [AP]M$/); expect(briefTime('never', 'America/Chicago', now)).toBe('');
});
it('says an answer under its words as a quiet note, and as the bubble itself when it has no words', async () => {
  const answered: CommsDetail = { ...detail, messages: [
    { thread: thread.id, seq: 1, kind: 'answer', sender: 'alice', at: thread.lastAt, words: 'Go ahead', verdict: 'yes' },
    { thread: thread.id, seq: 2, kind: 'answer', sender: 'alice', at: thread.lastAt, words: null, verdict: 'no' }] };
  await act(async () => { tree = create(h(CommsView, { snapshot, detail: answered, selected: thread.id, select: vi.fn(), actions: actions() })); });
  expect(classed('comms-bubble').map(words)).toEqual(['Go ahead', 'Answered No']);
  expect(classed('comms-delivery').map(words)).toEqual(['Answered Yes']);
});

it('shows archived retry state after its private reason expires', async () => {
  const notice: CommsDetail['messages'][number] = {
    thread: thread.id, seq: 5, kind: 'notice', sender: 'loom', at: thread.lastAt,
    words: null, notice: { error: 'start-retry', settled: true, attempt: 2 },
  };
  await draw(actions(), { ...detail, messages: [notice] });
  expect(words(classed('comms-notice')[0])).toContain('The agent started after a retry · attempt 2');
});
