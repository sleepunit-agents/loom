/** The pull brick's link to GitHub and the files its pull request changed (docs/specs/boards.md, "The first
 * bricks"). Its forms, flags and checks are in bricks-drawn.test.tsx. The data hook is a fake. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
const once = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed, useDataOnce: once }));
import { brickView, loadBricks, type Params } from './bricks';
import type { Form } from './layout';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; feed.mockReset(); once.mockReset(); });

const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const change = { id: 'github:acme/app#12', repository: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', title: 'Read the pump twice', state: 'open',
  draft: false, authorLogin: 'art-bot', project: 'pond', agent: 'art', branch: 'art/pump', headCommit: 'a'.repeat(40), baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci' };
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

// ── A changed file's patch, opened in place ──────────────────────────────────────────────────────────────────────
const opener = (path: string) => tree!.root.findAll((node) => node.type === 'button' && node.props.className === 'board-opens' && said(node) === path)[0];
async function open(path: string) { await act(async () => opener(path).props.onClick()); }
const patchOf = () => tree!.root.findAll((node) => node.type === 'pre' && node.props.className === 'board-patch')[0];
const lines = () => patchOf().findAllByType('span').map((line) => [line.props.className, said(line)]);
const notes = () => tree!.root.findAll((node) => node.type === 'p' && node.props.className === 'board-note').map(said);
const patched = (patch: unknown) => once.mockImplementation(() => ({ status: 'live', data: { patch } }));

it('opens a file in place to its patch, asked for once it is opened, its lines marked and keeping their signs', async () => {
  answer(read({}, { changeFiles: files }));
  patched({ state: 'patch', patch: '@@ -1,3 +1,3 @@ export\n context\n-old line\n+new line', cut: false });
  await draw('primary');
  expect(once).not.toHaveBeenCalled();
  expect(opener('src/pump/read.ts').props['aria-expanded']).toBe(false);
  await open('src/pump/read.ts');
  expect(opener('src/pump/read.ts').props['aria-expanded']).toBe(true);
  expect(once.mock.calls[0][0]).toContain('changeFilePatch(change:$change,path:$path){state patch cut}');
  expect(once.mock.calls[0][1]).toEqual({ change: change.id, path: 'src/pump/read.ts' });
  expect(lines()).toEqual([['board-patch-hunk', '@@ -1,3 +1,3 @@ export\n'], [undefined, ' context\n'], ['board-patch-remove', '-old line\n'], ['board-patch-add', '+new line\n']]);
  expect(patchOf().props['aria-label']).toBe('Patch of src/pump/read.ts');
  // Only the opened file asks; closing it draws no patch.
  expect(new Set(once.mock.calls.map((call) => call[1].path))).toEqual(new Set(['src/pump/read.ts']));
  await open('src/pump/read.ts');
  expect(patchOf()).toBeUndefined();
});

it('shows a patch that holds markup as its text, and nothing in it as markup or a link', async () => {
  answer(read({}, { changeFiles: files }));
  const words = '+<script>alert(1)</script> <a href="https://evil.test">[x](https://evil.test)</a> <b>bold</b>';
  patched({ state: 'patch', patch: words, cut: false });
  await draw('primary');
  await open('docs/pump.md');
  expect(lines()).toEqual([['board-patch-add', words + '\n']]);
  for (const type of ['script', 'b']) expect(patchOf().findAllByType(type), type).toEqual([]);
  expect(patchOf().findAllByType('a')).toEqual([]);
  expect(JSON.stringify(tree!.toJSON())).not.toContain('dangerouslySetInnerHTML');
});

it('says when a patch was cut, when GitHub gives none, when it could not be read, and while it loads', async () => {
  answer(read({}, { changeFiles: files }));
  patched({ state: 'patch', patch: '+first part', cut: true });
  await draw('primary');
  await open('docs/pump.md');
  expect(lines()).toEqual([['board-patch-add', '+first part\n']]);
  expect(notes()).toContain('This patch is longer than 200 KB: only its first part is shown. The whole of it is on GitHub.');
  const cases: [unknown, string][] = [
    [{ status: 'live', data: { patch: { state: 'none', patch: null, cut: false } } }, 'GitHub shows no patch for this file: it may be binary, a change too large for GitHub to show, a rename with no change in it, or an empty file.'],
    [{ status: 'live', data: { patch: { state: 'unlisted', patch: null, cut: false } } }, "GitHub's list of this pull request's files does not have this file just now: it may have changed since. Close it and open it again in a moment."],
    [{ status: 'live', data: { patch: { state: 'unavailable', patch: null, cut: false } } }, 'GitHub could not be read for this file just now. Close it and open it again in a moment to try again.'],
    [{ status: 'live', data: { patch: null } }, "This file's patch could not be read. Close it and open it again to try again."],
    [{ status: 'offline' }, "This file's patch could not be read. Close it and open it again to try again."],
    [{ status: 'loading' }, 'Loading…'],
  ];
  for (const [snapshot, note] of cases) {
    once.mockImplementation(() => snapshot);
    await draw('primary');
    await open('docs/pump.md');
    expect(patchOf(), note).toBeUndefined();
    expect(notes(), note).toContain(note);
    expect(notes(), note).not.toContain('This patch is longer than 200 KB: only its first part is shown. The whole of it is on GitHub.');
  }
});

it('forgets the opened files when the brick leaves its big form, so coming back asks nothing', async () => {
  answer(read({}, { changeFiles: files }));
  patched({ state: 'patch', patch: '+a', cut: false });
  await draw('primary');
  await open('src/pump/read.ts');
  await open('docs/pump.md');
  const asked = once.mock.calls.length;
  const body = (form: Form) => h(brickView('pull').Body, { params: { change: change.id }, form, act: vi.fn(), raise: vi.fn() });
  await act(async () => tree!.update(body('side')));
  await act(async () => tree!.update(body('primary')));
  expect(patchOf()).toBeUndefined();
  expect(opener('src/pump/read.ts').props['aria-expanded']).toBe(false);
  expect(once.mock.calls.length).toBe(asked);
});

it('forgets the opened files when the head commit or the change moves, and asks nothing for them', async () => {
  answer(read({}, { changeFiles: files }));
  patched({ state: 'patch', patch: '+a', cut: false });
  await draw('primary');
  await open('src/pump/read.ts');
  const asked = once.mock.calls.length;
  // A push: the same change, a new head. The patch drawn was of the old one; it is closed, not left open.
  answer(read({ headCommit: 'b'.repeat(40) }, { changeFiles: files }));
  await act(async () => tree!.update(h(brickView('pull').Body, { params: { change: change.id }, form: 'primary', act: vi.fn(), raise: vi.fn() })));
  expect(patchOf()).toBeUndefined();
  expect(once.mock.calls.length).toBe(asked);
  await open('src/pump/read.ts');
  expect(patchOf()).toBeDefined();
  // Another change with a file of the same name: nothing opens of itself.
  const other = once.mock.calls.length;
  answer(read({ id: 'github:acme/app#13', number: 13 }, { changeFiles: files.map((f) => ({ ...f, change: 'github:acme/app#13' })) }));
  await act(async () => tree!.update(h(brickView('pull').Body, { params: { change: 'github:acme/app#13' }, form: 'primary', act: vi.fn(), raise: vi.fn() })));
  expect(patchOf()).toBeUndefined();
  expect(once.mock.calls.length).toBe(other);
});
