/** The `subscriptions` brick (docs/specs/boards.md, "The first bricks"). The data hook is a fake and so is `fetch`:
 * what is checked is what is drawn, the request loom would receive, and what the board is told. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, brickView, loadBricks } from './bricks';
import type { Form } from './layout';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; update(element: unknown): void; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn(), raised = vi.fn();
let ok = true;
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); raised.mockReset(); ok = true;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    sent(url, body.input, body.id);
    return { ok, status: ok ? 200 : 500, json: async () => (ok ? { ok: true, value: { id: 'x' } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

const recent = new Date(Date.now() - 60_000).toISOString(), old = new Date(Date.now() - 2 * 3_600_000).toISOString(), later = new Date(Date.now() + 86_400_000).toISOString();
const login = (over: object = {}) => ({ reporting: true, expired: false, needsSignIn: false, canRequest: false, box: { id: 'box-1', name: 'Den' }, place: 'host', harness: 'codex', state: 'signed-in', expiresAt: null, checkedAt: recent, ...over });
const detail = (over: object = {}) => ({ __typename: 'RuntimeAccountDetail', label: 'Main subscription', level: 'plenty', id: 'account-1', owner: 'sam', provider: 'acme', usage: 0.2, usageReadAt: recent, resetsAt: later, hasRoom: true,
  pendingSignIns: [], signedInOn: [{ id: 'box-1', name: 'Den' }], windows: [{ window: 'week', usage: 0.58, usageReadAt: old, resetsAt: later, reserve: 0.1 }, { window: 'session', usage: null, usageReadAt: null, resetsAt: null, reserve: null }],
  logins: [login(), login({ box: { id: 'box-2', name: 'Attic' }, place: 'containers', state: 'signed-out', needsSignIn: true, canRequest: true })], ...over });
const summary = { __typename: 'RuntimeAccountSummary', label: 'Shared account', level: 'almost full' };
const week = { window: 'week', resetsAt: later, usage: 0.3, unattributed: 0.05, agents: [{ key: 'art', title: 'art', share: 0.2, href: null }], triggers: [{ key: null, title: 'No visible trigger', share: 0.2, href: null }],
  conversations: [{ key: 'cv-fence-1', title: 'Fence talk', share: 0.2, href: '/p/comms-preview/conversation/cv-fence-1' }] };
type World = { accounts?: object[] | null; setup?: object | null; loading?: boolean };
const answer = (w: World = {}) => feed.mockImplementation((query: string, variables?: object, options?: { pause?: boolean }) => {
  if (options?.pause || w.loading) return { status: 'loading' };
  if (query.startsWith('query RuntimeModelAccounts')) return w.accounts === null ? { status: 'error' } : { status: 'live', data: { deskTime: { timezone: 'UTC' }, agents: [{ id: 'art', removedAt: null }, { id: 'gone', removedAt: recent }],
    agentModels: [{ agent: 'art', model: 'big-one', position: 0 }, { agent: 'art', model: 'small-one', position: 1 }, { agent: 'gone', model: 'hidden-one', position: 0 }], modelAccounts: w.accounts ?? [detail(), summary] } };
  if (query.includes('subscriptionSetup')) return { status: 'live', data: { subscriptionSetup: w.setup === undefined ? { member: 'sam', providers: ['acme', 'other'], machines: [{ id: 'box-2', name: 'Attic' }, { id: 'box-1', name: 'Den' }] } : w.setup } };
  if (query.startsWith('query WeeklySubscriptions')) { expect(variables).toEqual({ detailId: 'account-1' }); return { status: 'live', data: { modelAccounts: [{ id: 'account-1', label: 'Main subscription', weeklyUsage: [week] }] } }; }
  throw new Error('A read the subscriptions brick should not make: ' + query);
});
const element = (form: Form) => h(brickView('subscriptions').Body, { params: {}, form, act: reported, raise: raised });
async function draw(form: Form) { await act(async () => { tree?.unmount(); tree = create(element(form)); }); }
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const shown = () => said(tree!.root as Node);
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'select'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });
const type = (label: string, value: string) => act(async () => tree!.root.findAllByType('input').find((n) => n.props['aria-label'] === label)!.props.onChange({ target: { value } }));

it('lists accounts by service in the desktop\'s words: a full account with its sign-ins, a shared one as a label and a level', async () => {
  answer();
  await draw('primary');
  for (const words of ['2 subscriptions · 1 almost full · 1 sign-in needed', // A service is a small heading with its count and level; an account is a row: its label, a quiet line, its level.
    'acme', '1 · plenty · Sign-in needed', 'Main subscription', 'sam · 1 signed in · 1 needs attention', 'plenty',
    'Shared summaries', '1 · almost full', 'Shared account', 'almost full', 'big-one · Primary, small-one']) expect(shown(), words).toContain(words);
  expect(shown()).not.toContain('hidden-one');
  expect(placed()).toEqual([{ brick: 'agent', params: { agent: 'art' } }]);
  expect(sent).not.toHaveBeenCalled();
});

it('opens an account: usage windows with a stale reading said, room, weekly usage by a chosen grouping, sign-ins and settings', async () => {
  answer();
  await draw('primary');
  await press('Main subscription');
  for (const words of ['Week', '58%', 'Stale reading (over an hour old)', 'Reserve 10%', 'Session', 'Not read yet', 'Has room', 'Yes', 'Week · 30% used', 'Unattributed', '5%', 'Den', 'codex · On the machine', 'Signed in',
    'Attic', 'codex · In houses', 'Signed out', 'Configured machines', 'Each percentage is a share']) expect(shown(), words).toContain(words);
  expect(placed()).toContainEqual({ brick: 'agent', params: { agent: 'art' } });
  expect(placed()).toContainEqual({ brick: 'person', params: { person: 'member:sam' } });
  await press('Conversation');
  expect(shown()).toContain('Fence talk');
  expect(placed()).toContainEqual({ brick: 'session', params: { session: 'cv-fence-1' } });
  await press('Trigger');
  expect(shown()).toContain('No visible trigger');
});

it('asks for a sign-in with runtime.accountSignIn only where loom says the member may, and tells the board nothing about which', async () => {
  answer();
  await draw('primary');
  await press('Main subscription');
  expect(buttons().filter((b) => said(b) === 'Sign in on this machine')).toHaveLength(1);
  await press('Sign in on this machine');
  expect(sent.mock.calls[0].slice(0, 2)).toEqual(['/api/runtime/accountSignIn', { account: 'account-1', box: 'box-2' }]);
  expect(reported).toHaveBeenCalledWith('signIn', {});
  expect(shown()).toContain('Sign-in requested. The subscription owner will receive the provider’s instructions in Inbox.');
  expect(buttons().find((b) => said(b) === 'Sign in on this machine')!.props.disabled).toBe(true);
});

it('reports nothing when a sign-in request is not confirmed', async () => {
  answer(); ok = false;
  await draw('primary');
  await press('Main subscription');
  await press('Sign in on this machine');
  expect(reported).not.toHaveBeenCalled();
  expect(shown()).toContain('Could not confirm the request. Check Inbox or retry.');
});

it('searches and keeps to what needs attention inside the brick; what is typed reaches no read and no act', async () => {
  answer({ accounts: [detail(), detail({ id: 'account-2', label: 'Quiet one', logins: [login()] }), summary] });
  await draw('primary');
  const reads = feed.mock.calls.length;
  await type('Search subscriptions', 'quiet');
  expect(shown()).toContain('Quiet onesam'); expect(shown()).not.toContain('Main subscription');
  await type('Search subscriptions', 'zebra');
  expect(shown()).toContain('No matching subscriptions.');
  await type('Search subscriptions', '');
  await press('Needs attention');
  expect(shown()).toContain('Main subscriptionsam'); expect(shown()).toContain('Shared account'); expect(shown()).not.toContain('Quiet one');
  expect(JSON.stringify(feed.mock.calls.slice(reads))).not.toContain('zebra');
  expect(reported).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
});

it('adds a subscription with runtime.accountCreate, what the desktop sends, the same request id on a retry, and nothing typed to the board', async () => {
  answer();
  await draw('primary');
  await press('Add a subscription');
  const label = () => tree!.root.findAllByType('label').find((l) => said(l) === 'Label')!.findAllByType('input')[0];
  const submit = () => act(async () => tree!.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));
  await submit();
  expect(shown()).toContain('Give the subscription a label.'); expect(sent).not.toHaveBeenCalled();
  await act(async () => label().props.onChange({ target: { value: ' Second plan ' } }));
  await press('other'); await press('Den'); await press('Attic');
  ok = false;
  await submit();
  expect(shown()).toContain('Could not confirm creation. Check the list or retry with the same settings.');
  expect(reported).not.toHaveBeenCalled();
  ok = true;
  await submit();
  expect(sent.mock.calls[1].slice(0, 2)).toEqual(['/api/runtime/accountCreate', { provider: 'other', label: 'Second plan', machines: ['box-1', 'box-2'] }]);
  expect(sent.mock.calls[1][2]).toBe(sent.mock.calls[0][2]);
  expect(reported).toHaveBeenCalledWith('create', {});
  expect(JSON.stringify(reported.mock.calls)).not.toMatch(/Second|other|box/);
  expect(shown()).toContain('Subscription added. Each selected machine has a sign-in request.');
});

it('offers no way to add a subscription to someone loom gives no choices', async () => {
  answer({ setup: null });
  await draw('primary');
  expect(buttons().map(said)).not.toContain('Add a subscription');
});

it('draws the side form as a list and the compact form as one line, neither with a control', async () => {
  answer();
  await draw('side');
  for (const words of ['Main subscription', 'plenty', 'Shared account', 'almost full']) expect(shown(), words).toContain(words);
  // Each subscription and how full it is; its windows and sign-ins are in the big form.
  for (const words of ['Week', '58%', 'sam · 1 signed in']) expect(shown(), words).not.toContain(words);
  expect(controls()).toEqual([]);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(shown()).toBe('2 subscriptions · 1 almost full · 1 sign-in needed');
  expect(controls()).toEqual([]);
});

it('says the list is unavailable when loom does not answer it, loading until it does, and so when there are none', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    answer({ accounts: null });
    await draw(form);
    expect(shown(), form).toBe('This list of subscriptions is unavailable.');
    expect(controls()).toEqual([]);
    answer({ loading: true });
    await draw(form);
    expect(shown(), form).toBe('Loading…');
  }
  answer({ accounts: [], setup: null });
  await draw('side');
  expect(shown()).toContain('No model accounts yet.');
});

it('flags itself when another sign-in is needed, and is headed by its name', async () => {
  answer({ accounts: [detail({ logins: [login()] })] });
  await draw('side');
  answer();
  await act(async () => { tree!.update(element('side')); });
  expect(raised).toHaveBeenCalledWith('Sign-in needed');
  expect(bricks.subscriptions.title({})).toBe('Subscriptions');
  expect(bricks.subscriptions.sub({})).toBe('');
});
