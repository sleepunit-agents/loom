/** The `projects` brick (docs/specs/boards.md, "The first bricks"): the project directory, each project a row that
 * places its `project` brick, searched in the big form on Enter or Search over what loom already sent. The data hook
 * is a fake answering by query name, so what is checked is the read asked and what is drawn from its answer. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';
import { PROJECTS_SHOWN } from './bricks-projects';

await loadBricks();

const b = bench(feed);
beforeEach(b.before);
afterEach(b.after);

const row = (id: string, name: string, over: object = {}) => ({ id, name, goal: null, lifecycle: 'active', ...over });
const garden = row('garden', 'Garden', { goal: 'Raised **beds** by spring.' });
const pond = row('pond', 'Pond', { goal: 'Keep the pump running.', lifecycle: 'retired' });
const shed = row('shed', 'Shed roof');
const place = (project: string) => ({ brick: 'project', params: { project } });
const search = async (words: string) => { await b.type('Search projects', words); await b.submit('Search projects'); };

it('lists every project the read answers, by name, each a row that places its project brick', async () => {
  b.answer({ BrickProjects: { projects: [garden, pond, shed] } });
  await b.draw('projects', {}, 'primary');
  // One read, the desktop's Work directory ordered by name, with no variables and nothing about who is asking.
  expect(b.asked('BrickProjects')).toBeUndefined();
  const query = feed.mock.calls.find(([q]) => /^query BrickProjects\b/.test(q))![0] as string;
  expect(query).toContain('projects(orderBy:{name:{direction:asc,priority:1},id:{direction:asc,priority:0}},limit:201)');
  expect(feed.mock.calls.every(([q]) => /^query BrickProjects\b/.test(q))).toBe(true);
  for (const shown of ['3 projects · 2 active', 'Garden', 'Raised beds by spring.', 'Pond', 'retired', 'Shed roof']) expect(b.all(), shown).toContain(shown);
  expect(b.placed()).toEqual([place('garden'), place('pond'), place('shed')]);
  expect(bricks.projects.title({})).toBe('Projects');
  // The small form lists them with no goal and no search; the compact is one line of counts.
  await b.draw('projects', {}, 'side');
  expect(b.placed()).toEqual([place('garden'), place('pond'), place('shed')]);
  expect(b.all()).not.toContain('Raised beds');
  expect(b.field('Search projects')).toBeUndefined();
  await b.draw('projects', {}, 'compact');
  b.oneLine();
  expect(b.all()).toBe('3 projects · 2 active');
  expect(b.sent).not.toHaveBeenCalled();
  expect(b.reported).not.toHaveBeenCalled();
});

it('shows a member who is not a household owner the projects loom answers them, with no owner-only read', async () => {
  // loom answers a member only the projects they are in (src/policy.ts, rules.project); the brick adds no gate of its own.
  b.answer({ BrickProjects: { projects: [pond] } });
  for (const form of ['primary', 'side'] as const) {
    await b.draw('projects', {}, form);
    expect(b.all(), form).toContain('Pond');
    expect(b.placed(), form).toEqual([place('pond')]);
    expect(feed.mock.calls.some(([q]) => /householdSharing|Access/.test(q)), form).toBe(false);
  }
  b.answer({ BrickProjects: { projects: [] } });
  await b.draw('projects', {}, 'primary');
  expect(b.all()).toContain('No projects you may read yet.');
});

it('searches on Enter or Search, not as the member types, every word in a name or goal; the words go nowhere', async () => {
  b.answer({ BrickProjects: { projects: [garden, pond, shed] } });
  await b.draw('projects', {}, 'primary');
  const calls = feed.mock.calls.length;
  await b.type('Search projects', 'pump');
  // Typing alone filters nothing.
  expect(b.placed()).toEqual([place('garden'), place('pond'), place('shed')]);
  await search('pump');
  expect(b.placed()).toEqual([place('pond')]);
  await search('ROOF shed');
  expect(b.placed()).toEqual([place('shed')]);
  await search('garden pump');
  expect(b.placed()).toEqual([]);
  expect(b.all()).toContain('No project matches. Every word must be in its name or goal.');
  // The words reach no read, no request and no act.
  expect(feed.mock.calls.slice(calls).every(([, variables]) => variables === undefined)).toBe(true);
  expect(b.sent).not.toHaveBeenCalled();
  expect(b.reported).not.toHaveBeenCalled();
  await b.press('Show every project');
  expect(b.placed()).toEqual([place('garden'), place('pond'), place('shed')]);
  expect(b.field('Search projects')!.props.value).toBe('');
});

it('is bounded: past the first 200 by name it says so', async () => {
  const many = Array.from({ length: PROJECTS_SHOWN + 1 }, (_, i) => row(`p-${String(i).padStart(3, '0')}`, `Project ${String(i).padStart(3, '0')}`));
  b.answer({ BrickProjects: { projects: many } });
  await b.draw('projects', {}, 'primary');
  expect(b.placed()).toHaveLength(PROJECTS_SHOWN);
  expect(b.all()).toContain('200+ projects');
  expect(b.all()).toContain('The first 200 by name are listed, and only they are searched.');
});

it('lists a project whose id a board cannot hold with no chip', async () => {
  b.answer({ BrickProjects: { projects: [row('not a ref', 'Odd one'), garden] } });
  await b.draw('projects', {}, 'primary');
  expect(b.all()).toContain('Odd one');
  expect(b.placed()).toEqual([place('garden')]);
});

it('is unavailable when the read fails, and loading until it answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    b.answer({ BrickProjects: { projects: null } });
    await b.draw('projects', {}, form);
    expect(b.all(), form).toBe('This project directory is unavailable.');
    b.answer({ BrickProjects: undefined });
    await b.draw('projects', {}, form);
    expect(b.all(), form).toBe('Loading…');
  }
});
