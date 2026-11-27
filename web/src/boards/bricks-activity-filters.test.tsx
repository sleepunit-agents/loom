/** The `activity` brick's filters (docs/specs/boards.md, "The first bricks"): Activity's own three groups and its
 * own rule, as buttons in the big form. Which are on is the drawn brick's state; nothing is sent or told. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';

await loadBricks();
const b = bench(feed);
afterEach(b.after);

const may = { allowed: true, agents: ['art', 'bo'], owner: 'Sam', timezone: 'America/Chicago', today: '2026-11-13', expires: 0, windows: ['2026-11-13'] };
const entry = (id: string, at: string, over: object = {}) => ({ id, agent: 'art', at, day: at.slice(0, 10), hour: 11, title: id, line: null, venue: 'terminal', where: 'Terminal', what: 'conversation', owner: null, expires: null, ...over });
const entries = [
  entry('Pump fixed', '2026-11-13T18:00:00Z', { what: 'work', owner: true }),
  entry('Morning check', '2026-11-13T15:00:00Z', { agent: 'bo', what: 'system', venue: 'wakes', where: 'Wakes' }),
  entry('Talk in the shed', '2026-11-13T14:00:00Z', { agent: 'bo', venue: 'shed', where: 'Shed' }),
];
beforeEach(() => {
  b.before();
  feed.mockImplementation((query: string) => {
    const name = /^query (\w+)/.exec(query)![1];
    if (name === 'MemoryActivityAccess') return { status: 'live', data: { memoryActivityAccess: may } };
    if (name === 'MemoryActivity') return { status: 'live', data: { memoryActivity: { id: 'w', to: '2026-11-13', days: ['2026-11-13', '2026-11-12', '2026-11-11'], earlier: null, entries, conversations: 'available', episodes: 'available', truncated: false, expires: 0 } } };
    return { status: 'live', data: {} };
  });
});
const group = (label: string) => b.root().findAll((n) => n.props.role === 'group' && n.props['aria-label'] === label).flatMap((n) => n.findAllByType('button')).map((x) => [b.said(x), x.props['aria-pressed']]);
const titles = () => entries.map((e) => e.id).filter((title) => b.all().includes(title));

it('offers Activity\'s groups with their counts once opened: who (the agents and the owner), where (its venues and any other seen), what', async () => {
  await b.draw('activity', { days: 1 }, 'primary');
  expect(group('Who')).toEqual([]);
  await b.press('Filter activity');
  expect(group('Who')).toEqual([['art · 1', false], ['bo · 2', false], ['Sam · 1', false]]);
  expect(group('Where')).toEqual([['Comms · 0', false], ['Discord · 0', false], ['shed · 1', false], ['Slack · 0', false], ['Terminal · 1', false], ['Wakes · 1', false]]);
  expect(group('What')).toEqual([['Conversations · 1', false], ['System · 1', false], ['Work done · 1', false]]);
});

it('keeps the entries that pass every group with something chosen, by Activity\'s own rule, and shows everything again', async () => {
  await b.draw('activity', { days: 1 }, 'primary');
  await b.press('Filter activity');
  expect(titles()).toEqual(['Pump fixed', 'Morning check', 'Talk in the shed']);
  await b.press('bo · 2');
  expect(titles()).toEqual(['Morning check', 'Talk in the shed']);
  expect(b.all()).toContain('2 of 3 entries today');
  expect(group('Who')).toContainEqual(['bo · 2', true]);
  await b.press('System · 1');
  expect(titles()).toEqual(['Morning check']);
  // Two of one group: either.
  await b.press('Conversations · 1');
  expect(titles()).toEqual(['Morning check', 'Talk in the shed']);
  // The owner's own entries, whichever agent they were with.
  await b.press('bo · 2'); await b.press('System · 1'); await b.press('Conversations · 1');
  await b.press('Sam · 1');
  expect(titles()).toEqual(['Pump fixed']);
  await b.press('Wakes · 1');
  expect(titles()).toEqual([]);
  expect(b.all()).toContain('Nothing matches these filters.');
  await b.press('Show everything');
  expect(titles()).toEqual(['Pump fixed', 'Morning check', 'Talk in the shed']);
  expect(b.labels()).not.toContain('Show everything');
  expect(b.sent).not.toHaveBeenCalled();
  expect(b.reported).not.toHaveBeenCalled();
});

it('has no filter in the small forms, which show everything', async () => {
  await b.draw('activity', { days: 1 }, 'side');
  expect(b.controls()).toEqual([]);
  expect(titles()).toEqual(['Pump fixed', 'Morning check', 'Talk in the shed']);
  await b.draw('activity', { days: 1 }, 'compact');
  b.oneLine();
  expect(b.all()).toContain('3 entries today');
});
