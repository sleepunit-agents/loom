/** The `household` brick (docs/specs/boards.md, "The first bricks"). The data hook is a fake and so is `fetch`:
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
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn(), checked = vi.fn();
let ok = true;
const at = '2026-11-14T15:00:00Z', print = 'f'.repeat(64), ref = 'e'.repeat(64);
const agent = (id: string, over: object = {}) => ({ id, spriteVersion: null, about: `About ${id}`, markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot', github: [], removedAt: null, ...over });
const setup = {
  defaultAgent: 'art',
  members: [{ id: 'sam', role: 'owner', fullOwner: true, agents: [] }, { id: 'lee', role: 'member', fullOwner: false, agents: ['bea', 'gone'] }],
  agents: [agent('art', { github: ['art-bot'], spriteVersion: 'v1' }), agent('bea'), agent('gone', { removedAt: at })],
  tokens: [{ fingerprint: print, label: 'Laptop CLI', kind: 'owner', expired: false, identity: 'sam', createdAt: at, expiresAt: null, revokedAt: null, lastUsedAt: null },
    { fingerprint: 'd'.repeat(64), label: 'Old one', kind: 'agent', expired: false, identity: 'art', createdAt: at, expiresAt: at, revokedAt: at, lastUsedAt: at }],
  sessions: [{ ref, device: 'Firefox on Linux', member: 'sam', tokenLabel: 'Passkey', isAgent: false, ended: false, issuedAt: at, seenAt: at }],
};
const programs = { owner: 'sam', catalogue: { records: ['tasks', 'projects'], operations: ['tasks.command', 'inbox.answer'] },
  tokens: [{ fingerprint: print, label: 'Sheet sync', member: 'lee', ended: false, records: ['tasks'], operations: [] }, { fingerprint: 'c'.repeat(64), label: 'Ended sync', member: null, ended: true, records: [], operations: [] }] };
let world: { status: string; setup: object | null; programs: object | null };
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); checked.mockReset(); ok = true; world = { status: 'live', setup, programs };
  feed.mockImplementation((query: string, _variables?: object, options?: { pause?: boolean }) => {
    if (options?.pause || world.status === 'loading') return { status: 'loading' };
    if (world.status !== 'live') return { status: world.status };
    if (query.includes('householdSetup')) return { status: 'live', data: { householdSetup: world.setup, boxes: [], boxAlertSettings: [] } };
    if (query.includes('programSetup')) return { status: 'live', data: { programSetup: world.programs } };
    throw new Error('A read the household brick should not make: ' + query);
  });
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === '/auth/session') { checked(); return { ok: true, status: 200, json: async () => ({ viewer: { id: 'sam' } }) }; }
    sent(url, JSON.parse(init!.body!).input);
    return { ok, status: ok ? 200 : 403, json: async () => (ok ? { ok: true, value: { revoked: true } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

async function draw(form: Form) { await act(async () => { tree?.unmount(); tree = create(h(brickView('household').Body, { params: {}, form, act: reported, raise: () => {} })); }); }
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const shown = () => said(tree!.root as Node);
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'select'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });

it('lists members and agents as Household setup does, each member a person chip and each agent an agent chip', async () => {
  await draw('primary');
  // Who is in the household leads; how they get in is the quiet line under it.
  for (const words of ['2 members · 2 agents', '1 active token · 1 signed-in browser', 'Household owner', 'Owns every agent, present and future', 'Member', 'Default agent: art', 'No assigned owner', 'Owned by lee',
    'About art · GitHub accounts: art-bot · Animated portrait', 'About bea · GitHub accounts: none · Generated face', 'Removed: gone', 'ask the agent in the conversation', 'A new token is made on the desktop']) expect(shown(), words).toContain(words);
  expect(placed()).toEqual([{ brick: 'person', params: { person: 'member:sam' } }, { brick: 'person', params: { person: 'member:lee' } }, { brick: 'agent', params: { agent: 'bea' } },
    { brick: 'agent', params: { agent: 'art' } }, { brick: 'agent', params: { agent: 'bea' } }]);
});

it('shows tokens and browsers by label and state and never a value or a fingerprint', async () => {
  await draw('primary');
  for (const words of ['Laptop CLI', 'owner · sam', 'Active', 'Last used Never', 'Old one', 'Revoked', 'Firefox on Linux', 'sam · Passkey · Browser · Active']) expect(shown(), words).toContain(words);
  const drawn = JSON.stringify(tree!.toJSON());
  for (const hidden of [print, ref, 'loom_']) expect(drawn).not.toContain(hidden);
  // A revoked token has nothing left to revoke.
  expect(buttons().filter((b) => said(b) === 'Revoke token…')).toHaveLength(1);
});

it('revokes a token only after asking, with token.revoke, then checks the sign-in as the desktop does', async () => {
  await draw('primary');
  await press('Revoke token…');
  expect(shown()).toContain('Revoke this token? Whatever uses it stops working, and it cannot be restored.');
  expect(sent).not.toHaveBeenCalled();
  await press('Keep it');
  expect(sent).not.toHaveBeenCalled();
  await press('Revoke token…');
  await press('Revoke it');
  expect(sent.mock.calls).toEqual([['/api/token/revoke', { fingerprint: print }]]);
  expect(checked).toHaveBeenCalledTimes(1);
  expect(reported.mock.calls).toEqual([['revokeToken', {}]]);
  expect(shown()).toContain('Saved');
});

it('signs a browser out only after asking, with sessions.revoke, and reports nothing when loom refuses', async () => {
  await draw('primary');
  await press('Sign out browser…');
  expect(shown()).toContain('Sign this browser out? It must sign in again.');
  expect(sent).not.toHaveBeenCalled();
  ok = false;
  await press('Sign it out');
  expect(sent.mock.calls).toEqual([['/api/sessions/revoke', { ref }]]);
  expect(reported).not.toHaveBeenCalled();
  expect(shown()).toContain('Could not confirm revocation. Check your sign-in and connection.');
  ok = true;
  await press('Sign it out');
  expect(reported.mock.calls).toEqual([['revokeSession', {}]]);
});

it('changes what an outside program is allowed with program.setGrants, from the choices loom lists', async () => {
  await draw('primary');
  for (const words of ['A program uses its member\'s permissions', 'Sheet sync', 'Acts as lee · Active', '1 record type · 0 operations', 'Ended sync', 'Acts as an unavailable member · Ended']) expect(shown(), words).toContain(words);
  expect(buttons().filter((b) => said(b) === 'Grants')).toHaveLength(1);
  await press('Grants');
  expect(buttons().find((b) => said(b) === 'tasks')!.props['aria-pressed']).toBe(true);
  await press('projects'); await press('tasks'); await press('inbox.answer');
  await press('Save program grants');
  expect(sent.mock.calls).toEqual([['/api/program/setGrants', { fingerprint: print, records: ['projects'], operations: ['inbox.answer'] }]]);
  expect(checked).not.toHaveBeenCalled();
  expect(reported.mock.calls).toEqual([['setGrants', {}]]);
  expect(JSON.stringify(reported.mock.calls)).not.toMatch(/projects|inbox|ffff/);
});

it('draws the side form as members and agents and the compact form as one line, neither with a control', async () => {
  await draw('side');
  for (const words of ['2 members · 2 agents', 'Household owner', 'Default agent: art', 'Owned by lee']) expect(shown(), words).toContain(words);
  for (const words of ['Laptop CLI', 'Firefox', 'Sheet sync']) expect(shown(), words).not.toContain(words);
  expect(controls()).toEqual([]);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(shown()).toBe('2 members · 2 agents · 1 active token · 1 signed-in browser');
  expect(controls()).toEqual([]);
});

it('says the setup is unavailable to anyone who is not a household owner, and loading until loom answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    for (const next of [{ status: 'live', setup: null, programs: null }, { status: 'error', setup, programs }]) {
      world = next;
      await draw(form);
      expect(shown(), form).toBe('This household setup is unavailable.');
      expect(controls()).toEqual([]);
    }
    world = { status: 'loading', setup, programs };
    await draw(form);
    expect(shown(), form).toBe('Loading…');
  }
  expect(sent).not.toHaveBeenCalled();
});

it('is headed by its name', () => {
  expect(bricks.household.title({})).toBe('Household');
  expect(bricks.household.sub({})).toBe('');
});
