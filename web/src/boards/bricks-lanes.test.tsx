/** The `lanes` brick's cards and, in its big form, the project's questions and the agents' claims
 * (docs/specs/boards.md, "The first bricks"). A pause or a resume is the desktop's work.setProjectClaims. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, loadBricks } from './bricks';
import { lanesQuery } from './bricks-lanes';
import { bench } from './bricks-work.test.helper';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();

const b = bench(feed);
beforeEach(b.before);
afterEach(b.after);

const cards = [
  { id: 't-1', title: 'Dig', lane: 'Working', reason: 'PR #4 · Draft', assignee: 'art', priority: 1 },
  { id: 't-2', title: 'Sow', lane: 'Waiting', reason: 'Which seed?', assignee: 'sam', priority: 0 },
  { id: 't-3', title: 'Weigh', lane: 'Verifying', reason: null, assignee: null, priority: 3 },
];
const claims = [{ agent: 'art', paused: false, revision: 3, at: '2026-11-20T10:00:00Z' }, { agent: 'fern', paused: true, revision: 7, at: null }];
const data = (over: object = {}) => ({ BrickLanes: { projectBoardTickets: cards }, WorkProjectDecisions: { inboxProjectNeeds: [{ project: 'pond', needs: 9 }, { project: 'garden', needs: 2 }] },
  WorkClaimStates: { projectClaimStates: claims }, ...over });
const card = (id: string) => b.said(b.root().findAll((n) => n.props['data-flip'] === 'tk-' + id)[0]);

it('shows each card with its priority, who has it and why it is waiting', async () => {
  b.answer(data());
  expect(lanesQuery).toContain('assignee priority');
  for (const form of ['primary', 'side'] as const) {
    await b.draw('lanes', { project: 'garden' }, form);
    expect(b.asked('BrickLanes')).toEqual({ project: 'garden' });
    expect(card('t-1'), form).toBe('Digt-1 · P1 · ArtPR #4 · Draft');
    expect(card('t-2'), form).toBe('Sowt-2 · P0 · SamWhich seed?');
    expect(card('t-3'), form).toBe('Weight-3 · P3');
  }
  // The small forms have no tools.
  expect(b.all()).not.toContain('Needs you');
  expect(b.controls()).toEqual([]);
  await b.draw('lanes', { project: 'garden' }, 'compact');
  b.oneLine();
  expect(b.all()).toBe('1 working · 1 verifying · 1 waiting');
  expect(b.controls()).toEqual([]);
  expect(bricks.lanes.title({ project: 'garden' })).toBe('Lanes');
});

it('says in the big form how many of the project\'s questions wait on the member, and nothing when none do', async () => {
  b.answer(data());
  await b.draw('lanes', { project: 'garden' }, 'primary');
  expect(b.all()).toContain('Needs you · 2');
  b.answer(data({ WorkProjectDecisions: { inboxProjectNeeds: [{ project: 'pond', needs: 9 }] }, WorkClaimStates: { projectClaimStates: [] } }));
  await b.draw('lanes', { project: 'garden' }, 'primary');
  expect(b.all()).not.toContain('Needs you');
  expect(b.controls()).toEqual([]);
});

it('pauses and resumes an agent\'s new claims with the desktop\'s operation, asking first, and tells the board only which was done', async () => {
  b.answer(data());
  await b.draw('lanes', { project: 'garden' }, 'primary');
  expect(b.asked('WorkClaimStates')).toEqual({ project: 'garden' });
  expect(b.all()).toContain('New claims enabled');
  expect(b.all()).toContain('New claims paused');
  expect(b.placed()).toEqual(expect.arrayContaining([{ brick: 'agent', params: { agent: 'art' } }, { brick: 'agent', params: { agent: 'fern' } }]));
  expect(b.labels()).toEqual(['Pause…', 'Resume…']);
  // The first press asks; nothing is sent until the member says so.
  await b.press('Pause new claims for Art');
  expect(b.sent).not.toHaveBeenCalled();
  expect(b.labels()).toEqual(['Pause new claims for Art', 'Cancel', 'Resume…']);
  await b.press('Cancel');
  expect(b.sent).not.toHaveBeenCalled();
  await b.press('Pause new claims for Art');
  await b.press('Pause new claims for Art');
  expect(b.sent.mock.calls).toEqual([['/api/work/setProjectClaims', { project: 'garden', agent: 'art', paused: true, expectedRevision: 3 }]]);
  expect(b.reported.mock.calls).toEqual([['pause', {}]]);
  expect(b.labels()).toEqual(['Pause…', 'Resume…']);
  b.sent.mockReset(); b.reported.mockReset();
  await b.press('Resume new claims for Fern');
  await b.press('Resume new claims for Fern');
  expect(b.sent.mock.calls).toEqual([['/api/work/setProjectClaims', { project: 'garden', agent: 'fern', paused: false, expectedRevision: 7 }]]);
  expect(b.reported.mock.calls).toEqual([['resume', {}]]);
});

it('tells the board nothing when the direction did not save, and offers nothing to a member who may not direct claims', async () => {
  b.answer(data());
  await b.draw('lanes', { project: 'garden' }, 'primary');
  b.reply.ok = false;
  await b.press('Pause new claims for Art');
  await b.press('Pause new claims for Art');
  expect(b.sent).toHaveBeenCalledTimes(1);
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.alert()).toBe('The direction could not be saved. Check the current state and try again.');
  // Loom answers no claim states for a project the member may not direct.
  b.answer(data({ WorkClaimStates: { projectClaimStates: [] } }));
  await b.draw('lanes', { project: 'garden' }, 'primary');
  expect(b.controls()).toEqual([]);
});

it('is unavailable when the board cannot be read, and loading until it answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    feed.mockImplementation(() => ({ status: 'denied' }));
    await b.draw('lanes', { project: 'garden' }, form);
    expect(b.all(), form).toBe('This project is unavailable.');
    b.answer({ BrickLanes: undefined });
    await b.draw('lanes', { project: 'garden' }, form);
    expect(b.all(), form).toBe('Loading…');
  }
});
