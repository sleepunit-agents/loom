/** The `project` brick (docs/specs/boards.md, "The first bricks"): goal, lifecycle, the members and agents on it
 * and the repositories its agents' cards name. It reads and has no action. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();

const b = bench(feed);
beforeEach(b.before);
afterEach(b.after);

const card = (repos: string[]) => ({ memoryProject: { id: 'art:garden', agent: 'art', agents: ['art'], now: 0, slug: 'garden', name: 'Garden beds', updated: '', activity: '', archived: false, unknown: false,
  card: { slug: 'garden', name: 'Garden beds', status: 'active', summary: null, goal: null, where: [], links: { aliases: null, notes: null, epic: null, repos, venues: null } },
  sections: [], waiting: [], lately: [], people: [], spark: [], changes: null, fields: [] } });
const data = (over: object = {}) => ({
  BrickProject: { project: { name: 'Garden', goal: 'Keep the garden tidy.', lifecycle: 'active', projectMembersByProject: [{ member: 'sam' }, { member: 'kim' }] } },
  WorkProjectNotes: { workProjectContributions: [{ id: 'art:garden', agent: 'art', name: 'Garden beds', goal: 'Raised beds by spring.', summary: 'Two beds are built.' }] },
  WorkClaimStates: { projectClaimStates: [{ agent: 'art', paused: false, revision: 0, at: null }, { agent: 'fern', paused: false, revision: 0, at: null }] },
  MemoryProject: card(['github:Acme/Garden.git', 'acme/garden', 'acme/tools', 'not a repository']),
  ...over,
});
const place = (brick: string, params: object) => ({ brick, params });

it('shows a project\'s goal, lifecycle, the members and agents on it, and its repositories as chips', async () => {
  b.answer(data());
  await b.draw('project', { project: 'garden' }, 'primary');
  expect(b.asked('BrickProject')).toEqual({ id: 'garden' });
  expect(b.asked('WorkProjectNotes')).toEqual({ project: 'garden' });
  expect(b.asked('MemoryProject')).toEqual({ id: 'art:garden' });
  for (const shown of ['Garden', 'Keep the garden tidy.', 'active', 'On it', 'Sam', 'Kim', 'Art', 'Fern', 'Art · Garden beds', 'Raised beds by spring.', 'Two beds are built.']) expect(b.all(), shown).toContain(shown);
  expect(b.placed()).toEqual([
    place('lanes', { project: 'garden' }), place('trend', { project: 'garden', days: 30 }),
    place('person', { person: 'member:sam' }), place('person', { person: 'member:kim' }), place('agent', { agent: 'art' }), place('agent', { agent: 'fern' }),
    // A repository is named as loom writes it, once, in this project; what is not a reference is not a chip.
    place('repository', { repository: 'acme/garden', project: 'garden' }), place('repository', { repository: 'acme/tools', project: 'garden' }),
  ]);
  expect(b.all()).not.toContain('not a repository');
  expect(b.controls()).toEqual([]);
  // The small form has who is on it and no cards or repositories.
  await b.draw('project', { project: 'garden' }, 'side');
  expect(b.placed()).toEqual([place('lanes', { project: 'garden' }), place('trend', { project: 'garden', days: 30 }),
    place('person', { person: 'member:sam' }), place('person', { person: 'member:kim' }), place('agent', { agent: 'art' }), place('agent', { agent: 'fern' })]);
  expect(b.all()).not.toContain('Raised beds');
  await b.draw('project', { project: 'garden' }, 'compact');
  b.oneLine();
  expect(b.all()).toBe('active Garden Keep the garden tidy.');
  expect(b.controls()).toEqual([]);
  expect(bricks.project.title({ project: 'garden' })).toBe('Project');
  expect(b.sent).not.toHaveBeenCalled();
});

it('draws what it may read: no agents, cards or repositories where loom gives none', async () => {
  b.answer({ BrickProject: { project: { name: 'Garden', goal: null, lifecycle: 'retired', projectMembersByProject: [] } }, WorkProjectNotes: { workProjectContributions: [] }, WorkClaimStates: { projectClaimStates: [] } });
  await b.draw('project', { project: 'garden' }, 'primary');
  expect(b.all()).toContain('No goal written.');
  expect(b.all()).toContain('retired');
  expect(b.all()).not.toContain('On it');
  expect(b.placed()).toEqual([place('lanes', { project: 'garden' }), place('trend', { project: 'garden', days: 30 })]);
  // A card that cannot be read gives no repositories and breaks nothing.
  b.answer(data({ MemoryProject: { memoryProject: null } }));
  await b.draw('project', { project: 'garden' }, 'primary');
  expect(b.placed().filter((p) => p.brick === 'repository')).toEqual([]);
  expect(b.all()).toContain('Art · Garden beds');
});

it('is unavailable for a project that is not there or may not be read, and loading until it answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    b.answer({ BrickProject: { project: null } });
    await b.draw('project', { project: 'garden' }, form);
    expect(b.all(), form).toBe('This project is unavailable.');
    b.answer({ BrickProject: undefined });
    await b.draw('project', { project: 'garden' }, form);
    expect(b.all(), form).toBe('Loading…');
  }
});
