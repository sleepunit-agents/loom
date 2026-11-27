/** The `inbox` brick's search (docs/specs/boards.md, "The first bricks"): what the member types is this page's
 * state, sent to the Inbox's own read as the desktop sends it, and never a parameter or a word told to the board. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';

await loadBricks();
const b = bench(feed);
beforeEach(b.before);
afterEach(b.after);

const row = (id: string, words: string) => ({ id, canAnswer: true, source: 'thread', agent: 'art', project: 'pond', at: '2026-11-14T20:00:00Z', state: 'waiting', volume: 'full', answers: 'yes-no', read: true, refs: [], body: { words } });
const folders = { needs: 2, alerts: 0, answered: 0, fyi: 0, all: 2, agents: [] };
const answer = (items: object[]) => b.answer({ Inbox: { inboxItems: items, inboxFolders: folders, inboxActionResults: [] }, InboxApprovals: { approvals: [] }, InboxProposalTitles: { inboxProposalTitles: [] } });

it('sends what is typed to the Inbox\'s read as its search, from the first page, and tells the board nothing', async () => {
  answer([row('in-1', 'Replace the pump filter?'), row('in-2', 'Buy seed?')]);
  await b.draw('inbox', { folder: 'needs' }, 'primary');
  expect(b.asked('Inbox')).toEqual({ folder: 'needs', search: '', agent: null, offset: 0, onlyErrors: false });
  expect(b.field('Search asks')).toBeDefined();
  answer([row('in-1', 'Replace the pump filter?')]);
  await b.type('Search asks', 'pump');
  expect(b.asked('Inbox')).toEqual({ folder: 'needs', search: 'pump', agent: null, offset: 0, onlyErrors: false });
  expect(b.all()).toContain('Replace the pump filter?');
  expect(b.all()).not.toContain('Buy seed?');
  expect(b.field('Search asks')!.props.value).toBe('pump');
  answer([]);
  await b.type('Search asks', 'heron');
  expect(b.all()).toContain('Nothing matches “heron”.');
  expect(b.sent).not.toHaveBeenCalled();
  expect(b.reported).not.toHaveBeenCalled();
});

it('has no search in the small forms or among the member\'s failed actions, and searches for nothing there', async () => {
  answer([row('in-1', 'Replace the pump filter?')]);
  for (const form of ['side', 'compact'] as const) {
    await b.draw('inbox', { folder: 'needs' }, form);
    expect(b.field('Search asks'), form).toBeUndefined();
    expect(b.asked('Inbox')).toMatchObject({ search: '' });
  }
  await b.draw('inbox', { folder: 'errors' }, 'primary');
  expect(b.field('Search asks')).toBeUndefined();
});
