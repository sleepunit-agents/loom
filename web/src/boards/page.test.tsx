/** What the boards page draws and calls (docs/specs/boards.md, "The page" and "A restart"). There is no browser
 * here: the page is drawn by the test renderer, with the data hook, the operations, the conversation and the
 * window's own objects (location, history, storage) faked. The bricks are the real ones. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

type Answer = { status: string; data?: unknown };
const f = vi.hoisted(() => {
  const f = {
    listeners: new Set<() => void>(), version: 0,
    status: 'live', boards: [] as unknown[], answers: {} as Record<string, { status: string; data?: unknown }>,
    op: vi.fn(), build: vi.fn(), reload: vi.fn(), stored: vi.fn(), went: [] as string[],
    area: { w: 1200, h: 800 },
    /** The page's motion is reduced: nothing slides. */ reduced: true,
    /** How many mounted hooks hold each query open, by its name. */ open: new Map<string, number>(),
    /** Stands in for a DOM element a click lands on. */
    Element: class { constructor(readonly found: Record<string, unknown>) {} closest(selector: string) { return this.found[selector] ?? null; } },
  };
  const g = globalThis as Record<string, any>;
  const store = () => ({ length: 0, getItem: () => null, key: () => null, setItem: f.stored, removeItem: f.stored, clear: f.stored });
  g.document = { getElementById: () => null };
  g.location = { pathname: '/app/boards', search: '', hash: '', reload: f.reload };
  const go = (_state: unknown, _title: string, path: string) => { f.went.push(path); g.location.pathname = path; };
  g.history = { pushState: go, replaceState: go };
  g.localStorage = store(); g.sessionStorage = store();
  g.Element = f.Element;
  g.ResizeObserver = class { observe() {} disconnect() {} };
  g.requestAnimationFrame = (frame: () => void) => { queueMicrotask(frame); return 1; };
  g.cancelAnimationFrame = () => {};
  g.addEventListener = () => {}; g.removeEventListener = () => {};
  return f;
});
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render() {} }) }));
vi.mock('../access', () => ({ wearMotion() {}, motionQuery: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }), reducedMotion: () => f.reduced }));
vi.mock('../signin/use-session', () => ({ useSession: () => ({ session: null, login() {}, message: '' }) }));
vi.mock('../contexts/portrait', () => ({ Portrait: () => null }));
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
  const { createElement } = await import('react');
  return { emptyTail: { last: 0, read: 0, working: false, conversation: '', status: 'live' }, threadId: (prefix: string, parts: string[]) => prefix + parts.join('-'),
    TranscriptPage: ({ id }: { id: string }) => createElement('transcript-of', { id }) };
});
vi.mock('./build', () => ({ buildChanged: f.build }));
vi.mock('../data/operation', () => ({ memberOperation: f.op }));
vi.mock('../data/graphql', async () => {
  const { useSyncExternalStore, useEffect } = await import('react');
  return {
    useDataQuery(query: string, _variables: unknown, options?: { pause?: boolean }) {
      useSyncExternalStore((fn) => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.version);
      const name = /query (\w+)/.exec(query)![1], paused = !!options?.pause;
      // A hook that is mounted and not paused holds its selection open.
      useEffect(() => { if (paused) return; f.open.set(name, (f.open.get(name) ?? 0) + 1); return () => { f.open.set(name, f.open.get(name)! - 1); }; }, [name, paused]);
      if (options?.pause) return { status: 'loading' };
      if (name === 'ThreadBoards') return f.status === 'live' ? { status: 'live', data: { threadBoards: f.boards } } : { status: f.status };
      return f.answers[name] ?? { status: 'live', data: null };
    },
  };
});
import { Page } from './main';
import { bricks, loadBricks } from './bricks';
import { samples } from './samples.test.helper';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; parent: Node | null; children: (Node | string)[]; findAll(test: (n: Node) => boolean): Node[]; findAllByType(type: string): Node[]; findByType(type: string): Node };
const text = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
const thread = 'th:board-sam-art';
const task = { id: 't-7', title: 'Mend the gate', status: 'open', assignee: 'art', assigneeKind: 'agent', goal: null, why: null, doneWhen: null, project: 'garden' };

let seq = 0;
type Made = { id: string; brick: string; params: string; rank: number; placedByKind: string; big: boolean; canBeBig: boolean; flagged: boolean };
const placed = (brick: string, params: object, over: Partial<Made> = {}): Made => ({ id: 'p-' + ++seq, brick, params: JSON.stringify(params), rank: 0, placedByKind: 'agent', big: false, canBeBig: true, flagged: false, ...over });
const board = (id: string, placements: Made[], over: object = {}) => ({ id, thread, title: '', revision: 1, closed: false, trailAt: '2026-11-27T10:00:0' + id.at(-1) + 'Z', placements: placements.map((p, rank) => ({ ...p, rank })), ...over });
const lanes = (over?: Partial<Made>) => placed('lanes', { project: 'garden' }, over);
const ticket = (over?: Partial<Made>) => placed('ticket', { ticket: 't-7' }, over);
// A brick the catalogue gives no big form: the question.
const question = (over?: Partial<Made>) => placed('question', { item: 'in-3' }, { canBeBig: false, ...over });

let tree: { root: Node; unmount(): void } | undefined;
/** Change what the data hook answers, as a live read does. */
const feed = (change: Partial<typeof f>) => act(async () => { Object.assign(f, change); f.version++; for (const fn of [...f.listeners]) fn(); });
async function draw(boards: unknown[], at: { path?: string; area?: { w: number; h: number } } = {}) {
  f.boards = boards; f.area = at.area ?? { w: 1200, h: 800 };
  location.pathname = at.path ?? '/app/boards';
  await act(async () => { tree = create(h(Page, { member: 'sam', thread, agent: 'art' }), { createNodeMock: () => ({ get clientWidth() { return f.area.w; }, get clientHeight() { return f.area.h; } }) }); });
  return tree!.root;
}
const articles = () => tree!.root.findAllByType('article');
const forms = () => articles().map((a) => a.props['data-form']);
const chips = () => tree!.root.findAll((n) => n.props.className === 'boards-folded')[0].findAll((n) => n.props.className === 'board-chip');
const called = (name: string) => f.op.mock.calls.filter(([op]) => op === name).map(([, input]) => input);
async function click(found: Record<string, unknown>, keys: object = {}) {
  const event = { target: new f.Element(found), metaKey: false, ctrlKey: false, preventDefault: vi.fn(), ...keys };
  await act(async () => tree!.root.findByType('main').props.onClick(event));
  return event;
}
const chipElement = (place: object) => ({ '[data-place]': { dataset: { place: JSON.stringify(place) } } });
const type = (words: string) => act(async () => tree!.root.findByType('textarea').props.onChange({ target: { value: words } }));
const submit = () => act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }));

beforeEach(() => {
  seq = 0;
  f.status = 'live'; f.answers = { BrickTicket: { status: 'live', data: { ticket: task } } } as Record<string, Answer>;
  f.op.mockReset().mockResolvedValue(undefined); f.build.mockReset().mockResolvedValue(false);
  f.reload.mockReset(); f.stored.mockReset(); f.went.length = 0; f.reduced = true;
  location.pathname = '/app/boards';
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });
/** Draw one board. Its articles are its placements that are not folded, in board order. */
const one = (placements: Made[], over: object = {}, at: Parameters<typeof draw>[1] = {}) => draw([board('b-1', placements, over)], at);

describe('the board', () => {
  it('draws the big placement in the primary form and the others small', async () => {
    await one([lanes({ big: true }), ticket(), question()]);
    expect(forms()).toEqual(['primary', 'side', 'side']);
    expect(chips()).toEqual([]);
  });
  it('takes the big one from the board, not from the order', async () => {
    await one([question(), ticket({ big: true }), lanes()]);
    expect(forms()).toEqual(['side', 'primary', 'side']);
  });
  it('gives a small placement the compact form when the side form has no room', async () => {
    await one([lanes({ big: true }), ticket(), question(), placed('comments', { ticket: 't-7' })], {}, { area: { w: 1200, h: 420 } });
    expect(forms()[0]).toBe('primary');
    expect(forms().slice(1).every((form) => form === 'side' || form === 'compact')).toBe(true);
    expect(forms()).toContain('compact');
    const compact = articles()[forms().indexOf('compact')];
    expect(compact.findAll((n) => n.props.className === 'board-brief')).toHaveLength(1);
  });
  it('draws no placement in the primary form when none is big', async () => {
    await one([question(), placed('approval', { approval: 'ap-4' }, { canBeBig: false })]);
    expect(forms()).toEqual(['side', 'side']);
  });
  it('shows a placement with no room as its chip in the folded row', async () => {
    const root = await one([lanes({ big: true }), ticket(), question()], {}, { area: { w: 500, h: 700 } });
    expect(forms()).toEqual(['primary']);
    expect(chips().map(text)).toEqual(['Ticket t-7', 'Question in-3']);
    // The row says how many placements are folded, once, before their chips.
    expect(text(root.findAll((n) => n.props.className === 'boards-folded-count')[0])).toBe('2 more');
  });
  it('says nothing in the folded row when nothing is folded', async () => {
    const root = await one([lanes({ big: true })]);
    expect(text(root.findAll((n) => n.props.className === 'boards-folded')[0])).toBe('');
  });
  it('is headed by its title', async () => {
    const root = await one([lanes({ big: true }), ticket()], { title: 'The garden this week' });
    expect(text(root.findByType('h1'))).toBe('The garden this week');
  });
  it('with no title, is headed by the big brick\'s name and reference', async () => {
    const root = await one([question(), ticket({ big: true })]);
    expect(text(root.findByType('h1'))).toBe('Ticket');
  });
  it('with no title and nothing big, is headed by its first placement', async () => {
    const root = await one([question(), placed('approval', { approval: 'ap-4' }, { canBeBig: false })]);
    expect(text(root.findByType('h1'))).toBe('Question');
  });
  it('has no heading when it has no placements', async () => {
    const root = await one([]);
    expect(text(root.findByType('h1'))).toBe('');
    expect(articles()).toEqual([]);
  });
});

describe('maximize', () => {
  const control = (a: Node) => a.findAll((n) => n.props.className === 'board-maximize');
  it('a small placement whose brick can be big has the control, and it asks for that placement', async () => {
    const small = ticket();
    await one([lanes({ big: true }), small]);
    expect(control(articles()[1])).toHaveLength(1);
    expect(control(articles()[1])[0].props['aria-label']).toBe('Make Ticket the big one');
    await act(async () => control(articles()[1])[0].props.onClick());
    expect(called('boards.change')).toEqual([{ board: 'b-1', changes: [{ change: 'maximize', placement: small.id }] }]);
  });
  it('the big placement has none, and neither has a small-only brick', async () => {
    await one([lanes({ big: true }), question()]);
    expect(articles().map((a) => control(a).length)).toEqual([0, 0]);
  });
  it('a folded chip of a brick that can be big maximizes it; a small-only one is not a control', async () => {
    const small = ticket();
    await one([lanes({ big: true }), small, question()], {}, { area: { w: 500, h: 700 } });
    expect(chips().map((c) => c.type)).toEqual(['button', 'span']);
    expect(chips()[1].props.onClick).toBeUndefined();
    await act(async () => chips()[0].props.onClick());
    expect(called('boards.change')).toEqual([{ board: 'b-1', changes: [{ change: 'maximize', placement: small.id }] }]);
  });
});

describe('remove, close and a closed board', () => {
  it('the remove control asks to remove that placement', async () => {
    const small = ticket();
    await one([lanes({ big: true }), small]);
    const remove = articles().map((a) => a.findAll((n) => n.props.className === 'board-remove'));
    expect(remove.map((r) => r.length)).toEqual([1, 1]);
    expect(remove[1][0].props['aria-label']).toBe('Remove Ticket');
    await act(async () => remove[1][0].props.onClick());
    expect(called('boards.change')).toEqual([{ board: 'b-1', changes: [{ change: 'remove', placement: small.id }] }]);
  });
  it('an open board has Close, which closes it, and its bricks respond', async () => {
    const root = await one([lanes({ big: true }), ticket()]);
    const head = root.findAll((n) => n.type === 'header' && n.findAllByType('h1').length > 0)[0];
    expect(head.findAllByType('button').map(text)).toEqual(['Close']);
    await act(async () => head.findAllByType('button')[0].props.onClick());
    expect(called('boards.close')).toEqual([{ board: 'b-1' }]);
    expect(articles().map((a) => (a.children[1] as Node).props.inert)).toEqual([false, false]);
  });
  it('a closed board has Reopen, no remove or maximize controls, and its bricks are inert', async () => {
    const root = await one([lanes({ big: true }), ticket(), question()], { closed: true }, { path: '/app/b/b-1' });
    expect(forms()).toEqual(['primary', 'side', 'side']);
    const head = root.findAll((n) => n.type === 'header' && n.findAllByType('h1').length > 0)[0];
    expect(head.findAllByType('button').map(text)).toEqual(['Reopen']);
    expect(root.findAll((n) => n.props.className === 'board-remove' || n.props.className === 'board-maximize')).toEqual([]);
    // Everything a brick draws, its actions and chips included, is inside the inert container.
    for (const a of articles()) {
      expect(a.children).toHaveLength(2);
      expect((a.children[0] as Node).type).toBe('header');
      expect((a.children[1] as Node).props.inert).toBe(true);
    }
    expect((articles()[1].children[1] as Node).findAllByType('button').length).toBeGreaterThan(0);
    await act(async () => head.findAllByType('button')[0].props.onClick());
    expect(called('boards.reopen')).toEqual([{ board: 'b-1' }]);
  });
  it('a closed board\'s folded chips are not controls', async () => {
    await one([lanes({ big: true }), ticket()], { closed: true }, { path: '/app/b/b-1', area: { w: 500, h: 700 } });
    expect(chips().map((c) => [c.type, c.props.onClick])).toEqual([['span', undefined]]);
  });
});

describe('flags', () => {
  const flag = (a: Node) => a.findAll((n) => n.props.className === 'board-flag').map(text);
  it('a flagged placement is marked and says so; pointing at it tells loom it was seen', async () => {
    const flagged = ticket({ flagged: true });
    await one([lanes({ big: true }), flagged]);
    expect(articles().map((a) => a.props['data-flagged'])).toEqual([false, true]);
    expect(articles().map(flag)).toEqual([[], ['Look here']]);
    await act(async () => articles()[0].props.onPointerEnter());
    expect(called('boards.seen')).toEqual([]);
    await act(async () => articles()[1].props.onPointerEnter());
    expect(called('boards.seen')).toEqual([{ board: 'b-1', placement: flagged.id }]);
  });
  it('focus inside a flagged placement counts as looking', async () => {
    const flagged = ticket({ flagged: true });
    await one([lanes({ big: true }), flagged]);
    await act(async () => articles()[1].props.onFocus());
    expect(called('boards.seen')).toEqual([{ board: 'b-1', placement: flagged.id }]);
  });
  it('a brick\'s own flag marks the placement, and looking clears it without a call', async () => {
    await one([lanes({ big: true }), ticket()]);
    expect(articles()[1].props['data-flagged']).toBe(false);
    await feed({ answers: { BrickTicket: { status: 'live', data: { ticket: { ...task, status: 'closed' } } } } });
    expect(articles().map((a) => a.props['data-flagged'])).toEqual([false, true]);
    expect(flag(articles()[1])).toEqual(['Closed']);
    await act(async () => articles()[1].props.onPointerEnter());
    expect(articles()[1].props['data-flagged']).toBe(false);
    expect(flag(articles()[1])).toEqual([]);
    expect(called('boards.seen')).toEqual([]);
  });
  it('a brick raises no flag for what the member did in it', async () => {
    f.answers = { BrickTicket: { status: 'live', data: { ticket: { ...task, status: 'closed' } } } };
    const small = ticket();
    await one([lanes({ big: true }), small]);
    await act(async () => articles()[1].findAll((n) => n.type === 'button' && text(n) === 'Reopen')[0].props.onClick());
    expect(called('tasks.command')).toEqual([{ action: 'reopen', id: 't-7' }]);
    expect(called('boards.act')).toEqual([{ board: 'b-1', placement: small.id, action: 'reopen', detail: {} }]);
    await feed({ answers: { BrickTicket: { status: 'live', data: { ticket: task } } } });
    expect(articles()[1].props['data-flagged']).toBe(false);
    expect(flag(articles()[1])).toEqual([]);
  });
  it('a folded flagged placement marks its chip and the folded row, and stays folded', async () => {
    const flagged = ticket({ flagged: true });
    const root = await one([lanes({ big: true }), flagged, question()], {}, { area: { w: 500, h: 700 } });
    expect(forms()).toEqual(['primary']);
    expect(chips().map((c) => c.props['data-flagged'])).toEqual([true, false]);
    expect(root.findAll((n) => n.props.className === 'boards-folded')[0].props['data-flagged']).toBe(true);
    await act(async () => chips()[0].props.onPointerEnter());
    expect(called('boards.seen')).toEqual([{ board: 'b-1', placement: flagged.id }]);
  });
  it('the folded row is unmarked when nothing in it is flagged', async () => {
    const root = await one([lanes({ big: true, flagged: true }), ticket()], {}, { area: { w: 500, h: 700 } });
    expect(root.findAll((n) => n.props.className === 'boards-folded')[0].props['data-flagged']).toBe(false);
  });
});

describe('chips', () => {
  it('a chip a brick draws, clicked, places its brick on the open board on screen', async () => {
    await one([lanes({ big: true }), ticket()]);
    const chip = articles()[1].findAll((n) => n.props.className === 'board-chip' && text(n) === 'Comments')[0];
    await click({ '[data-place]': { dataset: { place: chip.props['data-place'] } } });
    expect(called('boards.change')).toEqual([{ board: 'b-1', changes: [{ change: 'place', brick: 'comments', params: { ticket: 't-7' } }] }]);
    expect(called('boards.open')).toEqual([]);
  });
  it('with no board, a chip opens one', async () => {
    await draw([]);
    await click(chipElement({ brick: 'project', params: { project: 'garden' } }));
    expect(called('boards.open')).toEqual([{ thread, place: { brick: 'project', params: { project: 'garden' } } }]);
    expect(called('boards.change')).toEqual([]);
  });
  it('with a closed board on screen, a chip opens a new one', async () => {
    await one([lanes({ big: true })], { closed: true }, { path: '/app/b/b-1' });
    await click(chipElement({ brick: 'project', params: { project: 'garden' } }));
    expect(called('boards.open')).toEqual([{ thread, place: { brick: 'project', params: { project: 'garden' } } }]);
    expect(called('boards.change')).toEqual([]);
  });
  it('a ticket link in a reply places a ticket brick and does not follow the link', async () => {
    await one([lanes({ big: true })]);
    const event = await click({ a: { getAttribute: () => '?ticket=T-12' } });
    expect(called('boards.change')).toEqual([{ board: 'b-1', changes: [{ change: 'place', brick: 'ticket', params: { ticket: 't-12' } }] }]);
    expect(event.preventDefault).toHaveBeenCalled();
  });
  it('leaves any other link, a modified click and a click on nothing alone', async () => {
    await one([lanes({ big: true })]);
    for (const event of [
      await click({ a: { getAttribute: () => 'https://example.com/?ticket=t-12' } }),
      await click({ a: { getAttribute: () => '?ticket=t-12' } }, { metaKey: true }),
      await click({ a: { getAttribute: () => '?ticket=t-12' } }, { ctrlKey: true }),
      await click({}),
    ]) expect(event.preventDefault).not.toHaveBeenCalled();
    expect(called('boards.change')).toEqual([]);
    expect(called('boards.open')).toEqual([]);
  });
});

describe('sending', () => {
  it('opens the conversation of its thread with its agent', async () => {
    const root = await draw([]);
    expect(f.op.mock.calls.filter(([op]) => op === 'comms.open')).toEqual([['comms.open', { thread, agent: 'art', title: 'Boards' }, thread.slice(3)]]);
    expect(root.findAllByType('transcript-of').map((t) => t.props.id)).toEqual([thread]);
  });
  it('sends the words as typed, trimmed, with the board on screen, and empties the input', async () => {
    const root = await one([lanes({ big: true })]);
    await type('  what is left in the garden?\n');
    await submit();
    const sent = f.op.mock.calls.filter(([op]) => op === 'comms.send');
    expect(sent).toHaveLength(1);
    const [, input, id] = sent[0];
    expect(input).toEqual({ thread, clientId: id, words: 'what is left in the garden?', shows: { board: 'b-1' } });
    expect(root.findByType('textarea').props.value).toBe('');
  });
  it('says no board is shown when there is none', async () => {
    await draw([]);
    await type('hello');
    await submit();
    expect(called('comms.send')).toMatchObject([{ words: 'hello', shows: { board: null } }]);
  });
  it('names the board on screen, not the last on the trail', async () => {
    await draw([board('b-1', [lanes({ big: true })]), board('b-2', [ticket({ big: true })])], { path: '/app/b/b-1' });
    await type('hello');
    await submit();
    expect(called('comms.send')).toMatchObject([{ shows: { board: 'b-1' } }]);
  });
  it('sends nothing when there are no words, or before the conversation is open', async () => {
    await draw([]);
    await type('   ');
    await submit();
    expect(called('comms.send')).toEqual([]);
    await act(async () => tree!.unmount());
    f.op.mockImplementation((name: string) => (name === 'comms.open' ? new Promise(() => {}) : Promise.resolve()));
    await draw([]);
    await type('hello');
    await submit();
    expect(called('comms.send')).toEqual([]);
  });
  it('keeps the words and says so when the send is not confirmed', async () => {
    f.op.mockImplementation((name: string) => (name === 'comms.send' ? Promise.reject(new Error('lost')) : Promise.resolve()));
    const root = await draw([]);
    await type('hello');
    await submit();
    expect(root.findByType('textarea').props.value).toBe('hello');
    expect(text(root.findAll((n) => n.props.role === 'status')[0])).toBe('Delivery unconfirmed. Send the same message to retry.');
  });
});

describe('names', () => {
  it('heads every placement by its brick\'s name, and shows the reference only in the small monospace line', async () => {
    // Every brick of the catalogue, with parameters its own schema takes, and one brick this page has never heard of.
    const params: Record<string, Record<string, string | number>> = { ...samples(), mystery: { thing: 'x-1' } };
    expect(Object.keys(params)).toEqual(expect.arrayContaining(Object.keys(bricks)));
    const placements = Object.entries(params).map(([brick, p], i) => placed(brick, p, { big: i === 0 }));
    await draw([board('b-1', placements)], { area: { w: 1200, h: 9000 } });
    expect(articles()).toHaveLength(placements.length);
    const values = Object.values(params).flatMap((p) => Object.values(p)).filter((v) => typeof v === 'string') as string[];
    articles().forEach((a, i) => {
      const [brick, p] = Object.entries(params)[i];
      const heads = a.findAllByType('h2');
      expect(heads).toHaveLength(1);
      const head = text(heads[0]);
      expect(head).toBe(bricks[brick]?.title(p) ?? brick);
      for (const value of values) expect(head).not.toContain(value);
      const names = a.findAll((n) => n.props.className === 'board-names')[0];
      const small = names.findAllByType('small');
      expect(small).toHaveLength(1);
      expect(small[0].props.className).toBe('font-mono');
      if (brick !== 'mystery' && Object.keys(p).length) expect(text(small[0])).toContain(String(Object.values(p)[0]).slice(0, 11));
      // The controls are named by the brick too, never by its reference.
      for (const control of (a.children[0] as Node).findAllByType('button')) for (const value of values) expect(control.props['aria-label']).not.toContain(value);
    });
  });
});

describe('the trail', () => {
  it('goes to the last board of the thread, and with none to the thread', async () => {
    await draw([board('b-1', [lanes({ big: true })]), board('b-2', [ticket({ big: true })])]);
    expect(location.pathname).toBe('/app/b/b-2');
    await act(async () => tree!.unmount());
    await draw([]);
    expect(location.pathname).toBe('/app/t/' + encodeURIComponent(thread));
  });
  it('moves to a board that joins the trail', async () => {
    const first = board('b-1', [lanes({ big: true })]);
    const root = await draw([first]);
    expect(location.pathname).toBe('/app/b/b-1');
    await feed({ boards: [first, board('b-2', [ticket({ big: true })])] });
    expect(location.pathname).toBe('/app/b/b-2');
    expect(root.findAll((n) => n.props.className === 'boards-trail')[0].props.style.transform).toBe('translateX(-100%)');
    expect(root.findAll((n) => n.props.className === 'boards-dots')[0].findAllByType('i').map((i) => i.props['data-on'])).toEqual([false, true]);
  });
  it('keeps the board in the address on screen, closed, when it is closed', async () => {
    const first = board('b-1', [lanes({ big: true })]), second = board('b-2', [ticket({ big: true })]);
    const root = await draw([first, second], { path: '/app/b/b-2' });
    await feed({ boards: [first, { ...second, closed: true }] });
    expect(location.pathname).toBe('/app/b/b-2');
    expect(text(root.findByType('h1'))).toBe('Ticket');
    expect(root.findAll((n) => n.type === 'header' && n.findAllByType('h1').length > 0)[0].findAllByType('button').map(text)).toEqual(['Reopen']);
  });
  /** The bricks' own selections that are held open, by query name. The page's and the conversation's are left out. */
  const held = () => [...f.open].filter(([name, n]) => n > 0 && name.startsWith('Brick')).map(([name]) => name).sort();
  const boardsDrawn = () => tree!.root.findAll((n) => n.props.className === 'boards-board');
  const bodies = (boardNode: Node) => boardNode.findAllByType('article').map((a) => a.findAll((n) => n.type === 'div' && n.parent === a)[0].children.length > 0);
  it('only the board on screen draws its bricks and holds their reads; the others keep their frames for the slide', async () => {
    const first = board('b-1', [lanes({ big: true }), question({ flagged: true })]), second = board('b-2', [ticket({ big: true })]);
    await draw([first, second]);
    expect(location.pathname).toBe('/app/b/b-2');
    const [off, on] = boardsDrawn();
    // The board on screen: its ticket is drawn and read.
    expect(bodies(on)).toEqual([true]);
    expect(held()).toEqual(['BrickTicket', 'BrickTicketMore', 'BrickTicketSessions']);
    expect([on.props['data-live'], off.props['data-live'], off.props.inert]).toEqual([true, false, true]);
    // The board off screen: its heading and each placement's frame, name and reference, where the layout puts them, and no body.
    expect(text(off.findByType('h1'))).toBe('Lanes');
    expect(off.findAllByType('article').map((a) => [text(a.findByType('h2')), text(a.findByType('small')), a.props['data-form'], typeof a.props.style.width])).toEqual([['Lanes', 'garden', 'primary', 'number'], ['Question', 'in-3', 'side', 'number']]);
    expect(bodies(off)).toEqual([false, false]);
    // A flag stored on a placement of a board that is off screen is still on its frame.
    expect(off.findAllByType('article').map((a) => a.props['data-flagged'])).toEqual([false, true]);
    expect(off.findAll((n) => n.props.className === 'board-flag').map(text)).toEqual(['Look here']);
  });
  it('going along the trail draws the arriving board\'s bricks and lets the leaving board\'s go: at once where nothing moves', async () => {
    const first = board('b-1', [lanes({ big: true })]), second = board('b-2', [ticket({ big: true })]);
    await draw([first, second]);
    expect(held()).toEqual(['BrickTicket', 'BrickTicketMore', 'BrickTicketSessions']);
    location.pathname = '/app/b/b-1';
    await act(async () => { tree!.update(h(Page, { member: 'sam', thread, agent: 'art', at: { board: 'b-1' } })); });
    expect(boardsDrawn().map((b) => bodies(b))).toEqual([[true], [false]]);
    expect(held()).toEqual(['BrickLanes']);
  });
  it('while the trail slides, both boards are drawn; the leaving one lets go when the slide ends', async () => {
    f.reduced = false;
    const first = board('b-1', [lanes({ big: true })]), second = board('b-2', [ticket({ big: true })]);
    await draw([first, second]);
    location.pathname = '/app/b/b-1';
    await act(async () => { tree!.update(h(Page, { member: 'sam', thread, agent: 'art', at: { board: 'b-1' } })); });
    // The arriving board's bricks mount as the slide starts; the leaving board's are still there.
    expect(boardsDrawn().map((b) => bodies(b))).toEqual([[true], [true]]);
    expect(held()).toEqual(['BrickLanes', 'BrickTicket', 'BrickTicketMore', 'BrickTicketSessions']);
    const trail = tree!.root.findAll((n) => n.props.className === 'boards-trail')[0], here = {};
    // A transition inside the trail (a placement settling) is not the slide.
    await act(async () => trail.props.onTransitionEnd({ target: {}, currentTarget: here }));
    expect(held()).toEqual(['BrickLanes', 'BrickTicket', 'BrickTicketMore', 'BrickTicketSessions']);
    await act(async () => trail.props.onTransitionEnd({ target: here, currentTarget: here }));
    expect(boardsDrawn().map((b) => bodies(b))).toEqual([[true], [false]]);
    expect(held()).toEqual(['BrickLanes']);
  });
  it('a closed board drawn by its own address is the board on screen, and reads as ever', async () => {
    await draw([board('b-1', [lanes({ big: true })]), board('b-2', [ticket({ big: true })], { closed: true })], { path: '/app/b/b-2' });
    expect(boardsDrawn().map((b) => bodies(b))).toEqual([[true]]);
    expect(held()).toEqual(['BrickTicket', 'BrickTicketMore', 'BrickTicketSessions']);
  });
  it('a closed board that is not the one in the address gives way to the last open one', async () => {
    const root = await draw([board('b-1', [lanes({ big: true })]), board('b-2', [ticket({ big: true })], { closed: true })]);
    expect(location.pathname).toBe('/app/b/b-1');
    expect(root.findAllByType('h1').map(text)).toEqual(['Lanes']);
  });
});

describe('the address', () => {
  it('holds one id and the page keeps nothing else: no query, no fragment, nothing stored', async () => {
    const first = board('b-1', [lanes({ big: true }), ticket({ flagged: true })]);
    await draw([first]);
    await act(async () => articles()[1].props.onPointerEnter());
    await act(async () => articles()[1].findAll((n) => n.props.className === 'board-maximize')[0].props.onClick());
    await click(chipElement({ brick: 'project', params: { project: 'garden' } }));
    await click({ a: { getAttribute: () => '?ticket=t-12' } });
    await act(async () => tree!.root.findAll((n) => n.props.className === 'boards-presence')[0].props.onClick());
    await type('hello');
    await submit();
    await feed({ boards: [first, board('b-2', [ticket({ big: true })])] });
    await feed({ boards: [] });
    expect(f.went).toEqual(['/app/b/b-1', '/app/b/b-2', '/app/t/' + encodeURIComponent(thread)]);
    for (const path of f.went) expect(path).not.toMatch(/[?#]/);
    expect(location.search).toBe('');
    expect(location.hash).toBe('');
    expect(f.stored).not.toHaveBeenCalled();
  });
});

describe('a restart', () => {
  it('asks whether the build changed when the live read is live, and stays when it has not', async () => {
    await draw([]);
    expect(f.build).toHaveBeenCalledTimes(1);
    expect(f.reload).not.toHaveBeenCalled();
  });
  it('asks again when the live read comes back, and reloads onto a new build', async () => {
    await draw([board('b-1', [lanes({ big: true })])]);
    await feed({ status: 'error' });
    expect(f.build).toHaveBeenCalledTimes(1);
    f.build.mockResolvedValue(true);
    await feed({ status: 'live' });
    expect(f.build).toHaveBeenCalledTimes(2);
    expect(f.reload).toHaveBeenCalledTimes(1);
  });
  it('does not ask while the read is not live', async () => {
    f.status = 'loading'; f.build.mockResolvedValue(true);
    await draw([]);
    expect(f.build).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
  });
  it('waits until the input is empty', async () => {
    await draw([]);
    await type('half a thought');
    await feed({ status: 'error' });
    f.build.mockResolvedValue(true);
    await feed({ status: 'live' });
    expect(f.reload).not.toHaveBeenCalled();
    await type('   ');
    expect(f.reload).toHaveBeenCalledTimes(1);
  });
  it('waits until nothing is being sent', async () => {
    let delivered!: () => void;
    f.op.mockImplementation((name: string) => (name === 'comms.send' ? new Promise<void>((done) => { delivered = done; }) : Promise.resolve()));
    await draw([]);
    await type('hello');
    await submit();
    await type('');
    await feed({ status: 'error' });
    f.build.mockResolvedValue(true);
    await feed({ status: 'live' });
    expect(f.reload).not.toHaveBeenCalled();
    await act(async () => delivered());
    expect(f.reload).toHaveBeenCalledTimes(1);
  });
});

describe('a body that has not arrived', () => {
  const made = { arrive: (_module: { default: () => unknown }) => {} };
  afterEach(() => { for (const name of ['slow', 'gone']) delete bricks[name]; });
  it('keeps its placement\'s rectangle and heading and says loading, then draws in the same rectangle', async () => {
    const { lazy, createElement } = await import('react');
    bricks.slow = { ...bricks.ticket, title: () => 'Slow one', Body: lazy(() => new Promise<{ default: () => never }>((arrive) => { made.arrive = arrive as never; })) };
    await one([lanes({ big: true }), placed('slow', { ticket: 't-7' }), ticket()]);
    const [, slow, after] = articles();
    const rectangle = { ...slow.props.style };
    expect(rectangle.width).toBeGreaterThan(0);
    expect(text(slow.findByType('h2'))).toBe('Slow one');
    expect(text(slow.children[1] as Node)).toBe('Loading…');
    // The bricks beside it are drawn: one body on its way holds nothing else back.
    expect(text(after)).toContain('Mend the gate');
    await act(async () => { made.arrive({ default: () => createElement('p', null, 'Here now') }); });
    expect(text(articles()[1].children[1] as Node)).toBe('Here now');
    expect(articles()[1].props.style).toEqual(rectangle);
  });
  it('says so in its own placement when its module cannot be fetched, and leaves the rest of the board drawn', async () => {
    const { lazy } = await import('react');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    bricks.gone = { ...bricks.ticket, Body: lazy(() => Promise.reject(new Error('404'))) };
    await one([lanes({ big: true }), placed('gone', { ticket: 't-7' }), ticket()]);
    expect(text(articles()[1].children[1] as Node)).toBe('This brick did not load. Reload the page to try again.');
    expect(text(articles()[2])).toContain('Mend the gate');
    expect(f.reload).not.toHaveBeenCalled();
    quiet.mockRestore();
  });
  it('takes the new build when a module is gone because loom was deployed, unless something is typed', async () => {
    const { lazy } = await import('react');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    bricks.gone = { ...bricks.ticket, Body: lazy(() => Promise.reject(new Error('404'))) };
    // The page looked when its read went live, and there was no new build then. There is one by the time the module is asked for.
    f.build.mockResolvedValueOnce(false).mockResolvedValue(true);
    await one([lanes({ big: true })]);
    await type('half a thought');
    await feed({ boards: [board('b-1', [lanes({ big: true }), placed('gone', { ticket: 't-7' })])] });
    expect(text(articles()[1].children[1] as Node)).toBe('This brick did not load. Reload the page to try again.');
    expect(f.reload).not.toHaveBeenCalled();
    await type('');
    expect(f.reload).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });
});
