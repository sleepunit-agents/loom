/** The `sharing` brick (docs/specs/boards.md, "The first bricks"). The data hook is a fake and so is `fetch`, which
 * nothing here should call: the brick is read-only. */
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
const sent = vi.fn(), reported = vi.fn();
const project = (id: string, over: object = {}) => ({ id, name: 'Name of ' + id, goal: null, members: [], agents: [], repositories: [], ...over });
const sharing = { members: ['sam', 'lee'], agents: ['art'], projects: [project('pond', { goal: 'Keep the pond clear', members: ['sam', 'lee'], agents: ['art'], repositories: ['github:Acme/Pond.git', 'not a repo'] }), project('empty')] };
let world: { status: string; sharing: object | null };
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); world = { status: 'live', sharing };
  feed.mockImplementation((query: string) => {
    if (!query.includes('householdSharing')) throw new Error('A read the sharing brick should not make: ' + query);
    return world.status === 'live' ? { status: 'live', data: { householdSharing: world.sharing } } : { status: world.status };
  });
  vi.stubGlobal('fetch', async (url: string) => { sent(url); return { ok: false, status: 500, json: async () => ({ ok: false }) }; });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

async function draw(form: Form) { await act(async () => { tree?.unmount(); tree = create(h(brickView('sharing').Body, { params: {}, form, act: reported, raise: () => {} })); }); }
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const shown = () => said(tree!.root as Node);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'select'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));

it('lists every project with who and which agents and repositories are on it, each a chip', async () => {
  await draw('primary');
  for (const words of ['2 projects · 2 members · 1 agent', 'Name of pond', '2 members · 1 agents', 'Keep the pond clear', 'not a repo', 'Name of empty', 'Nobody is on it', 'Repositories', 'None', 'ask the agent in the conversation'])
    expect(shown(), words).toContain(words);
  expect(placed()).toEqual([
    { brick: 'project', params: { project: 'pond' } }, { brick: 'person', params: { person: 'member:sam' } }, { brick: 'person', params: { person: 'member:lee' } }, { brick: 'agent', params: { agent: 'art' } },
    { brick: 'repository', params: { repository: 'acme/pond', project: 'pond' } }, { brick: 'project', params: { project: 'empty' } },
  ]);
  expect(controls()).toEqual([]);
  expect(sent).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled();
});

it('draws the side form as a short list without goals or repositories and the compact form as one line, neither with a control', async () => {
  world.sharing = { ...sharing, projects: [...sharing.projects, ...Array.from({ length: 6 }, (_, i) => project('extra-' + i))] };
  await draw('side');
  // Four projects fit the side form without scrolling; the rest are counted.
  expect(placed().filter((p) => p.brick === 'project')).toHaveLength(4);
  expect(shown()).toContain('and 4 more');
  expect(shown()).not.toContain('Keep the pond clear'); expect(shown()).not.toContain('Repositories');
  expect(controls()).toEqual([]);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(shown()).toBe('8 projects · 2 members · 1 agent');
});

it('says sharing is unavailable to anyone who is not a household owner, and loading until loom answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    for (const next of [{ status: 'live', sharing: null }, { status: 'error', sharing }]) {
      world = next;
      await draw(form);
      expect(shown(), form).toBe('This project sharing is unavailable.');
      expect(controls()).toEqual([]);
    }
    world = { status: 'loading', sharing };
    await draw(form);
    expect(shown(), form).toBe('Loading…');
  }
});

it('is headed by its name', () => {
  expect(bricks.sharing.title({})).toBe('Sharing');
  expect(bricks.sharing.sub({})).toBe('');
});
