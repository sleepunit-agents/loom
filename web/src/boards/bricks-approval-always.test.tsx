/** The standing answer on the `approval` brick ("Always for <project>", docs/specs/boards.md, "The first bricks").
 * It is offered under the desktop's rule (web/src/data/work-approvals.ts, useStandingAnswer) and sent only after
 * it was asked about. The data hook and `fetch` are fakes: no real approval is answered and no rule is made. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { brickView } from './bricks';
import type { Form } from './layout';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn();
const head = 'a'.repeat(40);
const merge = { id: 'a-1', kind: 'merge', target: `github:acme/app#12@${head}`, actingFor: 'sam', operation: null as string | null, what: 'Merge the pump fix', why: 'Checks pass.', agent: 'art', project: 'pond',
  member: null, conversation: null, state: 'pending', ask: 'Merge the pump fix?', ifYes: 'It is merged.', ifNo: 'It stays open.', details: '', changeSummary: null, askedAt: '2026-11-14T20:00:00Z', decidedBy: null, expiresAt: null };
const change = { id: 'github:acme/app#12', state: 'open', agent: 'art', project: 'pond', headCommit: head };
const world = { row: merge as object, change: change as object | null, changeStatus: 'live', owner: true, members: [{ id: 'sam', role: 'member' }] as object[], ok: true };
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset();
  Object.assign(world, { row: merge, change, changeStatus: 'live', owner: true, members: [{ id: 'sam', role: 'member' }], ok: true });
  feed.mockImplementation((query: string, variables: object, options?: { pause?: boolean }) => {
    const name = /^query (\w+)/.exec(query)![1];
    if (name === 'InlineApproval') return { status: 'live', data: { approvals: [world.row], approvalRecord: [] } };
    if (name === 'WorkAnswerOwner') return { status: 'live', data: { workAnswerOwner: world.owner, workChangesRefresh: false, members: world.members } };
    if (name === 'WorkViewer') return { status: 'live', data: { homeComms: { member: 'lee' } } };
    if (name === 'ApprovalChange') {
      if (options?.pause) return { status: 'loading' };
      expect(variables).toEqual({ id: 'github:acme/app#12', head });
      return world.changeStatus === 'live' ? { status: 'live', data: { changes: world.change ? [world.change] : [] } } : { status: world.changeStatus };
    }
    throw new Error('A read the approval brick should not make: ' + name);
  });
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const input = JSON.parse(init.body).input;
    sent(url, input);
    return { ok: world.ok, status: world.ok ? 200 : 409, json: async () => (world.ok ? { ok: true, value: { id: input.approval ?? input.id } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

async function draw(form: Form = 'side') { await act(async () => { tree?.unmount(); tree = create(h(brickView('approval').Body, { params: { approval: 'a-1' }, form, act: reported, raise: () => {} })); }); }
const text = () => JSON.stringify(tree!.toJSON());
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const labels = () => buttons().map(said);
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });
const offer = 'Always for pond, Sam’s work only…';

it('offers the standing answer exactly where the desktop does: a waiting merge of the agent\'s own open pull request, at that commit, in that project, for a person of the household', async () => {
  for (const form of ['primary', 'side'] as const) { await draw(form); expect(labels(), form).toEqual(['Allow', offer, 'Deny']); }
  await draw('compact');
  expect(buttons()).toEqual([]);
  // An owner's own work is covered for everyone: the label names no person.
  world.members = [{ id: 'sam', role: 'owner' }];
  await draw();
  expect(labels()).toEqual(['Allow', 'Always for pond…', 'Deny']);
  const never: [string, object][] = [
    ['a member who may not answer', { owner: false }],
    ['a person who is not of the household', { members: [] }], ['a guest', { members: [{ id: 'sam', role: 'guest' }] }],
    ['a request that is not a merge', { row: { ...merge, kind: 'command' } }], ['an answered request', { row: { ...merge, state: 'allowed' } }],
    ['a household change', { row: { ...merge, operation: 'household.change' } }], ['a request with no project', { row: { ...merge, project: null } }],
    ['a request for nobody', { row: { ...merge, actingFor: 'unknown' } }], ['a target that names no commit', { row: { ...merge, target: 'github:acme/app#12' } }],
    ['a pull request loom no longer reads at that commit', { change: null }], ['a pull request still loading', { changeStatus: 'loading' }], ['a pull request that cannot be read', { changeStatus: 'offline' }],
    ['a closed pull request', { change: { ...change, state: 'merged' } }], ['another agent\'s pull request', { change: { ...change, agent: 'mark' } }],
    ['a pull request of another project', { change: { ...change, project: 'garden' } }], ['a pull request with no agent', { change: { ...change, agent: null } }],
  ];
  for (const [why, over] of never) {
    Object.assign(world, { row: merge, change, changeStatus: 'live', owner: true, members: [{ id: 'sam', role: 'member' }] }, over);
    await draw();
    expect(labels().filter((label) => label.startsWith('Always')), why).toEqual([]);
  }
  expect(sent.mock.calls.filter(([url]) => String(url).startsWith('/api/approvals/'))).toEqual([]);
});

it('asks before the standing answer: the first press sends nothing, Cancel sends nothing, and only the yes sends approvals.always and tells the board', async () => {
  await draw();
  await press(offer);
  expect(sent).not.toHaveBeenCalled();
  expect(reported).not.toHaveBeenCalled();
  expect(text()).toContain('makes a standing rule');
  expect(labels()).toEqual(['Allow', 'Deny', 'Yes, always allow', 'Cancel']);
  await press('Cancel');
  expect(labels()).toEqual(['Allow', offer, 'Deny']);
  expect(sent).not.toHaveBeenCalled();
  await press(offer);
  await press('Yes, always allow');
  // The one input the desktop sends: the request, the pull request at its commit, the project and whose work.
  expect(sent.mock.calls).toEqual([['/api/approvals/always', { approval: 'a-1', change: 'github:acme/app#12', head, project: 'pond', person: 'sam' }]]);
  expect(reported.mock.calls).toEqual([['always', {}]]);
  expect(labels()).toEqual(['Allow', offer, 'Deny']);
});

it('tells the board nothing when loom does not take the standing answer, and says so', async () => {
  world.ok = false;
  await draw();
  await press(offer);
  await press('Yes, always allow');
  expect(sent).toHaveBeenCalledTimes(1);
  expect(reported).not.toHaveBeenCalled();
  expect(tree!.root.findAll((node) => node.props.role === 'alert').map(said)).toEqual(['Could not save your answer. Reconnect and try again.']);
  // Allow and Deny are as before.
  world.ok = true;
  await press('Allow');
  expect(sent.mock.calls.at(-1)).toEqual(['/api/approvals/answer', { id: 'a-1', answer: 'allow' }]);
  expect(reported.mock.calls).toEqual([['approve', {}]]);
});
