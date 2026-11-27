/** Every branch of how an approval is read and answered (./answering.ts), with no view over it. The desktop's view
 * and the board's brick draw from these and add no decision of their own. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
import { shellCommandRecord } from '../../../../src/apps/shell-command-record';
import { answerable, answerFailed, answerKey, approvalReading, cautionWords, forWhom, needsSecondYes, refusalWords, same, sendAllow, sendDeny, useAnswering, type ApprovalActions } from './answering';
import type { Approval, Record as ApprovalRecord } from './model';
import { tempoChangeWords } from '../tempo/change';
import { measuringChangeWords } from '../measuring/change';
import { renderTempoChange } from '../tempo/settings';
import { renderMeasuringChange } from '../measuring/settings';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: Approval = { id: 'a-1', kind: 'command', target: 'pond/pump', operation: null, what: 'Drain the pond', why: 'The liner leaks.', agent: 'art', project: 'pond', member: 'sam',
  conversation: null, state: 'pending', ask: 'Drain the pond tonight?', ifYes: 'The pond is emptied.', ifNo: 'It keeps leaking.', details: 'pump --drain --all', changeSummary: 'Pond: full → empty',
  askedAt: '2026-11-14T20:00:00Z', decidedBy: null, expiresAt: null };
const household: Approval = { ...base, kind: 'setting', operation: 'household.change', what: 'stored words', details: JSON.stringify({ change: 'somethingNew', after: {} }) };
const card = { title: 'Make Robin an owner', nothing: false, facts: [{ label: 'Who', value: 'Robin' }], exact: '{"member":"robin"}', ifYes: 'Robin becomes an owner.', ifNo: 'Robin stays a member.' };
const name = (id: string) => id.toUpperCase();
const commands = () => ({ allow: vi.fn(async () => {}), deny: vi.fn(async () => {}) });
const states = ['pending', 'allowed', 'denied', 'used', 'withdrawn', 'expired'] as const;
const kinds = ['merge', 'command', 'setting', 'dangerous'] as const;

it('draws answer controls only for a waiting request, for a viewer given the commands, where the composition does not rule the request out', () => {
  for (const state of states) {
    expect(answerable({ state }, commands()), state).toBe(state === 'pending');
    // No commands: the viewer is not one loom says may answer.
    expect(answerable({ state }, undefined), state).toBe(false);
  }
  expect(answerable(base, { ...commands(), supports: () => false })).toBe(false);
  expect(answerable(base, { ...commands(), supports: (a) => a.id === 'a-1' })).toBe(true);
});

it('asks a second yes for a dangerous action and for nothing else', () => {
  for (const kind of kinds) expect(needsSecondYes({ kind }), kind).toBe(kind === 'dangerous');
});

it('names the reviewed version in an Allow exactly when the request on screen carries one, and confirm only on the second yes', async () => {
  const review = 'a'.repeat(64);
  const plain = commands(); await sendAllow(base, plain);
  expect(plain.allow).toHaveBeenCalledExactlyOnceWith('a-1');
  const second = commands(); await sendAllow(base, second, true);
  expect(second.allow).toHaveBeenCalledExactlyOnceWith('a-1', true);
  const reviewed = commands(); await sendAllow({ ...base, review }, reviewed);
  expect(reviewed.allow).toHaveBeenCalledExactlyOnceWith('a-1', undefined, review);
  const both = commands(); await sendAllow({ ...base, review }, both, true);
  expect(both.allow).toHaveBeenCalledExactlyOnceWith('a-1', true, review);
  for (const sent of [plain, second, reviewed, both]) expect(sent.deny).not.toHaveBeenCalled();
});

it('sends a reason for denying only when one was written, without the space around it', async () => {
  const none = commands(); await sendDeny(base, none, '');
  expect(none.deny).toHaveBeenCalledExactlyOnceWith('a-1');
  const blank = commands(); await sendDeny(base, blank, '  \n ');
  expect(blank.deny).toHaveBeenCalledExactlyOnceWith('a-1');
  const written = commands(); await sendDeny(base, written, '  Not tonight. \n');
  expect(written.deny).toHaveBeenCalledExactlyOnceWith('a-1', 'Not tonight.');
  expect(written.allow).not.toHaveBeenCalled();
});

it("says the program's own refusal as it is and anything else that failed as one fixed line", () => {
  expect(refusalWords(Object.assign(new Error('At least one household owner must remain'), { name: 'WorkRefused' }))).toBe('At least one household owner must remain');
  for (const other of [new Error('private server detail'), Object.assign(new Error('x'), { name: 'TypeError' }), { name: 'WorkRefused', message: 7 }, { name: 'WorkRefused' }, null, undefined, 'WorkRefused'])
    expect(refusalWords(other)).toBe(answerFailed);
});

it('keys the answering state by the reviewed version where there is one, else by the request', () => {
  expect(answerKey(base)).toBe('a-1');
  expect(answerKey({ ...base, review: 'b'.repeat(64) })).toBe('b'.repeat(64));
});

it('says what stands against allowing a request: a new version first, then a household blocker while it waits, then a stored problem', () => {
  expect(cautionWords(base)).toBeNull();
  expect(cautionWords(household)).toBeNull();
  expect(cautionWords({ ...household, review: 'a'.repeat(64), blocked: 'This cannot be allowed yet: x' })).toBe('The request has been refreshed. Review the current settings before allowing it.');
  for (const lead of ['This cannot be allowed: ', 'This cannot be allowed yet: ', 'This cannot be allowed as it stands: ', ''])
    expect(cautionWords({ ...household, blocked: lead + 'Art does not take messages from this account.' })).toBe('loom will refuse this as things stand: Art does not take messages from this account.');
  // An answered household card says nothing against itself. A household card's `problem` is not said; another card's `blocked` is not said.
  expect(cautionWords({ ...household, state: 'denied', blocked: 'This cannot be allowed yet: x' })).toBeNull();
  expect(cautionWords({ ...household, problem: 'p' })).toBeNull();
  expect(cautionWords({ ...base, blocked: 'b' })).toBeNull();
  expect(cautionWords({ ...base, problem: 'No live token has that label' })).toBe('This cannot be allowed as it stands: No live token has that label');
});

it('compares a question with its title without case or closing marks, and says whose a private request is', () => {
  expect(same(' Drain the pond?! ')).toBe(same('drain the pond'));
  expect(same('Drain the pond tonight?')).not.toBe(same('Drain the pond'));
  expect(forWhom({ member: null }, 'sam', name)).toBe('');
  expect(forWhom({ member: 'sam' }, 'sam', name)).toBe('for you');
  expect(forWhom({ member: 'sam' }, 'lee', name)).toBe('for SAM');
  expect(forWhom({ member: 'sam' }, undefined, name)).toBe('for SAM');
});

it('reads an ordinary request in its stored words: the question, what each answer does, the change, exactly what it allows and its details', () => {
  const r = approvalReading(base, [], name);
  expect(r).toMatchObject({ household: false, showStored: true, title: 'Drain the pond', ask: 'Drain the pond tonight?', kind: 'command', ifYes: 'The pond is emptied.', ifNo: 'It keeps leaking.',
    storedSummary: 'Pond: full → empty', allows: 'command: pond/pump', fullCommand: '', details: 'pump --drain --all', exact: '', answered: '', shell: false });
  // A question that only repeats the title is not said twice. A title the caller gives stands in for the stored one.
  expect(approvalReading({ ...base, ask: 'Drain the pond?' }, [], name).ask).toBe('');
  expect(approvalReading({ ...base, ask: '' }, [], name).ask).toBe('');
  expect(approvalReading(base, [], name, { displayTitle: 'Shown title' }).title).toBe('Shown title');
  expect(approvalReading({ ...base, changeSummary: null, details: '' }, [], name)).toMatchObject({ storedSummary: '', details: '' });
  // A kind this version does not know is said as it is stored.
  expect(approvalReading({ ...base, kind: 'novel' as Approval['kind'] }, [], name)).toMatchObject({ kind: 'novel', allows: 'novel: pond/pump' });
  // A change drawn as a checked before and after replaces the stored summary and the stored details.
  expect(approvalReading(base, [], name, { change: true })).toMatchObject({ storedSummary: '', details: '', allows: 'command: pond/pump' });
});

it('reads a command filed as a literal command as the full command, from the request event of this approval only', () => {
  const request = (over: Partial<ApprovalRecord>): ApprovalRecord => ({ seq: 1, at: base.askedAt, event: 'request', approval: 'a-1', agent: 'art', note: shellCommandRecord, ...over });
  expect(approvalReading(base, [request({})], name)).toMatchObject({ shell: true, fullCommand: 'pump --drain --all', details: '' });
  for (const other of [request({ approval: 'a-2' }), request({ note: 'something else' }), request({ event: 'use' })])
    expect(approvalReading(base, [other], name)).toMatchObject({ shell: false, fullCommand: '', details: 'pump --drain --all' });
  expect(approvalReading({ ...base, kind: 'dangerous' }, [request({})], name)).toMatchObject({ shell: false, fullCommand: '' });
});

it('reads who answered from the last allow or deny of this approval, in the record\'s own words where it was quoted', () => {
  const row = (seq: number, event: string, note: string, approval = 'a-1'): ApprovalRecord => ({ seq, at: base.askedAt, event, approval, agent: 'art', note });
  expect(approvalReading({ ...base, state: 'denied', decidedBy: 'sam' }, [], name)).toMatchObject({ answered: 'Answered by SAM', decision: undefined });
  const quoted = 'Allowed by sam through art, on their words: “Go ahead”';
  const records = [row(3, 'allow', quoted), row(1, 'request', ''), row(2, 'deny', 'sam'), row(9, 'deny', 'Denied by lee', 'a-2')];
  const r = approvalReading({ ...base, state: 'allowed', decidedBy: 'sam' }, records, name);
  expect(r.record.map((x) => x.seq)).toEqual([1, 2, 3]);
  expect(r.decision?.seq).toBe(3);
  expect(r.answered).toBe(quoted);
  expect(approvalReading({ ...base, state: 'denied', decidedBy: 'sam' }, [row(2, 'deny', 'sam')], name).answered).toBe('Answered by SAM');
  expect(approvalReading(base, records, name).answered).toBe('');
});

it('reads of a household change only its title without the owner\'s reading, and with it the reading\'s own words', () => {
  const bare = approvalReading({ ...household, exactRequest: 'exact stored' }, [], name);
  expect(bare).toMatchObject({ household: true, showStored: false, title: 'stored words', ask: '', storedSummary: '', allows: '', details: '', fullCommand: '', exact: 'exact stored' });
  const read = approvalReading({ ...household, card, exactRequest: 'exact stored' }, [], name, { displayTitle: 'Shown title' });
  expect(read).toMatchObject({ household: true, showStored: true, title: 'Make Robin an owner', ifYes: 'Robin becomes an owner.', ifNo: 'Robin stays a member.', exact: '{"member":"robin"}', ask: '', storedSummary: '', allows: '', details: '' });
  expect(read.card?.facts).toEqual(card.facts);
  // A reading that does not say what the answers do leaves the stored words for them.
  expect(approvalReading({ ...household, card: { ...card, ifYes: undefined, ifNo: undefined } }, [], name)).toMatchObject({ ifYes: 'The pond is emptied.', ifNo: 'It keeps leaking.' });
});

it('says a checked Tempo or Measuring change as before and after, exactly where the desktop draws one', () => {
  const timings = { settleSeconds: 1, dimDays: 2, muteDays: 3 }, later = { settleSeconds: 60, dimDays: 1, muteDays: 3 };
  const tempo = { kind: 'setting', target: 'tempo:agent:art', details: JSON.stringify({ who: { kind: 'agent', id: 'art' }, before: timings, after: later }),
    changeSummary: 'Tempo for agent art: settle 1 → 60 seconds; dim 2 → 1 days; mute 3 → 3 days' };
  expect(tempoChangeWords(tempo)).toEqual({ label: 'Tempo settings change', heading: 'Change Tempo timings for agent art', note: 'Allow applies these timings. Deny keeps the current timings.',
    before: [{ label: 'Inbox settle time', value: '1 second' }, { label: 'Dim ends after', value: '2 days' }, { label: 'Mute ends after', value: '3 days' }],
    after: [{ label: 'Inbox settle time', value: '60 seconds' }, { label: 'Dim ends after', value: '1 day' }, { label: 'Mute ends after', value: '3 days' }] });
  const off = { on: false, send_outside: false, outside_address: '', keep_days: 90 }, on = { on: true, send_outside: true, outside_address: 'https://monitor.example/v1/traces', keep_days: 0 };
  const measuring = { kind: 'setting', target: 'measuring', details: JSON.stringify({ before: off, after: on }), changeSummary: `Measuring: ${JSON.stringify(off)} → ${JSON.stringify(on)}` };
  expect(measuringChangeWords(measuring)).toEqual({ label: 'Measuring settings change', heading: 'Change Measuring settings', note: 'Allow applies these settings. Deny keeps the current settings.',
    before: [{ label: 'Measuring', value: 'Off' }, { label: 'Outside monitoring tool', value: 'Do not send measurements' }, { label: 'Monitoring address', value: 'None', long: true }, { label: 'Local history', value: '90 days' }],
    after: [{ label: 'Measuring', value: 'On' }, { label: 'Outside monitoring tool', value: 'Send measurements' }, { label: 'Monitoring address', value: on.outside_address, long: true }, { label: 'Local history', value: 'No local history' }] });
  // A card that is not exactly such a change has no checked words, in the pure reading and in the desktop's drawing alike.
  const not = [{ ...tempo, kind: 'command' }, { ...tempo, target: 'tempo:agent:mark' }, { ...tempo, changeSummary: 'Tempo, roughly' }, { ...tempo, details: 'not json' }, { ...tempo, details: JSON.stringify({ who: { kind: 'agent', id: 'art' }, before: timings }) },
    { ...measuring, kind: 'dangerous' }, { ...measuring, target: 'measuring:other' }, { ...measuring, changeSummary: 'Measuring, roughly' }, { ...measuring, details: '{}' }];
  for (const card of not) {
    expect(tempoChangeWords(card) ?? measuringChangeWords(card), JSON.stringify(card)).toBeNull();
    expect(renderTempoChange(card) ?? renderMeasuringChange(card), JSON.stringify(card)).toBeNull();
  }
  expect(renderTempoChange(tempo)).not.toBeNull();
  expect(renderMeasuringChange(measuring)).not.toBeNull();
});

/** The hook, read through a component that draws nothing. */
type Answering = ReturnType<typeof useAnswering>;
let tree: { update(element: unknown): void; unmount(): void } | undefined, now: Answering;
function Probe(props: { approval: Approval; actions?: ApprovalActions }) { now = useAnswering(props.approval, props.actions); return null; }
async function mount(approval: Approval, actions?: ApprovalActions) { await act(async () => { tree?.unmount(); tree = create(h(Probe, { approval, actions })); }); }
const step = (press: () => void) => act(async () => { press(); });
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });

it('allows an ordinary request on one press and reports that it was taken', async () => {
  for (const kind of ['merge', 'command', 'setting'] as const) {
    const sent = commands();
    await mount({ ...base, kind }, sent);
    expect(now).toMatchObject({ open: true, busy: false, error: '', allowed: false, confirming: false, always: undefined });
    await step(() => now.confirm());
    expect(sent.allow, kind).not.toHaveBeenCalled();
    await step(() => now.allow());
    expect(sent.allow, kind).toHaveBeenCalledExactlyOnceWith('a-1');
    expect(now).toMatchObject({ allowed: true, confirming: false, error: '' });
  }
});

it('never allows a dangerous action on one press: the first asks, cancel sends nothing, the second yes sends confirm', async () => {
  const sent = commands();
  await mount({ ...base, kind: 'dangerous' }, sent);
  // The second yes cannot be given before it is asked.
  await step(() => now.confirm());
  expect(sent.allow).not.toHaveBeenCalled();
  await step(() => now.allow());
  await step(() => now.allow());
  expect(now.confirming).toBe(true);
  expect(sent.allow).not.toHaveBeenCalled();
  await step(() => now.cancel());
  expect(now.confirming).toBe(false);
  await step(() => now.confirm());
  expect(sent.allow).not.toHaveBeenCalled();
  await step(() => now.allow());
  await step(() => now.confirm());
  expect(sent.allow).toHaveBeenCalledExactlyOnceWith('a-1', true);
  expect(now.allowed).toBe(true);
});

it('sends the reviewed version that is on the request it was given, with the second yes where the change is dangerous', async () => {
  const review = 'c'.repeat(64);
  const sent = commands();
  await mount({ ...household, card, review }, sent);
  await step(() => now.allow());
  expect(sent.allow).toHaveBeenCalledExactlyOnceWith('a-1', undefined, review);
  const risky = commands();
  await mount({ ...household, kind: 'dangerous', card, review }, risky);
  await step(() => now.allow());
  expect(risky.allow).not.toHaveBeenCalled();
  await step(() => now.confirm());
  expect(risky.allow).toHaveBeenCalledExactlyOnceWith('a-1', true, review);
});

it('denies with the written reason, on one press, for any kind', async () => {
  for (const kind of kinds) {
    const sent = commands();
    await mount({ ...base, kind }, sent);
    await step(() => now.setReason('  The pond is full of fish. '));
    expect(now.reason).toBe('  The pond is full of fish. ');
    await step(() => now.deny());
    expect(sent.deny, kind).toHaveBeenCalledExactlyOnceWith('a-1', 'The pond is full of fish.');
    expect(sent.allow).not.toHaveBeenCalled();
    expect(now.allowed).toBe(false);
  }
});

it('sends nothing for a viewer without the commands, a request the composition rules out, or a request no longer waiting', async () => {
  const sent = commands();
  const cases: [Approval, ApprovalActions | undefined][] = [[base, undefined], [base, { ...sent, supports: () => false }], ...states.filter((state) => state !== 'pending').map((state): [Approval, ApprovalActions] => [{ ...base, kind: 'dangerous', state }, sent])];
  for (const [approval, actions] of cases) {
    await mount(approval, actions);
    expect(now.open).toBe(false);
    expect(now.always).toBeUndefined();
    for (const press of [() => now.allow(), () => now.confirm(), () => now.deny()]) await step(press);
    expect(now.confirming).toBe(false);
  }
  expect(sent.allow).not.toHaveBeenCalled();
  expect(sent.deny).not.toHaveBeenCalled();
});

it('holds one call in flight, drops every press meanwhile, and says a refused answer in the program\'s words', async () => {
  let refuse!: (error: unknown) => void;
  const allow = vi.fn(() => new Promise<void>((_, no) => { refuse = no; })), deny = vi.fn(async () => {}), refreshProposal = vi.fn();
  await mount(base, { allow, deny, refreshProposal });
  await step(() => { now.allow(); now.allow(); });
  expect(now.busy).toBe(true);
  await step(() => { now.deny(); now.allow(); });
  expect(allow).toHaveBeenCalledTimes(1);
  expect(deny).not.toHaveBeenCalled();
  await step(() => refuse(Object.assign(new Error('The reviewed settings changed. Review the updated card before allowing it.'), { name: 'WorkRefused' })));
  expect(now).toMatchObject({ busy: false, allowed: false, open: true, error: 'The reviewed settings changed. Review the updated card before allowing it.' });
  // A refused Allow has the request read again.
  expect(refreshProposal).toHaveBeenCalledExactlyOnceWith('a-1');
  // The next try clears what was said; anything else that fails is one fixed line.
  await step(() => now.allow());
  expect(now).toMatchObject({ busy: true, error: '' });
  await step(() => refuse(new Error('private server detail')));
  expect(now.error).toBe(answerFailed);
  expect(refreshProposal).toHaveBeenCalledTimes(2);
});

it('does not read the request again for a failed Deny', async () => {
  const refreshProposal = vi.fn(), deny = vi.fn(async () => { throw Object.assign(new Error('This approval cannot be answered now. Open it again.'), { name: 'WorkRefused' }); });
  await mount(base, { allow: vi.fn(async () => {}), deny, refreshProposal });
  await step(() => now.deny());
  expect(now).toMatchObject({ error: 'This approval cannot be answered now. Open it again.', allowed: false, busy: false });
  expect(refreshProposal).not.toHaveBeenCalled();
});

it('offers a standing answer only for the very request the composition names', async () => {
  const run = vi.fn(async () => {});
  await mount(base, { ...commands(), always: { approval: 'a-other', label: 'Always for pond', run } });
  expect(now.always).toBeUndefined();
  const sent = commands();
  await mount(base, { ...sent, always: { approval: 'a-1', label: 'Always for pond', run } });
  expect(now.always?.label).toBe('Always for pond');
  await step(() => now.always!.run());
  expect(run).toHaveBeenCalledExactlyOnceWith('a-1');
  expect(sent.allow).not.toHaveBeenCalled();
  expect(now.allowed).toBe(false);
});

it('sends a standing answer only as the yes to its question, for a view that asks first', async () => {
  function Asking(props: { approval: Approval; actions?: ApprovalActions }) { now = useAnswering(props.approval, props.actions, { askStanding: true }); return null; }
  const run = vi.fn(async () => {}), sent = commands();
  await act(async () => { tree?.unmount(); tree = create(h(Asking, { approval: base, actions: { ...sent, always: { approval: 'a-1', label: 'Always for pond', run } } })); });
  // A press that was not asked about sends nothing.
  await step(() => now.always!.run());
  expect(run).not.toHaveBeenCalled();
  expect(now.always).toMatchObject({ label: 'Always for pond', asking: false });
  await step(() => now.always!.ask());
  expect(now.always!.asking).toBe(true);
  expect(run).not.toHaveBeenCalled();
  await step(() => now.always!.cancel());
  expect(now.always!.asking).toBe(false);
  await step(() => now.always!.run());
  expect(run).not.toHaveBeenCalled();
  await step(() => now.always!.ask());
  await step(() => now.always!.run());
  expect(run).toHaveBeenCalledExactlyOnceWith('a-1');
  // The question does not stay open for a second send.
  expect(now.always!.asking).toBe(false);
  expect(sent.allow).not.toHaveBeenCalled();
});
