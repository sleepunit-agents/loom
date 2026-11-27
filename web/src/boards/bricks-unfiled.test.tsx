/** The `unfiled` brick (docs/specs/boards.md, "The first bricks"): the tickets under no project, read with the
 * desktop Unfiled view's own selection, and its Set project action. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { unfiledPageSize, workUnfiledQuery } from '../pieces/work/query';
import { bricks, loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();

const b = bench(feed);
beforeEach(b.before);
afterEach(b.after);

const row = (id: string, title: string, status = 'open') => ({ id, title, status, changedAt: '2026-11-20T10:00:00Z' });
const data = (unfiled = [row('t-4', 'Order hinges'), row('t-2', 'Dig the bed', 'in_progress'), row('t-5', 'Sow the bed', 'closed')]) => ({
  WorkUnfiled: { unfiled },
  TaskChoices: { projects: [{ id: 'garden', name: 'Garden', projectMembersByProject: [] }, { id: 'pond', name: 'Pond', projectMembersByProject: [] }], agents: [], members: [] },
  WorkViewer: { homeComms: { member: 'sam' } },
});
const chip = (id: string) => ({ brick: 'ticket', params: { ticket: id } });

it('lists the tickets under no project as the desktop\'s Unfiled view reads them, each a ticket chip', async () => {
  b.answer(data());
  await b.draw('unfiled', {}, 'primary');
  expect(feed.mock.calls.some(([query, variables]) => query === workUnfiledQuery && JSON.stringify(variables) === '{"offset":0}')).toBe(true);
  expect(b.placed()).toEqual([chip('t-4'), chip('t-2'), chip('t-5')]);
  for (const shown of ['3 unfiled tickets', 'Order hinges', 'Open', 'Dig the bed', 'In progress', 'Sow the bed', 'Closed']) expect(b.all(), shown).toContain(shown);
  await b.draw('unfiled', {}, 'side');
  expect(b.placed()).toEqual([chip('t-4'), chip('t-2'), chip('t-5')]);
  expect(b.controls()).toEqual([]);
  await b.draw('unfiled', {}, 'compact');
  b.oneLine();
  expect(b.all()).toBe('3 unfiled tickets');
  expect(b.controls()).toEqual([]);
  expect(bricks.unfiled.title({})).toBe('Unfiled tickets');
  expect(bricks.unfiled.sub({})).toBe('');
});

it('says so when there are none, when there are more than a page, when it cannot be read and while it loads', async () => {
  b.answer(data([]));
  await b.draw('unfiled', {}, 'side');
  expect(b.all()).toBe('No unfiled tickets. Every ticket you can see belongs to a project.');
  await b.draw('unfiled', {}, 'compact');
  expect(b.all()).toBe('No unfiled tickets');
  b.answer(data(Array.from({ length: unfiledPageSize + 1 }, (_, n) => row('t-' + (n + 100), 'Ticket ' + n))));
  await b.draw('unfiled', {}, 'compact');
  expect(b.all()).toBe(`More than ${unfiledPageSize} unfiled tickets`);
  await b.draw('unfiled', {}, 'primary');
  expect(b.placed()).toHaveLength(unfiledPageSize);
  expect(b.all()).toContain('and more');
  await b.draw('unfiled', {}, 'side');
  expect(b.placed()).toHaveLength(6);
  for (const form of ['primary', 'side', 'compact'] as const) {
    feed.mockImplementation(() => ({ status: 'denied' }));
    await b.draw('unfiled', {}, form);
    expect(b.all(), form).toBe('Unfiled tickets are unavailable.');
    expect(b.controls()).toEqual([]);
    b.answer({ WorkUnfiled: undefined });
    await b.draw('unfiled', {}, form);
    expect(b.all(), form).toBe('Loading…');
  }
  expect(b.sent).not.toHaveBeenCalled();
});

it('files a ticket into a project with the desktop\'s action and tells the board only that one was filed', async () => {
  b.answer(data());
  await b.draw('unfiled', {}, 'primary');
  expect(b.labels()).toEqual(['File…', 'File…', 'File…']);
  await b.press('File t-2 into a project');
  expect(b.labels()).toEqual(['File…', 'Garden', 'Pond', 'Cancel', 'File…']);
  await b.press('Pond');
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'edit', id: 't-2', input: { project: 'pond' } }]]);
  expect(b.reported.mock.calls).toEqual([['project', {}]]);
  expect(b.labels()).toEqual(['File…', 'File…', 'File…']);
  b.sent.mockReset(); b.reported.mockReset();
  Object.assign(b.reply, { ok: false, message: 'Task t-4 has an unanswered question' });
  await b.press('File t-4 into a project');
  await b.press('Garden');
  expect(b.sent).toHaveBeenCalledTimes(1);
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.alert()).toBe('Task t-4 has an unanswered question');
  await b.press('Cancel');
  expect(b.labels()).toEqual(['File…', 'File…', 'File…']);
});
