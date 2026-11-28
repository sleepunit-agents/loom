/** The `agent` and `agents` bricks (docs/specs/boards.md, "The first bricks"): one agent as Home's card says it,
 * and the member's agents as a roster. The data hook is a fake; the member's operation goes to a fake fetch, so what
 * is checked is the request loom would receive (as in bricks-drawn.test.tsx). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
// Art's built-in sprite draws on a real element; here it is a mark that it was drawn (as in ./threads.test.tsx).
vi.mock('../contexts/portrait', async () => { const { createElement } = await import('react'); return { Portrait: () => createElement('art-sprite') }; });
import { brickView, loadBricks, type Params } from './bricks';
import type { Form } from './layout';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();
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
  AgentActivityFeed: { agentActivityFeed: [] },
  ...over,
});

describe('agent', () => {
  it('says who it is, its state and its own report, and what it is doing now in Home\'s words', async () => {
    answer(world());
    await draw('agent', { agent: 'art' }, 'side');
    expect(said(tree!.root.findAll((n) => n.props.className === 'board-lead')[0])).toBe('Art');
    expect(all()).toContain('Working · 1 needs you');
    expect(all()).toContain('Waiting for the feed order');
    // Small, who it is gives way to what it has in hand; the big form says both.
    expect(all()).not.toContain('Keeps the garden and the hens.');
    expect(all()).toContain('Taking a hand-off from Mira · Fence survey');
    expect(all()).toContain('Working on Mend the gate · t-7');
    expect(all()).toContain('and 2 more');
    // The desktop's addresses for what it is doing are not drawn: nothing here leads off the page.
    expect(JSON.stringify(tree!.toJSON())).not.toContain('/p/');
  });
  it('draws each running or recent job, a session chip where it has a conversation, and its open tickets as ticket chips', async () => {
    answer(world());
    // The side form is who it is and what it has in hand: it counts the jobs running and draws none, and no tickets.
    await draw('agent', { agent: 'art' }, 'side');
    expect(asked.find((q) => q.name === 'BrickAgentJobs')!.options).toMatchObject({ pause: true });
    expect(placed()).toEqual([]);
    await draw('agent', { agent: 'art' }, 'primary');
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
    await draw('agent', { agent: 'mira' }, 'primary');
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
    expect(placed().filter((p) => p.brick === 'session')).toHaveLength(0);
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
    await draw('agent', { agent: 'art' }, 'primary');
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
    expect(all()).toContain('Quiet');
    await draw('agent', { agent: 'art' }, 'primary');
    expect(all()).toContain('Can’t read jobs right now.');
  });
  it('is headed by its name and shows the reference only in the small line', () => {
    expect(brickView('agent').title({ agent: 'art' })).toBe('Agent');
    expect(brickView('agent').sub({ agent: 'art' })).toBe('art');
  });
});

describe('agent: its activity posts', () => {
  const post = (id: string, over: object = {}) => ({ id, at, words: 'Post **' + id + '**', source: 'agent', sourceTask: null, work: [], ...over });
  const threads = [
    { thread: 'ap-fence', title: 'The fence', latest: post('p-9', { words: 'Fence is *mended*' }), parent: null },
    { thread: 'ap-hens', title: 'The hens', latest: post('p-8'), parent: null },
  ];
  const opens = () => tree!.root.findAll((n) => n.type === 'button' && n.props.className === 'board-opens');
  const history = (pages: Record<string, unknown[]>) => (variables: { after: string }) => ({ agentActivityHistory: pages[variables.after] ?? [] });
  const answerWith = (over: Data) => {
    answer(world(over));
    const plainFeed = feed.getMockImplementation()!;
    // A read that answers from its variables (the history's cursor).
    feed.mockImplementation((query: string, variables: Record<string, unknown>, options?: { pause?: boolean }) => {
      const name = /^query (\w+)/.exec(query)![1], answerOf = over[name];
      if (typeof answerOf !== 'function') return plainFeed(query, variables, options);
      asked.push({ name, variables, options });
      return options?.pause ? { status: 'loading' } : { status: 'live', data: (answerOf as (v: unknown) => unknown)(variables) };
    });
  };
  it('reads the desktop\'s own selections, word for word', async () => {
    const desktop = await import('../pieces/attention/live-agent-posts');
    const brick = await import('./bricks-agent');
    expect(brick.agentFeedQuery).toBe(desktop.agentFeedQuery);
    expect(brick.agentHistoryQuery).toBe(desktop.agentHistoryQuery);
  });
  it('the big form lists its threads of posts, newest first, each with its latest post as plain words; the small forms read none', async () => {
    answer(world({ AgentActivityFeed: { agentActivityFeed: threads } }));
    await draw('agent', { agent: 'art' }, 'side');
    expect(asked.some((q) => q.name === 'AgentActivityFeed')).toBe(false);
    await draw('agent', { agent: 'art' }, 'compact');
    expect(asked.some((q) => q.name === 'AgentActivityFeed')).toBe(false);
    await draw('agent', { agent: 'art' }, 'primary');
    expect(asked.find((q) => q.name === 'AgentActivityFeed')!.variables).toEqual({ agent: 'art', limit: 6, compact: false, before: '0' });
    expect(opens().map((b) => [said(b), b.props['aria-expanded']])).toEqual([['The fence', false], ['The hens', false]]);
    expect(all()).toContain('Fence is mended');
    expect(all()).toContain('Post p-8');
    // Its history is not read until a thread is opened.
    expect(asked.some((q) => q.name === 'AgentActivityHistory')).toBe(false);
  });
  it('says when it has posted nothing, when its posts cannot be read, and that earlier threads are in the Agents app', async () => {
    answer(world());
    await draw('agent', { agent: 'art' }, 'primary');
    expect(all()).toContain('No updates yet.');
    answer(world({ AgentActivityFeed: null }));
    await draw('agent', { agent: 'art' }, 'primary');
    expect(all()).toContain('Can’t read its activity right now.');
    const six = Array.from({ length: 6 }, (_, n) => ({ thread: 'ap-' + n, title: 'Thread ' + n, latest: post('p-' + n), parent: null }));
    answer(world({ AgentActivityFeed: { agentActivityFeed: six } }));
    await draw('agent', { agent: 'art' }, 'primary');
    expect(opens()).toHaveLength(5);
    expect(all()).toContain('Earlier activity is in the Agents app.');
  });
  it('opens one thread\'s history on demand, a page at a time, with Earlier and Newer posts; closing it drops the read', async () => {
    const first = Array.from({ length: 26 }, (_, n) => post('p-' + (100 - n)));
    answerWith({ AgentActivityFeed: { agentActivityFeed: threads }, AgentActivityHistory: history({ '0': first, 'p-76': [post('p-75', { sourceTask: 't-7' })] }) });
    await draw('agent', { agent: 'art' }, 'primary');
    await act(async () => { opens()[0].props.onClick(); });
    expect(opens()[0].props['aria-expanded']).toBe(true);
    expect(asked.filter((q) => q.name === 'AgentActivityHistory').map((q) => q.variables)).toEqual([{ agent: 'art', thread: 'ap-fence', after: '0', limit: 26 }]);
    const posts = () => tree!.root.findAll((n) => n.props['aria-label'] === 'Posts' && n.type === 'ul')[0]?.findAll((n) => n.props.className === 'board-row') ?? [];
    expect(posts()).toHaveLength(25);
    expect(said(posts()[0])).toContain('Post p-100');
    expect(buttons().map(said)).toContain('Earlier posts');
    expect(buttons().map(said)).not.toContain('Newer posts');
    await press('Earlier posts');
    expect(asked.filter((q) => q.name === 'AgentActivityHistory').at(-1)!.variables).toEqual({ agent: 'art', thread: 'ap-fence', after: 'p-76', limit: 26 });
    expect(posts().map(said)).toEqual([expect.stringContaining('Post p-75')]);
    // A post made for a ticket is that ticket's chip.
    expect(placed()).toContainEqual({ brick: 'ticket', params: { ticket: 't-7' } });
    expect(buttons().map(said)).not.toContain('Earlier posts');
    await press('Newer posts');
    expect(posts()).toHaveLength(25);
    // Opening the other thread closes the first; closing it reads nothing more.
    await act(async () => { opens()[1].props.onClick(); });
    expect(opens().map((b) => b.props['aria-expanded'])).toEqual([false, true]);
    expect(asked.filter((q) => q.name === 'AgentActivityHistory').at(-1)!.variables).toMatchObject({ thread: 'ap-hens', after: '0' });
    await act(async () => { opens()[1].props.onClick(); });
    expect(opens().map((b) => b.props['aria-expanded'])).toEqual([false, false]);
    expect(posts()).toEqual([]);
  });
  it('drops an opened history when the brick leaves its big form, and starts closed when it is big again', async () => {
    answerWith({ AgentActivityFeed: { agentActivityFeed: threads }, AgentActivityHistory: history({ '0': [post('p-1')] }) });
    await draw('agent', { agent: 'art' }, 'primary');
    await act(async () => { opens()[0].props.onClick(); });
    asked.length = 0;
    await act(async () => tree!.update(element('agent', { agent: 'art' }, 'side')));
    expect(asked.some((q) => q.name === 'AgentActivityHistory' || q.name === 'AgentActivityFeed')).toBe(false);
    expect(opens()).toEqual([]);
    await act(async () => tree!.update(element('agent', { agent: 'art' }, 'primary')));
    expect(opens().map((b) => b.props['aria-expanded'])).toEqual([false, false]);
    expect(asked.some((q) => q.name === 'AgentActivityHistory')).toBe(false);
  });
  it('says when a thread\'s posts cannot be read, and draws no address of the desktop\'s', async () => {
    answerWith({ AgentActivityFeed: { agentActivityFeed: threads }, AgentActivityHistory: () => ({ agentActivityHistory: [post('p-1', { work: [{ id: 'w', title: 'Fence', state: 'done', href: '/p/desktop/work' }] })] }) });
    await draw('agent', { agent: 'art' }, 'primary');
    await act(async () => { opens()[0].props.onClick(); });
    expect(JSON.stringify(tree!.toJSON())).not.toContain('/p/');
    answer(world({ AgentActivityFeed: { agentActivityFeed: threads }, AgentActivityHistory: null }));
    await draw('agent', { agent: 'art' }, 'primary');
    await act(async () => { opens()[0].props.onClick(); });
    expect(all()).toContain('Can’t read these posts right now.');
  });
});

describe('agents', () => {
  it('gives each agent the one face the page draws: its stored sprite, Art\'s built-in sprite for Art, or the face made from its colours', async () => {
    const look = (id: string, over: object = {}) => ({ id, markBg: '#3366ff', markFg: '#ffffff', faceShape: 'clover', faceEyes: 'dot', spriteVersion: null, ...over });
    const faces = () => tree!.root.findAll((n) => n.props.className === 'boards-face' && !tree!.root.findAll((m) => m.props.className === 'boards-face' && m !== n && m.findAll((x) => x === n).length > 0).length);
    // Art with nothing stored: the built-in sprite, in the roster as in the header. Mira: her generated face.
    answer(world({ DeskAgentDisplays: { agents: [look('art'), look('mira')] } }));
    await draw('agents', {}, 'side');
    expect(faces().map((face) => [face.props['data-sprite'] ?? 'drawn', face.props.style.width])).toEqual([['art', 32], ['drawn', 32]]);
    expect(tree!.root.findAllByType('art-sprite')).toHaveLength(1);
    expect(tree!.root.findAllByType('svg').map((svg) => svg.props['data-shape'])).toEqual(['clover']);
    // An agent the household keeps a sprite for is drawn from it (by the desktop's renderer, fetched when first drawn), and Art too.
    answer(world({ DeskAgentDisplays: { agents: [look('art', { spriteVersion: 'v3' }), look('mira', { spriteVersion: 'v1' })] } }));
    await draw('agents', {}, 'side');
    expect(faces().map((face) => face.props['data-sprite'])).toEqual(['stored', 'stored']);
    // A mark that would vanish into the card is drawn in the agent's other colour, in the scheme where it would.
    answer(world({ DeskAgentDisplays: { agents: [look('art'), look('mira', { markBg: '#07070c', markFg: '#e8e8f0' })] } }));
    await draw('agents', {}, 'side');
    expect(tree!.root.findAllByType('svg')[0].findAllByType('path')[0].props.style.stroke).toBe('light-dark(#07070c, #e8e8f0)');
    // In the `agent` brick the face heads the brick, larger and framed.
    await draw('agent', { agent: 'art' }, 'side');
    expect(faces().map((face) => [face.props['data-sprite'], face.props['data-framed'], face.props.style.width])).toEqual([['art', true, 48]]);
  });
  it('lists the member\'s own agents in Home\'s order, each a chip that places its agent brick, with its state and current work', async () => {
    answer(world());
    await draw('agents', {}, 'side');
    // Not a removed agent, and not one that is someone else's.
    expect(placed()).toEqual([{ brick: 'agent', params: { agent: 'art' } }, { brick: 'agent', params: { agent: 'mira' } }]);
    // Each agent is a row of the kit: its name, where it stands at the row's end, and what it is doing under them.
    const lines = tree!.root.findAll((n) => n.props.className === 'board-row').map(said);
    expect(lines[0]).toBe('ArtWorking · 1 needs youTaking a hand-off from Mira · Fence survey +3 more');
    expect(asked.filter((q) => q.name === 'DeskDoing').map((q) => q.variables)).toEqual(expect.arrayContaining([{ agent: 'art' }, { agent: 'mira' }]));
    expect(buttons()).toEqual([]);
    expect(tree!.root.findAllByType('a')).toEqual([]);
  });
  it('says an idle agent is quiet, and when the member has no agents', async () => {
    answer(world({ DeskDoing: { agentDoing: { items: [], more: 0, claimed: 0 } } }));
    await draw('agents', {}, 'side');
    expect(tree!.root.findAll((n) => n.props.className === 'board-row').map(said)).toEqual(['ArtWaiting · 1 needs you', 'MiraQuiet']);
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
