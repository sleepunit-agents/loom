/** What each brick draws (docs/specs/boards.md, "The first bricks"), with the data hook and the operations faked. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

type Answer = { status: string; data?: unknown };
const f = vi.hoisted(() => ({ answers: {} as Record<string, { status: string; data?: unknown }>, queries: [] as { query: string; variables: unknown; options: unknown }[], op: vi.fn() }));
vi.mock('../data/graphql', () => ({
  useDataQuery(query: string, variables: unknown, options?: { pause?: boolean }) {
    f.queries.push({ query, variables, options });
    if (options?.pause) return { status: 'loading' };
    return f.answers[/query (\w+)/.exec(query)![1]] ?? { status: 'live', data: null };
  },
}));
vi.mock('../data/operation', () => ({ memberOperation: f.op }));
import { bricks, brickView, type Params } from './bricks';
import type { Form } from './layout';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(test: (n: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
const text = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
const live = (data: unknown): Answer => ({ status: 'live', data });

const task = { id: 't-7', title: 'Mend the gate', status: 'open', assignee: null as string | null, assigneeKind: null as string | null, goal: 'A gate that shuts.', why: 'It swings.', doneWhen: 'It latches.', project: 'garden' };
const job = { id: 'j-1', title: 'Survey the fence', state: 'running', queuedAt: new Date(Date.now() - 5 * 60000).toISOString(), usage: { model: 'test-model', harness: 'test-harness', tools: [{ name: 'Read', count: 4 }, { name: 'Bash', count: 9 }, { name: 'Idle', count: 0 }] } };
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();
function data(over: Record<string, Answer> = {}) {
  f.answers = {
    BrickProject: live({ project: { name: 'Garden', goal: 'Keep the garden tidy.', lifecycle: 'active' } }),
    BrickLanes: live({ projectBoardTickets: [
      { id: 't-1', title: 'Dig', lane: 'Working', reason: null, assignee: 'art' },
      { id: 't-2', title: 'Sow', lane: 'Working', reason: 'claimed', assignee: 'art' },
      { id: 't-3', title: 'Weigh', lane: 'Verifying', reason: null, assignee: null },
    ] }),
    BrickTrend: live({ opened: [{ id: 't-1', title: 'Dig', at: iso(0) }, { id: 't-2', title: 'Sow', at: iso(1) }], closed: [{ id: 't-1', title: 'Dig', at: iso(0) }] }),
    BrickTicket: live({ ticket: task }),
    BrickComments: live({ ticket: { title: 'Mend the gate', taskCommentsByTask: [{ seq: 2, text: 'Hinge ordered', actor: 'art', at: iso(0) }, { seq: 1, text: 'Looked at it', actor: 'sam', at: iso(1) }] } }),
    BrickAssigned: live({ rows: [{ id: 't-7', title: 'Mend the gate', status: 'open' }, { id: 't-8', title: 'Oil the latch', status: 'open' }] }),
    BrickSession: live({ jobs: [{ ...job, id: 'j-0', title: 'An earlier job', state: 'done', queuedAt: iso(2) }, job], cv: { agent: 'art', label: 'Fence', venue: 'loom' } }),
    BrickSessionJob: live({ rows: [{ brief: 'Walk the fence line.', logTail: 'last line', endedNote: null, claimedAt: job.queuedAt, endedAt: null }] }),
    // What the agent brick reads beside its tickets (its own suite is bricks-agent.test.tsx).
    DeskAgentProfiles: live({ agents: [{ id: 'art', about: 'Keeps the garden.', aboutAskedAt: null }] }),
    DeskAgentStatus: live({ agentStatus: [] }), DeskDoing: live({ agentDoing: { items: [], more: 0, claimed: 0 } }), DeskDoingAll: live({ agentDoing: { items: [], more: 0, claimed: 0 } }),
    DeskWaitingCounts: live({ homeComms: { member: 'sam' }, inboxFolders: { needs: 0, agents: [] } }),
    DeskHomeComms: live({ homeComms: { member: 'sam', agents: ['art'], summaries: [] } }), BrickAgentJobs: live({ jobs: [] }),
    ...over,
  };
}

let tree: { root: Node; toJSON(): any; unmount(): void } | undefined;
const acted = vi.fn(), raised = vi.fn();
async function draw(brick: string, params: Params, form: Form) {
  await act(async () => tree?.unmount());
  const { Body } = brickView(brick);
  await act(async () => { tree = create(h(Body, { params, form, act: acted, raise: raised })); });
  return tree!;
}
const button = (name: string) => tree!.root.findAllByType('button').find((b) => text(b) === name);
const press = (name: string) => act(async () => button(name)!.props.onClick());
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.clearAllMocks(); f.queries = []; });

const drawn: [string, Params][] = [
  ['project', { project: 'garden' }],
  ['lanes', { project: 'garden' }],
  ['trend', { project: 'garden', days: 7 }],
  ['ticket', { ticket: 't-7' }],
  ['comments', { ticket: 't-7' }],
  ['person', { person: 'member:sam' }],
  ['agent', { agent: 'art' }],
  ['session', { session: 'cv-fence-0001' }],
];
describe('every drawn brick', () => {
  it.each(drawn)('%s: the compact form is exactly one short line', async (brick, params) => {
    data();
    const json = (await draw(brick, params, 'compact')).toJSON();
    expect(Array.isArray(json)).toBe(false);
    expect(json.type).toBe('p');
    expect(json.props.className).toBe('board-brief');
    const line = text(tree!.root.findAllByType('p')[0]);
    expect(line.length).toBeGreaterThan(0);
    expect(line).not.toContain('\n');
  });
  it.each(drawn)('%s: the side and primary forms draw its record', async (brick, params) => {
    data();
    for (const form of ['side', 'primary'] as const) {
      const json = JSON.stringify((await draw(brick, params, form)).toJSON());
      expect(json).not.toContain('does not draw this brick');
      expect(json).not.toContain('unavailable');
      expect(json).not.toContain('board-brief');
    }
  });
  it.each(drawn)('%s: says loading while its read loads, and unavailable when the read fails or has no record', async (brick, params) => {
    for (const form of ['compact', 'side', 'primary'] as const) {
      f.answers = new Proxy({}, { get: () => ({ status: 'loading' }) });
      expect(text((await draw(brick, params, form)).root.findAllByType('p')[0])).toBe('Loading…');
      f.answers = new Proxy({}, { get: () => ({ status: 'error' }) });
      expect(text((await draw(brick, params, form)).root.findAllByType('p')[0])).toMatch(/^This \w+ is unavailable\.$/);
    }
  });
  it('the registry holds the bricks of the spec, eight of them drawn here', () => {
    expect(Object.keys(bricks).sort()).toEqual(['activity', 'agent', 'agents', 'approval', 'approvals', 'backlog', 'comments', 'inbox', 'knowledge', 'knowledge-page', 'lanes', 'new-ticket', 'people', 'person', 'project', 'pull', 'question', 'repository', 'session', 'threads', 'ticket', 'trend', 'unfiled']);
  });
});

describe('a brick this page does not draw', () => {
  it('an unknown brick says so in every form and never throws', async () => {
    f.answers = {};
    for (const form of ['compact', 'side', 'primary'] as const) {
      const json = (await draw('a-brick-nobody-wrote', { thing: 'x-1' }, form)).toJSON();
      expect(json.type).toBe('p');
      expect(text(tree!.root.findAllByType('p')[0])).toContain('This page does not draw this brick yet.');
    }
    expect(f.queries).toEqual([]);
    expect(f.op).not.toHaveBeenCalled();
  });
  it('an unknown brick is named by its own name and has no reference', () => {
    const view = brickView('a-brick-nobody-wrote');
    expect(view.title({ thing: 'x-1' })).toBe('a-brick-nobody-wrote');
    expect(view.sub({ thing: 'x-1' })).toBe('');
  });
});

describe('lanes', () => {
  it('counts each lane in the compact form', async () => {
    data();
    expect(text((await draw('lanes', { project: 'garden' }, 'compact')).root.findAllByType('p')[0])).toBe('2 working · 1 verifying · 0 waiting');
  });
  it('draws the three lanes, each ticket a chip that places its ticket brick', async () => {
    data();
    const { root } = await draw('lanes', { project: 'garden' }, 'primary');
    expect(root.findAllByType('section').map((s) => [s.props['aria-label'], s.props['data-empty']])).toEqual([['Working', false], ['Verifying', false], ['Waiting', true]]);
    expect(root.findAllByType('button').map((b) => JSON.parse(b.props['data-place']))).toEqual(['t-1', 't-2', 't-3'].map((ticket) => ({ brick: 'ticket', params: { ticket } })));
  });
  it('shows three tickets a lane in the side form and says how many more', async () => {
    data({ BrickLanes: live({ projectBoardTickets: Array.from({ length: 5 }, (_, i) => ({ id: 't-' + i, title: 'T' + i, lane: 'Working', reason: null, assignee: null })) }) });
    const { root } = await draw('lanes', { project: 'garden' }, 'side');
    expect(root.findAllByType('button')).toHaveLength(3);
    expect(JSON.stringify(tree!.toJSON())).toContain('"and ","2"," more"');
  });
});

describe('ticket', () => {
  const worked = [
    { conversation: 'cv-2', title: 'Second pass', state: 'running', at: '2026-11-27T10:00:00.000Z' },
    { conversation: 'cv-1', title: 'First pass', state: 'done', at: '2026-11-20T10:00:00.000Z' },
    { conversation: 'cv-0', title: '', state: null, at: '2026-11-19T10:00:00.000Z' },
  ];
  const closed = { ...task, status: 'closed', assignee: 'art', assigneeKind: 'agent' };
  const section = (root: Node) => root.findAll((n) => n.props['data-ticket-sessions'] === '');
  it('lists the sessions that worked a closed ticket in the big form, each a chip that places its session brick', async () => {
    data({ BrickTicket: live({ ticket: closed }), BrickTicketSessions: live({ rows: worked }) });
    const { root } = await draw('ticket', { ticket: 't-7' }, 'primary');
    const [sessions] = section(root);
    expect(text(sessions.findAllByType('dt')[0])).toBe('Sessions');
    // In the order loom gave them (newest first), each with its title, its state and when.
    const chips = sessions.findAllByType('button');
    expect(chips.map((b) => JSON.parse(b.props['data-place']))).toEqual(['cv-2', 'cv-1', 'cv-0'].map((session) => ({ brick: 'session', params: { session } })));
    expect(chips.map(text)).toEqual(['Second pass', 'First pass', 'Session']);
    expect(sessions.findAll((n) => n.props.className === 'board-state').map(text)).toEqual(['running', 'done', 'not started']);
    expect(text(sessions)).toContain('2026');
    expect(f.queries.find((q) => q.query.includes('BrickTicketSessions'))).toMatchObject({ variables: { t: 't-7' } });
    // The ticket is still a closed ticket: only Reopen is offered.
    expect(root.findAllByType('button').filter((b) => !b.props['data-place']).map(text)).toEqual(['Reopen']);
  });
  it('says so in the big form when no session is recorded, or the list cannot be read', async () => {
    data({ BrickTicket: live({ ticket: closed }), BrickTicketSessions: live({ rows: [] }) });
    expect(text(section((await draw('ticket', { ticket: 't-7' }, 'primary')).root)[0])).toBe('SessionsNo session is recorded for this ticket.');
    data({ BrickTicket: live({ ticket: closed }), BrickTicketSessions: { status: 'error' } });
    expect(text(section((await draw('ticket', { ticket: 't-7' }, 'primary')).root)[0])).toBe('SessionsIts sessions are unavailable.');
  });
  it('gives the side form a count line, and the compact form nothing', async () => {
    data({ BrickTicket: live({ ticket: closed }), BrickTicketSessions: live({ rows: worked }) });
    const side = await draw('ticket', { ticket: 't-7' }, 'side');
    expect(section(side.root).map(text)).toEqual(['3 sessions worked this']);
    expect(side.root.findAll((n) => n.type === 'button' && /"session"/.test(n.props['data-place'] ?? ''))).toEqual([]);
    data({ BrickTicket: live({ ticket: closed }), BrickTicketSessions: live({ rows: worked.slice(0, 1) }) });
    expect(section((await draw('ticket', { ticket: 't-7' }, 'side')).root).map(text)).toEqual(['1 session worked this']);
    data({ BrickTicket: live({ ticket: closed }), BrickTicketSessions: live({ rows: [] }) });
    expect(section((await draw('ticket', { ticket: 't-7' }, 'side')).root)).toEqual([]);
    data({ BrickTicket: live({ ticket: closed }), BrickTicketSessions: live({ rows: worked }) });
    f.queries = [];
    const compact = await draw('ticket', { ticket: 't-7' }, 'compact');
    expect(text(compact.root.findAllByType('p')[0])).toBe('closed Mend the gate');
    expect(section(compact.root)).toEqual([]);
    expect(f.queries.some((q) => q.query.includes('BrickTicketSessions'))).toBe(false);
  });
  const names = () => tree!.root.findAll((n) => n.type === 'button' && n.props.className === 'board-action').map(text);
  it('offers Claim and Close on an open ticket nobody holds', async () => {
    data();
    await draw('ticket', { ticket: 't-7' }, 'side');
    expect(names()).toEqual(['Claim', 'Close…']);
  });
  it('offers Release and Close on an open ticket somebody holds', async () => {
    data({ BrickTicket: live({ ticket: { ...task, status: 'in_progress', assignee: 'art', assigneeKind: 'agent' } }) });
    await draw('ticket', { ticket: 't-7' }, 'primary');
    expect(names()).toEqual(['Release', 'Close…']);
  });
  it('offers only Reopen on a closed ticket', async () => {
    data({ BrickTicket: live({ ticket: { ...task, status: 'closed', assignee: 'art', assigneeKind: 'agent' } }) });
    await draw('ticket', { ticket: 't-7' }, 'side');
    expect(names()).toEqual(['Reopen']);
  });
  it.each([
    ['Claim', 'claim', { ...task }],
    ['Release', 'unclaim', { ...task, assignee: 'sam', assigneeKind: 'member' }],
    ['Reopen', 'reopen', { ...task, status: 'closed' }],
  ])('%s calls tasks.command %s and then reports the act', async (label, action, ticket) => {
    data({ BrickTicket: live({ ticket }) });
    f.op.mockImplementation(async () => { expect(acted).not.toHaveBeenCalled(); });
    await draw('ticket', { ticket: 't-7' }, 'side');
    await press(label);
    expect(f.op.mock.calls).toEqual([['tasks.command', { action, id: 't-7' }]]);
    expect(acted.mock.calls).toEqual([[action, {}]]);
  });
  it('Close asks why first, and closes with the reason as typed and trimmed', async () => {
    data();
    f.op.mockResolvedValue(undefined);
    const { root } = await draw('ticket', { ticket: 't-7' }, 'side');
    await press('Close…');
    expect(f.op).not.toHaveBeenCalled();
    expect(names()).toEqual(['Claim', 'Close ticket', 'Cancel']);
    expect(button('Close ticket')!.props.disabled).toBe(true);
    await act(async () => root.findAllByType('input')[0].props.onChange({ target: { value: '  Gate replaced ' } }));
    await act(async () => root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));
    expect(f.op.mock.calls).toEqual([['tasks.command', { action: 'close', id: 't-7', reason: 'Gate replaced' }]]);
    expect(acted.mock.calls).toEqual([['close', {}]]);
    expect(root.findAllByType('form')).toHaveLength(0);
  });
  it('reports no act when the command fails, and says it did not save', async () => {
    data();
    f.op.mockRejectedValue(new Error('refused'));
    const { root } = await draw('ticket', { ticket: 't-7' }, 'side');
    await press('Claim');
    expect(acted).not.toHaveBeenCalled();
    expect(text(root.findAll((n) => n.props.role === 'alert')[0])).toBe('That did not save.');
  });
  it('links to its project, its holder and its comments by chips', async () => {
    data({ BrickTicket: live({ ticket: { ...task, assignee: 'art', assigneeKind: 'agent' } }) });
    const { root } = await draw('ticket', { ticket: 't-7' }, 'side');
    expect(root.findAll((n) => n.type === 'button' && !!n.props['data-place']).map((b) => JSON.parse(b.props['data-place']))).toEqual([
      { brick: 'project', params: { project: 'garden' } }, { brick: 'agent', params: { agent: 'art' } }, { brick: 'comments', params: { ticket: 't-7' } }]);
    data({ BrickTicket: live({ ticket: { ...task, assignee: 'sam', assigneeKind: 'member' } }) });
    expect((await draw('ticket', { ticket: 't-7' }, 'side')).root.findAll((n) => n.type === 'button' && !!n.props['data-place']).map((b) => JSON.parse(b.props['data-place']))[1])
      .toEqual({ brick: 'person', params: { person: 'member:sam' } });
  });
  it('flags itself when someone else closes or reopens it, and not for a claim', async () => {
    data();
    await draw('ticket', { ticket: 't-7' }, 'side');
    const become = async (status: string) => { data({ BrickTicket: live({ ticket: { ...task, status } }) }); await act(async () => tree!.update(h(brickView('ticket').Body, { params: { ticket: 't-7' }, form: 'side', act: acted, raise: raised }))); };
    await become('in_progress');
    expect(raised).not.toHaveBeenCalled();
    await become('closed');
    expect(raised.mock.calls).toEqual([['Closed']]);
    await become('open');
    expect(raised.mock.calls).toEqual([['Closed'], ['Reopened']]);
  });
  it('does not flag itself for a change the member made here a moment ago', async () => {
    data();
    f.op.mockResolvedValue(undefined);
    const { root } = await draw('ticket', { ticket: 't-7' }, 'side');
    await press('Close…');
    await act(async () => root.findAllByType('input')[0].props.onChange({ target: { value: 'Done' } }));
    await act(async () => root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));
    data({ BrickTicket: live({ ticket: { ...task, status: 'closed' } }) });
    await act(async () => tree!.update(h(brickView('ticket').Body, { params: { ticket: 't-7' }, form: 'side', act: acted, raise: raised })));
    expect(raised).not.toHaveBeenCalled();
  });
});

describe('comments', () => {
  it('says how many and the latest in the compact form', async () => {
    data();
    expect(text((await draw('comments', { ticket: 't-7' }, 'compact')).root.findAllByType('p')[0])).toBe('2 · latest from art: Hinge ordered');
    data({ BrickComments: live({ ticket: { title: 'Mend the gate', taskCommentsByTask: [] } }) });
    expect(text((await draw('comments', { ticket: 't-7' }, 'compact')).root.findAllByType('p')[0])).toBe('No comments yet');
  });
  it('adding calls tasks.command comment with the words trimmed, reports the act and empties the input', async () => {
    data();
    f.op.mockResolvedValue(undefined);
    const { root } = await draw('comments', { ticket: 't-7' }, 'side');
    expect(button('Add')!.props.disabled).toBe(true);
    await act(async () => root.findAllByType('input')[0].props.onChange({ target: { value: ' New hinge fitted ' } }));
    await act(async () => root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));
    expect(f.op.mock.calls).toEqual([['tasks.command', { action: 'comment', id: 't-7', text: 'New hinge fitted' }]]);
    expect(acted.mock.calls).toEqual([['comment', {}]]);
    expect(root.findAllByType('input')[0].props.value).toBe('');
  });
  it('an empty comment calls nothing', async () => {
    data();
    const { root } = await draw('comments', { ticket: 't-7' }, 'side');
    await act(async () => root.findAllByType('input')[0].props.onChange({ target: { value: '   ' } }));
    await act(async () => root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));
    expect(f.op).not.toHaveBeenCalled();
  });
  it('flags itself when a comment arrives from someone else', async () => {
    data();
    await draw('comments', { ticket: 't-7' }, 'side');
    data({ BrickComments: live({ ticket: { title: 'Mend the gate', taskCommentsByTask: [{ seq: 3, text: 'Third', actor: 'sam', at: iso(0) }, { seq: 2, text: 'b', actor: 'art', at: iso(0) }, { seq: 1, text: 'a', actor: 'sam', at: iso(1) }] } }) });
    await act(async () => tree!.update(h(brickView('comments').Body, { params: { ticket: 't-7' }, form: 'side', act: acted, raise: raised })));
    expect(raised.mock.calls).toEqual([['New comment']]);
  });
});

describe('person and agent', () => {
  it('reads the open tickets of a member by the id after "member:", and of an agent by its id', async () => {
    data();
    await draw('person', { person: 'member:sam' }, 'side');
    expect(f.queries.at(-1)).toMatchObject({ variables: { ref: 'sam' } });
    expect(f.queries.at(-1)!.query).toContain('assigneeKind:{eq:member}');
    expect(text(tree!.root.findAllByType('p')[0])).toBe('2 open tickets.');
    await draw('agent', { agent: 'art' }, 'side');
    expect(f.queries.find((q) => q.query.includes('assigneeKind:{eq:agent}'))).toMatchObject({ variables: { ref: 'art' } });
    expect(tree!.root.findAllByType('p').map(text)).toContain('2 open tickets.');
    expect(tree!.root.findAllByType('button').map((b) => JSON.parse(b.props['data-place']))).toEqual(['t-7', 't-8'].map((ticket) => ({ brick: 'ticket', params: { ticket } })));
  });
  it('says so when there are none', async () => {
    data({ BrickAssigned: live({ rows: [] }) });
    expect(text((await draw('person', { person: 'member:sam' }, 'compact')).root.findAllByType('p')[0])).toBe('No open tickets');
    expect(text((await draw('person', { person: 'member:sam' }, 'side')).root.findAllByType('p')[0])).toBe('No open tickets.');
    expect((await draw('agent', { agent: 'art' }, 'side')).root.findAllByType('p').map(text)).toContain('No open tickets.');
  });
});

describe('session', () => {
  it('shows the latest job of the conversation', async () => {
    data();
    expect(text((await draw('session', { session: 'cv-fence-0001' }, 'compact')).root.findAllByType('p')[0])).toBe('running Survey the fence');
  });
  it('reads what it was asked only in the primary form', async () => {
    data();
    await draw('session', { session: 'cv-fence-0001' }, 'side');
    expect(f.queries.filter((q) => q.query.includes('BrickSessionJob')).every((q) => (q.options as { pause: boolean }).pause)).toBe(true);
    expect(JSON.stringify(tree!.toJSON())).not.toContain('Walk the fence line.');
    await draw('session', { session: 'cv-fence-0001' }, 'primary');
    expect(f.queries.at(-1)).toMatchObject({ variables: { agent: 'art', id: 'j-1' }, options: { pause: false } });
    expect(JSON.stringify(tree!.toJSON())).toContain('Walk the fence line.');
  });
  it('Stop asks first, then calls runtime.jobStop as a write-off and reports the act', async () => {
    data();
    f.op.mockImplementation(async () => { expect(acted).not.toHaveBeenCalled(); });
    await draw('session', { session: 'cv-fence-0001' }, 'side');
    await press('Stop…');
    expect(f.op).not.toHaveBeenCalled();
    expect(tree!.root.findAllByType('button').map(text).filter((t) => /Stop|Keep/.test(t))).toEqual(['Stop this session', 'Keep it running']);
    await press('Keep it running');
    expect(f.op).not.toHaveBeenCalled();
    await press('Stop…');
    await press('Stop this session');
    expect(f.op.mock.calls).toEqual([['runtime.jobStop', { job: 'j-1', reason: 'write-off' }]]);
    expect(acted.mock.calls).toEqual([['stop', {}]]);
  });
  it('reports no act when the stop fails', async () => {
    data();
    f.op.mockRejectedValue(new Error('refused'));
    const { root } = await draw('session', { session: 'cv-fence-0001' }, 'side');
    await press('Stop…');
    await press('Stop this session');
    expect(acted).not.toHaveBeenCalled();
    expect(text(root.findAll((n) => n.props.role === 'alert')[0])).toBe('That did not stop it.');
  });
  it('a session that is not running has no stop control', async () => {
    data({ BrickSession: live({ jobs: [{ ...job, state: 'done' }], cv: { agent: 'art', label: 'Fence', venue: 'loom' } }) });
    await draw('session', { session: 'cv-fence-0001' }, 'primary');
    expect(tree!.root.findAllByType('button').map(text).filter((t) => t.startsWith('Stop'))).toEqual([]);
  });
  it.each([['done', 'Finished'], ['stopped', 'Stopped'], ['failed', 'Failed']])('flags itself when a running session becomes %s', async (state, name) => {
    data();
    await draw('session', { session: 'cv-fence-0001' }, 'side');
    data({ BrickSession: live({ jobs: [{ ...job, state }], cv: { agent: 'art', label: 'Fence', venue: 'loom' } }) });
    await act(async () => tree!.update(h(brickView('session').Body, { params: { session: 'cv-fence-0001' }, form: 'side', act: acted, raise: raised })));
    expect(raised.mock.calls).toEqual([[name]]);
  });
});

describe('trend', () => {
  it('reads the project over its days and totals them in the compact form', async () => {
    data();
    expect(text((await draw('trend', { project: 'garden', days: 7 }, 'compact')).root.findAllByType('p')[0])).toBe('2 opened · 1 closed in 7 days');
    expect(f.queries.at(-1)).toMatchObject({ variables: { project: 'garden' } });
  });
  it('a picked day lists its tickets as chips, in the primary form only', async () => {
    data();
    const { root } = await draw('trend', { project: 'garden', days: 7 }, 'primary');
    const hits = root.findAll((n) => n.type === 'rect' && n.props.className === 'board-trend-hit');
    expect(hits).toHaveLength(7);
    await act(async () => hits[6].props.onClick());
    expect(root.findAllByType('button').map((b) => JSON.parse(b.props['data-place']))).toEqual([{ brick: 'ticket', params: { ticket: 't-1' } }, { brick: 'ticket', params: { ticket: 't-1' } }]);
    expect((await draw('trend', { project: 'garden', days: 7 }, 'side')).root.findAll((n) => n.type === 'rect' && n.props.className === 'board-trend-hit')).toHaveLength(0);
  });
});
