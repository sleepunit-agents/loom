/** The `approval` brick, answered from the board (docs/specs/boards.md, "The first bricks"). The data hook is a
 * fake and so is `fetch`: what is checked is what is drawn, the request loom would receive, and what the board is
 * told. No browser, and no real approval is answered. The decisions themselves are checked without a view in
 * web/src/pieces/approval-view/answering.test.tsx. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { brickView, loadBricks } from './bricks';
import type { Form } from './layout';
import { shellCommandRecord } from '../../../src/apps/shell-command-record';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; update(element: unknown): void; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn();

const approval = { id: 'a-1', kind: 'command', target: 'pond/pump', actingFor: 'sam', operation: null as string | null, what: 'Drain the pond', why: 'The liner leaks.', agent: 'art', project: 'pond',
  member: 'sam', conversation: null, state: 'pending', ask: 'Drain the pond tonight?', ifYes: 'The pond is emptied.', ifNo: 'It keeps leaking.', details: 'pump --drain --all',
  changeSummary: null as string | null, askedAt: '2026-11-14T20:00:00Z', decidedBy: null as string | null, expiresAt: null as string | null };
type Row = typeof approval;
const household: Row = { ...approval, kind: 'setting', operation: 'household.change', what: 'stored words', ask: 'stored ask', ifYes: 'stored yes', ifNo: 'stored no', target: 'stored-target',
  details: JSON.stringify({ change: 'members.role', member: 'robin', role: 'owner' }) };
const reading = (review: string | undefined, who = 'Robin') => ({ summary: `Who: ${who}`, problem: null, blocked: null, ...(review ? { review } : {}),
  card: { title: `Make ${who} an owner`, nothing: false, facts: [{ label: 'Who', value: who }, { label: 'Member id', value: 'robin', small: true }], exact: `{"member":"${who}"}`, ifYes: `${who} becomes an owner.`, ifNo: `${who} stays a member.` } });

/** The world the brick reads: the row, its record, whether loom says the member may answer, who they are, the
 * owner's reading of a household change, and what `approvals.answer` replies. */
const world = { row: approval as Row | null, record: [] as object[], owner: true as boolean | 'loading' | 'offline', viewer: 'lee', preview: null as object | null,
  reply: (input: { id: string }): { status: number; body: unknown } => ({ status: 200, body: { ok: true, value: { id: input.id } } }) };
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset();
  Object.assign(world, { row: approval, record: [], owner: true, viewer: 'lee', preview: null, reply: (input: { id: string }) => ({ status: 200, body: { ok: true, value: { id: input.id } } }) });
  feed.mockImplementation((query: string) => {
    const name = /^query (\w+)/.exec(query)![1];
    if (name === 'InlineApproval') return { status: 'live', data: { approvals: world.row ? [world.row] : [], approvalRecord: world.record } };
    if (name === 'WorkAnswerOwner') return typeof world.owner === 'string' ? { status: world.owner } : { status: 'live', data: { workAnswerOwner: world.owner, workChangesRefresh: false, members: [] } };
    if (name === 'WorkViewer') return { status: 'live', data: { homeComms: { member: world.viewer } } };
    // The standing answer's read of the pull request (paused for everything but a waiting merge); it is answered in bricks-approval-always.test.tsx.
    if (name === 'ApprovalChange') return { status: 'live', data: { changes: [] } };
    throw new Error('A read the approval brick should not make: ' + name);
  });
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const input = JSON.parse(init.body).input;
    sent(url, input);
    const reply = url === '/api/household/proposalPreview' ? (world.preview ? { status: 200, body: { ok: true, value: world.preview } } : { status: 403, body: { ok: false } }) : world.reply(input);
    return { ok: reply.status === 200, status: reply.status, json: async () => reply.body };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

const element = (form: Form) => h(brickView('approval').Body, { params: { approval: 'a-1' }, form, act: reported, raise: () => {} });
async function draw(form: Form = 'side') { await act(async () => { tree?.unmount(); tree = create(element(form)); }); return tree!; }
/** The same placement, drawn again after what it reads changed. */
const again = (form: Form = 'side') => act(async () => { tree!.update(element(form)); });
const text = () => JSON.stringify(tree!.toJSON());
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const labels = () => buttons().map(said);
/** Everything a member could answer with. Chips place bricks; they answer nothing. */
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'details', 'select'].includes(node.type) && !node.props['data-place']);
const handlers = () => tree!.root.findAll((node) => typeof node.type === 'string' && !node.props['data-place'] && Object.keys(node.props).some((key) => /^on[A-Z]/.test(key)));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });
const write = (words: string) => act(async () => { tree!.root.findAllByType('textarea')[0].props.onChange({ target: { value: words } }); });
const answers = () => sent.mock.calls.filter(([url]) => url === '/api/approvals/answer').map(([, input]) => input);
const previews = () => sent.mock.calls.filter(([url]) => url === '/api/household/proposalPreview').length;

const states = ['pending', 'allowed', 'denied', 'used', 'withdrawn', 'expired'];
const kinds = ['merge', 'command', 'setting', 'dangerous'];

it('draws Allow and Deny for a waiting request in the primary and side forms, for a member loom says may answer, and for no other kind, state, form or viewer', async () => {
  for (const kind of kinds) for (const state of states) for (const form of ['primary', 'side', 'compact'] as const) for (const owner of [true, false, 'loading', 'offline'] as const) {
    Object.assign(world, { row: { ...approval, kind, state }, owner });
    await draw(form);
    const where = `${kind} ${state} ${form} ${owner}`;
    if (state === 'pending' && form !== 'compact' && owner === true) expect(labels(), where).toEqual(['Allow', 'Deny']);
    else { expect(controls(), where).toEqual([]); expect(handlers(), where).toEqual([]); }
    expect(text(), where).toContain(state);
  }
  expect(sent).not.toHaveBeenCalled();
  expect(reported).not.toHaveBeenCalled();
});

it('keeps the compact form to one line that reads the request and asks nothing about answering', async () => {
  for (const row of [approval, { ...approval, kind: 'dangerous' }, household]) {
    world.row = row; world.preview = reading('a'.repeat(64));
    await draw('compact');
    const json = tree!.toJSON() as { type: string; props: { className: string } };
    expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
    expect(said(tree!.root as Node)).toBe(`pending ${row.what}`);
    expect(controls()).toEqual([]);
  }
  expect(feed.mock.calls.every(([query]) => /^query InlineApproval/.test(query))).toBe(true);
  expect(sent).not.toHaveBeenCalled();
});

it('shows before a decision everything the desktop shows: what, why, for whom, what each answer does, exactly what it allows, and the details', async () => {
  world.row = { ...approval, changeSummary: 'Pond: full → empty', expiresAt: '2026-11-14T21:00:00Z' };
  for (const form of ['primary', 'side'] as const) {
    await draw(form);
    expect(feed.mock.calls.find(([query]) => /InlineApproval/.test(query))![1]).toEqual({ id: 'a-1' });
    for (const shown of ['Drain the pond', 'Drain the pond tonight?', 'The liner leaks.', 'If you allow', 'The pond is emptied.', 'If you deny', 'It keeps leaking.', 'Exactly what will change', 'Pond: full → empty',
      'Exactly what this allows', 'command: pond/pump', 'Details', 'pump --drain --all', 'pending', 'for Sam', 'Allowance ends'])
      expect(text(), `${form} ${shown}`).toContain(shown);
    expect(tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']))).toEqual([{ brick: 'agent', params: { agent: 'art' } }, { brick: 'project', params: { project: 'pond' } }]);
    // All of it stands above the answer.
    const flat = text();
    for (const shown of ['The liner leaks.', 'command: pond/pump', 'pump --drain --all']) expect(flat.indexOf(shown), shown).toBeLessThan(flat.indexOf('Answer approval'));
  }
  // The member's own private request says so.
  world.viewer = 'sam';
  await draw();
  expect(text()).toContain('for you');
  // A command filed as a literal command is headed as the full command.
  world.record = [{ seq: 1, at: approval.askedAt, event: 'request', approval: 'a-1', agent: 'art', note: shellCommandRecord }];
  await draw('primary');
  expect(text()).toContain('Full command');
  expect(text()).toContain('pump --drain --all');
  expect(text()).toContain('History');
  // What already stands against a request is said above its buttons, which stay.
  world.row = { ...approval, problem: 'No live token has that label' } as Row;
  await draw();
  expect(text()).toContain('This cannot be allowed as it stands: No live token has that label');
  expect(labels()).toEqual(['Allow', 'Deny']);
  expect(sent).not.toHaveBeenCalled();
});

it('draws a checked Tempo or Measuring change as before and after in plain words, as the desktop does, and not as stored JSON', async () => {
  const off = { on: false, send_outside: false, outside_address: '', keep_days: 90 }, on = { ...off, on: true, keep_days: 7 };
  world.row = { ...approval, kind: 'setting', target: 'measuring', details: JSON.stringify({ before: off, after: on }), changeSummary: `Measuring: ${JSON.stringify(off)} → ${JSON.stringify(on)}` };
  await draw();
  for (const shown of ['Change Measuring settings', 'Before', 'After', 'Off', 'On', '90 days', '7 days', 'Allow applies these settings. Deny keeps the current settings.', 'setting: measuring']) expect(text(), shown).toContain(shown);
  expect(text()).not.toContain('keep_days');
  const timings = { settleSeconds: 1, dimDays: 2, muteDays: 3 };
  world.row = { ...approval, kind: 'setting', target: 'tempo:agent:art', details: JSON.stringify({ who: { kind: 'agent', id: 'art' }, before: timings, after: { ...timings, settleSeconds: 60 } }),
    changeSummary: 'Tempo for agent art: settle 1 → 60 seconds; dim 2 → 2 days; mute 3 → 3 days' };
  await draw();
  for (const shown of ['Change Tempo timings for agent art', '1 second', '60 seconds', 'Allow applies these timings. Deny keeps the current timings.']) expect(text(), shown).toContain(shown);
  expect(text()).not.toContain('settleSeconds');
  await press('Allow');
  expect(answers()).toEqual([{ id: 'a-1', answer: 'allow' }]);
  // A setting change that is not exactly one of these is shown in its stored words.
  world.row = { ...approval, kind: 'setting', target: 'measuring', details: '{"before":1}', changeSummary: 'Measuring, roughly' };
  await draw();
  expect(text()).toContain('Measuring, roughly');
  expect(text()).toContain('{\\"before\\":1}');
  expect(text()).not.toContain('Change Measuring settings');
});

it('allows an ordinary request on one press, then tells the board "approve" with an empty detail', async () => {
  for (const kind of ['merge', 'command', 'setting']) {
    sent.mockClear(); reported.mockClear();
    world.row = { ...approval, kind };
    await draw(kind === 'merge' ? 'primary' : 'side');
    await press('Allow');
    expect(answers(), kind).toEqual([{ id: 'a-1', answer: 'allow' }]);
    expect(reported.mock.calls, kind).toEqual([['approve', {}]]);
  }
});

it('never allows a dangerous action on one press: it asks again, Cancel sends nothing, and only "Yes, allow it" sends, with confirm', async () => {
  world.row = { ...approval, kind: 'dangerous' };
  for (const form of ['primary', 'side'] as const) {
    sent.mockClear(); reported.mockClear();
    await draw(form);
    expect(labels()).toEqual(['Allow', 'Deny']);
    expect(text()).not.toContain('This cannot be undone.');
    await press('Allow');
    expect(sent).not.toHaveBeenCalled();
    expect(text()).toContain('This cannot be undone.');
    expect(labels()).toEqual(['Yes, allow it', 'Cancel', 'Deny']);
    await press('Cancel');
    expect(sent).not.toHaveBeenCalled();
    expect(labels()).toEqual(['Allow', 'Deny']);
    expect(text()).not.toContain('This cannot be undone.');
    await press('Allow');
    await press('Yes, allow it');
    expect(answers()).toEqual([{ id: 'a-1', answer: 'allow', confirm: true }]);
    expect(reported.mock.calls).toEqual([['approve', {}]]);
  }
});

it('denies with the reason the member wrote; the reason reaches approvals.answer and never the board', async () => {
  for (const kind of kinds) {
    sent.mockClear(); reported.mockClear();
    world.row = { ...approval, kind };
    await draw();
    expect(tree!.root.findAllByType('textarea')[0].props.maxLength).toBe(2000);
    await write('  The pond is full of fish.  ');
    await press('Deny');
    expect(answers(), kind).toEqual([{ id: 'a-1', answer: 'deny', reason: 'The pond is full of fish.' }]);
    expect(reported.mock.calls, kind).toEqual([['refuse', {}]]);
    expect(JSON.stringify(reported.mock.calls)).not.toContain('fish');
  }
  // With nothing written, no reason is sent.
  sent.mockClear(); reported.mockClear();
  await draw();
  await press('Deny');
  expect(answers()).toEqual([{ id: 'a-1', answer: 'deny' }]);
  expect(reported.mock.calls).toEqual([['refuse', {}]]);
});

it('shows a refused answer in loom\'s own words, leaves the controls, and tells the board nothing', async () => {
  world.reply = () => ({ status: 409, body: { ok: false, code: 'conflict', message: 'This approval cannot be answered now. Open it again.' } });
  await draw();
  await write('typed reason');
  for (const label of ['Allow', 'Deny']) {
    await press(label);
    expect(said(tree!.root.findAll((node) => node.props.role === 'alert')[0])).toBe('This approval cannot be answered now. Open it again.');
    expect(labels()).toEqual(['Allow', 'Deny']);
    expect(buttons().every((b) => b.props.disabled === false)).toBe(true);
  }
  // Anything else that fails is one fixed line: nothing of the reply is shown.
  world.reply = () => ({ status: 503, body: { ok: false, code: 'unavailable', message: 'private server detail' } });
  await press('Allow');
  expect(said(tree!.root.findAll((node) => node.props.role === 'alert')[0])).toBe('Could not save your answer. Reconnect and try again.');
  expect(text()).not.toContain('private server detail');
  // An acknowledgement of some other approval is not a yes.
  world.reply = () => ({ status: 200, body: { ok: true, value: { id: 'a-other' } } });
  await press('Allow');
  expect(tree!.root.findAll((node) => node.props.role === 'alert')).toHaveLength(1);
  expect(labels()).toEqual(['Allow', 'Deny']);
  expect(reported).not.toHaveBeenCalled();
});

it('disables every control while an answer is in flight and drops a second press', async () => {
  let finish!: () => void;
  const waiting = new Promise<void>((done) => { finish = done; });
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const input = JSON.parse(init.body).input; sent(url, input);
    await waiting;
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { id: input.id } }) };
  });
  await draw();
  await act(async () => { buttons()[0].props.onClick(); buttons()[0].props.onClick(); buttons()[1].props.onClick(); });
  expect(answers()).toEqual([{ id: 'a-1', answer: 'allow' }]);
  expect(buttons().every((b) => b.props.disabled === true)).toBe(true);
  expect(tree!.root.findAllByType('textarea')[0].props.disabled).toBe(true);
  expect(text()).toContain('Saving answer…');
  expect(reported).not.toHaveBeenCalled();
  await act(async () => { buttons()[1].props.onClick(); });
  expect(answers()).toHaveLength(1);
  await act(async () => { finish(); await waiting; });
  expect(reported.mock.calls).toEqual([['approve', {}]]);
  expect(text()).not.toContain('Saving answer…');
});

it('shows the outcome and no controls once the request is answered, by anyone, while it is on screen', async () => {
  world.row = { ...approval, kind: 'dangerous' };
  await draw();
  await press('Allow');
  expect(labels()).toEqual(['Yes, allow it', 'Cancel', 'Deny']);
  // Someone else denies it while the second yes is being asked.
  world.row = { ...approval, kind: 'dangerous', state: 'denied', decidedBy: 'robin' };
  world.record = [{ seq: 2, at: approval.askedAt, event: 'deny', approval: 'a-1', agent: 'art', note: 'robin' }];
  await again();
  expect(controls()).toEqual([]);
  expect(handlers()).toEqual([]);
  expect(text()).toContain('denied');
  expect(text()).toContain('Answered by Robin');
  expect(text()).not.toContain('This cannot be undone.');
  // An answer quoted from a conversation is said in the record's own words.
  const quoted = 'Allowed by sam through art, on their words: “Go ahead” (conversation room, message msg, item item)';
  world.row = { ...approval, state: 'allowed', decidedBy: 'sam' };
  world.record = [{ seq: 2, at: approval.askedAt, event: 'allow', approval: 'a-1', agent: 'art', note: quoted }];
  await again();
  expect(text()).toContain(quoted);
  expect(controls()).toEqual([]);
  // The request leaves the member's reads: nothing of it stays, and no control.
  world.row = null;
  await again();
  expect(said(tree!.root as Node)).toBe('This approval is unavailable.');
  // Another approval's row is never drawn in this one's place.
  world.row = { ...approval, id: 'a-2' };
  await again();
  expect(said(tree!.root as Node)).toBe('This approval is unavailable.');
  expect(sent).not.toHaveBeenCalled();
  expect(reported).not.toHaveBeenCalled();
});

it('withdraws the controls when loom stops saying the member may answer', async () => {
  await draw();
  expect(labels()).toEqual(['Allow', 'Deny']);
  for (const owner of [false, 'offline', 'loading'] as const) {
    world.owner = owner;
    await again();
    expect(controls(), String(owner)).toEqual([]);
  }
});

it('shows of a household change only its title, why and state to a member who may not answer, and asks loom for no reading of it', async () => {
  Object.assign(world, { row: household, owner: false, preview: reading('a'.repeat(64)) });
  await draw();
  expect(said(tree!.root.findAll((node) => node.props.className === 'board-lead')[0])).toBe('stored words');
  for (const hidden of ['stored ask', 'stored yes', 'stored no', 'stored-target', 'robin', 'Robin']) expect(text(), hidden).not.toContain(hidden);
  expect(text()).toContain('The liner leaks.');
  expect(text()).toContain('pending');
  expect(tree!.root.findAll((node) => !!node.props['data-place'])).toEqual([]);
  expect(controls()).toEqual([]);
  expect(sent).not.toHaveBeenCalled();
});

it('shows an owner a household change as loom reads it now, and allows it naming the version that is on screen', async () => {
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  Object.assign(world, { row: household, preview: reading(first) });
  await draw();
  expect(sent.mock.calls).toEqual([['/api/household/proposalPreview', { id: 'a-1' }]]);
  for (const shown of ['Make Robin an owner', 'Who', 'Robin becomes an owner.', 'Robin stays a member.', 'Exact request', 'The request has been refreshed. Review the current settings before allowing it.']) expect(text(), shown).toContain(shown);
  for (const hidden of ['stored ask', 'stored yes', 'stored no', 'stored-target']) expect(text(), hidden).not.toContain(hidden);
  // loom refuses the Allow because the change moved on: the reason is said, the request is read again, and the
  // next Allow names the version that is now on screen, not the one refused.
  world.reply = () => ({ status: 409, body: { ok: false, code: 'conflict', message: 'The reviewed settings changed. Review the updated card before allowing it.' } });
  world.preview = reading(second, 'Robin Lee');
  await press('Allow');
  expect(answers()).toEqual([{ id: 'a-1', answer: 'allow', review: first }]);
  expect(previews()).toBe(2);
  expect(text()).toContain('Make Robin Lee an owner');
  expect(text()).not.toContain('Make Robin an owner');
  expect(reported).not.toHaveBeenCalled();
  expect(labels()).toEqual(['Allow', 'Deny']);
  world.reply = (input) => ({ status: 200, body: { ok: true, value: { id: input.id } } });
  await press('Allow');
  expect(answers().at(-1)).toEqual({ id: 'a-1', answer: 'allow', review: second });
  expect(reported.mock.calls).toEqual([['approve', {}]]);
});

it('starts the second yes over when a dangerous household change is read again in a new version', async () => {
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  Object.assign(world, { row: { ...household, kind: 'dangerous' }, preview: reading(first) });
  world.reply = () => ({ status: 409, body: { ok: false, code: 'conflict', message: 'The reviewed settings changed. Review the updated card before allowing it.' } });
  await draw('primary');
  await press('Allow');
  expect(answers()).toEqual([]);
  world.preview = reading(second, 'Robin Lee');
  await press('Yes, allow it');
  expect(answers()).toEqual([{ id: 'a-1', answer: 'allow', confirm: true, review: first }]);
  // The new version is on screen and nothing pressed for the old one carries over: Allow asks again.
  expect(text()).toContain('Make Robin Lee an owner');
  expect(labels()).toEqual(['Allow', 'Deny']);
  expect(text()).not.toContain('This cannot be undone.');
  world.reply = (input) => ({ status: 200, body: { ok: true, value: { id: input.id } } });
  await press('Allow');
  expect(answers()).toHaveLength(1);
  await press('Yes, allow it');
  expect(answers().at(-1)).toEqual({ id: 'a-1', answer: 'allow', confirm: true, review: second });
});

it('names no version where loom gave none, and says what stands against a household change above buttons that stay', async () => {
  Object.assign(world, { row: household, preview: reading(undefined) });
  await draw();
  expect(text()).toContain('Make Robin an owner');
  expect(text()).not.toContain('The request has been refreshed');
  await press('Allow');
  expect(answers()).toEqual([{ id: 'a-1', answer: 'allow' }]);
  sent.mockClear();
  world.preview = { ...reading(undefined), blocked: 'This cannot be allowed yet: Robin has not signed in. Deny this card, and ask for it again once that is done.' };
  await draw();
  expect(text()).toContain('loom will refuse this as things stand: Robin has not signed in.');
  expect(labels()).toEqual(['Allow', 'Deny']);
  // A reason typed for a household change goes with the Deny, and no version does.
  await write('Not yet.');
  await press('Deny');
  expect(answers()).toEqual([{ id: 'a-1', answer: 'deny', reason: 'Not yet.' }]);
  expect(reported.mock.calls.at(-1)).toEqual(['refuse', {}]);
});

it('decides nothing about the answer in the brick itself: every send goes through the code the desktop runs', () => {
  const source = readFileSync(new URL('./bricks-approval.tsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  for (const own of ['memberOperation', 'sendWorkAnswer', 'sendWorkAlways', 'fetch(', 'work-answer', 'work-always', 'data/operation', '/api/', 'confirm:', 'review:', "'dangerous'", 'useState', 'useRef', '../kit\'', 'kit/index', '.css'])
    expect(source, own).not.toContain(own);
  for (const shared of ['../pieces/approval-view/answering', '../data/work-approvals', 'useAnswering', 'ownerApprovalActions', 'useProposalNow', 'useWorkAccess', 'answerKey'])
    expect(source, shared).toContain(shared);
});
