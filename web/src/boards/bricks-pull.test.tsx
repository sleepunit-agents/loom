/** The pull brick's link to GitHub and the files its pull request changed (docs/specs/boards.md, "The first
 * bricks"). Its forms, flags and checks are in bricks-drawn.test.tsx. The data hook is a fake. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { brickView, loadBricks, type Params } from './bricks';
import type { Form } from './layout';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; feed.mockReset(); });

const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const change = { id: 'github:acme/app#12', repository: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', title: 'Read the pump twice', state: 'open',
  draft: false, authorLogin: 'art-bot', project: 'pond', agent: 'art', branch: 'art/pump', baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci' };
const read = (over: object = {}, more: object = {}) => ({ changes: [{ ...change, ...over }], changeChecks: [], changePeople: [], changeTasks: [], ...more });
const answer = (data: unknown) => feed.mockImplementation(() => ({ status: 'live', data }));
async function draw(form: Form, params: Params = { change: change.id }) {
  await act(async () => { tree?.unmount(); tree = create(h(brickView('pull').Body, { params, form, act: vi.fn(), raise: vi.fn() })); });
}
const links = () => tree!.root.findAllByType('a').map((a) => [a.props.href, a.props.target, a.props.rel, said(a)]);

it('links the pull request to its page on GitHub, in a new tab, in the side and primary forms', async () => {
  answer(read());
  for (const form of ['primary', 'side'] as const) {
    await draw(form);
    expect(links(), form).toEqual([[change.url, '_blank', 'noopener noreferrer', 'Open on GitHub']]);
  }
  await draw('compact');
  expect(links()).toEqual([]);
});

it('draws no link when the stored address is not a GitHub page', async () => {
  for (const url of ['', 'javascript:alert(1)', 'https://example.test/acme/app/pull/12', 'http://github.com/acme/app/pull/12']) {
    answer(read({ url }));
    await draw('primary');
    expect(links(), url).toEqual([]);
  }
});

const files = [
  { change: change.id, path: 'src/pump/read.ts', additions: 84, deletions: 12 },
  { change: change.id, path: 'docs/pump.md', additions: 9, deletions: 0 },
];
const rows = () => tree!.root.findAll((node) => node.props.className === 'board-row').map((row) => said(row));

it('lists the files the pull request changed, each with its added and removed lines, in the primary form, the query asking for them', async () => {
  answer(read({}, { changeFiles: files }));
  await draw('primary');
  expect(feed.mock.calls[0][0]).toContain('changeFiles(where:{change:{eq:$id}}){change path additions deletions}');
  const section = tree!.root.findAll((node) => node.type === 'section').find((s) => said(s).startsWith('Files changed'))!;
  expect(said(section.findAllByType('h3')[0])).toBe('Files changed2');
  expect(rows()).toEqual(['docs/pump.md+9 −0', 'src/pump/read.ts+84 −12']);
  for (const form of ['side', 'compact'] as const) {
    await draw(form);
    expect(JSON.stringify(tree!.toJSON()), form).not.toContain('src/pump/read.ts');
  }
});

it('says the files are not known yet when none are stored, or the read leaves them out', async () => {
  for (const more of [{ changeFiles: [] }, { changeFiles: undefined }]) {
    answer(read({}, more));
    await draw('primary');
    expect(rows()).toEqual([]);
    expect(JSON.stringify(tree!.toJSON())).toContain('Which files it changes is not known yet.');
    expect(JSON.stringify(tree!.toJSON())).toContain('Read the pump twice');
  }
});
