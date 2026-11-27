/** The ticket picker inside a brick (./ticket-picker.tsx), and the `ticket` brick's Ask a person and Promote to
 * epic (docs/specs/boards.md, "The first bricks"). What is typed to find a ticket stays on the page. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { loadBricks } from './bricks';
import { ticketMoreQuery } from './bricks-ticket-edit';
import { bench } from './bricks-work.test.helper';
import { pickerResults, ticketMatches } from './ticket-picker';

await loadBricks();
const b = bench(feed);
beforeEach(b.before);
afterEach(b.after);

const ticket = { id: 't-7', title: 'Mend the gate', status: 'open', assignee: null, assigneeKind: null, goal: 'A gate that shuts.', why: 'It swings.', doneWhen: 'It latches.', project: 'garden' };
const more = { ...ticket, type: 'task', description: '', priority: 2, ask: null, ifYes: null, ifNo: null, createdAt: '2026-11-01T10:00:00Z', createdBy: 'sam', closedAt: null, closeReason: null,
  taskLinksByTask: [{ dependsOn: 't-3', type: 'blocks', dependsOnRow: { id: 't-3', title: 'Buy hinges' } }], taskLinksByDependsOn: [] };
const tasks = [{ id: 't-1', title: 'Fence the garden' }, { id: 't-3', title: 'Buy hinges' }, { id: 't-7', title: 'Mend the gate' }, { id: 't-9', title: 'Hang the gate' }, { id: 't-10', title: 'Oil the garden gate' }];
const data = (over: object = {}, base: object = {}) => ({
  BrickTicket: { ticket: { ...ticket, ...base } }, BrickTicketMore: { ticket: { ...more, ...base, ...over } }, BrickTicketSessions: { rows: [] },
  TaskChoices: { projects: [{ id: 'garden', name: 'Garden', projectMembersByProject: [{ member: 'ada' }] }], agents: [{ id: 'art' }], members: [{ id: 'sam' }] },
  WorkViewer: { homeComms: { member: 'sam' } }, BrickTicketChoices: { tasks },
});
const found = (label: string) => b.root().findAll((n) => n.props.role === 'group' && n.props['aria-label'] === `${label}: tickets found`).flatMap((n) => n.findAllByType('button')).map(b.said);

it('finds tickets by every word typed, in any case, in the title or the id, as the desktop\'s task search does', () => {
  expect(ticketMatches(tasks, 'GATE garden').map((t) => t.id)).toEqual(['t-10']);
  expect(ticketMatches(tasks, 'gate').map((t) => t.id)).toEqual(['t-7', 't-9', 't-10']);
  expect(ticketMatches(tasks, 't-1').map((t) => t.id)).toEqual(['t-1', 't-10']);
  expect(ticketMatches(tasks, '   ')).toEqual([]);
  expect(ticketMatches(tasks, 'heron')).toEqual([]);
  expect(pickerResults).toBe(6);
});

it('links a ticket chosen from what a typed title finds: not this ticket, not one already linked, and the words go nowhere', async () => {
  b.answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  await b.press('Links…');
  expect(found('Blocking ticket')).toEqual([]);
  await b.type('Blocking ticket', 'the gate');
  // Words with a space stay as typed; this ticket and its blocker are not offered.
  expect(b.field('Blocking ticket')!.props.value).toBe('the gate');
  expect(found('Blocking ticket')).toEqual(['Hang the gate · t-9', 'Oil the garden gate · t-10']);
  expect(b.button('Add blocker')!.props.disabled).toBe(true);
  await b.type('Blocking ticket', 'hinges');
  expect(found('Blocking ticket')).toEqual([]);
  expect(b.all()).toContain('No ticket matches.');
  await b.type('Blocking ticket', 'the gate');
  await b.press('Hang the gate · t-9');
  expect(b.field('Blocking ticket')!.props.value).toBe('t-9');
  expect(found('Blocking ticket')).toEqual([]);
  expect(b.button('Add blocker')!.props.disabled).toBe(false);
  expect(b.sent).not.toHaveBeenCalled();
  await b.submitNth(1);
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'link', id: 't-7', dependsOn: 't-9', type: 'blocks' }]]);
  expect(b.reported.mock.calls).toEqual([['link', { type: 'blocks' }]]);
  expect(JSON.stringify(b.reported.mock.calls)).not.toContain('gate');
  // The parent is chosen the same way.
  b.sent.mockReset(); b.reported.mockReset();
  await b.type('Parent ticket', 'fence');
  expect(found('Parent ticket')).toEqual(['Fence the garden · t-1']);
  await b.press('Fence the garden · t-1');
  await b.submitNth(0);
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'link', id: 't-7', dependsOn: 't-1', type: 'parent-child' }]]);
});

it('asks a person as the desktop form does: a member, the question, what yes and no mean, and how it is answered', async () => {
  expect(ticketMoreQuery).toContain('type');
  b.answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  await b.press('Ask a person…');
  // Members only: an agent is not asked through a ticket.
  const people = b.root().findAll((n) => n.props.role === 'group' && n.props['aria-label'] === 'Person')[0].findAllByType('button').map(b.said);
  expect(people).toEqual(['Sam', 'Ada']);
  expect(b.button('Ask')!.props.disabled).toBe(true);
  await b.type('Question', '  Brass or steel hinges?  ');
  await b.type('If yes', 'Brass');
  await b.type('If no', 'Steel');
  expect(b.button('Ask')!.props.disabled).toBe(true);
  await b.press('Ada');
  expect(b.button('Ask')!.props.disabled).toBe(false);
  await b.press('In words');
  await b.submit('Ask a person');
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'ask', id: 't-7', input: { to: { kind: 'member', id: 'ada' }, ask: 'Brass or steel hinges?', ifYes: 'Brass', ifNo: 'Steel', answers: 'words' } }]]);
  expect(b.reported.mock.calls).toEqual([['ask', {}]]);
  expect(b.labels()).toContain('Ask a person…');
  // A refusal is said in loom's words and tells the board nothing.
  b.sent.mockReset(); b.reported.mockReset();
  await b.press('Ask a person…');
  await b.type('Question', 'Q'); await b.type('If yes', 'Y'); await b.type('If no', 'N'); await b.press('Sam');
  Object.assign(b.reply, { ok: false, message: 'Only its owner asks' });
  await b.submit('Ask a person');
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.alert()).toBe('Only its owner asks');
  // A closed ticket asks nobody.
  b.answer(data({}, { status: 'closed' }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.labels()).not.toContain('Ask a person…');
});

it('promotes a ticket to an epic only after asking, by an edit of its type alone, and offers it to no epic', async () => {
  b.answer(data());
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  await b.press('Promote to epic…');
  expect(b.sent).not.toHaveBeenCalled();
  await b.press('Cancel');
  expect(b.sent).not.toHaveBeenCalled();
  await b.press('Promote to epic…');
  await b.press('Make this ticket an epic');
  expect(b.sent.mock.calls).toEqual([['/api/tasks/command', { action: 'edit', id: 't-7', input: { type: 'epic' } }]]);
  expect(b.reported.mock.calls).toEqual([['promote', {}]]);
  b.answer(data({ type: 'epic' }));
  await b.draw('ticket', { ticket: 't-7' }, 'primary');
  expect(b.labels()).not.toContain('Promote to epic…');
  for (const form of ['side', 'compact'] as const) {
    b.answer(data());
    await b.draw('ticket', { ticket: 't-7' }, form);
    expect(b.labels()).not.toContain('Promote to epic…');
    expect(b.labels()).not.toContain('Ask a person…');
  }
});
