/** The `household` brick's Make a token (docs/specs/boards.md, "The first bricks"): a token made by the desktop's
 * sign-in door, its value drawn once in the brick, and the board told its label and kind and nothing else. The data
 * hook, `fetch` and the clipboard are fakes; what is checked is what loom would receive, what is drawn and when it is
 * forgotten, and everywhere the value could leak to: `act`, a flag, the data hook, a log, the address, storage. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { brickView, loadBricks } from './bricks';
import type { Form } from './layout';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; update(element: unknown): void; unmount(): void } | undefined;
const BEARER = 'loom_' + 'Q7'.repeat(21) + 'x', at = '2026-11-14T15:00:00Z';
const ADDRESS = 'https://loom.example.test/boards?board=b-1', moved = vi.fn(), stored = vi.fn();
const reported = vi.fn(), raised = vi.fn(), written = vi.fn(), logged: unknown[][] = [];
const requests: { url: string; body: any }[] = [];
let reply: () => { status: number; body: unknown };
/** When set, loom answers only once it resolves: a request still in flight. */
let hold: Promise<void> | null = null;
const setup = {
  defaultAgent: 'art',
  members: [{ id: 'sam', role: 'owner', fullOwner: true, agents: [] }, { id: 'lee', role: 'member', fullOwner: false, agents: [] }],
  agents: [{ id: 'art', spriteVersion: null, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot', github: [], removedAt: null }],
  tokens: [], sessions: [],
};
const boxes = [{ id: 'bx-1', name: 'shed-pi', revokedAt: null }, { id: 'bx-0', name: 'old-pi', revokedAt: at }];
const programs = { owner: 'sam', catalogue: { records: ['tasks', 'projects'], operations: ['tasks.command'] }, tokens: [] };
let world: { setup: object | null; owner: string };
beforeEach(() => {
  feed.mockReset(); reported.mockReset(); raised.mockReset(); written.mockReset(); requests.length = 0; logged.length = 0; world = { setup, owner: 'sam' }; hold = null;
  reply = () => ({ status: 200, body: { ok: true, value: { token: BEARER, fingerprint: 'f'.repeat(64) } } });
  feed.mockImplementation((query: string, _v?: object, options?: { pause?: boolean }) => {
    if (options?.pause) return { status: 'loading' };
    if (query.includes('householdSetup')) return { status: 'live', data: { householdSetup: world.setup, boxes, boxAlertSettings: [] } };
    if (query.includes('programSetup')) return { status: 'live', data: { programSetup: world.setup ? { ...programs, owner: world.owner } : null } };
    throw new Error('A read the household brick should not make: ' + query);
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string; method: string; credentials: string }) => {
    requests.push({ url, body: JSON.parse(init.body) });
    if (hold) await hold;
    expect([init.method, init.credentials]).toEqual(['POST', 'same-origin']);
    const { status, body } = reply();
    return { ok: status < 400, status, json: async () => body };
  }));
  vi.stubGlobal('navigator', { clipboard: { writeText: written.mockImplementation(async () => {}) } });
  vi.stubGlobal('location', { href: ADDRESS, search: '', hash: '' });
  vi.stubGlobal('history', { pushState: moved, replaceState: moved });
  moved.mockReset(); stored.mockReset();
  for (const name of ['localStorage', 'sessionStorage']) vi.stubGlobal(name, { setItem: stored, getItem: () => null, removeItem() {}, clear() {}, key: () => null, length: 0 });
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...words: unknown[]) => { logged.push(words); });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const element = (form: Form) => h(brickView('household').Body, { params: {}, form, act: reported, raise: raised });
const draw = (form: Form) => act(async () => { tree?.unmount(); tree = create(element(form)); });
const redraw = (form: Form) => act(async () => tree!.update(element(form)));
const said = (node: Node | string): string => (typeof node === 'string' ? node : node.children.map(said).join(''));
const shown = () => said(tree!.root);
const json = () => JSON.stringify(tree!.toJSON());
const button = (words: string) => tree!.root.findAllByType('button').find((b) => !b.props['data-place'] && (said(b) === words || b.props['aria-label'] === words));
const press = (words: string) => act(async () => { await button(words)!.props.onClick(); });
const type = (label: string, value: string) => act(async () => { tree!.root.findAll((n) => n.type === 'input' && n.props['aria-label'] === label)[0].props.onChange({ target: { value } }); });
const submit = () => act(async () => { tree!.root.findAll((n) => n.type === 'form' && n.props['aria-label'] === 'Make a token')[0].props.onSubmit({ preventDefault() {} }); });
/** Every place the value could have gone that is not the one place it is drawn. `copies` is how often Copy was pressed:
 * the clipboard is written then and at no other time. */
function nowhere(copies = 0) {
  expect(written.mock.calls, 'the clipboard').toEqual(Array.from({ length: copies }, () => [BEARER]));
  for (const [where, seen] of [['act', reported.mock.calls], ['flags', raised.mock.calls], ['the data hook', feed.mock.calls], ['logs', logged]] as const) expect(JSON.stringify(seen), where).not.toContain(BEARER);
  expect([location.href, location.search, location.hash], 'the address').toEqual([ADDRESS, '', '']);
  expect(moved, 'the address').not.toHaveBeenCalled();
  expect(stored, 'storage').not.toHaveBeenCalled();
}
async function make(label = 'pump-laptop') { await press('Make a token…'); await type('Token label', label); await submit(); }
/** Type a label and submit, from the closed form or the open one. */
async function tryLabel(label: string) { if (button('Make a token…')) await press('Make a token…'); await type('Token label', label); await submit(); }

it('makes a member\'s token by the desktop\'s door, draws its value once with Copy, and tells the board only its label and kind', async () => {
  await draw('primary');
  expect(shown()).not.toContain('made on the desktop');
  await make();
  expect(requests).toEqual([{ url: '/api/signin/token', body: { kind: 'owner', label: 'pump-laptop', member: 'sam' } }]);
  expect(reported.mock.calls).toEqual([['token', { label: 'pump-laptop', kind: 'member' }]]);
  expect(shown()).toContain('Save this token now. It is shown once');
  expect(tree!.root.findAll((n) => n.props['aria-label'] === 'Token value').map(said)).toEqual([BEARER]);
  expect(json().split(BEARER)).toHaveLength(2); // drawn in one place and no other
  expect(button('Make a token…')).toBeUndefined(); // one at a time: the value first, then a new one
  await press('Copy token');
  expect(written.mock.calls).toEqual([[BEARER]]);
  expect(shown()).toContain('Copied.');
  nowhere(1);
  await press('Hide token');
  expect(json()).not.toContain(BEARER);
  expect(button('Make a token…')).toBeDefined();
  expect(requests).toHaveLength(1);
  nowhere(1);
});

it('makes an agent\'s, a machine\'s and an outside program\'s token with what the desktop sends, each told by its kind', async () => {
  await draw('primary');
  await press('Make a token…');
  await press('Agent');
  await type('Token label', 'art-terminal');
  await type('Expires (optional ISO time)', '2027-01-01T00:00:00Z');
  await submit();
  await press('Hide token');
  await press('Make a token…');
  await press('Machine');
  expect(shown()).toContain('shed-pi');
  expect(shown()).not.toContain('old-pi');
  await type('Token label', 'shed.pi');
  await submit();
  await press('Hide token');
  await press('Make a token…');
  await press('Outside program');
  await press('Member: sam'); await press('lee');
  await press('projects'); await press('tasks.command');
  await type('Token label', 'sheet-sync');
  await submit();
  expect(requests).toEqual([
    { url: '/api/signin/token', body: { kind: 'agent', label: 'art-terminal', agent: 'art', expiresAt: '2027-01-01T00:00:00Z' } },
    { url: '/api/signin/token', body: { kind: 'runner', label: 'shed.pi', box: 'bx-1' } },
    { url: '/api/signin/program', body: { label: 'sheet-sync', member: 'lee', records: ['projects'], operations: ['tasks.command'] } },
  ]);
  expect(reported.mock.calls).toEqual([['token', { label: 'art-terminal', kind: 'agent' }], ['token', { label: 'shed.pi', kind: 'machine' }], ['token', { label: 'sheet-sync', kind: 'program' }]]);
  nowhere();
});

it('forgets the value when the brick is drawn again, leaves its big form, or stops being the owner\'s; a fresh answer of the same setup keeps it', async () => {
  await draw('primary');
  await make();
  // New data for the same placement (the token list grew): still the member's to copy.
  await redraw('primary');
  expect(json()).toContain(BEARER);
  // Drawn again: a new body has nothing of the old one.
  await draw('primary');
  expect(json()).not.toContain(BEARER);
  await make('second');
  await redraw('side');
  expect(json()).not.toContain(BEARER);
  await redraw('primary');
  expect(json()).not.toContain(BEARER);
  await make('third');
  world = { setup: null, owner: 'sam' };
  await redraw('primary');
  expect(shown()).toBe('This household setup is unavailable.');
  world = { setup, owner: 'sam' };
  await redraw('primary');
  expect(json()).not.toContain(BEARER);
  // Nothing was asked for again: forgetting is not a retry.
  expect(requests.map((r) => r.body.label)).toEqual(['pump-laptop', 'second', 'third']);
  nowhere();
});

it('is refused for a member loom does not let make one, and for a browser that signed in too long ago, telling the board nothing', async () => {
  await draw('primary');
  reply = () => ({ status: 403, body: { error: 'Household owner required' } });
  await make();
  expect(shown()).toContain('Token creation refused. Check its label and identity.');
  reply = () => ({ status: 403, body: { error: 'Sign in again before making a token' } });
  await submit();
  expect(shown()).toContain('Sign in again to make a token.');
  reply = () => ({ status: 409, body: { error: 'A live token already has that label' } });
  await submit();
  expect(shown()).toContain('Token creation refused.');
  // A reply that is not a token, or no reply at all: it may have been made, so the member is told to check.
  for (const next of [() => ({ status: 200, body: { ok: true, value: { token: 'not-a-token' } } }), () => ({ status: 500, body: {} })]) {
    reply = next;
    await submit();
    expect(shown()).toContain('Token creation may have completed. Check its label and revoke it before trying again.');
  }
  expect(reported).not.toHaveBeenCalled();
  expect(json()).not.toContain('loom_');
  // Anyone loom does not answer the setup for has no form at all.
  world = { setup: null, owner: 'sam' };
  await draw('primary');
  expect(button('Make a token…')).toBeUndefined();
});

it('sends nothing for a label the board could not be told, and says why', async () => {
  await draw('primary');
  for (const label of ['', 'Pump laptop', '-dash', 'x'.repeat(121)]) {
    await tryLabel(label);
    expect(shown(), label).toContain('A label here is one word');
  }
  expect(requests).toEqual([]);
  expect(reported).not.toHaveBeenCalled();
});

const SAME = 'That looks like a secret value, not a name.';
it('sends nothing for a label that has the shape of a secret value, says so, and takes an ordinary label', async () => {
  await draw('primary');
  for (const label of [BEARER, 'ghp_' + 'A1b2'.repeat(6), 'ci/sk-ant-' + 'k'.repeat(24), 'Zx9' + 'q8W7e6R5t4Y3u2I1'.repeat(2)]) {
    await tryLabel(label);
    expect(shown(), label).toContain(SAME);
  }
  expect(requests).toEqual([]);
  expect(reported).not.toHaveBeenCalled();
  for (const label of ['PUMP_TOKEN', 'github-deploy-key', 'ci:runner']) {
    await tryLabel(label);
    expect(shown(), label).not.toContain(SAME);
    await press('Hide token');
  }
  expect(requests.map((r) => r.body.label)).toEqual(['PUMP_TOKEN', 'github-deploy-key', 'ci:runner']);
});

it('says the token may have been made when the form goes away while loom is asked, as the desktop does, and draws no value later', async () => {
  let answer!: () => void;
  hold = new Promise((resolve) => { answer = resolve; });
  await draw('primary');
  await make();
  expect(requests).toHaveLength(1);
  // The agent puts another brick in the big place: this one is drawn small, and the form is gone.
  await redraw('side');
  expect(shown()).toContain('Token creation for “pump-laptop” may have completed. Check its label before trying again.');
  await act(async () => { answer(); await Promise.resolve(); });
  await redraw('primary');
  // loom made it, so the board is told it exists; its value is lost and drawn nowhere.
  expect(reported.mock.calls).toEqual([['token', { label: 'pump-laptop', kind: 'member' }]]);
  expect(json()).not.toContain(BEARER);
  expect(shown()).toContain('may have completed');
  // Asking again clears the warning.
  hold = null;
  await make('second');
  expect(shown()).not.toContain('may have completed');
  nowhere();
});

it('drops a value shown, or asked for, when the signed-in owner changes, as the desktop does', async () => {
  await draw('primary');
  await make();
  expect(json()).toContain(BEARER);
  // Another owner signs in on this browser: the setup is still answered, but not for the owner who made it.
  world = { setup, owner: 'lee' };
  await redraw('primary');
  expect(json()).not.toContain(BEARER);
  expect(button('Make a token…')).toBeDefined();
  // In flight when the owner changes: the member is told it may have been made, and the late answer is not drawn.
  let answer!: () => void;
  hold = new Promise((resolve) => { answer = resolve; });
  await make('second');
  world = { setup, owner: 'sam' };
  await redraw('primary');
  expect(shown()).toContain('Token creation for “second” may have completed.');
  await act(async () => { answer(); await Promise.resolve(); });
  expect(json()).not.toContain(BEARER);
  expect(reported.mock.calls).toEqual([['token', { label: 'pump-laptop', kind: 'member' }]]);
  nowhere();
});

it('says it could not copy when the page has no clipboard', async () => {
  vi.stubGlobal('navigator', {});
  await draw('primary');
  await make();
  await press('Copy token');
  expect(shown()).toContain('Could not copy. Select the token and copy it.');
  expect(json().split(BEARER)).toHaveLength(2);
});
