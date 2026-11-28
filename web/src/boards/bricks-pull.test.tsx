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
  // The patch wraps and does not scroll, so it is a named region and no stop of its own for the keyboard.
  expect([patchOf().props.role, patchOf().props.tabIndex, patchOf().props['aria-label']]).toEqual(['region', undefined, 'Patch of docs/pump.md']);
  expect(notes()).toContain('Only the first 200 KB of this patch is shown. The whole of it is on GitHub.');
  const cases: [unknown, string][] = [
    [{ status: 'live', data: { patch: { state: 'none', patch: null, cut: false } } }, 'GitHub has no patch for this file: it may be binary, too large for GitHub to show, renamed with no change in it, or empty.'],
    [{ status: 'live', data: { patch: { state: 'unlisted', patch: null, cut: false } } }, 'GitHub does not list this file for the pull request just now: it may have changed since. Close the file and open it again in a moment.'],
    [{ status: 'live', data: { patch: { state: 'unavailable', patch: null, cut: false } } }, 'GitHub could not be read for this file. Close the file and open it again to try again.'],
    [{ status: 'live', data: { patch: null } }, "This file's patch could not be read. Close the file and open it again to try again."],
    [{ status: 'offline' }, "This file's patch could not be read. Close the file and open it again to try again."],
    [{ status: 'loading' }, 'Loading…'],
  ];
  for (const [snapshot, note] of cases) {
    once.mockImplementation(() => snapshot);
    await draw('primary');
    await open('docs/pump.md');
    expect(patchOf(), note).toBeUndefined();
    expect(notes(), note).toContain(note);
    expect(notes(), note).not.toContain('Only the first 200 KB of this patch is shown. The whole of it is on GitHub.');
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

// ── When loom last read GitHub, loom's reviews, and Read GitHub again ────────────────────────────────────
const access = (refresh: boolean) => ({ status: 'live', data: { workAnswerOwner: refresh, workChangesRefresh: refresh, members: [] } });
function world(pull: unknown, { refresh = false, review = { status: 'live', data: { changeReviewHistory: [] } } as unknown } = {}) {
  feed.mockImplementation((query: string) => (query.includes('WorkAnswerOwner') ? access(refresh) : query.includes('ChangeReviewHistory') ? review : { status: 'live', data: pull }));
}
const asked = (name: string) => feed.mock.calls.filter((call) => String(call[0]).includes(name));
const text = () => JSON.stringify(tree!.toJSON());
const button = (words: string) => tree!.root.findAll((node) => node.type === 'button' && said(node) === words)[0];
const problems = () => tree!.root.findAll((node) => node.type === 'p' && node.props.className === 'board-problem').map(said);
const readAt = '2026-11-27T20:00:00.000Z';

it('says when loom last read GitHub, and that the last read failed, in the primary form only, the query asking for it', async () => {
  world(read({}, { changeSync: [{ readAt, failed: false, nextAt: null }] }));
  await draw('primary');
  expect(asked('BrickPull')[0][0]).toContain('changeSync{readAt failed nextAt}');
  // It is the brick's last quiet line, said once, with the time it was read.
  const foot = () => tree!.root.findAll((node) => node.type === 'div' && node.props.className === 'board-foot');
  expect(foot()).toHaveLength(1);
  expect(said(foot()[0])).toMatch(/^Last read from GitHub /);
  expect(foot()[0].findAll((node) => node.type === 'time' && node.props.dateTime === readAt)).toHaveLength(1);
  expect(tree!.root.findAll((node) => node.type === 'time' && node.props.dateTime === readAt)).toHaveLength(1);
  expect(text()).not.toContain('The last read failed');
  world(read({}, { changeSync: [{ readAt, failed: true, nextAt: null }] }));
  await draw('primary');
  expect(said(foot()[0])).toContain('The last read failed: this is the copy from before it.');
  for (const form of ['side', 'compact'] as const) {
    await draw(form);
    expect(text(), form).not.toContain('Last read from GitHub');
    expect(text(), form).not.toContain('The last read failed');
  }
  // Anyone but a household owner reads no row of it, and nothing is said.
  world(read({}, { changeSync: [] }));
  await draw('primary');
  expect(text()).not.toContain('Last read from GitHub');
});

const rounds = [
  { change: change.id, job: 'j-1', headCommit: 'b'.repeat(40), tier: 'medium', round: 1, verdict: 'BLOCKING', findings: 'The pump is read once.\nRead it twice.' },
  { change: change.id, job: 'j-2', headCommit: change.headCommit, tier: 'high', round: 2, verdict: 'CLEAR', findings: null },
  { change: change.id, job: 'j-3', headCommit: change.headCommit, tier: 'high', round: 3, verdict: null, findings: null },
];
const reviewOpener = () => tree!.root.findAll((node) => node.type === 'button' && node.props.className === 'board-fold' && said(node) === "Loom's reviews")[0];

it('asks for loom\'s reviews only once it is opened, and draws each round with its verdict, commit and findings', async () => {
  world(read(), { review: { status: 'live', data: { changeReviewHistory: rounds } } });
  await draw('primary');
  expect(asked('ChangeReviewHistory')).toEqual([]);
  expect(reviewOpener().props['aria-expanded']).toBe(false);
  await act(async () => reviewOpener().props.onClick());
  expect(asked('ChangeReviewHistory')[0][1]).toEqual({ change: change.id });
  expect(rows()).toEqual([
    'Round 1 · mediumEarlier commit bbbbbbbBlockingFindingsThe pump is read once.\nRead it twice.',
    'Round 2 · highCurrent commit aaaaaaaClear',
    'Round 3 · highCurrent commit aaaaaaaPending',
  ]);
  expect(tree!.root.findAll((node) => node.type === 'pre' && node.props.className === 'board-tail').map(said)).toEqual(['The pump is read once.\nRead it twice.']);
  // Closed, it asks for nothing more and draws none of it.
  const calls = asked('ChangeReviewHistory').length;
  await act(async () => reviewOpener().props.onClick());
  expect(text()).not.toContain('Round 1');
  expect(asked('ChangeReviewHistory').length).toBe(calls);
  for (const form of ['side', 'compact'] as const) {
    await draw(form);
    expect(text(), form).not.toContain("Loom's reviews");
  }
});

it('says when there is no review, while it loads, and when it cannot be read; and forgets it was opened when the brick leaves its big form', async () => {
  const cases: [unknown, string][] = [
    [{ status: 'live', data: { changeReviewHistory: [] } }, 'Loom has not reviewed it.'],
    [{ status: 'live', data: { changeReviewHistory: [{ ...rounds[0], change: 'github:acme/app#13' }] } }, 'Loom has not reviewed it.'],
    [{ status: 'loading' }, 'Loading…'],
    [{ status: 'offline' }, "Loom's reviews are unavailable. Close them and open them again to try again."],
    [{ status: 'denied' }, "Loom's reviews are unavailable. Close them and open them again to try again."],
  ];
  for (const [review, note] of cases) {
    world(read(), { review });
    await draw('primary');
    await act(async () => reviewOpener().props.onClick());
    expect(notes(), note).toContain(note);
  }
  const body = (form: Form) => h(brickView('pull').Body, { params: { change: change.id }, form, act: vi.fn(), raise: vi.fn() });
  await act(async () => tree!.update(body('side')));
  const calls = asked('ChangeReviewHistory').length;
  await act(async () => tree!.update(body('primary')));
  expect(reviewOpener().props['aria-expanded']).toBe(false);
  expect(asked('ChangeReviewHistory').length).toBe(calls);
});

async function drawWith(actFn: ReturnType<typeof vi.fn>) {
  await act(async () => { tree?.unmount(); tree = create(h(brickView('pull').Body, { params: { change: change.id }, form: 'primary', act: actFn, raise: vi.fn() })); });
}
afterEach(() => { vi.unstubAllGlobals(); });

it('offers Read GitHub again only to a member loom says may use it, and only in the primary form', async () => {
  world(read(), { refresh: false });
  await draw('primary');
  expect(button('Read GitHub again')).toBeUndefined();
  world(read(), { refresh: true });
  await draw('primary');
  expect(button('Read GitHub again')).toBeDefined();
  // The small forms do not even ask whether the member may.
  for (const form of ['side', 'compact'] as const) {
    feed.mockClear();
    await draw(form);
    expect(button('Read GitHub again'), form).toBeUndefined();
    expect(asked('WorkAnswerOwner'), form).toEqual([]);
  }
});

it('a press sends the desktop\'s refresh once, says it is refreshing, then that it is done, and tells the board refresh with nothing more', async () => {
  world(read(), { refresh: true });
  let answer!: (r: Response) => void;
  const request = vi.fn(() => new Promise<Response>((done) => { answer = done; }));
  vi.stubGlobal('fetch', request);
  const told = vi.fn();
  await drawWith(told);
  await act(async () => button('Read GitHub again').props.onClick());
  // Pending: the button says so and cannot be pressed; a second press is dropped.
  expect(button('Reading GitHub…').props.disabled).toBe(true);
  await act(async () => button('Reading GitHub…').props.onClick());
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]).toEqual(['/api/changes/refresh', expect.objectContaining({ method: 'POST', body: JSON.stringify({ input: {} }) })]);
  expect(told).not.toHaveBeenCalled();
  await act(async () => answer(Response.json({ ok: true, value: { refreshed: true } })));
  expect(button('Read GitHub again').props.disabled).toBe(false);
  expect(notes()).toContain('Loom has read GitHub again.');
  expect(problems()).toEqual([]);
  expect(told.mock.calls).toEqual([['refresh', {}]]);
});

it('says loom refused a refresh, apart from one that failed, and tells the board nothing for either', async () => {
  world(read(), { refresh: true });
  const cases: [() => Promise<Response>, string][] = [
    [async () => Response.json({ ok: false, error: 'refused' }, { status: 403 }), 'Loom refused: only a household owner may have it read GitHub again.'],
    [async () => Response.json({ ok: false }, { status: 503 }), 'GitHub could not be read just now. Try again in a moment.'],
    [async () => { throw new Error('offline'); }, 'GitHub could not be read just now. Try again in a moment.'],
    [async () => Response.json({ ok: true, value: { refreshed: false } }), 'GitHub could not be read just now. Try again in a moment.'],
  ];
  for (const [reply, words] of cases) {
    vi.stubGlobal('fetch', vi.fn(reply));
    const told = vi.fn();
    await drawWith(told);
    await act(async () => button('Read GitHub again').props.onClick());
    expect(problems(), words).toEqual([words]);
    expect(notes(), words).not.toContain('Loom has read GitHub again.');
    expect(told, words).not.toHaveBeenCalled();
    // The control stays, so it can be pressed again.
    expect(button('Read GitHub again').props.disabled, words).toBe(false);
  }
});

it('keeps saying it was refused once loom no longer offers the refresh, and draws no control', async () => {
  world(read(), { refresh: true });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false }, { status: 403 })));
  await drawWith(vi.fn());
  await act(async () => button('Read GitHub again').props.onClick());
  world(read(), { refresh: false });
  await act(async () => tree!.update(h(brickView('pull').Body, { params: { change: change.id }, form: 'primary', act: vi.fn(), raise: vi.fn() })));
  expect(problems()).toEqual(['Loom refused: only a household owner may have it read GitHub again.']);
  expect(button('Read GitHub again')).toBeUndefined();
});
