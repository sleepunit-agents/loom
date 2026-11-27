/** More than one conversation on the boards page (docs/specs/boards.md, "The page", Threads): the list of the
 * member's threads, a new conversation with any agent, the open thread's title with rename and archive, the
 * presence of the thread's own agent, and the address that still holds one id. No browser: the test renderer, with
 * the data hook, the operations, the conversation and the window's objects faked, as in page.test.tsx. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

type Answer = { status: string; data?: unknown; settling?: boolean };
const f = vi.hoisted(() => {
  const f = {
    listeners: new Set<() => void>(), version: 0,
    answers: {} as Record<string, Answer | ((variables: Record<string, unknown>) => Answer)>, asked: [] as string[],
    op: vi.fn(), stored: vi.fn(), went: [] as string[], tail: null as object | null,
    heard: [] as [string, (event: unknown) => void][], focused: vi.fn(),
  };
  const g = globalThis as Record<string, any>;
  const store = () => ({ length: 0, getItem: () => null, key: () => null, setItem: f.stored, removeItem: f.stored, clear: f.stored });
  g.document = { getElementById: () => null, visibilityState: 'visible' };
  g.location = { pathname: '/app/boards', search: '', hash: '', reload() {} };
  const go = (_state: unknown, _title: string, path: string) => { f.went.push(path); g.location.pathname = path; };
  g.history = { pushState: go, replaceState: go };
  g.localStorage = store(); g.sessionStorage = store();
  g.Element = class {};
  g.ResizeObserver = class { observe() {} disconnect() {} };
  g.requestAnimationFrame = (frame: () => void) => { queueMicrotask(frame); return 1; };
  g.cancelAnimationFrame = () => {};
  g.addEventListener = (name: string, fn: (event: unknown) => void) => { f.heard.push([name, fn]); };
  g.removeEventListener = (name: string, fn: unknown) => { f.heard = f.heard.filter(([n, one]) => n !== name || one !== fn); };
  return f;
});
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render() {} }) }));
vi.mock('../access', () => ({ wearMotion() {}, motionQuery: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }), reducedMotion: () => true }));
vi.mock('../signin/use-session', () => ({ useSession: () => ({ session: null, login() {}, message: '' }) }));
vi.mock('../contexts/portrait', async () => { const { createElement } = await import('react'); return { Portrait: () => createElement('art-sprite') }; });
vi.mock('../pair/ui/button', async () => { const { createElement } = await import('react'); return { Button: (p: object) => createElement('button', p) }; });
vi.mock('../pair/ui/input-group', async () => {
  const { createElement } = await import('react');
  const box = ({ children }: { children?: unknown }) => createElement('div', null, children as never);
  return { InputGroup: box, InputGroupAddon: box, InputGroupTextarea: (p: object) => createElement('textarea', p), InputGroupButton: ({ variant: _v, size: _s, ...p }: Record<string, unknown>) => createElement('button', p) };
});
vi.mock('../pair/ui/message-scroller', async () => {
  const { createElement } = await import('react');
  const box = ({ children }: { children?: unknown }) => createElement('div', null, children as never);
  return { MessageScroller: box, MessageScrollerContent: box, MessageScrollerProvider: box, MessageScrollerViewport: box, MessageScrollerButton: () => null };
});
vi.mock('../pair/transcript', async () => {
  const { createElement, useEffect } = await import('react');
  return { emptyTail: { last: 0, read: 0, working: false, conversation: '', status: 'connecting' }, threadId: (prefix: string, parts: string[]) => prefix + parts.join('-'),
    TranscriptPage: ({ id, onTail }: { id: string; onTail(tail: object): void }) => { useEffect(() => { if (f.tail) onTail(f.tail); }); return createElement('transcript-of', { id }); } };
});
vi.mock('./build', () => ({ buildChanged: async () => false }));
vi.mock('../data/operation', () => ({ memberOperation: f.op }));
vi.mock('../data/id', () => { let n = 0; return { newId: () => 'new-' + ++n }; });
vi.mock('../data/graphql', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useDataQuery(query: string, variables: Record<string, unknown> | undefined, options?: { pause?: boolean }) {
      useSyncExternalStore((fn) => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.version);
      if (options?.pause) return { status: 'loading' };
      const name = /query (\w+)/.exec(query)![1];
      if (!f.asked.includes(name)) f.asked.push(name);
      const answer = f.answers[name];
      return typeof answer === 'function' ? answer(variables ?? {}) : answer ?? { status: 'live', data: null };
    },
  };
});
import { Page, Resolve } from './main';
import { ThreadHead, ThreadSwitch } from './threads';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(test: (n: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
const text = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let tree: { root: Node; unmount(): void } | undefined;
const mount = (element: unknown) => act(async () => { tree = create(element, { createNodeMock: () => ({ clientWidth: 1200, clientHeight: 800, focus: f.focused }) }); });
const feed = (answers: typeof f.answers) => act(async () => { Object.assign(f.answers, answers); f.version++; for (const fn of [...f.listeners]) fn(); });
const called = (name: string) => f.op.mock.calls.filter(([op]) => op === name).map(([, input]) => input);
const buttons = () => tree!.root.findAllByType('button');
const press = (label: string) => act(async () => { await buttons().find((b) => text(b) === label || b.props['aria-label'] === label)!.props.onClick(); });
const dialog = () => tree!.root.findAll((n) => n.props.role === 'dialog')[0];
const key = (name: string) => act(async () => dialog().props.onKeyDown({ key: name, preventDefault() {} }));
const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
/** A key or a move of the history, as the window would say it to whoever listens. */
const hear = (name: string, event: object = {}) => act(async () => { for (const [n, fn] of [...f.heard]) if (n === name) fn(event); });
const chord = { code: 'Space', key: ' ', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, repeat: false, timeStamp: 1, isComposing: false, preventDefault() {}, stopPropagation() {} };

const row = (id: string, over: object = {}) => ({ id, conversation: 'cv-' + id, venue: 'loom', title: 'About ' + id, agent: 'art', project: null, member: 'sam', pinned: false, archivedAt: null,
  lastAt: '2026-11-27T10:00:00Z', readSeq: 0, working: false, stopRequested: false, unread: false, ...over });
const threads = [
  row('th:old', { lastAt: '2026-11-25T10:00:00Z', title: 'The gate' }),
  row('th:new', { lastAt: '2026-11-27T09:00:00Z', title: 'The pond', agent: 'mira', working: true, unread: true }),
  row('th:pin', { lastAt: '2026-11-20T10:00:00Z', title: 'Standing orders', pinned: true }),
];
const listed = (rows = threads, agents = ['art', 'mira']) => ({ BoardsThreads: { status: 'live', data: { homeComms: { member: 'sam', agents }, commsThreads: rows } } });
const display = (id: string) => ({ id, markBg: '#3366ff', markFg: '#ffffff', faceShape: 'clover', faceEyes: 'oval', spriteVersion: null });

beforeEach(() => {
  f.answers = {}; f.asked = []; f.tail = null; f.heard = []; f.went.length = 0;
  f.op.mockReset().mockResolvedValue(undefined); f.stored.mockReset(); f.focused.mockReset();
  location.pathname = '/app/boards';
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });

describe('the list of conversations', () => {
  const visit = vi.fn();
  const open = async (answers = listed()) => { visit.mockReset(); f.answers = answers; await mount(h(ThreadSwitch, { thread: 'th:old', visit })); await press('Conversations'); };
  const links = () => dialog().findAllByType('a');

  it('is closed until asked for, and reads nothing while closed', async () => {
    f.answers = listed();
    await mount(h(ThreadSwitch, { thread: 'th:old', visit }));
    expect(dialog()).toBeUndefined();
    expect(f.asked).toEqual([]);
    expect(buttons().map((b) => [b.props['aria-label'], b.props['aria-expanded']])).toEqual([['Conversations', false]]);
  });
  it('lists the member\'s threads in Comms\' order, each a link to its address with its title, agent, working and unread', async () => {
    await open();
    expect(links().map((a) => [a.props.href, text(a)])).toEqual([
      ['/app/t/th%3Apin', 'Standing orders Art'],
      ['/app/t/th%3Anew', 'The pond MiraWorkingUnread'],
      ['/app/t/th%3Aold', 'The gate Art'],
    ]);
    expect(links().map((a) => a.props['aria-current'])).toEqual([undefined, undefined, 'page']);
    expect(f.focused).toHaveBeenCalled();
  });
  it('names an agent as the shared directory does', async () => {
    await open({ ...listed(), DeskAgentDirectory: { status: 'live', data: { memoryPeopleAccess: { directory: true }, memoryPeople: [{ id: 'commons:mira', slug: 'mira', agent: null, name: 'Mira the Second', kind: 'agent' }] } } });
    expect(text(links()[1])).toBe('The pond Mira the SecondWorkingUnread');
  });
  it('choosing one goes to its address and closes the list; a modified click is left to the browser', async () => {
    await open();
    const kept = { ...plain, ctrlKey: true, preventDefault: vi.fn() };
    await act(async () => links()[1].props.onClick(kept));
    expect(visit).not.toHaveBeenCalled(); expect(kept.preventDefault).not.toHaveBeenCalled(); expect(dialog()).toBeDefined();
    const event = { ...plain, preventDefault: vi.fn() };
    await act(async () => links()[1].props.onClick(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(visit.mock.calls).toEqual([['/app/t/th%3Anew']]);
    expect(dialog()).toBeUndefined();
  });
  it('the desktop\'s launcher keys open and close it; arrows move, Enter chooses, Escape closes', async () => {
    f.answers = listed(); visit.mockReset();
    await mount(h(ThreadSwitch, { thread: 'th:old', visit }));
    await hear('keydown', chord); await hear('keyup', { ...chord, ctrlKey: false });
    expect(dialog()).toBeDefined();
    const active = () => dialog().findAll((n) => n.props['data-active'] === true).map(text);
    expect(active()).toEqual(['Standing orders Art']);
    await key('ArrowDown');
    expect(active()).toEqual(['The pond MiraWorkingUnread']);
    await key('ArrowUp'); await key('ArrowUp');
    expect(active()).toEqual(['New conversation with Mira']);
    await key('ArrowDown'); await key('ArrowDown'); await key('ArrowDown');
    await key('Enter');
    expect(visit.mock.calls).toEqual([['/app/t/th%3Aold']]);
    expect(dialog()).toBeUndefined();
    await hear('keydown', chord); await hear('keyup', { ...chord, ctrlKey: false });
    expect(dialog()).toBeDefined();
    await key('Escape');
    expect(dialog()).toBeUndefined();
    await hear('keydown', chord); await hear('keyup', { ...chord, ctrlKey: false });
    await hear('keydown', chord);
    expect(dialog()).toBeUndefined();
    expect(visit).toHaveBeenCalledTimes(1);
  });
  it('offers a new conversation with every agent the member may talk to, made as Comms makes one', async () => {
    await open();
    expect(buttons().map(text).filter((t) => t.startsWith('New'))).toEqual(['New conversation with Art', 'New conversation with Mira']);
    await press('New conversation with Mira');
    expect(called('comms.open')).toEqual([{ agent: 'mira', thread: 'th:new-1' }]);
    expect(visit.mock.calls).toEqual([['/app/t/th%3Anew-1']]);
    expect(dialog()).toBeUndefined();
  });
  it('says so when the conversation could not be started, and a retry asks for the same thread', async () => {
    await open();
    f.op.mockRejectedValueOnce(new Error('offline'));
    await key('ArrowUp'); await key('Enter');
    expect(text(dialog().findAll((n) => n.props.role === 'alert')[0])).toBe('Could not start the conversation. Try again.');
    expect(visit).not.toHaveBeenCalled();
    await key('Enter');
    const asked = called('comms.open') as { agent: string; thread: string }[];
    expect(asked).toHaveLength(2);
    expect(asked[0]).toEqual({ agent: 'mira', thread: asked[1].thread });
    expect(visit.mock.calls).toEqual([['/app/t/' + encodeURIComponent(asked[1].thread)]]);
  });
  it('says it is loading, and says when the threads cannot be read', async () => {
    await open({ BoardsThreads: { status: 'loading' } });
    expect(text(dialog())).toBe('Loading…');
    await feed({ BoardsThreads: { status: 'offline' } });
    expect(text(dialog())).toBe('Conversations are unavailable.');
    await feed({ BoardsThreads: { status: 'live', data: { homeComms: null, commsThreads: [] } } });
    expect(text(dialog())).toBe('Conversations are unavailable.');
  });
});

describe('the thread\'s title', () => {
  const head = (over: object = {}, member = 'sam') => { f.answers = { BoardsThreadHead: { status: 'live', data: { thread: row('th:old', { title: 'The gate', ...over }) } } }; return mount(h(ThreadHead, { thread: 'th:old', member })); };
  const typed = (words: string) => act(async () => tree!.root.findAllByType('input')[0].props.onChange({ target: { value: words } }));
  const submit = () => act(async () => tree!.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));

  it('is shown, with rename and archive for the member whose thread it is', async () => {
    await head();
    expect(text(tree!.root.findAllByType('strong')[0])).toBe('The gate');
    expect(buttons().map(text)).toEqual(['Rename', 'Archive…']);
  });
  it('draws nothing until the thread is read, and no controls on someone else\'s thread', async () => {
    f.answers = { BoardsThreadHead: { status: 'loading' } };
    await mount(h(ThreadHead, { thread: 'th:old', member: 'sam' }));
    expect(tree!.root.findAllByType('div')).toEqual([]);
    await act(async () => tree!.unmount());
    await head({ member: 'other' });
    expect(text(tree!.root.findAllByType('strong')[0])).toBe('The gate');
    expect(buttons()).toEqual([]);
  });
  it('renames with comms.change, trimmed, and refuses an empty title and one over sixty characters', async () => {
    await head();
    await press('Rename');
    expect(tree!.root.findAllByType('input')[0].props.value).toBe('The gate');
    const save = () => buttons().find((b) => text(b) === 'Save title')!;
    await typed('   ');
    expect(save().props.disabled).toBe(true);
    await typed('x'.repeat(61));
    expect(save().props.disabled).toBe(true);
    await submit();
    expect(f.op).not.toHaveBeenCalled();
    await typed('  The garden gate ');
    expect(save().props.disabled).toBe(false);
    await submit();
    expect(f.op.mock.calls).toEqual([['comms.change', { thread: 'th:old', change: 'rename', title: 'The garden gate' }]]);
    expect(tree!.root.findAllByType('form')).toEqual([]);
  });
  it('keeps the form and says so when the rename did not save', async () => {
    await head();
    await press('Rename');
    f.op.mockRejectedValueOnce(new Error('offline'));
    await typed('Other'); await submit();
    expect(text(tree!.root.findAll((n) => n.props.role === 'alert')[0])).toBe('Could not save. Try again.');
    expect(tree!.root.findAllByType('form')).toHaveLength(1);
  });
  it('asks before archiving, and archives only on the second word', async () => {
    await head();
    await press('Archive…');
    expect(f.op).not.toHaveBeenCalled();
    await press('Keep it');
    expect(f.op).not.toHaveBeenCalled();
    expect(buttons().map(text)).toEqual(['Rename', 'Archive…']);
    await press('Archive…'); await press('Archive conversation');
    expect(f.op.mock.calls).toEqual([['comms.change', { thread: 'th:old', change: 'archive', archived: true }]]);
  });
  it('says an archived thread is archived and restores it', async () => {
    await head({ archivedAt: '2026-11-26T10:00:00Z' });
    expect(text(tree!.root)).toContain('Archived');
    expect(buttons().map(text)).toEqual(['Rename', 'Restore']);
    await press('Restore');
    expect(f.op.mock.calls).toEqual([['comms.change', { thread: 'th:old', change: 'archive', archived: false }]]);
  });
});

describe('the presence', () => {
  const face = () => tree!.root.findAll((n) => n.props.className === 'boards-face');
  it('is the thread\'s own agent: its name, and its own face drawn from its mark, shape and eyes', async () => {
    f.answers = { DeskAgentDisplays: { status: 'live', data: { agents: [display('mira'), display('art')] } } };
    await mount(h(Page, { member: 'sam', thread: 'th:new', agent: 'mira' }));
    expect(text(tree!.root.findAll((n) => n.props.className === 'boards-presence')[0])).toContain('Mira');
    expect(tree!.root.findAllByType('textarea')[0].props['aria-label']).toBe('Message Mira');
    expect(face()).toHaveLength(1);
    const svg = face()[0].findAllByType('svg')[0];
    expect(svg.props['data-shape']).toBe('clover');
    expect(svg.findAllByType('path')[0].props.style.stroke).toBe('#3366ff');
    expect(tree!.root.findAllByType('art-sprite')).toEqual([]);
  });
  it('keeps Art\'s sprite for Art, and draws no face for an agent whose look cannot be read', async () => {
    await mount(h(Page, { member: 'sam', thread: 'th:old', agent: 'art' }));
    expect(tree!.root.findAllByType('art-sprite')).toHaveLength(1);
    await act(async () => tree!.unmount());
    await mount(h(Page, { member: 'sam', thread: 'th:new', agent: 'mira' }));
    expect(face()).toEqual([]);
    expect(tree!.root.findAllByType('art-sprite')).toEqual([]);
  });
  it('marks the conversation read, as Comms does, when it is on screen and holds something new', async () => {
    f.tail = { last: 7, read: 4, working: false, conversation: 'cv', tool: null, update: true, status: 'live' };
    await mount(h(Page, { member: 'sam', thread: 'th:old', agent: 'art' }));
    expect(called('comms.change')).toEqual([{ thread: 'th:old', change: 'read', seq: 7 }]);
  });
  it('does not mark it read in a hidden tab, or when nothing is new', async () => {
    (document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    f.tail = { last: 7, read: 4, working: false, conversation: 'cv', tool: null, update: true, status: 'live' };
    await mount(h(Page, { member: 'sam', thread: 'th:old', agent: 'art' }));
    (document as unknown as { visibilityState: string }).visibilityState = 'visible';
    expect(called('comms.change')).toEqual([]);
    await act(async () => tree!.unmount());
    f.tail = { last: 7, read: 7, working: false, conversation: 'cv', tool: null, update: false, status: 'live' };
    await mount(h(Page, { member: 'sam', thread: 'th:old', agent: 'art' }));
    expect(called('comms.change')).toEqual([]);
  });
});

describe('the address and more than one thread', () => {
  const transcripts = () => tree!.root.findAllByType('transcript-of').map((t) => t.props.id);
  const known: Record<string, string> = { 'th:old': 'art', 'th:new': 'mira' };
  const boardsOf: Record<string, string> = { 'b-1': 'th:old', 'b-2': 'th:old', 'b-9': 'th:new' };
  const made = (id: string) => ({ id, thread: boardsOf[id], title: 'Board ' + id, revision: 1, closed: false, trailAt: '2026-11-27T10:00:0' + id.at(-1) + 'Z', placements: [] });
  const world = () => ({
    ...listed(),
    BoardsHome: { status: 'live', data: { homeComms: { agents: ['art', 'mira'] } } },
    BoardsThread: (v: Record<string, unknown>) => ({ status: 'live', data: { thread: known[v.id as string] ? { id: v.id, agent: known[v.id as string] } : null } }),
    BoardThread: (v: Record<string, unknown>) => ({ status: 'live', data: { board: boardsOf[v.id as string] ? { thread: boardsOf[v.id as string] } : null } }),
    ThreadBoards: (v: Record<string, unknown>) => ({ status: 'live', data: { threadBoards: Object.keys(boardsOf).filter((id) => boardsOf[id] === v.thread).map(made) } }),
  }) as typeof f.answers;
  const at = async (path: string, answers = world()) => { location.pathname = path; f.answers = answers; await mount(h(Resolve, { member: 'sam' })); };

  it('with no id opens the member\'s own boards thread with the first agent, making it', async () => {
    await at('/app/boards', { ...world(), ThreadBoards: { status: 'live', data: { threadBoards: [] } } });
    expect(transcripts()).toEqual(['th:board-sam-art']);
    expect(called('comms.open')).toEqual([{ thread: 'th:board-sam-art', agent: 'art', title: 'Boards' }]);
  });
  it('a thread\'s address opens that thread with its own agent, and does not make what is already there', async () => {
    await at('/app/t/th%3Anew');
    expect(transcripts()).toEqual(['th:new']);
    expect(tree!.root.findAllByType('textarea')[0].props['aria-label']).toBe('Message Mira');
    expect(called('comms.open')).toEqual([]);
    expect(tree!.root.findAllByType('textarea')[0].props.autoFocus).toBe(true);
  });
  it('choosing another conversation pushes its address and draws it; back returns; the address holds one id and nothing is stored', async () => {
    await at('/app/t/th%3Aold');
    expect(location.pathname).toBe('/app/b/b-2');
    await press('Conversations');
    await act(async () => dialog().findAllByType('a').find((a) => a.props.href === '/app/t/th%3Anew')!.props.onClick({ ...plain, preventDefault() {} }));
    expect(transcripts()).toEqual(['th:new']);
    expect(f.went).toEqual(['/app/b/b-2', '/app/t/th%3Anew', '/app/b/b-9']);
    // Back, as the browser does it: the address is the earlier one, then the page is told.
    location.pathname = '/app/b/b-2';
    await hear('popstate');
    expect(transcripts()).toEqual(['th:old']);
    expect(location.pathname).toBe('/app/b/b-2');
    for (const path of f.went) expect(path).toMatch(/^\/app\/[bt]\/[^/?#]+$/);
    expect(location.search).toBe(''); expect(location.hash).toBe('');
    expect(f.stored).not.toHaveBeenCalled();
  });
  it('going back to another board of the same thread keeps the conversation as it is: what was typed stays', async () => {
    await at('/app/b/b-1');
    await act(async () => tree!.root.findAllByType('textarea')[0].props.onChange({ target: { value: 'half a thought' } }));
    location.pathname = '/app/b/b-2';
    await hear('popstate');
    expect(tree!.root.findAllByType('textarea')[0].props.value).toBe('half a thought');
    expect(transcripts()).toEqual(['th:old']);
    expect(tree!.root.findAll((n) => n.props.className === 'boards-dots')[0].findAll((n) => n.props['data-on'] === true)).toHaveLength(1);
    expect(location.pathname).toBe('/app/b/b-2');
  });
  it('keeps the page on screen while another address is being found, then replaces it', async () => {
    await at('/app/t/th%3Aold');
    const slow = world().BoardsThread as (v: Record<string, unknown>) => Answer;
    await feed({ BoardsThread: (v) => (v.id === 'th:new' ? { status: 'loading' } : slow(v)) });
    await press('Conversations');
    await act(async () => dialog().findAllByType('a').find((a) => a.props.href === '/app/t/th%3Anew')!.props.onClick({ ...plain, preventDefault() {} }));
    expect(transcripts()).toEqual(['th:old']);
    await feed({ BoardsThread: slow });
    expect(transcripts()).toEqual(['th:new']);
  });
  it('a thread or board that is not there, or not the member\'s to read, draws one line and no conversation', async () => {
    await at('/app/t/th%3Anobody');
    expect(text(tree!.root)).toBe('There is nothing here.');
    await act(async () => tree!.unmount());
    await at('/app/b/b-404');
    expect(text(tree!.root)).toBe('There is nothing here.');
    expect(transcripts()).toEqual([]);
  });
});
