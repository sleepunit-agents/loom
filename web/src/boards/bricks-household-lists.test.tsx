/** The `household` brick's tokens and signed-in browsers (docs/specs/boards.md, "The first bricks"): the live ones
 * first, the rest folded behind one heading with its count and drawn thirty at a time once opened, a search over
 * what loom already sent whose words go nowhere, and Make a token at the top of the tokens. The data hook and
 * `fetch` are fakes: what is checked is what is drawn, in which order, and that no read, request or report moves. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { brickView, loadBricks } from './bricks';
import { forgetTokenNotices } from './token-notices';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
const at = '2026-11-14T15:00:00Z';
const reported = vi.fn(), raised = vi.fn(), fetched = vi.fn(), moved = vi.fn(), stored = vi.fn();
const token = (n: number, over: object = {}) => ({ fingerprint: n.toString(16).padStart(64, '0'), label: `tok-${n}`, kind: 'agent', expired: false, identity: 'art', createdAt: at, expiresAt: null, revokedAt: null, lastUsedAt: null, ...over });
const browser = (n: number, over: object = {}) => ({ ref: n.toString(16).padStart(64, 'a'), device: `Device ${n}`, member: 'sam', tokenLabel: 'Passkey', isAgent: false, ended: false, issuedAt: at, seenAt: at, ...over });
const base = {
  defaultAgent: 'art',
  members: [{ id: 'sam', role: 'owner', fullOwner: true, agents: [] }, { id: 'lee', role: 'member', fullOwner: false, agents: [] }],
  agents: [{ id: 'art', spriteVersion: null, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot', github: [], removedAt: null }],
};
let setup: object;
beforeEach(() => {
  feed.mockReset(); reported.mockReset(); raised.mockReset(); fetched.mockReset(); moved.mockReset(); stored.mockReset(); forgetTokenNotices();
  feed.mockImplementation((query: string, _v?: object, options?: { pause?: boolean }) => {
    if (options?.pause) return { status: 'loading' };
    if (query.includes('householdSetup')) return { status: 'live', data: { householdSetup: setup, boxes: [], boxAlertSettings: [] } };
    if (query.includes('programSetup')) return { status: 'live', data: { programSetup: { owner: 'sam', catalogue: { records: [], operations: [] }, tokens: [] } } };
    throw new Error('A read the household brick should not make: ' + query);
  });
  vi.stubGlobal('fetch', fetched);
  vi.stubGlobal('location', { href: 'https://loom.example.test/boards?board=b-1', search: '', hash: '' });
  vi.stubGlobal('history', { pushState: moved, replaceState: moved });
  for (const name of ['localStorage', 'sessionStorage']) vi.stubGlobal(name, { setItem: stored, getItem: () => null, removeItem() {}, clear() {}, key: () => null, length: 0 });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

const draw = () => act(async () => { tree?.unmount(); tree = create(h(brickView('household').Body, { params: {}, form: 'primary', act: reported, raise: raised })); });
const said = (node: Node | string): string => (typeof node === 'string' ? node : node.children.map(said).join(''));
const shown = () => said(tree!.root);
const button = (words: string) => tree!.root.findAllByType('button').find((b) => !b.props['data-place'] && (said(b) === words || b.props['aria-label'] === words));
const press = (words: string) => act(async () => { await button(words)!.props.onClick(); });
const list = (label: string) => tree!.root.findAll((n) => n.type === 'ul' && n.props['aria-label'] === label)[0];
/** The titles of a list's rows, in order. */
const titles = (label: string) => { const ul = list(label); return ul ? ul.findAll((n) => n.type === 'li').map((li) => said(li.findAll((n) => n.props.className === 'board-row-title')[0] ?? li)) : []; };
const field = (name: string) => tree!.root.findAll((n) => n.type === 'input' && n.props['aria-label'] === name)[0];
async function search(name: string, words: string) {
  await act(async () => { field(name).props.onChange({ target: { value: words } }); });
  await act(async () => { tree!.root.findAll((n) => n.type === 'form' && n.props['aria-label'] === name)[0].props.onSubmit({ preventDefault() {} }); });
}
const labels = (pattern: RegExp) => (shown().match(pattern) ?? []);

it('lists live tokens and browsers first, and folds the revoked, expired and signed-out ones under one heading with each count', async () => {
  setup = { ...base,
    tokens: [token(1, { revokedAt: at }), token(2), token(3, { expired: true, expiresAt: at }), token(4), token(5, { revokedAt: at, expired: true })],
    sessions: [browser(1, { ended: true }), browser(2), browser(3)] };
  await draw();
  // Live, in loom's order; the rest are not drawn until the fold is opened.
  expect(titles('Live tokens')).toEqual(['tok-2', 'tok-4']);
  expect(titles('Live browsers')).toEqual(['Device 2', 'Device 3']);
  for (const hidden of ['tok-1', 'tok-3', 'tok-5', 'Device 1']) expect(shown(), hidden).not.toContain(hidden);
  expect(shown()).toContain('Tokens2 live');
  expect(shown()).toContain('Signed-in browsers2 live');
  expect(button('Revoked or expired · 3')!.props['aria-expanded']).toBe(false);
  expect(button('Signed out · 1')).toBeDefined();
  expect(labels(/Revoke token…/g)).toHaveLength(2);
  await press('Revoked or expired · 3');
  expect(button('Revoked or expired · 3')!.props['aria-expanded']).toBe(true);
  expect(titles('Revoked or expired tokens')).toEqual(['tok-1', 'tok-3', 'tok-5']);
  // An expired token can still be revoked, as before, after asking; a revoked one has nothing to revoke.
  expect(labels(/Revoke token…/g)).toHaveLength(3);
  expect(button('Revoke token tok-3')).toBeDefined();
  expect(button('Revoke token tok-1')).toBeUndefined();
  await press('Signed out · 1');
  expect(titles('Signed out browsers')).toEqual(['Device 1']);
  await press('Revoked or expired · 3');
  expect(shown()).not.toContain('tok-1');
  expect(fetched).not.toHaveBeenCalled();
  expect(reported).not.toHaveBeenCalled();
});

it('draws no fold when nothing is revoked or expired, and says when nothing is live', async () => {
  setup = { ...base, tokens: [token(1)], sessions: [browser(1, { ended: true })] };
  await draw();
  expect(button('Revoked or expired · 0')).toBeUndefined();
  expect(shown()).not.toContain('Revoked or expired');
  expect(shown()).toContain('No live browsers');
  expect(shown()).toContain('Signed-in browsers0 live');
});

it('opens the fold thirty at a time, with Show 30 more until every one is drawn', async () => {
  setup = { ...base, tokens: [token(0), ...Array.from({ length: 75 }, (_, i) => token(i + 1, { revokedAt: at }))], sessions: [] };
  await draw();
  await press('Revoked or expired · 75');
  expect(titles('Revoked or expired tokens')).toEqual(Array.from({ length: 30 }, (_, i) => `tok-${i + 1}`));
  await press('Show 30 more');
  expect(titles('Revoked or expired tokens')).toHaveLength(60);
  expect(titles('Revoked or expired tokens').at(-1)).toBe('tok-60');
  await press('Show 30 more');
  expect(titles('Revoked or expired tokens')).toHaveLength(75);
  expect(button('Show 30 more')).toBeUndefined();
  // Live ones are all drawn whatever the fold holds.
  expect(titles('Live tokens')).toEqual(['tok-0']);
});

it('searches tokens by label, kind and owner, on Enter or Search, over what loom sent, with the folded count following', async () => {
  setup = { ...base, sessions: [], tokens: [
    token(1, { label: 'pump-laptop', kind: 'owner', identity: 'sam' }), token(2, { label: 'shed-pi', kind: 'runner', identity: 'bx-shed' }),
    token(3, { label: 'old-sheet', kind: 'program', identity: 'lee', revokedAt: at }), token(4, { label: 'fern', kind: 'agent', identity: 'fern' }),
    token(5, { label: 'sam-phone', kind: 'owner', identity: 'sam', expired: true }),
  ] };
  await draw();
  const calls = feed.mock.calls.length;
  // Typing alone filters nothing.
  await act(async () => { tree!.root.findAll((n) => n.type === 'input' && n.props['aria-label'] === 'Search tokens')[0].props.onChange({ target: { value: 'pump' } }); });
  expect(titles('Live tokens')).toEqual(['pump-laptop', 'shed-pi', 'fern']);
  await search('Search tokens', 'PUMP');
  expect(titles('Live tokens')).toEqual(['pump-laptop']);
  expect(button('Revoked or expired · 2')).toBeUndefined();
  await search('Search tokens', 'runner');
  expect(titles('Live tokens')).toEqual(['shed-pi']);
  // By whose it is, with the folded ones counted and drawn from the matches only.
  await search('Search tokens', 'sam');
  expect(titles('Live tokens')).toEqual(['pump-laptop']);
  await press('Revoked or expired · 1');
  expect(titles('Revoked or expired tokens')).toEqual(['sam-phone']);
  await search('Search tokens', 'program lee');
  expect(shown()).toContain('No live token matches.');
  expect(titles('Revoked or expired tokens')).toEqual(['old-sheet']);
  await search('Search tokens', 'nobody');
  expect(shown()).toContain('No token matches. Every word must be in its label, kind or owner.');
  expect(shown()).toContain('Tokens0 live');
  await press('Show every token');
  expect(titles('Live tokens')).toEqual(['pump-laptop', 'shed-pi', 'fern']);
  expect(tree!.root.findAll((n) => n.type === 'input' && n.props['aria-label'] === 'Search tokens')[0].props.value).toBe('');
  // The words were sent nowhere: no read was asked with them, nothing fetched, nothing told, nothing stored or moved.
  expect(feed.mock.calls.slice(calls).every(([, variables]) => variables === undefined)).toBe(true);
  expect(JSON.stringify(feed.mock.calls)).not.toMatch(/pump|runner|nobody/i);
  for (const spy of [fetched, reported, raised, moved, stored]) expect(spy).not.toHaveBeenCalled();
});

it('searches browsers by name, kind and owner', async () => {
  setup = { ...base, tokens: [], sessions: [browser(1, { device: 'Firefox on Linux', member: 'sam' }), browser(2, { device: 'Headless Chrome', member: 'lee', isAgent: true }), browser(3, { device: 'Safari', member: 'lee', ended: true })] };
  await draw();
  await search('Search browsers', 'firefox');
  expect(titles('Live browsers')).toEqual(['Firefox on Linux']);
  await search('Search browsers', 'agent');
  expect(titles('Live browsers')).toEqual(['Headless Chrome']);
  await search('Search browsers', 'lee');
  expect(titles('Live browsers')).toEqual(['Headless Chrome']);
  await press('Signed out · 1');
  expect(titles('Signed out browsers')).toEqual(['Safari']);
  for (const spy of [fetched, reported, raised, moved, stored]) expect(spy).not.toHaveBeenCalled();
});

it('puts Make a token at the top of the tokens, above the search and the list, even with no token yet', async () => {
  setup = { ...base, tokens: Array.from({ length: 40 }, (_, i) => token(i + 1)), sessions: [] };
  await draw();
  const text = shown();
  const tokens = text.indexOf('Tokens40 live');
  expect(tokens).toBeGreaterThanOrEqual(0);
  expect(text.indexOf('Make a token…')).toBeGreaterThan(tokens);
  expect(text.indexOf('Make a token…')).toBeLessThan(text.indexOf('tok-1'));
  const order = tree!.root.findAll((n) => (n.type === 'button' && said(n) === 'Make a token…') || (n.type === 'form' && n.props['aria-label'] === 'Search tokens'));
  expect(order.map((n) => n.type)).toEqual(['button', 'form']);
  setup = { ...base, tokens: [], sessions: [] };
  await draw();
  expect(shown()).toContain('No tokens');
  expect(shown().indexOf('Make a token…')).toBeLessThan(shown().indexOf('No tokens'));
});
