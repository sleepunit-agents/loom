/** The `catchup` brick (docs/specs/boards.md, "The first bricks"): the desktop's Work catch-up across every project the
 * member may read, since the start of today, or of three or seven days, its tickets as chips. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, loadBricks } from './bricks';
import { catchupFrom } from './bricks-catchup';
import { bench } from './bricks-work.test.helper';

await loadBricks();

const b = bench(feed);
// Noon on the member's clock: the tickets below moved minutes ago, which is today at any hour of a run.
const now = new Date(2026, 10, 27, 12).getTime();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); b.before(); });
afterEach(async () => { await b.after(); vi.useRealTimers(); });

const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();
const ticket = (id: string, title: string, minutes: number, over: object = {}) => ({ id, title, changedAt: ago(minutes), createdAt: ago(60 * 24 * 30), startedAt: null, closedAt: null,
  status: 'open', closeReason: null, ask: null, taskCommentsByTask: [], ...over });
const projects = [
  { id: 'garden', name: 'Garden', lifecycle: 'active', tasksByProject: [
    ticket('t-1', 'Fix the gate latch', 10, { status: 'closed', closedAt: ago(10), closeReason: 'done' }),
    ticket('t-2', 'Dig the north bed', 30, { startedAt: ago(30) }),
    ticket('t-3', 'Sow the beans', 50, { taskCommentsByTask: [{ at: ago(50), actor: 'sam', text: 'Broad beans, not runners.' }] }),
    ticket('t-4', 'Net the brassicas', 70, { createdAt: ago(70) }),
  ] },
  { id: 'pond', name: 'Pond', lifecycle: 'active', tasksByProject: [] },
  { id: 'old', name: 'Old', lifecycle: 'removed', tasksByProject: [ticket('t-9', 'Gone', 5)] },
];
const posts = [{ project: 'pond', task: 't-5', title: 'Fit the pump', id: '7', at: ago(20), agent: 'fern', words: 'Pump arrived.' }];
const data = (over: object = {}) => ({ BrickCatchUp: { projects }, BrickCatchUpPosts: { projectActivityHighlights: posts }, ...over });
const chip = (id: string) => ({ brick: 'ticket', params: { ticket: id } });

it('reads from the start of today, of three days or of seven, as the parameter says, and asks both reads with it', async () => {
  b.answer(data());
  for (const since of ['today', '3-days', '7-days'] as const) {
    await b.draw('catchup', { since }, 'side');
    const from = catchupFrom(now, since);
    expect(b.asked('BrickCatchUp')).toEqual({ since: from });
    expect(b.asked('BrickCatchUpPosts')).toEqual({ since: from });
    const start = new Date(from);
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
  }
  const days = (since: string) => Math.round((new Date().setHours(0, 0, 0, 0) - Date.parse(catchupFrom(now, since as 'today'))) / 86400000);
  expect([days('today'), days('3-days'), days('7-days')]).toEqual([0, 2, 6]);
  // An unknown word in the parameter is today's.
  await b.draw('catchup', { since: 'later' }, 'side');
  expect(b.asked('BrickCatchUp')).toEqual({ since: catchupFrom(now, 'today') });
  expect(bricks.catchup.title({ since: 'today' })).toBe('Catch-up');
  expect(bricks.catchup.sub({ since: '3-days' })).toBe('3 days');
});

it('lists every project\'s moved tickets newest first as chips, with what moved each, an agent\'s update with its agent', async () => {
  b.answer(data());
  await b.draw('catchup', { since: 'today' }, 'primary');
  expect(b.placed()).toEqual([
    { brick: 'catchup', params: { since: '3-days' } }, { brick: 'catchup', params: { since: '7-days' } },
    chip('t-1'), chip('t-2'), chip('t-3'), { brick: 'project', params: { project: 'garden' } },
    chip('t-5'), { brick: 'agent', params: { agent: 'fern' } }, { brick: 'project', params: { project: 'pond' } },
  ]);
  for (const shown of ['5 tickets moved today', 'Garden', 'Completed', 'Work started', 'sam · Broad beans, not runners.', 'Pond', 'Pump arrived.', 'More moved in Garden'])
    expect(b.all(), shown).toContain(shown);
  // A removed project is left out, as on the desktop; the fourth of a project waits behind its project's chip.
  for (const hidden of ['Gone', 'Net the brassicas']) expect(b.all(), hidden).not.toContain(hidden);
  expect(b.controls()).toEqual([]);
  await b.draw('catchup', { since: 'today' }, 'side');
  expect(b.placed().filter((p) => p.brick === 'ticket')).toEqual([chip('t-1'), chip('t-5'), chip('t-2'), chip('t-3'), chip('t-4')]);
  expect(b.all()).toContain('Garden · Completed');
  await b.draw('catchup', { since: 'today' }, 'compact');
  b.oneLine();
  expect(b.all()).toBe('5 tickets moved today in 2 projects');
});

it('says each choice of time in its own words, and offers the other two as chips', async () => {
  b.answer(data());
  await b.draw('catchup', { since: '3-days' }, 'compact');
  expect(b.all()).toBe('5 tickets moved in 3 days in 2 projects');
  await b.draw('catchup', { since: '7-days' }, 'primary');
  expect(b.all()).toContain('5 tickets moved in 7 days');
  expect(b.placed().filter((p) => p.brick === 'catchup')).toEqual([{ brick: 'catchup', params: { since: 'today' } }, { brick: 'catchup', params: { since: '3-days' } }]);
});

it('says so when nothing moved, while it loads, when it is unavailable, and shows the tickets when only the updates fail', async () => {
  b.answer(data({ BrickCatchUp: { projects: [{ ...projects[1] }] }, BrickCatchUpPosts: { projectActivityHighlights: [] } }));
  await b.draw('catchup', { since: 'today' }, 'side');
  expect(b.all()).toBe('No ticket you can read has changed today.');
  await b.draw('catchup', { since: '7-days' }, 'compact');
  expect(b.all()).toBe('Nothing moved in 7 days');
  b.answer(data({ BrickCatchUp: undefined }));
  await b.draw('catchup', { since: 'today' }, 'side');
  expect(b.all()).toBe('Loading…');
  b.answer(data({ BrickCatchUp: { projects: null } }));
  await b.draw('catchup', { since: 'today' }, 'side');
  expect(b.all()).toBe('The catch-up is unavailable.');
  b.answer(data({ BrickCatchUpPosts: { projectActivityHighlights: null } }));
  await b.draw('catchup', { since: 'today' }, 'primary');
  expect(b.all()).toContain('Agent updates are unavailable.');
  expect(b.all()).toContain('4 tickets moved today');
  expect(b.all()).not.toContain('Pump arrived.');
});
