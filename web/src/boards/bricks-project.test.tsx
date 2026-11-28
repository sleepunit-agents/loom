/** The `project` brick (docs/specs/boards.md, "The first bricks"): goal, lifecycle, the members and agents on it
 * and the repositories its agents' cards name. It reads and has no action. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
const once = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed, useDataOnce: once }));
import { bricks, loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();

const b = bench(feed);
beforeEach(() => { b.before(); once.mockReset(); once.mockImplementation(() => { throw new Error('A one-shot read nobody asked for'); }); });
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
  // Its one control opens the agents' notes; it has no action.
  expect(b.controls()).toHaveLength(1);
  expect(b.labels()).toEqual(["Show the agents' notes"]);
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

// ── The agents' notes, read only once asked for ─────────────────────────────────────────────────────────────────────
const preview = (ref: string, title: string, status = 'fact', when = '2026-11-20T10:00:00Z') => ({ title, ref, when, status });
const memories = (id: string, items: object[], total = items.length, over: object = {}) => ({ id, agent: id.split(':')[0], sections: [
  { key: 'tasks', available: true, error: null, total: 0, items: [] },
  { key: 'memories', available: true, error: null, total, items, ...over },
] });
const notesData = (over: object = {}) => ({
  ...data({ WorkProjectNotes: { workProjectContributions: [
    { id: 'art:garden', agent: 'art', name: 'Garden beds', goal: null, summary: null },
    { id: 'fern:garden', agent: 'fern', name: 'Garden', goal: null, summary: null },
  ] } }),
  BrickProjectNotes: {
    c0: memories('art:garden', [preview('m-1', 'Compost bay — Waiting on timber from the yard.', 'decision'), preview('m-2', 'Bed sizes — Each bed is 1.2 m by 2.4 m.')], 34),
    c1: memories('fern:garden', [preview('m-9', 'Frost dates — Last frost is mid April.', 'fact', '2026-11-21T10:00:00Z')]),
  },
  BrickProjectNote: { note: { id: 'art:m-1', agent: 'art', title: 'Compost bay', content: 'Waiting on **timber** from the yard; it comes Thursday.', category: 'decision', created: '2026-11-20T10:00:00Z' } },
  ...over,
});
/** Every read answered from the same scene, the one-shot ones counted apart. */
const answerAll = (scene: Record<string, unknown>) => {
  b.answer(scene);
  once.mockImplementation((query: string, variables: Record<string, string>) => {
    const name = /^query (\w+)/.exec(query)![1];
    const value = scene[name];
    if (value === 'offline') return { status: 'offline' };
    if (name === 'BrickProjectNote') return { status: 'live', data: (value as { note: { id: string } }).note.id === variables.id ? value : { note: null } };
    return value === undefined ? { status: 'loading' } : { status: 'live', data: value };
  });
};
const onceAsked = (name: string) => once.mock.calls.filter(([query]) => new RegExp(`^query ${name}\\b`).test(query)).map(([, variables]) => variables);
const show = () => b.press("Show the agents' notes");
const find = async (words: string) => { await b.type("Search the agents' notes", words); await b.submit("Search the agents' notes"); };

it('reads nothing of the agents\' notes until the member opens them, and then each card once, in one request', async () => {
  answerAll(notesData());
  await b.draw('project', { project: 'garden' }, 'primary');
  expect(b.labels()).toContain("Show the agents' notes");
  expect(once).not.toHaveBeenCalled();
  expect(b.all()).not.toContain('Compost bay');
  // Not on a small form at all.
  await b.draw('project', { project: 'garden' }, 'side');
  expect(b.labels()).not.toContain("Show the agents' notes");
  await b.draw('project', { project: 'garden' }, 'primary');
  await show();
  expect(onceAsked('BrickProjectNotes')).toEqual([{ c0: 'art:garden', c1: 'fern:garden' }]);
  expect(once.mock.calls[0][0]).toContain('c0:memoryProject(id:$c0){id agent sections{key available error total items{title ref when status}}}');
  // Neither is a live read.
  expect(feed.mock.calls.some(([q]) => /^query BrickProjectNote/.test(q))).toBe(false);
  for (const shown of ['Compost bay — Waiting on timber from the yard.', 'Bed sizes', 'Frost dates', 'decision', "Each agent's latest and most-used notes: 3 of 35 notes."]) expect(b.all(), shown).toContain(shown);
  expect(onceAsked('BrickProjectNote')).toEqual([]);
});

it('searches the notes read on Enter or Search, every word, and opens one note to read it whole', async () => {
  answerAll(notesData());
  await b.draw('project', { project: 'garden' }, 'primary');
  await show();
  const reads = () => new Set(once.mock.calls.map(([query, variables]) => JSON.stringify([query, variables]))).size;
  await b.type("Search the agents' notes", 'frost');
  // Typing alone filters nothing and asks nothing.
  expect(b.all()).toContain('Compost bay');
  await find('frost');
  expect(b.all()).toContain('Frost dates');
  expect(b.all()).not.toContain('Compost bay');
  await find('TIMBER compost');
  expect(b.all()).toContain('Compost bay');
  expect(b.all()).not.toContain('Frost dates');
  // The words reach no read, no request and no act.
  expect(reads()).toBe(1);
  expect(once.mock.calls.flatMap(([, v]) => Object.values(v as object)).some((v) => String(v).includes('compost'))).toBe(false);
  expect(b.sent).not.toHaveBeenCalled();
  expect(b.reported).not.toHaveBeenCalled();
  await b.press('Compost bay — Waiting on timber from the yard.');
  expect(onceAsked('BrickProjectNote')).toEqual([{ id: 'art:m-1' }]);
  expect(b.all()).toContain('it comes Thursday.');
  await b.press('Show every note');
  expect(b.all()).toContain('Frost dates');
});

it('says when no note matches, when there are none it may read, and when the notes or a note cannot be read', async () => {
  answerAll(notesData());
  await b.draw('project', { project: 'garden' }, 'primary');
  await show();
  await find('greenhouse');
  expect(b.all()).toContain('No note matches. Every word must be in its title or its first words.');
  // A card the member may not read answers nothing, and one whose section failed is said.
  answerAll(notesData({ BrickProjectNotes: { c0: null, c1: memories('fern:garden', [], 0, { error: 'Memories are unavailable' }) } }));
  await b.draw('project', { project: 'garden' }, 'primary');
  await show();
  expect(b.all()).toContain('No notes on it that you may read.');
  expect(b.all()).toContain("1 agent's notes could not be read.");
  // The request failing.
  answerAll(notesData({ BrickProjectNotes: 'offline' }));
  await b.draw('project', { project: 'garden' }, 'primary');
  await show();
  expect(b.alert()).toBe("The agents' notes could not be read. Hide them and show them again to try again.");
  // One note failing, and one no longer there.
  answerAll(notesData({ BrickProjectNote: 'offline' }));
  await b.draw('project', { project: 'garden' }, 'primary');
  await show();
  await b.press('Bed sizes — Each bed is 1.2 m by 2.4 m.');
  expect(b.alert()).toBe('This note could not be read. Close it and open it again to try again.');
  answerAll(notesData());
  await b.draw('project', { project: 'garden' }, 'primary');
  await show();
  await b.press('Bed sizes — Each bed is 1.2 m by 2.4 m.');
  expect(b.all()).toContain('This note is no longer there.');
});

it('forgets what was read when the notes are hidden, the brick leaves its big form or its project changes', async () => {
  answerAll(notesData());
  await b.draw('project', { project: 'garden' }, 'primary');
  await show();
  await find('frost');
  await b.press("Hide the agents' notes");
  expect(b.all()).not.toContain('Frost dates');
  await show();
  expect(b.field("Search the agents' notes")!.props.value).toBe('');
  expect(b.all()).toContain('Compost bay');
  // Leaving the big form and coming back: closed again.
  await find('frost');
  await b.redraw('project', { project: 'garden' }, 'side');
  await b.redraw('project', { project: 'garden' }, 'primary');
  expect(b.labels()).toContain("Show the agents' notes");
  expect(b.all()).not.toContain('Frost dates');
  // Another project: closed again.
  await show();
  await b.redraw('project', { project: 'pond' }, 'primary');
  expect(b.labels()).toContain("Show the agents' notes");
  expect(b.all()).not.toContain('Compost bay');
});

it('offers no notes where no agent keeps a card for the project', async () => {
  answerAll(data({ WorkProjectNotes: { workProjectContributions: [] } }));
  await b.draw('project', { project: 'garden' }, 'primary');
  expect(b.labels()).not.toContain("Show the agents' notes");
  expect(once).not.toHaveBeenCalled();
});
