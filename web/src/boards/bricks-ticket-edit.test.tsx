/** The `ticket` brick's facts and its Edit and Links forms (docs/specs/boards.md, "The first bricks"): what is
 * sent is the desktop's tasks.command for each, and the board hears the action and, for a link, its kind. */
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

const ticket = { id: 't-7', title: 'Mend the gate', status: 'open', assignee: null, assigneeKind: null, goal: 'A gate that shuts.', why: 'It swings.', doneWhen: 'It latches.', project: 'garden' };
const more = { ...ticket, description: 'The top hinge is loose.', priority: 2, createdAt: '2026-11-01T10:00:00Z', createdBy: 'sam', closedAt: null, closeReason: null,
  taskLinksByTask: [{ dependsOn: 't-1', type: 'parent-child', dependsOnRow: { id: 't-1', title: 'Fence the garden' } }, { dependsOn: 't-3', type: 'blocks', dependsOnRow: { id: 't-3', title: 'Buy hinges' } },
    // A blocker the member may not read: its row does not come back.
    { dependsOn: 't-99', type: 'blocks', dependsOnRow: null }],
  taskLinksByDependsOn: [{ task: 't-8', type: 'parent-child', taskRow: { id: 't-8', title: 'Oil the latch' } }, { task: 't-5', type: 'blocks', taskRow: { id: 't-5', title: 'Paint the gate' } }] };
const data = (over: object = {}, base: object = {}) => ({
  BrickTicket: { ticket: { ...ticket, ...base } }, BrickTicketMore: { ticket: { ...more, ...base, ...over } }, BrickTicketSessions: { rows: [] },
  TaskChoices: { projects: [{ id: 'garden', name: 'Garden', projectMembersByProject: [] }, { id: 'pond', name: 'Pond', projectMembersByProject: [] }], agents: [], members: [{ id: 'sam' }] },
  WorkViewer: { homeComms: { member: 'sam' } },
  BrickTicketChoices: { tasks: [{ id: 't-1', title: 'Fence the garden' }, { id: 't-3', title: 'Buy hinges' }, { id: 't-7', title: 'Mend the gate' }, { id: 't-9', title: 'Hang the gate' }] },
});
const chip = (id: string) => ({ brick: 'ticket', params: { ticket: id } });

it('shows a ticket with its priority, who filed it and when, and its links as ticket chips, under the heading Ticket', async () => {
  b.answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.asked('BrickTicketMore')).toEqual({ id: 't-7' });
  for (const shown of ['P2', 'Filed by Sam', 'Nov 1', 'The top hinge is loose.', 'Parent', 'Fence the garden', 'Children', 'Oil the latch', 'Blocked by', 'Buy hinges', 'Blocks', 'Paint the gate', 't-99']) expect(b.all(), shown).toContain(shown);
  expect(b.placed()).toEqual(expect.arrayContaining([chip('t-1'), chip('t-8'), chip('t-3'), chip('t-5')]));
  // One the member may not read is its id and no chip.
  expect(b.placed()).not.toContainEqual(chip('t-99'));
  expect(b.all()).not.toContain('Closed');
  await b.draw('ticket', { ticket: 't-7' }, 'side');
  expect(b.placed()).toEqual(expect.arrayContaining([chip('t-1'), chip('t-8'), chip('t-3'), chip('t-5')]));
  expect(b.all()).toContain('P2');
  expect(b.all()).not.toContain('Fence the garden');
  // The small form has the ticket's own actions and no editor.
  expect(b.labels()).toEqual(['Claim', 'Close…']);
  await b.draw('ticket', { ticket: 't-7' }, 'compact');
  b.oneLine();
  expect(b.controls()).toEqual([]);
  expect(bricks.ticket.title({ ticket: 't-7' })).toBe('Ticket');
  expect(b.sent).not.toHaveBeenCalled();
});

it('shows why a closed ticket was closed', async () => {
  b.answer(data({ closeReason: 'The gate was replaced.', closedAt: '2026-11-20T10:00:00Z' }, { status: 'closed' }));
  for (const form of ['primary', 'side'] as const) {
    await b.draw('ticket', { ticket: 't-7' }, form);
    expect(b.all(), form).toContain('The gate was replaced.');
    expect(b.all(), form).toContain('Closed');
  }
});

it('edits a ticket through tasks.command as the desktop form does, and tells the board only that it was edited', async () => {
  b.answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.labels()).toEqual(['Claim', 'Close…', 'Edit…', 'Links…', 'Ask a person…', 'Promote to epic…', 'Show the story']);
  await b.press('Edit…');
  expect(Object.fromEntries(b.fields().map((f) => [f.props['aria-label'], f.props.value]))).toEqual(
    { Title: 'Mend the gate', Goal: 'A gate that shuts.', Why: 'It swings.', 'Done when': 'It latches.', Description: 'The top hinge is loose.' });
  expect(b.root().findAll((n) => n.props['aria-pressed'] === true).map(b.said)).toEqual(['P2']);
  // The project is one of many: a menu that shows the chosen one and opens the rest in place (brick-kit.tsx, Menu).
  expect(b.root().findAll((n) => n.props['aria-haspopup'] === 'listbox').map(b.said)).toEqual(['Garden']);
  await b.type('Title', '  Mend the gate properly  ');
  await b.type('Done when', 'It latches in wind.');
  await b.press('P1');
  await b.press('Garden');
  await b.press('Pond');
  await b.submit('Edit ticket');
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'edit', id: 't-7', input: { title: 'Mend the gate properly', goal: 'A gate that shuts.', why: 'It swings.',
    doneWhen: 'It latches in wind.', description: 'The top hinge is loose.', priority: 1, project: 'pond' } }]]);
  expect(b.reported.mock.calls).toEqual([['edit', {}]]);
  expect(JSON.stringify(b.reported.mock.calls)).not.toContain('properly');
  // The form closes when it saved.
  expect(b.labels()).toContain('Edit…');
  // No project is sent as none.
  b.sent.mockReset();
  await b.press('Edit…');
  await b.press('Garden');
  await b.press('No project');
  await b.submit('Edit ticket');
  expect(b.sent.mock.calls[0][1].input.project).toBeNull();
});

it('does not send an edit that leaves the title, the goal or the why empty, and says what loom said when it refuses', async () => {
  b.answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  await b.press('Edit…');
  for (const label of ['Title', 'Goal', 'Why']) {
    const was = b.field(label)!.props.value;
    await b.type(label, '   ');
    expect(b.button('Save changes')!.props.disabled, label).toBe(true);
    await b.submit('Edit ticket');
    await b.type(label, was);
  }
  expect(b.sent).not.toHaveBeenCalled();
  Object.assign(b.reply, { ok: false, message: 'That project is retired' });
  await b.submit('Edit ticket');
  expect(b.sent).toHaveBeenCalledTimes(1);
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.alert()).toBe('That project is retired');
  // Cancel closes the form and sends nothing more.
  await b.press('Cancel');
  expect(b.fields()).toEqual([]);
  expect(b.sent).toHaveBeenCalledTimes(1);
});

it('links and unlinks a parent and a blocker as the desktop forms do, telling the board the kind of link and no ticket', async () => {
  b.answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  await b.press('Links…');
  // It has a parent: no second one is offered beside it.
  expect(b.field('Parent ticket')).toBeUndefined();
  expect(b.all()).toContain('To change the parent, remove this one first.');
  await b.press('Remove parent t-1');
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'unlink', id: 't-7', dependsOn: 't-1', type: 'parent-child' }]]);
  expect(b.reported.mock.calls).toEqual([['unlink', { type: 'parent-child' }]]);
  b.sent.mockReset(); b.reported.mockReset();
  await b.press('Remove blocker t-3');
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'unlink', id: 't-7', dependsOn: 't-3', type: 'blocks' }]]);
  expect(b.reported.mock.calls).toEqual([['unlink', { type: 'blocks' }]]);
  b.sent.mockReset(); b.reported.mockReset();
  // A blocker is a ticket the member may read that is not this one and not one already blocking it.
  for (const not of ['t-404', 't-7', 't-3', 'buy the hinges today']) {
    await b.type('Blocking ticket', not);
    expect(b.button('Add blocker')!.props.disabled, not).toBe(true);
  }
  await b.type('Blocking ticket', ' t-9 ');
  expect(b.button('Add blocker')!.props.disabled).toBe(false);
  await b.submitNth(0);
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'link', id: 't-7', dependsOn: 't-9', type: 'blocks' }]]);
  expect(b.reported.mock.calls).toEqual([['link', { type: 'blocks' }]]);
  expect(b.field('Blocking ticket')!.props.value).toBe('');
  // With no parent, one is set.
  b.sent.mockReset(); b.reported.mockReset();
  b.answer(data({ taskLinksByTask: [] }));
  await b.redraw('ticket', { ticket: 't-7' }, 'primary');
  await b.type('Parent ticket', 't-1');
  await b.submitNth(0);
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'link', id: 't-7', dependsOn: 't-1', type: 'parent-child' }]]);
  expect(b.reported.mock.calls).toEqual([['link', { type: 'parent-child' }]]);
  await b.press('Done');
  expect(b.labels()).toContain('Links…');
});

it('draws the ticket as before when its further facts cannot be read', async () => {
  b.answer({ BrickTicket: { ticket }, BrickTicketMore: undefined });
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.all()).toContain('Mend the gate');
  expect(b.labels()).toEqual(['Claim', 'Close…']);
  b.answer({ BrickTicket: { ticket: null } });
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.all()).toBe('This ticket is unavailable.');
});
