/** The `tickets` brick (docs/specs/boards.md, "The first bricks"): every ticket the member may read, a state at a
 * time, paged, with a search in its big form. The data hooks are fakes; which rows each state's selection holds,
 * under the real rules, is bricks-tickets-queries.test.ts. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { feed, once } = vi.hoisted(() => ({ feed: vi.fn(), once: vi.fn() }));
vi.mock('../data/graphql', () => ({ useDataQuery: feed, useDataOnce: once }));
import { bricks, loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';
import { searchPattern, ticketsAllQuery, ticketsOpenQuery, ticketsPageSize, ticketsReadyQuery, ticketsRetiredQuery, type TicketRow } from './bricks-tickets';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();

const b = bench(feed);
beforeEach(() => { b.before(); once.mockReset().mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : { status: 'offline' })); });
afterEach(b.after);

const row = (id: string, title: string, over: Partial<TicketRow> = {}): TicketRow => ({ id, title, status: 'open', closeReason: null, priority: 2, project: 'garden', projectRow: { name: 'Garden' },
  assigneeKind: null, assignee: null, isReady: true, isShelved: false, ...over });
const ready = [row('t-1', 'Fix the gate latch'), row('t-4', 'Order seed potatoes', { project: null, projectRow: null })];
const working = [row('t-2', 'Dig the north bed', { status: 'in_progress', isReady: false, assigneeKind: 'member', assignee: 'sam' })];
const shelved = [row('t-5', 'Pump half fitted', { status: 'in_progress', project: 'pond', projectRow: { name: 'Pond' }, isShelved: true, isReady: false, assigneeKind: 'agent', assignee: 'moss' })];
const every = [...working, row('t-6', 'Sow beans', { status: 'closed', closeReason: 'done', isReady: false }), ...ready, ...shelved];
/** Each read answered by its query's name; a list answered by the state its selection is for. */
const data = (over: Record<string, unknown> = {}) => ({ BrickTicketsRetired: { retired: [{ id: 'pond' }] }, BrickTicketsReady: { rows: ready }, BrickTicketsAll: { rows: every },
  BrickTicketsOpen: { rows: working }, ...over });
const asked = (query: string) => feed.mock.calls.filter(([q, , o]) => q === query && !o?.pause).at(-1)?.[1];
const chip = (id: string) => ({ brick: 'ticket', params: { ticket: id } });

it('opens on Ready, from readyTasks, each row a chip placing its ticket with id, title, project, state and who has it', async () => {
  b.answer(data());
  await b.draw('tickets', {}, 'primary');
  expect(asked(ticketsReadyQuery)).toEqual({ where: {}, limit: ticketsPageSize + 1 });
  // Ready reads no retired project: readyTasks already leaves the shelved out.
  expect(feed.mock.calls.filter(([q, , o]) => q === ticketsRetiredQuery && !o?.pause)).toEqual([]);
  expect(b.placed()).toEqual([{ brick: 'tickets', params: { state: 'in-progress' } }, { brick: 'tickets', params: { state: 'shelved' } }, { brick: 'tickets', params: { state: 'all' } }, chip('t-1'), chip('t-4')]);
  for (const shown of ['2 ready tickets', 'Fix the gate latch', 't-1', 'Garden · no one has it', 'Ready', 'Order seed potatoes', 'No project']) expect(b.all(), shown).toContain(shown);
  expect(bricks.tickets.title({ state: 'ready' })).toBe('Tickets');
  expect(bricks.tickets.sub({ state: 'in-progress' })).toBe('in progress');
  expect(b.reported).not.toHaveBeenCalled();
});

it('reads In progress and Shelved from tasks split by the retired projects, and All latest change first', async () => {
  b.answer(data());
  await b.draw('tickets', { state: 'in-progress' }, 'side');
  expect(asked(ticketsOpenQuery)).toEqual({ where: { status: { eq: 'in_progress' }, project: { OR: [{ isNull: true }, { notInArray: ['pond'] }] } }, limit: ticketsPageSize + 1 });
  expect(b.placed()).toEqual([chip('t-2')]);
  for (const shown of ['Dig the north bed', 'Garden · with sam', 'In progress']) expect(b.all(), shown).toContain(shown);
  b.answer(data({ BrickTicketsOpen: { rows: shelved } }));
  await b.draw('tickets', { state: 'shelved' }, 'side');
  expect(asked(ticketsOpenQuery)).toEqual({ where: { status: { ne: 'closed' }, project: { inArray: ['pond'] } }, limit: ticketsPageSize + 1 });
  for (const shown of ['Pump half fitted', 'Pond · with moss', 'Shelved']) expect(b.all(), shown).toContain(shown);
  b.answer(data());
  await b.draw('tickets', { state: 'all' }, 'side');
  expect(asked(ticketsAllQuery)).toEqual({ where: {}, limit: ticketsPageSize + 1 });
  expect(b.placed()).toEqual(every.map((t) => chip(t.id)));
  for (const shown of ['In progress', 'Closed', 'Ready', 'Shelved']) expect(b.all(), shown).toContain(shown);
  // The small forms have no search, no paging and no control but the chips.
  expect(b.controls()).toEqual([]);
  await b.draw('tickets', { state: 'all' }, 'compact');
  b.oneLine();
  expect(b.all()).toBe('5 tickets');
  b.answer(data({ BrickTicketsOpen: { rows: working } }));
  await b.draw('tickets', { state: 'in-progress' }, 'compact');
  expect(b.all()).toBe('1 ticket in progress');
});

it('says so when a state is empty, when no project is retired, and while it loads', async () => {
  b.answer(data({ BrickTicketsReady: { rows: [] } }));
  await b.draw('tickets', { state: 'ready' }, 'side');
  expect(b.all()).toBe('No ticket is ready.');
  await b.draw('tickets', { state: 'ready' }, 'compact');
  expect(b.all()).toBe('No ticket is ready');
  // No retired project: nothing is shelved, and no list is asked for.
  b.answer(data({ BrickTicketsRetired: { retired: [] } }));
  feed.mockClear();
  await b.draw('tickets', { state: 'shelved' }, 'side');
  expect(b.all()).toBe('No ticket is shelved with a retired project.');
  expect(feed.mock.calls.filter(([q, , o]) => q !== ticketsRetiredQuery && !o?.pause)).toEqual([]);
  // In progress with nothing retired asks for every ticket in progress.
  await b.draw('tickets', { state: 'in-progress' }, 'side');
  expect(asked(ticketsOpenQuery)).toEqual({ where: { status: { eq: 'in_progress' } }, limit: ticketsPageSize + 1 });
  b.answer(data({ BrickTicketsReady: undefined }));
  await b.draw('tickets', { state: 'ready' }, 'side');
  expect(b.all()).toBe('Loading…');
  b.answer(data({ BrickTicketsRetired: undefined }));
  await b.draw('tickets', { state: 'shelved' }, 'side');
  expect(b.all()).toBe('Loading…');
});

it('is unavailable, in every form, when the list or the retired projects cannot be read', async () => {
  for (const [state, failing] of [['ready', 'BrickTicketsReady'], ['all', 'BrickTicketsAll'], ['shelved', 'BrickTicketsRetired'], ['in-progress', 'BrickTicketsOpen']] as const) {
    b.answer(data());
    const base = feed.getMockImplementation()!;
    feed.mockImplementation((q: string, v: unknown, o?: { pause?: boolean }) => (new RegExp(`^query ${failing}\\b`).test(q) && !o?.pause ? { status: 'denied' } : base(q, v, o)));
    for (const form of ['side', 'compact'] as const) {
      await b.draw('tickets', { state }, form);
      expect(b.all(), `${state} ${form}`).toBe('Tickets are unavailable.');
    }
    await b.draw('tickets', { state }, 'primary');
    expect(b.all(), state).toContain('Tickets are unavailable.');
  }
  // A live answer that holds no retired projects is a failed one, not "nothing is shelved".
  b.answer(data({ BrickTicketsRetired: { retired: null } }));
  await b.draw('tickets', { state: 'shelved' }, 'side');
  expect(b.all()).toBe('Tickets are unavailable.');
});

it('shows a page, loads the next on a press, and stops asking at the most it reads', async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(`t-${100 + i}`, `Ticket ${i}`));
  feed.mockImplementation((q: string, v: { limit?: number } | undefined, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' }
    : q === ticketsReadyQuery ? { status: 'live', data: { rows: many(Math.min(v!.limit!, 400)) } } : { status: 'live', data: {} }));
  await b.draw('tickets', { state: 'ready' }, 'primary');
  expect(b.all()).toContain(`More than ${ticketsPageSize} ready tickets`);
  expect(b.placed().filter((p) => p.brick === 'ticket')).toHaveLength(ticketsPageSize);
  await b.press(`Show ${ticketsPageSize} more`);
  expect(asked(ticketsReadyQuery)).toEqual({ where: {}, limit: 2 * ticketsPageSize + 1 });
  expect(b.placed().filter((p) => p.brick === 'ticket')).toHaveLength(2 * ticketsPageSize);
  for (let n = 0; n < 12; n++) if (b.button(`Show ${ticketsPageSize} more`)) await b.press(`Show ${ticketsPageSize} more`);
  expect(asked(ticketsReadyQuery)).toEqual({ where: {}, limit: 301 });
  expect(b.button(`Show ${ticketsPageSize} more`)).toBeUndefined();
  expect(b.all()).toContain('Showing the first 300. Search to narrow the list.');
  // The side form: a glance at the first page, and "and more" where loom holds more than that.
  await b.draw('tickets', { state: 'ready' }, 'side');
  expect(asked(ticketsReadyQuery)).toEqual({ where: {}, limit: ticketsPageSize + 1 });
  expect(b.controls()).toEqual([]);
  await b.draw('tickets', { state: 'ready' }, 'compact');
  expect(b.all()).toBe(`More than ${ticketsPageSize} ready tickets`);
  expect(b.reported).not.toHaveBeenCalled();
});

it('searches once on Search, never while typing, and keeps the words out of the board', async () => {
  b.answer(data());
  await b.draw('tickets', { state: 'in-progress' }, 'primary');
  await b.type('Search tickets', 'north  BED');
  // Typing asks nothing.
  expect(once.mock.calls.filter(([, , o]) => !o?.pause)).toEqual([]);
  once.mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : { status: 'live', data: { rows: working } }));
  await b.submit('Search tickets');
  const [query, variables] = once.mock.calls.filter(([, , o]) => !o?.pause).at(-1)!;
  expect(query).toBe(ticketsOpenQuery);
  expect(searchPattern('north  BED')).toBe('%north%BED%');
  const like = { like: '%north%BED%' }, own = { status: { eq: 'in_progress' }, project: { OR: [{ isNull: true }, { notInArray: ['pond'] }] } };
  expect(variables).toEqual({ limit: ticketsPageSize + 1, where: { OR: [
    { ...own, id: like }, { ...own, title: like }, { ...own, goal: like }, { ...own, why: like }, { ...own, description: like },
    { status: { eq: 'in_progress' }, project: { notInArray: ['pond'], ...like } }, { ...own, assignee: like },
  ] } });
  expect(b.all()).toContain('1 ticket in progress matching “north  BED”');
  expect(b.placed().filter((p) => p.brick === 'ticket')).toEqual([chip('t-2')]);
  // The live list is paused while a search is shown.
  expect(feed.mock.calls.at(-1)?.[2]).toMatchObject({ pause: true });
  // Nothing typed reached a parameter, a chip or the board.
  expect(JSON.stringify(b.placed())).not.toContain('north');
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.sent).not.toHaveBeenCalled();
  // Nothing matches; then the search cannot be read.
  once.mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : { status: 'live', data: { rows: [] } }));
  await b.type('Search tickets', 'zebra');
  await b.submit('Search tickets');
  expect(b.all()).toContain('Nothing matches “zebra”.');
  once.mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : { status: 'offline' }));
  await b.type('Search tickets', 'gate');
  await b.submit('Search tickets');
  expect(b.all()).toContain('Search is unavailable.');
  // Show the list goes back to the live list.
  await b.press('Show the list');
  expect(b.field('Search tickets')!.props.value).toBe('');
  expect(b.all()).toContain('Dig the north bed');
  expect(feed.mock.calls.at(-1)?.[2]).toMatchObject({ pause: false });
});

it('pages a search too, asking again once for each More', async () => {
  const many = Array.from({ length: ticketsPageSize + 1 }, (_, i) => row(`t-${200 + i}`, `Gate ${i}`));
  b.answer(data());
  once.mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : { status: 'live', data: { rows: many } }));
  await b.draw('tickets', { state: 'all' }, 'primary');
  await b.type('Search tickets', 'gate');
  await b.submit('Search tickets');
  expect(b.all()).toContain(`More than ${ticketsPageSize} tickets matching “gate”`);
  await b.press(`Show ${ticketsPageSize} more`);
  expect(once.mock.calls.filter(([, , o]) => !o?.pause).at(-1)![1]).toMatchObject({ limit: 2 * ticketsPageSize + 1 });
});
