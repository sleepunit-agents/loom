/** The `new-ticket` brick (docs/specs/boards.md, "The first bricks"): the desktop's Create task form for one
 * project. What is sent is tasks.command `create` with that form's input; the board hears `create` and no words. */
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

const data = {
  BrickNewTicket: { project: { id: 'garden', name: 'Garden', lifecycle: 'active' } },
  TaskChoices: { projects: [{ id: 'garden', name: 'Garden', projectMembersByProject: [{ member: 'kim' }] }], agents: [{ id: 'art', removedAt: null }, { id: 'old', removedAt: '2026-01-01T00:00:00Z' }], members: [{ id: 'sam' }] },
  WorkViewer: { homeComms: { member: 'sam' } },
  BrickTicketChoices: { tasks: [{ id: 't-1', title: 'Fence the garden' }] },
};
const fill = async () => { await b.type('Title', ' Mend the gate '); await b.type('Goal', 'A gate that shuts. '); await b.type('Why', 'It swings.'); };

it('draws its three forms: the whole form big, the three needed fields small, and one line with no controls', async () => {
  b.answer(data);
  await b.draw('new-ticket', { project: 'garden' }, 'primary');
  expect(b.asked('BrickNewTicket')).toEqual({ id: 'garden' });
  expect(b.fields().map((f) => f.props['aria-label'])).toEqual(['Title', 'Goal', 'Why', 'Done when', 'Description', 'Parent ticket']);
  // Priority, type and owner are fixed choices. The owner is the household, a member or an agent in use.
  expect(b.labels()).toEqual(['P0 · most urgent', 'P1', 'P2', 'P3', 'P4 · least urgent', 'Task', 'Bug', 'Feature', 'Epic', 'Household', 'Sam', 'Kim', 'Art', 'File ticket']);
  expect(b.root().findAll((n) => n.props['aria-pressed'] === true).map(b.said)).toEqual(['P2', 'Task', 'Household']);
  expect(b.root().findAllByType('select')).toEqual([]);
  await b.draw('new-ticket', { project: 'garden' }, 'side');
  expect(b.fields().map((f) => f.props['aria-label'])).toEqual(['Title', 'Goal', 'Why']);
  expect(b.labels()).toEqual(['File ticket']);
  await b.draw('new-ticket', { project: 'garden' }, 'compact');
  b.oneLine();
  expect(b.all()).toBe('File a ticket in Garden');
  expect(b.controls()).toEqual([]);
  expect(bricks['new-ticket'].title({ project: 'garden' })).toBe('New ticket');
  expect(bricks['new-ticket'].sub({ project: 'garden' })).toBe('garden');
});

it('is unavailable for a project that is not there or may not be read, and loading until it answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    b.answer({ BrickNewTicket: { project: null } });
    await b.draw('new-ticket', { project: 'garden' }, form);
    expect(b.all(), form).toBe('This project is unavailable.');
    expect(b.controls()).toEqual([]);
    b.answer({ BrickNewTicket: undefined });
    await b.draw('new-ticket', { project: 'garden' }, form);
    expect(b.all(), form).toBe('Loading…');
  }
  expect(b.sent).not.toHaveBeenCalled();
});

it('files a ticket from the small form with the desktop form\'s defaults, offers it as a chip and clears', async () => {
  b.answer(data);
  await b.draw('new-ticket', { project: 'garden' }, 'side');
  expect(b.button('File ticket')!.props.disabled).toBe(true);
  await b.submit('File a ticket');
  expect(b.sent).not.toHaveBeenCalled();
  await fill();
  expect(b.button('File ticket')!.props.disabled).toBe(false);
  b.reply.value = { id: 't-42' };
  await b.submit('File a ticket');
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'create', input: { title: 'Mend the gate', goal: 'A gate that shuts.', why: 'It swings.', doneWhen: '', description: '',
    priority: 2, project: 'garden', type: 'task', owner: { kind: 'household' } } }]]);
  expect(b.reported.mock.calls).toEqual([['create', {}]]);
  expect(b.placed()).toEqual([{ brick: 'ticket', params: { ticket: 't-42' } }]);
  expect(b.all()).toContain('Filed');
  expect(b.fields().map((f) => f.props.value)).toEqual(['', '', '']);
});

it('files a ticket from the big form with every field, and tells the board nothing that was typed or chosen', async () => {
  b.answer(data);
  await b.draw('new-ticket', { project: 'garden' }, 'primary');
  await fill();
  await b.type('Done when', 'It latches.');
  await b.type('Description', 'The top hinge is loose.');
  await b.press('P0 · most urgent');
  await b.press('Bug');
  await b.press('Art');
  // A parent is a ticket the member may read.
  await b.type('Parent ticket', 't-404');
  expect(b.button('File ticket')!.props.disabled).toBe(true);
  await b.type('Parent ticket', 't-1');
  await b.submit('File a ticket');
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'create', input: { title: 'Mend the gate', goal: 'A gate that shuts.', why: 'It swings.', doneWhen: 'It latches.',
    description: 'The top hinge is loose.', priority: 0, project: 'garden', type: 'bug', owner: { kind: 'agent', id: 'art' }, parent: 't-1' } }]]);
  expect(b.reported.mock.calls).toEqual([['create', {}]]);
  expect(b.root().findAll((n) => n.props['aria-pressed'] === true).map(b.said)).toEqual(['P2', 'Task', 'Household']);
  expect(b.field('Parent ticket')!.props.value).toBe('');
  // A member as owner is sent as that member.
  b.sent.mockReset();
  await fill();
  await b.press('Kim');
  await b.submit('File a ticket');
  expect(b.sent.mock.calls[0][1].input.owner).toEqual({ kind: 'member', id: 'kim' });
});

it('keeps what was typed and tells the board nothing when loom refuses the ticket', async () => {
  b.answer(data);
  await b.draw('new-ticket', { project: 'garden' }, 'side');
  await fill();
  Object.assign(b.reply, { ok: false, message: 'This project is retired' });
  await b.submit('File a ticket');
  expect(b.sent).toHaveBeenCalledTimes(1);
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.alert()).toBe('This project is retired');
  expect(b.field('Title')!.props.value).toBe(' Mend the gate ');
  expect(b.placed()).toEqual([]);
});
