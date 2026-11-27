/** The `backlog` brick (docs/specs/boards.md, "The first bricks"): a project's open tickets in no lane, in the
 * desktop backlog's order, and its Set priority action. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, loadBricks } from './bricks';
import { backlogQuery } from './bricks-backlog';
import { bench } from './bricks-work.test.helper';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();

const b = bench(feed);
beforeEach(b.before);
afterEach(b.after);

const row = (id: string, title: string, priority: number, over: object = {}) => ({ id, title, status: 'open', priority, isShelved: false, ...over });
// As loom answers it: by priority, then the hand-kept position, then id.
const open = [row('t-4', 'Order hinges', 0), row('t-2', 'Dig the bed', 1), row('t-9', 'In a lane', 1), row('t-6', 'Being worked', 2, { status: 'in_progress' }), row('t-3', 'Shelved', 2, { isShelved: true }), row('t-5', 'Sow the bed', 3)];
const data = (over: object = {}) => ({ BrickBacklog: { project: { id: 'garden', name: 'Garden' }, open, ...over }, BrickBacklogLaned: { projectBoardTickets: [{ id: 't-9' }, { id: 't-6' }] } });
const chip = (id: string) => ({ brick: 'ticket', params: { ticket: id } });

it('lists the open tickets that no lane holds, in the order loom gives, each a ticket chip with its title and priority', async () => {
  b.answer(data());
  await b.draw('backlog', { project: 'garden' }, 'primary');
  expect(b.asked('BrickBacklog')).toEqual({ project: 'garden' });
  expect(b.asked('BrickBacklogLaned')).toEqual({ project: 'garden' });
  // The desktop backlog's order: priority, then position, then id.
  expect(backlogQuery).toContain('orderBy:{priority:{direction:asc,priority:2},position:{direction:asc,priority:1},id:{direction:asc,priority:0}}');
  expect(b.placed()).toEqual([chip('t-4'), chip('t-2'), chip('t-5')]);
  for (const shown of ['3 tickets in the backlog', 'Order hinges', 'P0', 'Dig the bed', 'P1', 'Sow the bed', 'P3']) expect(b.all(), shown).toContain(shown);
  for (const hidden of ['In a lane', 'Being worked', 'Shelved']) expect(b.all(), hidden).not.toContain(hidden);
  await b.draw('backlog', { project: 'garden' }, 'side');
  expect(b.placed()).toEqual([chip('t-4'), chip('t-2'), chip('t-5')]);
  expect(b.all()).toContain('Order hinges');
  // The small form changes nothing.
  expect(b.controls()).toEqual([]);
  await b.draw('backlog', { project: 'garden' }, 'compact');
  b.oneLine();
  expect(b.all()).toBe('3 tickets in the backlog');
  expect(b.controls()).toEqual([]);
  expect(bricks.backlog.title({ project: 'garden' })).toBe('Backlog');
  expect(bricks.backlog.sub({ project: 'garden' })).toBe('garden');
});

it('says so when the backlog is empty, shows only the first of a long one, and never flags itself', async () => {
  b.answer(data({ open: [] }));
  await b.draw('backlog', { project: 'garden' }, 'side');
  expect(b.all()).toBe('No tickets in the backlog.');
  await b.draw('backlog', { project: 'garden' }, 'compact');
  expect(b.all()).toBe('No tickets in the backlog');
  b.answer(data({ open: Array.from({ length: 40 }, (_, n) => row('t-' + (n + 100), 'Ticket ' + n, 2)) }));
  await b.draw('backlog', { project: 'garden' }, 'side');
  expect(b.placed()).toHaveLength(6);
  expect(b.all()).toContain('and 34 more');
  await b.draw('backlog', { project: 'garden' }, 'primary');
  expect(b.placed()).toHaveLength(30);
  expect(b.all()).toContain('and 10 more');
  b.answer(data({ open: [row('t-4', 'Order hinges', 4)] }));
  await b.redraw('backlog', { project: 'garden' }, 'primary');
  expect(b.raised).not.toHaveBeenCalled();
});

it('is unavailable for a project that is not there or may not be read, and loading until it answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    b.answer({ BrickBacklog: { project: null, open: [] }, BrickBacklogLaned: { projectBoardTickets: [] } });
    await b.draw('backlog', { project: 'garden' }, form);
    expect(b.all(), form).toBe('This project is unavailable.');
    expect(b.controls()).toEqual([]);
    b.answer({ BrickBacklog: undefined, BrickBacklogLaned: undefined });
    await b.draw('backlog', { project: 'garden' }, form);
    expect(b.all(), form).toBe('Loading…');
  }
  expect(b.sent).not.toHaveBeenCalled();
});

it('sets a ticket\'s priority with the desktop\'s action and tells the board which priority, not which ticket', async () => {
  b.answer(data());
  await b.draw('backlog', { project: 'garden' }, 'primary');
  expect(b.labels()).toEqual(['Priority…', 'Priority…', 'Priority…']);
  await b.press('Set priority of t-2');
  expect(b.root().findAll((n) => n.props['aria-pressed'] === true).map(b.said)).toEqual(['P1']);
  await b.press('P3');
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'edit', id: 't-2', input: { priority: 3 } }]]);
  expect(b.reported.mock.calls).toEqual([['priority', { priority: '3' }]]);
  expect(b.labels()).toEqual(['Priority…', 'Priority…', 'Priority…']);
  // Refused: the choice stays open, what loom said is shown, the board hears nothing.
  b.sent.mockReset(); b.reported.mockReset();
  Object.assign(b.reply, { ok: false, message: 'Access changed' });
  await b.press('Set priority of t-4');
  await b.press('P4 · least urgent');
  expect(b.sent).toHaveBeenCalledTimes(1);
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.alert()).toBe('Access changed');
  await b.press('Cancel');
  expect(b.labels()).toEqual(['Priority…', 'Priority…', 'Priority…']);
});
