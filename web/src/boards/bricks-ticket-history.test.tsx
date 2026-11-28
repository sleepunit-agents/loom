/** The `ticket` brick's history (./bricks-ticket-history.tsx): its pull requests as `pull` chips, where it was
 * filed from, and its reviews and story, each read only once the member opens it, a page at a time, and never as a
 * live read. The data hooks are fakes: the live one answers by query name, and the one-shot one answers the same way
 * and is counted apart, so what is checked is which read is asked, how, and when. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
const once = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed, useDataOnce: once }));
import { loadBricks } from './bricks';
import { bench, type Data } from './bricks-work.test.helper';

await loadBricks();

const b = bench(feed);
beforeEach(() => { b.before(); once.mockReset(); });
afterEach(b.after);
/** Every read answered from the same scene; the one-shot reads are also counted by `onceAsked`. */
const answer = (data: Data) => { b.answer(data); once.mockImplementation((...args: unknown[]) => feed.getMockImplementation()!(...args)); };
const onceAsked = (name: string) => once.mock.calls.filter(([query]) => new RegExp(`^query ${name}\\b`).test(query)).map(([, variables]) => variables);
const liveAsked = (name: string) => feed.mock.calls.filter(([query]) => new RegExp(`^query ${name}\\b`).test(query)).map(([, variables]) => variables);

const ticket = { id: 't-7', title: 'Mend the gate', status: 'open', assignee: null, assigneeKind: null, goal: 'A gate that shuts.', why: 'It swings.', doneWhen: null, project: 'garden' };
const pr12 = { id: 'github:acme/app#12', number: 12, title: 'Oil the hinge', state: 'open', draft: false };
const pr13 = { id: 'github:acme/app#13', number: 13, title: 'Swap the latch', state: 'merged', draft: false };
const more = { ...ticket, description: null, priority: 2, createdAt: '2026-11-01T10:00:00Z', createdBy: 'sam', closedAt: null, closeReason: null,
  taskLinksByTask: [], taskLinksByDependsOn: [], sourceKind: null, sourceId: null,
  // A link to a pull request the member may not read comes back with no row.
  changeTasksByTask: [{ changeRow: pr12 }, { changeRow: pr13 }, { changeRow: null }] };
const post = (n: number) => ({ task: 't-7', id: `p-${n}`, at: new Date(Date.parse('2026-11-20T10:00:00Z') - n * 60000).toISOString(), agent: 'art', thread: 'at-1', words: `Post number ${n}.` });
const github = (n: number) => ({ id: `g-${n}`, change: pr12.id, login: 'fern', submittedAt: new Date(Date.parse('2026-11-20T10:00:00Z') - n * 60000).toISOString(), state: 'APPROVED', headCommit: 'b'.repeat(40), body: `Review body ${n}.`, url: `https://github.com/acme/app/pull/12#review-${n}` });
const round = { change: pr12.id, job: 'j-1', headCommit: 'c'.repeat(40), tier: 'standard', round: 1, requestedAt: '2026-11-19T10:00:00Z', completedAt: '2026-11-19T11:00:00Z', verdict: 'BLOCKING', findings: 'The hinge pin is missing.' };
const data = (over: object = {}, reads: Data = {}): Data => ({
  BrickTicket: { ticket }, BrickTicketMore: { ticket: { ...more, ...over } }, BrickTicketSessions: { rows: [] },
  BrickTicketPosts: { posts: [post(1), post(2)] }, BrickTicketRounds: { rounds: [round] }, BrickTicketGithubReviews: { reviews: [github(1)] },
  ...reads,
});
const pull = (id: string) => ({ brick: 'pull', params: { change: id } });

it('shows its pull requests as pull chips: big, with title and state; small, by number; asked with the ticket itself', async () => {
  answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.placed()).toEqual(expect.arrayContaining([pull(pr12.id), pull(pr13.id)]));
  for (const shown of ['Pull requests', '#12', 'Oil the hinge', 'open', '#13', 'Swap the latch', 'merged']) expect(b.all(), shown).toContain(shown);
  // No read of its own: the ticket's read carries them.
  expect(liveAsked('BrickTicketMore').length).toBeGreaterThan(0);
  expect(feed.mock.calls.find(([q]) => /^query BrickTicketMore\b/.test(q))![0]).toContain('changeTasksByTask{changeRow{id number title state draft}}');
  await b.draw('ticket', { ticket: 't-7' }, 'side');
  expect(b.placed()).toEqual(expect.arrayContaining([pull(pr12.id), pull(pr13.id)]));
  expect(b.all()).toContain('#12');
  expect(b.all()).not.toContain('Oil the hinge');
  await b.draw('ticket', { ticket: 't-7' }, 'compact');
  b.oneLine();
  expect(b.placed()).toEqual([]);
});

it('draws a pull request whose id a board cannot hold as its number alone, and says nothing of pull requests when it has none', async () => {
  answer(data({ changeTasksByTask: [{ changeRow: { ...pr12, id: 'gitlab:acme/app#12' } }] }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.all()).toContain('#12');
  expect(b.placed().filter((p) => p.brick === 'pull')).toEqual([]);
  answer(data({ changeTasksByTask: [{ changeRow: null }] }));
  for (const form of ['primary', 'side'] as const) {
    await b.draw('ticket', { ticket: 't-7' }, form);
    expect(b.all(), form).not.toContain('Pull requests');
    // With no pull request the member may read there are no reviews to open, as on the desktop.
    expect(b.labels(), form).not.toContain('Reviews');
  }
});

it('links the conversation it was filed from, asked once and only where the ticket names one', async () => {
  answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(onceAsked('BrickTicketSource')).toEqual([]);
  expect(b.all()).not.toContain('Filed from');
  answer(data({ sourceKind: 'conversation', sourceId: 'cv-1' }, { BrickTicketSource: { source: { id: 'cv-1', venue: 'loom', place: 'th:abc' } } }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(onceAsked('BrickTicketSource').at(-1)).toEqual({ id: 'cv-1' });
  expect(liveAsked('BrickTicketSource')).toEqual([]);
  expect(b.root().findAllByType('a').map((a) => [a.props.href, b.said(a)])).toEqual([['/app/t/th%3Aabc', 'Open the conversation it was filed from']]);
  // A handed-off session is a session chip; any other venue is named.
  answer(data({ sourceKind: 'conversation', sourceId: 'cv-2' }, { BrickTicketSource: { source: { id: 'cv-2', venue: 'handoff', place: 'h-1' } } }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.placed()).toContainEqual({ brick: 'session', params: { session: 'cv-2' } });
  answer(data({ sourceKind: 'conversation', sourceId: 'cv-3' }, { BrickTicketSource: { source: { id: 'cv-3', venue: 'discord', place: 'x' } } }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.all()).toContain('A conversation on discord');
  // One the member may not read, or one still loading, is not drawn; nor is it in a small form.
  for (const source of [{ source: null }, undefined]) {
    answer(data({ sourceKind: 'conversation', sourceId: 'cv-1' }, { BrickTicketSource: source }));
    await b.draw('ticket', { ticket: 't-7' }, 'primary');
    expect(b.all()).not.toContain('Filed from');
  }
  answer(data({ sourceKind: 'conversation', sourceId: 'cv-1' }, { BrickTicketSource: { source: { id: 'cv-1', venue: 'loom', place: 'th:abc' } } }));
  once.mockClear();
  await b.draw('ticket', { ticket: 't-7' }, 'side');
  expect(onceAsked('BrickTicketSource')).toEqual([]);
});

it('reads its story only when the member opens it, once and not live, and hides it again', async () => {
  answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.all()).toContain('Story');
  expect(onceAsked('BrickTicketPosts')).toEqual([]);
  expect(b.all()).not.toContain('Post number 1.');
  await b.press('Story');
  expect(onceAsked('BrickTicketPosts').at(-1)).toEqual({ task: 't-7', before: '0' });
  expect(liveAsked('BrickTicketPosts')).toEqual([]);
  expect(b.all()).toContain('Post number 1.');
  expect(b.all()).toContain('Post number 2.');
  expect(b.placed()).toContainEqual({ brick: 'agent', params: { agent: 'art' } });
  // Two posts are one page: nothing older to ask for.
  expect(b.labels()).not.toContain('Older posts');
  await b.press('Story');
  expect(b.all()).not.toContain('Post number 1.');
  // No small form has it.
  once.mockClear();
  await b.draw('ticket', { ticket: 't-7' }, 'side');
  expect(b.labels()).not.toContain('Story');
  expect(onceAsked('BrickTicketPosts')).toEqual([]);
});

it('says while its story loads, when it is empty and when it cannot be read', async () => {
  for (const [posts, words] of [[undefined, 'Loading…'], [{ posts: [] }, 'No agent has posted about this ticket.'], ['offline', 'Its story is unavailable.']] as const) {
    answer(data({}, { BrickTicketPosts: posts === 'offline' ? undefined : posts }));
    if (posts === 'offline') once.mockImplementation(() => ({ status: 'offline' }));
    await b.draw('ticket', { ticket: 't-7' }, 'primary');
    await b.press('Story');
    expect(b.all(), String(words)).toContain(words);
  }
});

it('pages its story thirty at a time: the thirty-first read says there is more, and Older posts asks for the next page once', async () => {
  const first = Array.from({ length: 31 }, (_, i) => post(i + 1)), second = [post(31), post(32)];
  b.answer(data());
  once.mockImplementation((query: string, variables: { before?: string }) => (/BrickTicketPosts/.test(query)
    ? { status: 'live', data: { posts: variables.before === '0' ? first : second } } : { status: 'loading' }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  await b.press('Story');
  expect(b.all()).toContain('Post number 30.');
  expect(b.all()).not.toContain('Post number 31.');
  await b.press('Older posts');
  expect(onceAsked('BrickTicketPosts').at(-1)).toEqual({ task: 't-7', before: 'p-30' });
  expect(b.all()).toContain('Post number 30.');
  expect(b.all()).toContain('Post number 32.');
  expect(b.labels()).not.toContain('Older posts');
});

it('reads its reviews, loom\'s and GitHub\'s, only when the member opens them, once and not live', async () => {
  answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(onceAsked('BrickTicketRounds')).toEqual([]);
  expect(onceAsked('BrickTicketGithubReviews')).toEqual([]);
  await b.press('Reviews');
  expect(onceAsked('BrickTicketRounds').at(-1)).toEqual({ task: 't-7' });
  expect(onceAsked('BrickTicketGithubReviews').at(-1)).toEqual({ task: 't-7', at: null, id: null });
  expect(liveAsked('BrickTicketRounds')).toEqual([]);
  expect(liveAsked('BrickTicketGithubReviews')).toEqual([]);
  for (const shown of ['Round 1 · #12 · cccccccc', 'Blocking', 'The hinge pin is missing.', 'fern', 'approved', 'Review body 1.']) expect(b.all(), shown).toContain(shown);
  expect(b.root().findAllByType('a').map((a) => [a.props.href, a.props.target, b.said(a)])).toEqual([[github(1).url, '_blank', 'Open on GitHub']]);
  await b.press('Reviews');
  expect(b.all()).not.toContain('The hinge pin is missing.');
});

it('says while its reviews load, when there are none, and when they cannot be read', async () => {
  answer(data({}, { BrickTicketRounds: undefined, BrickTicketGithubReviews: undefined }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  await b.press('Reviews');
  expect(b.all().match(/Loading…/g)?.length).toBe(2);
  answer(data({}, { BrickTicketRounds: { rounds: [{ ...round, change: 'github:acme/other#1' }] }, BrickTicketGithubReviews: { reviews: [] } }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  await b.press('Reviews');
  // A round for a pull request not among the ones shown is left out, as on the desktop.
  expect(b.all()).toContain('Loom has not reviewed its pull requests.');
  expect(b.all()).toContain('No one has reviewed its pull requests on GitHub.');
  answer(data());
  once.mockImplementation(() => ({ status: 'offline' }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  await b.press('Reviews');
  expect(b.all()).toContain("Loom's reviews are unavailable.");
  expect(b.all()).toContain("GitHub's reviews are unavailable.");
});

it('pages GitHub reviews by when they were submitted and their id, and links only to GitHub', async () => {
  const first = Array.from({ length: 31 }, (_, i) => github(i + 1));
  b.answer(data());
  once.mockImplementation((query: string, variables: { id?: string | null }) => (/BrickTicketGithubReviews/.test(query)
    ? { status: 'live', data: { reviews: variables.id === null ? first : [{ ...github(40), url: 'https://example.com/x' }] } }
    : /BrickTicketRounds/.test(query) ? { status: 'live', data: { rounds: [] } } : { status: 'loading' }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  await b.press('Reviews');
  expect(b.all()).toContain('Review body 30.');
  expect(b.all()).not.toContain('Review body 31.');
  await b.press('Older GitHub reviews');
  expect(onceAsked('BrickTicketGithubReviews').at(-1)).toEqual({ task: 't-7', at: github(30).submittedAt, id: 'g-30' });
  expect(b.all()).toContain('Review body 40.');
  expect(b.root().findAllByType('a').map((a) => a.props.href)).not.toContain('https://example.com/x');
  expect(b.labels()).not.toContain('Older GitHub reviews');
});
