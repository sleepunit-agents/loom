/** The `trend` brick's backlog history (./bricks-trend.tsx; docs/specs/boards.md, "The first bricks"): in the big form
 * only, closed until the member opens it, read once each time it is opened and each time a group is picked, for the
 * window the chart shows, and forgotten when the brick leaves its big form or its project or days change. Its chart
 * is checked in bricks.test.tsx. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { feed, once } = vi.hoisted(() => ({ feed: vi.fn(), once: vi.fn() }));
vi.mock('../data/graphql', () => ({ useDataQuery: feed, useDataOnce: once }));
import { loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';
import { since } from './trend';

await loadBricks();

const b = bench(feed);
const now = new Date(2026, 10, 27, 12).getTime();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); b.before(); once.mockReset(); });
afterEach(async () => { await b.after(); vi.useRealTimers(); });

type Vars = { project: string; since: string; until: string; group: string | null; offset: number };
const counts = { start: 4, end: 5, originalEverClosed: 2, originalClosed: 1, originalMovedOut: 0, addedOpen: 3, created: 2, arrivalsClosed: 1, reopened: 1, movedIn: 1, movedOut: 0 };
const report = (over: object = {}) => ({ coverage: '2026-01-01T00:00:00.000Z', from: new Date(since(now, 7)).toISOString(), until: new Date(now).toISOString(),
  counts: Object.entries(counts).map(([key, total]) => ({ key, total })), tickets: [], ...over });
let answer: (v: Vars) => unknown = () => ({ status: 'live', data: { projectBacklogWindow: report() } });
const grouped = (v: Vars) => ({ status: 'live', data: { projectBacklogWindow: report({ tickets: v.group === 'created' ? [{ id: 't-4', title: 'Sow the beans' }, { id: 't-6', title: 'Mend the hose' }] : [] }) } });
const asked = () => once.mock.calls.filter(([q, , o]) => /^query BrickBacklogWindow\b/.test(q) && !o?.pause).map(([, v]) => v as Vars);
const chart = { BrickTrend: { opened: [], closed: [] } };

beforeEach(() => { answer = grouped; once.mockImplementation((_q: string, v: Vars, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : answer(v))); });

/** Whether the section's heading, which is its control, says it is closed (false) or open (true). */
const folded = () => b.root().findAll((node) => node.type === 'button' && node.props.className === 'board-fold' && b.said(node) === 'Backlog history')[0]?.props['aria-expanded'];

it('is closed until the member opens it, then reads once for the window the chart shows, and shows the counts', async () => {
  b.answer(chart);
  await b.draw('trend', { project: 'garden', days: 7 }, 'primary');
  expect(folded()).toBe(false);
  expect(once).not.toHaveBeenCalled();
  await b.press('Backlog history');
  expect(asked().at(-1)).toEqual({ project: 'garden', since: new Date(since(now, 7)).toISOString(), until: new Date(now).toISOString(), group: null, offset: 0 });
  expect(new Set(asked().map((v) => JSON.stringify(v))).size).toBe(1);
  for (const shown of ['4 open at the start · 5 open at the end', 'tickets you can open today']) expect(b.all(), shown).toContain(shown);
  expect(folded()).toBe(true);
  // A redraw with the same answer asks nothing new; the read is once per opening.
  const before = asked().length;
  await b.redraw('trend', { project: 'garden', days: 7 }, 'primary');
  expect(new Set(asked().slice(before).map((v) => JSON.stringify(v)))).toEqual(new Set([JSON.stringify(asked()[0])]));
  // The side and compact forms have no backlog history.
  for (const form of ['side', 'compact'] as const) {
    once.mockClear();
    await b.draw('trend', { project: 'garden', days: 7 }, form);
    expect(b.all()).not.toContain('backlog history');
    expect(once).not.toHaveBeenCalled();
  }
});

it('reads a picked group\'s tickets once and lists them as ticket chips with their titles', async () => {
  b.answer(chart);
  await b.draw('trend', { project: 'garden', days: 30 }, 'primary');
  await b.press('Backlog history');
  await b.press('Tickets: none');
  expect(b.labels()).toContain('Tickets created here · 2');
  await b.press('Tickets created here · 2');
  expect(asked().at(-1)).toMatchObject({ project: 'garden', since: new Date(since(now, 30)).toISOString(), group: 'created', offset: 0 });
  expect(b.placed()).toEqual([{ brick: 'ticket', params: { ticket: 't-4' } }, { brick: 'ticket', params: { ticket: 't-6' } }]);
  expect(b.all()).toContain('Sow the beans');
  // A group with nothing the member can open says so.
  await b.press('Tickets: Tickets created here · 2');
  await b.press('Reopened here · 1');
  expect(b.all()).toContain('No ticket you can open is in this group.');
});

it('forgets what it read when it is hidden, when the brick leaves its big form, and when its project or days change', async () => {
  b.answer(chart);
  await b.draw('trend', { project: 'garden', days: 7 }, 'primary');
  await b.press('Backlog history');
  await b.press('Backlog history');
  expect(b.all()).not.toContain('open at the start');
  once.mockClear();
  await b.press('Backlog history');
  expect(asked()).not.toEqual([]);
  // Smaller, then big again: closed.
  await b.redraw('trend', { project: 'garden', days: 7 }, 'side');
  await b.redraw('trend', { project: 'garden', days: 7 }, 'primary');
  expect(folded()).toBe(false);
  expect(b.all()).not.toContain('open at the start');
  // Open, then another window: closed again.
  await b.press('Backlog history');
  await b.redraw('trend', { project: 'garden', days: 30 }, 'primary');
  expect(folded()).toBe(false);
  await b.press('Backlog history');
  await b.redraw('trend', { project: 'pond', days: 30 }, 'primary');
  expect(folded()).toBe(false);
});

it('says while it reads, when it is unavailable, when nothing was in the backlog, and where history starts', async () => {
  b.answer(chart);
  answer = () => ({ status: 'loading' });
  await b.draw('trend', { project: 'garden', days: 7 }, 'primary');
  await b.press('Backlog history');
  expect(b.all()).toContain('Loading…');
  answer = () => ({ status: 'live', data: { projectBacklogWindow: null } });
  await b.press('Backlog history');
  await b.press('Backlog history');
  expect(b.all()).toContain('The backlog history is unavailable.');
  answer = () => ({ status: 'live', data: { projectBacklogWindow: report({ counts: [], coverage: new Date(now - 3600000).toISOString() }) } });
  await b.press('Backlog history');
  await b.press('Backlog history');
  expect(b.all()).toContain('Nothing was in this project\'s backlog in this time.');
  expect(b.all()).toContain('History starts');
});
