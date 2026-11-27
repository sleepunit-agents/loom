/** The `bridges` brick (docs/specs/boards.md, "The first bricks"). The data hook is a fake and so is `fetch`:
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
let saved = true;
const at = '2026-11-14T15:00:00Z';
const send = (id: string, state: string, over: object = {}) => ({ id, incoming: 'in-' + id, connection: 'c-1', channel: 'C-garden', thread: null, text: `Secret words of ${id}`, state, createdAt: at, ...over });
const data = (over: object = {}) => ({
  bridgeReader: { id: 'sam', manage: true },
  bridgeActivity: [{ id: 'c-1', received: 5, delivered: 4, held: 1 }],
  bridgeConnections: [{ id: 'c-1', platform: 'discord', agent: 'art', workspace: 'W-home', botUser: 'B-1', tokenSecret: 'discord-bot', appSecret: null, enabled: true, state: 'connected', stateAt: at }],
  bridgeChannelFilters: [{ connection: 'c-1', channel: 'C-noise', rule: 'ignore' }],
  bridgeChannels: [{ platform: 'discord', workspace: 'W-home', channel: 'C-garden', answers: 'art', botsMayTalk: false }],
  bridgePeople: [{ platform: 'discord', workspace: 'W-home', user: 'U-9', member: 'lee' }],
  bridgeSends: [send('s-held', 'held', { thread: 'T-1' }), send('s-doubt', 'uncertain'), send('s-sent', 'sent'), send('s-gone', 'dismissed')],
  ...over,
});
let world: { status: string; data: object };
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); raised.mockReset(); saved = true; world = { status: 'live', data: data() };
  feed.mockImplementation((query: string) => {
    if (!query.startsWith('query Bridges')) throw new Error('A read the bridges brick should not make: ' + query);
    return world.status === 'live' ? { status: 'live', data: world.data } : { status: world.status };
  });
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    sent(url, JSON.parse(init.body).input);
    return { ok: true, status: 200, json: async () => (saved ? { ok: true, value: { saved: true } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

const element = (form: Form) => h(brickView('bridges').Body, { params: {}, form, act: reported, raise: raised });
async function draw(form: Form) { await act(async () => { tree?.unmount(); tree = create(element(form)); }); }
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const shown = () => said(tree!.root as Node);
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'select'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string, nth = 0) => act(async () => { await buttons().filter((b) => said(b) === label)[nth].props.onClick(); });

it('shows a household owner the waiting replies, connections, channel rules and person links as Bridges does', async () => {
  await draw('primary');
  for (const words of ['1 connection · 2 pending sends', 'Reply to C-garden', 'Secret words of s-held', 'Thread: T-1', 'This send waits for a person to release or dismiss it.', 'Secret words of s-doubt',
    'Delivery could not be confirmed. Review before sending again.', 'discord', 'connected', 'Enabled', 'W-home · 5 received · 4 delivered · 1 held in 24 hours', // A connection's details are facts: a label and its value (brick-kit.tsx, Fact).
    'Bot userB-1', 'Only channelsNone', 'Ignored channelsC-noise',
    'Stored secret namesBot token: discord-bot', 'Answers when nobody is addressed:', 'Bots may talk: No', 'Outside user: U-9', 'ask the agent in the conversation']) expect(shown(), words).toContain(words);
  expect(shown()).not.toContain('s-sent'); expect(shown()).not.toContain('s-gone');
  expect(placed()).toEqual([{ brick: 'agent', params: { agent: 'art' } }, { brick: 'agent', params: { agent: 'art' } }, { brick: 'person', params: { person: 'member:lee' } }]);
  // A held reply can be released or dismissed; one in doubt only dismissed.
  expect(buttons().map(said)).toEqual(['Release send…', 'Dismiss send…', 'Dismiss send…']);
  expect(sent).not.toHaveBeenCalled();
});

it('releases a held reply only after asking, through /api/bridges/command, and tells the board none of its words', async () => {
  await draw('primary');
  await press('Release send…');
  expect(shown()).toContain('Send this reply to C-garden? It cannot be taken back.');
  expect(sent).not.toHaveBeenCalled();
  await press('Keep it held');
  expect(sent).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled();
  await press('Release send…');
  await press('Release it');
  expect(sent).toHaveBeenCalledWith('/api/bridges/command', { action: 'review', id: 's-held', decision: 'release' });
  expect(reported.mock.calls).toEqual([['release', {}]]);
  expect(shown()).toContain('Saved.');
});

it('dismisses a reply only after asking, and reports nothing when loom does not confirm', async () => {
  await draw('primary');
  await press('Dismiss send…', 1);
  expect(shown()).toContain('Dismiss this reply? It will never be sent.');
  expect(sent).not.toHaveBeenCalled();
  await press('Dismiss it');
  expect(sent).toHaveBeenCalledWith('/api/bridges/command', { action: 'review', id: 's-doubt', decision: 'dismiss' });
  expect(reported.mock.calls).toEqual([['dismiss', {}]]);
  saved = false; reported.mockClear();
  await press('Dismiss send…', 0);
  await press('Dismiss it');
  expect(reported).not.toHaveBeenCalled();
  expect(shown()).toContain('Change not confirmed. Check the current item before starting a new change.');
  expect(JSON.stringify(reported.mock.calls)).not.toMatch(/Secret|s-held|C-garden/);
});

it('shows someone who does not run the bridges only the replies loom sends them, which they may review', async () => {
  world.data = data({ bridgeReader: { id: 'lee', manage: false }, bridgeActivity: [], bridgeConnections: [], bridgeChannelFilters: [], bridgeChannels: [], bridgePeople: [], bridgeSends: [send('s-dm', 'held')] });
  await draw('primary');
  expect(shown()).toContain('1 pending send');
  for (const words of ['Connections', 'Channel rules', 'Person links', 'ask the agent']) expect(shown(), words).not.toContain(words);
  expect(buttons().map(said)).toEqual(['Release send…', 'Dismiss send…']);
});

it('draws the side form as a short list and the compact form as one line, neither with a control', async () => {
  await draw('side');
  for (const words of ['1 connection · 2 pending sends', 'Secret words of s-held']) expect(shown(), words).toContain(words);
  // The side form is what waits to be sent; the connections are counted in its lead and listed in the big form.
  for (const words of ['Channel rules', 'connected']) expect(shown(), words).not.toContain(words);
  expect(controls()).toEqual([]);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(shown()).toBe('1 connection · 2 pending sends');
  expect(controls()).toEqual([]);
});

it('says the list is unavailable to someone who is no member of the household, and loading until loom answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    for (const [status, value] of [['live', data({ bridgeReader: null })], ['error', {}]] as const) {
      world = { status, data: value };
      await draw(form);
      expect(shown(), form).toBe('This list of bridges is unavailable.');
      expect(shown()).not.toContain('Secret words');
      expect(controls()).toEqual([]);
    }
    world.status = 'loading';
    await draw(form);
    expect(shown(), form).toBe('Loading…');
  }
  expect(sent).not.toHaveBeenCalled();
});

it('flags itself when another reply is held, and is headed by its name', async () => {
  world.data = data({ bridgeSends: [] });
  await draw('side');
  world.data = data();
  await act(async () => { tree!.update(element('side')); });
  expect(raised).toHaveBeenCalledWith('Held send');
  expect(bricks.bridges.title({})).toBe('Bridges');
  expect(bricks.bridges.sub({})).toBe('');
});
