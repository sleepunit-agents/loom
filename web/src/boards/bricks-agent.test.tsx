/** The `agent` and `agents` bricks (docs/specs/boards.md, "The first bricks"): one agent as Home's card says it,
 * and the member's agents as a roster. The data hook is a fake; the member's operation goes to a fake fetch, so what
 * is checked is the request loom would receive (as in bricks-drawn.test.tsx). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { brickView, type Params } from './bricks';
import type { Form } from './layout';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; update(element: unknown): void; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn(), raised = vi.fn();
let ok = true;
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); raised.mockReset(); ok = true;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    sent(url, JSON.parse(init.body).input);
    return { ok, status: ok ? 200 : 409, json: async () => (ok ? { ok: true, value: { stopped: true } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

type Data = Record<string, unknown>;
const asked: { name: string; variables: unknown; options?: { pause?: boolean } }[] = [];
/** What each read answers, by the name of its query. `undefined` is a read still loading; a paused read says loading. */
const answer = (data: Data) => { asked.length = 0; feed.mockImplementation((query: string, variables: unknown, options?: { pause?: boolean }) => {
  const name = /^query (\w+)/.exec(query)![1];
  asked.push({ name, variables, options });
  if (options?.pause) return { status: 'loading' };
  return name in data ? (data[name] === undefined ? { status: 'loading' } : data[name] === null ? { status: 'offline' } : { status: 'live', data: data[name] }) : { status: 'live', data: null };
}); };
const element = (brick: string, params: Params, form: Form) => h(brickView(brick).Body, { params, form, act: reported, raise: raised });
const draw = async (brick: string, params: Params, form: Form) => { await act(async () => { tree?.unmount(); tree = create(element(brick, params, form)); }); return tree!; };
const said = (node: Node | string): string => (typeof node === 'string' ? node : node.children.map(said).join(''));
const all = () => said(tree!.root);
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });
const oneLine = () => { const json = tree!.toJSON() as { type: string; props: { className: string } }; expect(Array.isArray(json)).toBe(false); expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief'); };

const at = '2026-11-27T09:00:00Z';
const item = (over: object) => ({ id: 'd-1', kind: 'job', title: null, with: null, place: null, direct: null, ref: null, task: null, quietSince: null, machine: null, since: at, state: 'running', href: '/p/desktop/only', ...over });
const jobs = [
  { id: 'j-3', title: 'Survey the fence', state: 'running', conversation: 'cv-fence', queuedAt: at, endedAt: null },
  { id: 'j-2', title: '', state: 'queued', conversation: null, queuedAt: at, endedAt: null },
  { id: 'j-1', title: 'Count the hens', state: 'done', conversation: 'cv-hens', queuedAt: at, endedAt: at },
  { id: 'j-0', title: 'Weigh the feed', state: 'failed', conversation: 'cv-feed', queuedAt: at, endedAt: at },
];
const world = (over: Data = {}): Data => ({
  DeskAgentProfiles: { agents: [{ id: 'art', about: 'Keeps the garden and the hens.', aboutAskedAt: null }, { id: 'mira', about: '', aboutAskedAt: null }] },
  DeskAgentStatus: { agentStatus: [{ agent: 'art', state: 'waiting', work: 'Waiting for the feed order', changedAt: at }, { agent: 'mira', state: 'idle', work: '', changedAt: at }] },
  DeskDoing: { agentDoing: { items: [item({ id: 'd-1', kind: 'handoff', with: 'mira', title: 'Fence survey' }), item({ id: 'd-2', kind: 'task', title: 'Mend the gate', ref: 't-7' })], more: 2, claimed: 0 } },
  DeskDoingAll: { agentDoing: { items: [item({ id: 'd-1', kind: 'handoff', with: 'mira', title: 'Fence survey' }), item({ id: 'd-2', kind: 'task', title: 'Mend the gate', ref: 't-7' }),
    item({ id: 'd-3', kind: 'loom', with: 'sam' }), item({ id: 'd-4', kind: 'private' })], more: 0, claimed: 0 } },
  DeskWaitingCounts: { homeComms: { member: 'sam' }, inboxFolders: { needs: 1, agents: [{ id: 'art', needs: 1 }] } },
  DeskHomeComms: { homeComms: { member: 'sam', agents: ['art', 'mira'], summaries: [
    { agent: 'art', unread: 2, last: { thread: 'th:last', title: 'Latest', at }, first: { thread: 'th:first', title: 'Unread', at } },
    { agent: 'mira', unread: 0, last: null, first: null }] } },
  DeskRoster: { homeComms: { member: 'sam', agents: ['art', 'mira'] }, agents: [{ id: 'mira', position: 2, removedAt: null }, { id: 'art', position: 1, removedAt: null }, { id: 'gone', position: 0, removedAt: at }, { id: 'theirs', position: 0, removedAt: null }] },
  BrickAgentJobs: { jobs },
  BrickAssigned: { rows: [{ id: 't-7', title: 'Mend the gate', status: 'open' }] },
  BrickAgentsAtWork: { agentsAtWork: ['art'] },
  ...over,
});

describe('agent', () => {
  it('says who it is, its state and its own report, and what it is doing now in Home\'s words', async () => {
    answer(world());
    await draw('agent', { agent: 'art' }, 'side');
    expect(said(tree!.root.findAll((n) => n.props.className === 'board-lead')[0])).toBe('Art');
    expect(all()).toContain('Working · 1 needs you');
    expect(all()).toContain('Waiting for the feed order');
    expect(all()).toContain('Keeps the garden and the hens.');
    expect(all()).toContain('Taking a hand-off from Mira · Fence survey');
    expect(all()).toContain('Working on Mend the gate · t-7');
    expect(all()).toContain('+2 more');
    // The desktop's addresses for what it is doing are not drawn: nothing here leads off the page.
    expect(JSON.stringify(tree!.toJSON())).not.toContain('/p/');
  });
  it('draws each running or recent job, a session chip where it has a conversation, and its open tickets as ticket chips', async () => {
    answer(world());
    await draw('agent', { agent: 'art' }, 'side');
    expect(asked.find((q) => q.name === 'BrickAgentJobs')!.variables).toEqual({ agent: 'art', first: 12 });
    expect(asked.find((q) => q.name === 'BrickAssigned')!.variables).toEqual({ ref: 'art' });
    expect(placed()).toEqual([
      { brick: 'session', params: { session: 'cv-fence' } }, { brick: 'session', params: { session: 'cv-hens' } }, { brick: 'session', params: { session: 'cv-feed' } },
      { brick: 'ticket', params: { ticket: 't-7' } }]);
    expect(all()).toContain('Untitled job');
    expect(tree!.root.findAll((n) => n.props.className === 'board-state').map(said)).toEqual(['Working · 1 needs you', 'running', 'queued', 'done', 'failed']);
  });
  it('links to its conversation: the one with an unread reply first, else the latest; and says when there is none or it may not be talked to', async () => {
    answer(world());
    await draw('agent', { agent: 'art' }, 'side');
    expect(tree!.root.findAllByType('a').map((a) => [a.props.href, said(a)])).toEqual([['/app/t/th%3Afirst', 'Open the conversation with an unread reply']]);
    expect(all()).toContain('2 unread');
    answer(world({ DeskHomeComms: { homeComms: { member: 'sam', agents: ['art'], summaries: [{ agent: 'art', unread: 0, last: { thread: 'th:last', title: 'Latest', at }, first: null }] } } }));
    await draw('agent', { agent: 'art' }, 'side');
    expect(tree!.root.findAllByType('a').map((a) => [a.props.href, said(a)])).toEqual([['/app/t/th%3Alast', 'Open the latest conversation']]);
    await draw('agent', { agent: 'mira' }, 'side');
    expect(tree!.root.findAllByType('a')).toEqual([]);
    expect(all()).not.toContain('Conversation');
    answer(world());
    await draw('agent', { agent: 'mira' }, 'side');
    expect(all()).toContain('None yet. Start one from the list of conversations.');
  });
  it('the primary form reads everything it is doing and its last thirty jobs, and draws them all', async () => {
    const many = Array.from({ length: 9 }, (_, n) => ({ id: 'j-9' + n, title: 'Job ' + n, state: 'done', conversation: 'cv-' + n, queuedAt: at, endedAt: at }));
    answer(world({ BrickAgentJobs: { jobs: many } }));
    await draw('agent', { agent: 'art' }, 'primary');
    expect(asked.find((q) => q.name === 'BrickAgentJobs')!.variables).toEqual({ agent: 'art', first: 30 });
    expect(asked.some((q) => q.name === 'DeskDoingAll')).toBe(true);
    expect(placed().filter((p) => p.brick === 'session')).toHaveLength(9);
    expect(all()).toContain('Talking with Sam in loom');
    expect(all()).toContain('In a private conversation');
    await draw('agent', { agent: 'art' }, 'side');
    expect(placed().filter((p) => p.brick === 'session')).toHaveLength(2);
  });
  it('the compact form is one line: its state and the first thing it is doing, with no controls and no jobs read', async () => {
    answer(world());
    await draw('agent', { agent: 'art' }, 'compact');
    oneLine();
    expect(all()).toBe('Working · 1 needs you Taking a hand-off from Mira · Fence survey');
    expect(tree!.root.findAll((n) => ['button', 'a', 'input', 'form'].includes(n.type))).toEqual([]);
    expect(asked.find((q) => q.name === 'BrickAgentJobs')!.options).toMatchObject({ pause: true });
    answer(world({ DeskDoing: { agentDoing: { items: [], more: 0, claimed: 0 } }, DeskWaitingCounts: { homeComms: { member: 'sam' }, inboxFolders: { needs: 0, agents: [] } } }));
    await draw('agent', { agent: 'mira' }, 'compact');
    oneLine();
    expect(all()).toBe('Quiet Mira');
  });
  it('stops a running job only after asking, by runtime.jobStop as the session brick does, and reports it with nothing in the detail', async () => {
    answer(world());
    await draw('agent', { agent: 'art' }, 'side');
    expect(buttons().map(said)).toEqual(['Stop…', 'Stop…']);
    await act(async () => { await buttons()[0].props.onClick(); });
    expect(sent).not.toHaveBeenCalled();
    await press('Keep it running');
    expect(sent).not.toHaveBeenCalled();
    await act(async () => { await buttons()[0].props.onClick(); });
    await press('Stop this job');
    expect(sent.mock.calls).toEqual([['/api/runtime/jobStop', { job: 'j-3', reason: 'write-off' }]]);
    expect(reported.mock.calls).toEqual([['stop', {}]]);
  });
  it('says so and reports nothing when the job could not be stopped', async () => {
    answer(world()); ok = false;
    await draw('agent', { agent: 'art' }, 'primary');
    await act(async () => { await buttons()[0].props.onClick(); });
    await press('Stop this job');
    expect(said(tree!.root.findAll((n) => n.props.role === 'alert')[0])).toBe('That did not stop it.');
    expect(reported).not.toHaveBeenCalled();
  });
  it('flags itself when it starts waiting on the member, and not when it already was or stops', async () => {
    const waits = (needs: number) => world({ DeskWaitingCounts: { homeComms: { member: 'sam' }, inboxFolders: { needs, agents: needs ? [{ id: 'art', needs }] : [] } } });
    answer(waits(1));
    await draw('agent', { agent: 'art' }, 'side');
    expect(raised).not.toHaveBeenCalled();
    answer(waits(0)); await act(async () => tree!.update(element('agent', { agent: 'art' }, 'side')));
    expect(raised).not.toHaveBeenCalled();
    answer(waits(2)); await act(async () => tree!.update(element('agent', { agent: 'art' }, 'side')));
    expect(raised.mock.calls).toEqual([['Waiting on you']]);
    answer(waits(3)); await act(async () => tree!.update(element('agent', { agent: 'art' }, 'side')));
    expect(raised).toHaveBeenCalledTimes(1);
  });
  it('says loading, and unavailable for an agent that is not there or cannot be read; a failed part says so in its place', async () => {
    for (const form of ['compact', 'side', 'primary'] as const) {
      answer(world({ DeskAgentProfiles: undefined }));
      expect(said((await draw('agent', { agent: 'art' }, form)).root)).toBe('Loading…');
      answer(world({ DeskAgentProfiles: null }));
      expect(said((await draw('agent', { agent: 'art' }, form)).root)).toBe('This agent is unavailable.');
      answer(world());
      expect(said((await draw('agent', { agent: 'nobody' }, form)).root)).toBe('This agent is unavailable.');
    }
    answer(world({ DeskDoing: null, BrickAgentJobs: null, DeskAgentStatus: null, DeskWaitingCounts: null, DeskHomeComms: null }));
    await draw('agent', { agent: 'art' }, 'side');
    expect(all()).toContain('Can’t tell what it is doing right now.');
    expect(all()).toContain('Can’t read jobs right now.');
    expect(all()).toContain('Quiet');
  });
  it('is headed by its name and shows the reference only in the small line', () => {
    expect(brickView('agent').title({ agent: 'art' })).toBe('Agent');
    expect(brickView('agent').sub({ agent: 'art' })).toBe('art');
  });
});

describe('agents', () => {
  it('lists the member\'s own agents in Home\'s order, each a chip that places its agent brick, with its state and current work', async () => {
    answer(world());
    await draw('agents', {}, 'side');
    // Not a removed agent, and not one that is someone else's.
    expect(placed()).toEqual([{ brick: 'agent', params: { agent: 'art' } }, { brick: 'agent', params: { agent: 'mira' } }]);
    const lines = tree!.root.findAll((n) => n.props.className === 'board-line').map(said);
    expect(lines[0]).toBe('ArtWorking · 1 needs youTaking a hand-off from Mira · Fence survey+3 more');
    expect(asked.filter((q) => q.name === 'DeskDoing').map((q) => q.variables)).toEqual(expect.arrayContaining([{ agent: 'art' }, { agent: 'mira' }]));
    expect(buttons()).toEqual([]);
    expect(tree!.root.findAllByType('a')).toEqual([]);
  });
  it('says an idle agent is quiet, and when the member has no agents', async () => {
    answer(world({ DeskDoing: { agentDoing: { items: [], more: 0, claimed: 0 } } }));
    await draw('agents', {}, 'side');
    expect(tree!.root.findAll((n) => n.props.className === 'board-line').map(said)).toEqual(['ArtWaiting · 1 needs you', 'MiraQuiet']);
    answer(world({ DeskRoster: { homeComms: { member: 'sam', agents: [] }, agents: [{ id: 'theirs', position: 0, removedAt: null }] } }));
    await draw('agents', {}, 'side');
    expect(all()).toBe('No agents of your own.');
  });
  it('the compact form is one line of counts, with no controls', async () => {
    answer(world());
    await draw('agents', {}, 'compact');
    oneLine();
    expect(all()).toBe('2 agents · 1 working · 1 waiting on you');
    expect(asked.find((q) => q.name === 'BrickAgentsAtWork')!.variables).toEqual({ agents: ['art', 'mira'] });
    expect(tree!.root.findAll((n) => ['button', 'a', 'input', 'form'].includes(n.type))).toEqual([]);
    answer(world({ BrickAgentsAtWork: null, DeskWaitingCounts: null }));
    await draw('agents', {}, 'compact');
    oneLine();
    expect(all()).toBe('2 agents');
  });
  it('says loading, and unavailable when the roster cannot be read or the member has no mailbox', async () => {
    for (const form of ['compact', 'side'] as const) {
      answer(world({ DeskRoster: undefined }));
      expect(said((await draw('agents', {}, form)).root)).toBe('Loading…');
      answer(world({ DeskRoster: null }));
      expect(said((await draw('agents', {}, form)).root)).toBe('This roster is unavailable.');
      answer(world({ DeskRoster: { homeComms: null, agents: [] } }));
      expect(said((await draw('agents', {}, form)).root)).toBe('This roster is unavailable.');
    }
  });
  it('is headed by its name, calls no operation, reports nothing and never flags itself', async () => {
    expect(brickView('agents').title({})).toBe('Agents');
    answer(world());
    await draw('agents', {}, 'side');
    answer(world({ DeskWaitingCounts: { homeComms: { member: 'sam' }, inboxFolders: { needs: 5, agents: [{ id: 'mira', needs: 5 }] } } }));
    await act(async () => tree!.update(element('agents', {}, 'side')));
    expect(sent).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled(); expect(raised).not.toHaveBeenCalled();
  });
});
