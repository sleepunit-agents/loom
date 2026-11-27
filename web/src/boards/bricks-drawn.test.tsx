/** The bricks drawn from loom's own records: pull, repository, question, approval (its answer is in
 * bricks-approval.test.tsx) and a person who is a contact
 * (docs/specs/boards.md, "The first bricks"). The data hook is a fake; the member's operations go to a fake fetch,
 * so what is checked is the request loom would receive. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, brickView, loadBricks, type Params } from './bricks';
import type { Form } from './layout';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; update(element: unknown): void; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn(), raised = vi.fn();
let answerOk = true;
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); raised.mockReset(); answerOk = true;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    sent(url, JSON.parse(init.body).input);
    return { ok: answerOk, status: answerOk ? 200 : 409, json: async () => (answerOk ? { ok: true, value: { saved: true } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

/** What each read answers, by the name of its query. `undefined` is a read still loading. */
type Data = Record<string, unknown>;
const answer = (data: Data) => feed.mockImplementation((query: string) => {
  const name = /^query (\w+)/.exec(query)![1];
  return name in data ? (data[name] === undefined ? { status: 'loading' } : { status: 'live', data: data[name] }) : { status: 'live', data: {} };
});
const element = (brick: string, params: Params, form: Form) => h(brickView(brick).Body, { params, form, act: reported, raise: raised });
async function draw(brick: string, params: Params, form: Form) {
  await act(async () => { tree?.unmount(); tree = create(element(brick, params, form)); });
  return tree!;
}
const text = () => JSON.stringify(tree!.toJSON());
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const buttons = () => tree!.root.findAllByType('button');
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });
/** A compact form is one line: one paragraph of the brief's class and nothing beside it. */
const oneLine = () => { const json = tree!.toJSON() as { type: string; props: { className: string } }; expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief'); };

const change = { id: 'github:acme/app#12', repository: 'acme/app', number: 12, title: 'Read the pump twice', state: 'open', draft: false, authorLogin: 'art-bot',
  project: 'pond', agent: 'art', branch: 'art/pump', baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci' };
const pullData = (over: object = {}) => ({ BrickPull: {
  changes: [{ ...change, ...over }],
  changeChecks: [{ change: change.id, name: 'unit', state: 'running' }, { change: change.id, name: 'build', state: 'failing' }],
  changePeople: [{ change: change.id, login: 'sam', role: 'requested' }],
  // The second ticket is one the member may not read: its row does not come back.
  changeTasks: [{ change: change.id, task: 't-41', taskRow: { id: 't-41', title: 'Pump reads low', status: 'in_progress' } }, { change: change.id, task: 't-99', taskRow: null }],
} });
const item = { id: 'in-pump', canAnswer: true, source: 'thread', agent: 'art', project: 'pond', at: '2026-11-14T20:00:00Z', state: 'waiting', volume: 'full', answers: 'yes-no',
  read: false, refs: ['t-12'], body: { words: 'Replace the pump filter?', why: 'It is clogged.', ifYes: 'I order one.', ifNo: 'I clean the old one.' } };
const approval = { id: 'a-1', kind: 'dangerous', target: 'pond/pump', actingFor: 'sam', operation: null, what: 'Drain the pond', why: 'The liner leaks.', agent: 'art', project: 'pond',
  member: 'sam', conversation: null, state: 'pending', ask: 'Drain the pond tonight?', ifYes: 'The pond is emptied.', ifNo: 'It keeps leaking.', details: 'pump --drain --all',
  changeSummary: null, askedAt: '2026-11-14T20:00:00Z', decidedBy: null, expiresAt: null };
const contact = { id: 'commons:anton', slug: 'anton', agent: null, name: 'Anton Avguchenko', updated: '2026-11-01', synthesizedAt: null, kind: 'person', newer: 0, mergedFrom: null,
  card: { slug: 'anton', name: 'Anton Avguchenko', summary: 'Fits the pond liners.', where: [], how: [], may: [] }, evidence: [],
  fields: [{ key: 'email', value: 'anton@example.test', label: 'work', source: null, verifiedAt: null, state: 'fresh' }],
  projects: [{ agent: 'art', slug: 'pond', name: 'Pond', status: 'active', href: null }], ownership: null, sightings: [], conversations: { available: true, rows: [] }, history: [] };

const drawn: [string, Params, Data, string, string][] = [
  ['pull', { change: change.id }, pullData(), 'Read the pump twice', 'pull request'],
  ['repository', { repository: 'acme/app' }, { BrickRepository: { open: [change], known: [{ id: change.id }] } }, '1 open pull request', 'repository'],
  ['question', { item: 'in-pump' }, { InboxItem: { inboxItem: item } }, 'Replace the pump filter?', 'question'],
  ['approval', { approval: 'a-1' }, { InlineApproval: { approvals: [approval], approvalRecord: [] } }, 'Drain the pond', 'approval'],
  ['person', { person: 'contact:anton' }, { MemoryPerson: { memoryPerson: contact } }, 'Anton Avguchenko', 'person'],
];
const missing: Record<string, Data> = {
  pull: { BrickPull: { changes: [], changeChecks: [], changePeople: [], changeTasks: [] } }, repository: { BrickRepository: { open: [], known: [] } },
  question: { InboxItem: { inboxItem: null } }, approval: { InlineApproval: { approvals: [], approvalRecord: [] } }, person: { MemoryPerson: { memoryPerson: null } },
};

it.each(drawn)('draws %s in all three forms, its compact form as one line', async (brick, params, data, words) => {
  answer(data);
  for (const form of ['primary', 'side'] as const) {
    await draw(brick, params, form);
    expect(text(), form).toContain(words);
    expect(text(), form).not.toContain('does not draw this brick');
  }
  await draw(brick, params, 'compact');
  oneLine();
  expect(text()).toContain(words);
  expect(controls()).toEqual([]);
});

it.each(drawn)('draws %s as unavailable when its record is not there or may not be read, and as loading until it answers', async (brick, params, _data, _words, what) => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    answer(missing[brick]);
    await draw(brick, params, form);
    expect(said(tree!.root as Node), form).toBe(`This ${what} is unavailable.`);
    expect(controls()).toEqual([]);
    answer(Object.fromEntries(Object.keys(missing[brick]).map((name) => [name, undefined])));
    await draw(brick, params, form);
    expect(said(tree!.root as Node), form).toBe('Loading…');
  }
  expect(sent).not.toHaveBeenCalled();
});

it('heads every brick by its name and shows a reference only in the small line', () => {
  for (const [brick, params] of drawn) {
    const view = bricks[brick];
    for (const value of Object.values(params)) {
      expect(view.title(params), brick).not.toContain(String(value));
      expect(view.sub(params), brick).toContain(String(value));
    }
  }
  expect(bricks.repository.sub({ repository: 'acme/app', project: 'pond' })).toBe('acme/app · pond');
});

it('shows a pull request with its state, checks, review, who it waits on, and the tickets the member may read as chips', async () => {
  answer(pullData());
  await draw('pull', { change: change.id }, 'side');
  expect(feed.mock.calls[0][1]).toEqual({ id: change.id });
  expect(text()).toContain('Checks running · Review needed · Waiting on the checks');
  expect(placed()).toEqual([{ brick: 'repository', params: { repository: 'acme/app' } }, { brick: 'project', params: { project: 'pond' } },
    { brick: 'agent', params: { agent: 'art' } }, { brick: 'ticket', params: { ticket: 't-41' } }]);
  await draw('pull', { change: change.id }, 'primary');
  for (const more of ['art/pump', 'into ', 'next', 'Failing', 'build', 'Running', 'unit', 'Asked to review', 'sam', 'Pump reads low', 'Not known yet']) expect(text(), more).toContain(more);
  expect(text()).not.toContain('t-99');
  // It has no action: a merge is answered through its approval, on the desktop.
  answer(pullData({ waitingOn: 'you' }));
  await draw('pull', { change: change.id }, 'primary');
  expect(text()).toContain('The merge is answered in Changes on the desktop.');
  expect(controls()).toEqual([]);
  for (const [over, word] of [[{ draft: true }, 'Draft'], [{ state: 'merged' }, 'Merged'], [{ state: 'closed' }, 'Closed'], [{}, 'Open']] as const) {
    answer(pullData(over));
    await draw('pull', { change: change.id }, 'compact');
    expect(said(tree!.root.findAll((node) => node.props.className === 'board-state')[0]), word).toBe(word);
  }
  expect(sent).not.toHaveBeenCalled();
});

it('flags a pull request when its checks go to failing, or it is merged or closed, and for nothing else', async () => {
  const steps: [object, string | null][] = [[{ checks: 'passing' }, null], [{ checks: 'failing' }, 'Checks failing'], [{ checks: 'failing', review: 'approved' }, null],
    [{ checks: 'passing' }, null], [{ checks: 'passing', state: 'merged' }, 'Merged']];
  answer(pullData());
  await draw('pull', { change: change.id }, 'side');
  expect(raised).not.toHaveBeenCalled();
  for (const [over, flag] of steps) {
    raised.mockReset();
    answer(pullData(over));
    await act(async () => tree!.update(element('pull', { change: change.id }, 'side')));
    expect(raised.mock.calls, JSON.stringify(over)).toEqual(flag ? [[flag]] : []);
  }
  answer(pullData());
  await draw('pull', { change: change.id }, 'side');
  raised.mockReset();
  answer(pullData({ state: 'closed' }));
  await act(async () => tree!.update(element('pull', { change: change.id }, 'side')));
  expect(raised.mock.calls).toEqual([['Closed']]);
});

it('shows a repository by its open pull requests, each a pull chip, in one project when one is given', async () => {
  const second = { ...change, id: 'github:acme/app#14', number: 14, title: 'Quieter pump', waitingOn: 'you' };
  answer({ BrickRepository: { open: [change, second], known: [{ id: change.id }] } });
  await draw('repository', { repository: 'github:Acme/App.git' }, 'side');
  // The repository is asked for as `changes.repository` is written.
  expect(feed.mock.calls[0][1]).toEqual({ repository: 'acme/app' });
  expect(feed.mock.calls[0][0]).not.toContain('$project');
  expect(placed()).toEqual([{ brick: 'pull', params: { change: 'github:acme/app#12' } }, { brick: 'pull', params: { change: 'github:acme/app#14' } }]);
  expect(text()).toContain('1 waiting on you');
  await draw('repository', { repository: 'acme/app', project: 'pond' }, 'primary');
  expect(feed.mock.calls.at(-1)![1]).toEqual({ repository: 'acme/app', project: 'pond' });
  expect(feed.mock.calls.at(-1)![0]).toContain('project:{eq:$project}');
  expect(text()).toContain('Quieter pump');
  expect(text()).toContain('Waiting on you');
  expect(placed()).toHaveLength(2);
  // Known, with nothing open.
  answer({ BrickRepository: { open: [], known: [{ id: change.id }] } });
  await draw('repository', { repository: 'acme/app' }, 'side');
  expect(said(tree!.root as Node)).toBe('No open pull requests.');
  await draw('repository', { repository: 'acme/app' }, 'compact');
  expect(said(tree!.root as Node)).toBe('No open pull requests');
});

it('answers a question through inbox.answer and then tells the board which answer, never the words', async () => {
  answer({ InboxItem: { inboxItem: item } });
  // Every way of answering is in the primary form; the side form is the question and its main answer.
  await draw('question', { item: 'in-pump' }, 'side');
  expect(buttons().filter((b) => !b.props['data-place']).map(said)).toEqual(['Yes', 'No']);
  await draw('question', { item: 'in-pump' }, 'primary');
  for (const shown of ['It is clogged.', 'I order one.', 'I clean the old one.', 'art']) expect(text(), shown).toContain(shown);
  expect(placed()).toEqual([{ brick: 'agent', params: { agent: 'art' } }, { brick: 'project', params: { project: 'pond' } }, { brick: 'ticket', params: { ticket: 't-12' } }]);
  expect(buttons().filter((b) => !b.props['data-place']).map(said)).toEqual(['Yes', 'No', 'Mark done', 'Dismiss', 'Record answer']);
  await press('Yes');
  expect(sent.mock.calls).toEqual([['/api/inbox/answer', { item: 'in-pump', answer: 'yes' }]]);
  expect(reported.mock.calls).toEqual([['answer', { answer: 'yes' }]]);
  for (const [label, verdict] of [['No', 'no'], ['Mark done', 'done'], ['Dismiss', 'dismiss']]) {
    sent.mockReset(); reported.mockReset();
    await press(label);
    expect(sent.mock.calls).toEqual([['/api/inbox/answer', { item: 'in-pump', answer: verdict }]]);
    expect(reported.mock.calls).toEqual([['answer', { answer: verdict }]]);
  }
  // Words go to the operation. The board hears only that the answer was in words.
  sent.mockReset(); reported.mockReset();
  const record = () => buttons().find((b) => said(b) === 'Record answer')!;
  expect(record().props.disabled).toBe(true);
  await act(async () => tree!.root.findAllByType('input')[0].props.onChange({ target: { value: '  Order two, on Tuesday  ' } }));
  expect(record().props.disabled).toBe(false);
  await act(async () => { await tree!.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }); });
  expect(sent.mock.calls).toEqual([['/api/inbox/answer', { item: 'in-pump', answer: 'words', words: 'Order two, on Tuesday' }]]);
  expect(reported.mock.calls).toEqual([['answer', { answer: 'words' }]]);
  expect(JSON.stringify(reported.mock.calls)).not.toContain('Tuesday');
});

it('tells the board nothing when the answer did not save', async () => {
  answer({ InboxItem: { inboxItem: item } });
  await draw('question', { item: 'in-pump' }, 'side');
  answerOk = false;
  await press('Yes');
  expect(sent).toHaveBeenCalledTimes(1);
  expect(reported).not.toHaveBeenCalled();
  expect(said(tree!.root.findAll((node) => node.props.role === 'alert')[0])).toBe('Could not save. Try again.');
});

it('shows an answered question with its answer and no controls, and offers none where the desktop offers none', async () => {
  answer({ InboxItem: { inboxItem: { ...item, state: 'answered', answer: 'no', answeredBy: 'sam', answeredAt: '2026-11-15T09:00:00Z' } } });
  for (const form of ['side', 'primary'] as const) {
    await draw('question', { item: 'in-pump' }, form);
    expect(text()).toContain('No · sam');
    expect(controls()).toEqual([]);
  }
  await draw('question', { item: 'in-pump' }, 'compact');
  expect(said(tree!.root as Node)).toBe('No Replace the pump filter?');
  // A question that takes words has no Yes or No.
  answer({ InboxItem: { inboxItem: { ...item, answers: 'words' } } });
  await draw('question', { item: 'in-pump' }, 'side');
  expect(buttons().filter((b) => !b.props['data-place']).map(said)).toEqual(['Record answer']);
  await draw('question', { item: 'in-pump' }, 'primary');
  expect(buttons().filter((b) => !b.props['data-place']).map(said)).toEqual(['Mark done', 'Dismiss', 'Record answer']);
  const closed: [string, object][] = [
    ['the member may not answer it', { canAnswer: false }],
    ['it is an approval, answered on its own card', { source: 'approval', waitsOnKind: 'approval', waitsOnId: 'a-1' }],
    ['it is a secret request, answered in Secrets', { source: 'secret-request', sourceId: 'sr-1' }],
    ['it takes no answer', { answers: null }],
    ['its words are gone', { body: null }],
    ['its private words are past their keep time', { thread: 'th:1', bodyKeepUntil: '2020-01-01T00:00:00Z' }],
    ['it was settled without an answer', { state: 'resolved', resolution: 'The task was closed.' }],
  ];
  for (const [why, over] of closed) {
    answer({ InboxItem: { inboxItem: { ...item, ...over } } });
    await draw('question', { item: 'in-pump' }, 'side');
    expect(controls(), why).toEqual([]);
  }
  answer({ InboxItem: { inboxItem: { ...item, source: 'approval', waitsOnKind: 'approval', waitsOnId: 'a-1', refs: [] } } });
  await draw('question', { item: 'in-pump' }, 'side');
  expect(text()).toContain('This is answered where it was asked.');
  expect(placed()).toContainEqual({ brick: 'approval', params: { approval: 'a-1' } });
  expect(sent).not.toHaveBeenCalled();
});

// The approval brick's own suite is bricks-approval.test.tsx.
it('keeps every way of answering a merge out of the pull request brick', () => {
  const pull = readFileSync(new URL('./bricks-pull.tsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  for (const way of ['memberOperation', 'sendWorkAnswer', 'fetch', 'data/operation', 'onClick', '<button']) expect(pull, way).not.toContain(way);
});

it('shows a contact by the card People opens, and still shows a member by their open tickets', async () => {
  answer({ MemoryPerson: { memoryPerson: contact } });
  await draw('person', { person: 'contact:anton' }, 'side');
  expect(feed.mock.calls[0][1]).toEqual({ id: 'commons:anton' });
  for (const shown of ['Anton Avguchenko', 'Fits the pond liners.', 'email', 'work', 'anton@example.test', 'fresh']) expect(text(), shown).toContain(shown);
  expect(controls()).toEqual([]);
  await draw('person', { person: 'contact:anton' }, 'compact');
  expect(said(tree!.root as Node)).toBe('Anton Avguchenko · Fits the pond liners.');
  answer({ BrickAssigned: { rows: [{ id: 't-7', title: 'Order a filter', status: 'open' }] } });
  await draw('person', { person: 'member:sam' }, 'side');
  expect(feed.mock.calls.at(-1)![1]).toEqual({ ref: 'sam' });
  expect(text()).toContain('open ticket');
  expect(placed()).toEqual([{ brick: 'ticket', params: { ticket: 't-7' } }]);
});
