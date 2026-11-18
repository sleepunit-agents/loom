import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../kit', () => Object.fromEntries(['Split', 'List', 'Row', 'Empty', 'Error', 'Loading', 'Button', 'Input'].map(name => [name, (props: { children?: ReactNode; reader?: ReactNode; list?: ReactNode }) => h(name, props, props.children, ...(name === 'Split' ? [props.list, props.reader] : []))])));
import Approvals, { ApprovalCard, type ApprovalActions } from './index';
import { renderMeasuringChange } from '../measuring/settings';
import { rows, type ApprovalSnapshot } from './model';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const approval = { id: 'a-pump', kind: 'setting' as const, target: 'inbox:pace', what: 'Change inbox pace', why: 'Answer faster', agent: 'art', project: null, member: null,
  conversation: 'cv-pump', state: 'pending' as const, ask: 'Wake the inbox every minute?', ifYes: 'I change it', ifNo: 'I keep the default', details: '',
  changeSummary: 'Before: default. After: 60 seconds.', askedAt: '2026-11-14T20:00:00Z', decidedBy: null, expiresAt: null };
const snapshot: ApprovalSnapshot = { status: 'live', approvals: [approval], rules: [], notices: [], record: [], timezone: 'America/Chicago' };
const buttons = () => tree.root.findAllByType('Button');
async function draw(s = snapshot, actions?: ApprovalActions) { await act(async () => { tree = create(h(ApprovalCard, { id: approval.id, snapshot: s, actions })); }); }

it('renders exact before/after and outcome lines inline and uses the original request id', async () => {
  const allow = vi.fn(async () => {}), deny = vi.fn(async () => {});
  await draw(snapshot, { allow, deny });
  const words = JSON.stringify(tree.toJSON());
  for (const text of [approval.ask, approval.changeSummary, approval.ifYes, approval.ifNo, approval.target]) expect(words).toContain(text);
  await act(async () => { buttons().find((b: { props: { children: string } }) => b.props.children === 'Allow').props.onClick(); });
  expect(allow).toHaveBeenCalledExactlyOnceWith(approval.id);
  expect(deny).not.toHaveBeenCalled();
  await act(async () => { tree.update(h(ApprovalCard, { id: approval.id, snapshot: { ...snapshot, approvals: [{ ...approval, state: 'used' }] }, actions: { allow, deny } })); });
  expect(buttons()).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('used');
});

it('withdraws private words and answer buttons on access loss even if the caller retains stale rows', async () => {
  await draw(snapshot, { allow: vi.fn(), deny: vi.fn() });
  for (const status of ['offline', 'denied', 'loading'] as const) {
    await act(async () => { tree.update(h(ApprovalCard, { id: approval.id, snapshot: { ...snapshot, status } })); });
    expect(buttons()).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).not.toContain(approval.ask);
  }
});

it('does not offer Always for another approval, serializes taps and displays save failures', async () => {
  let reject!: (error: Error) => void;
  const allow = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  await draw(snapshot, { allow, deny: vi.fn(), always: { approval: 'a-other', label: 'Always for pond', run: vi.fn() } });
  expect(buttons().map((b: { props: { children: string } }) => b.props.children)).toEqual(['Allow', 'Deny']);
  await act(async () => { const button = buttons()[0]; button.props.onClick(); button.props.onClick(); });
  expect(allow).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error('private server detail')); });
  expect(tree.root.findAllByType('Error')).toHaveLength(1);
  expect(JSON.stringify(tree.toJSON())).not.toContain('private server detail');
});

it('keeps current pending/history folders and filters them without returning stale records', () => {
  const s: ApprovalSnapshot = { ...snapshot, approvals: [approval, { ...approval, id: 'a-used', state: 'used' }] };
  expect(rows(s, 'pending', 'inbox art').map(a => a.id)).toEqual(['a-pump']);
  expect(rows(s, 'history', '').map(a => a.id)).toEqual(['a-used']);
  expect(rows({ ...s, status: 'offline' }, 'pending', '')).toEqual([]);
});

it('mounts validated Measuring before/after in the shared inline card and removes it on access loss', async () => {
  const before = { on: false, send_outside: false, outside_address: '', keep_days: 90 };
  const after = { ...before, on: true, keep_days: 7 };
  const measuring = { ...approval, target: 'measuring', details: JSON.stringify({ before, after }),
    changeSummary: `Measuring: ${JSON.stringify(before)} → ${JSON.stringify(after)}` };
  const live: ApprovalSnapshot = { ...snapshot, approvals: [measuring] };
  const renderChange = vi.fn(renderMeasuringChange), allow = vi.fn(async () => {});
  await act(async () => { tree = create(h(ApprovalCard, { id: measuring.id, snapshot: live, renderChange, actions: { allow, deny: vi.fn() } })); });
  expect(JSON.stringify(tree.toJSON())).toContain('Measuring settings change');
  expect(JSON.stringify(tree.toJSON())).toContain('Before');
  expect(JSON.stringify(tree.toJSON())).toContain('After');
  expect(renderChange).toHaveBeenCalledWith(measuring);
  await act(async () => { buttons().find((b: { props: { children: string } }) => b.props.children === 'Allow').props.onClick(); });
  expect(allow).toHaveBeenCalledExactlyOnceWith(measuring.id);
  renderChange.mockClear();
  await act(async () => { tree.update(h(ApprovalCard, { id: measuring.id, snapshot: { ...live, status: 'denied' }, renderChange })); });
  expect(JSON.stringify(tree.toJSON())).not.toContain('Measuring settings change');
  expect(renderChange).not.toHaveBeenCalled();
});

it('threads change presentation through the selected tile reader without parsing it in generic Approvals', async () => {
  const renderChange = vi.fn(() => h('p', {}, 'Custom before and after'));
  await act(async () => { tree = create(h(Approvals, { snapshot, renderChange })); });
  expect(renderChange).not.toHaveBeenCalled();
  await act(async () => { tree.root.findByType('Row').props.onClick(); });
  expect(renderChange).toHaveBeenCalledWith(approval);
  expect(tree.root.findAllByType('p').some((p: { props: { children: string } }) => p.props.children === 'Custom before and after')).toBe(true);
  renderChange.mockClear();
  await act(async () => { tree.update(h(Approvals, { snapshot: { ...snapshot, status: 'offline' }, renderChange })); });
  expect(renderChange).not.toHaveBeenCalled();
  expect(tree.root.findAllByType('p').some((p: { props: { children: string } }) => p.props.children === 'Custom before and after')).toBe(false);
});

it('asks for a second, explicit yes before allowing a dangerous action; cancel sends nothing', async () => {
  const allow = vi.fn(async () => {}), deny = vi.fn(async () => {});
  const dangerous = { ...snapshot, approvals: [{ ...approval, kind: 'dangerous' as const }] };
  const press = (label: string) => act(async () => { buttons().find((b: { props: { children: string } }) => b.props.children === label).props.onClick(); });
  await draw(dangerous, { allow, deny });
  await press('Allow');
  expect(allow).not.toHaveBeenCalled();
  expect(JSON.stringify(tree.toJSON())).toContain('This cannot be undone.');
  await press('Cancel');
  expect(allow).not.toHaveBeenCalled();
  expect(JSON.stringify(tree.toJSON())).not.toContain('This cannot be undone.');
  await press('Allow'); await press('Yes, allow it');
  expect(allow).toHaveBeenCalledExactlyOnceWith(approval.id, true);
  await press('Deny');
  expect(deny).toHaveBeenCalledExactlyOnceWith(approval.id);
});

it('says the program\'s own refusal of an answer as it is, and shows what already stands against a card', async () => {
  let reject!: (error: Error) => void;
  const allow = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  await draw({ ...snapshot, approvals: [{ ...approval, problem: 'No live token has that label' }] }, { allow, deny: vi.fn() });
  expect(JSON.stringify(tree.toJSON())).toContain('No live token has that label');
  await act(async () => { buttons()[0].props.onClick(); });
  await act(async () => { reject(Object.assign(new Error('At least one household owner must remain'), { name: 'WorkRefused' })); });
  expect(tree.root.findAllByType('Error').map((node: { props: { text: string } }) => node.props.text)).toEqual(['At least one household owner must remain']);
  // A card nothing stands against says nothing about it.
  await draw(snapshot, { allow: vi.fn(), deny: vi.fn() });
  expect(JSON.stringify(tree.toJSON())).not.toContain('cannot be allowed');
});

it('shows the quoted decision on the inline approval card', async () => {
 const note='Allowed by sam through art, on their words: “Go ahead” (conversation room, message msg, item item)';
 await draw({...snapshot,approvals:[{...approval,state:'allowed',decidedBy:'sam'}],
   record:[{seq:1,at:approval.askedAt,event:'allow',approval:approval.id,agent:'art',note}]});
 expect(JSON.stringify(tree.toJSON())).toContain(note);
});

it('keeps machine Allow disabled until the owner review has loaded and all conditions pass', async () => {
  const card = { ...approval, operation: 'household.change', target: 'household:triggerMachine:evening', changeSummary: 'Request filed' };
  const actions = { allow: vi.fn(), deny: vi.fn() };
  const allowDisabled = () => buttons().find((b: { props: { children: string } }) => b.props.children === 'Allow')?.props.disabled;
  await draw({ ...snapshot, approvals: [card] }, actions);
  expect(allowDisabled()).toBe(true);
  const words = 'Review ' + 'a'.repeat(5000) + '\nKeep the ending.\n';
  await draw({ ...snapshot, approvals: [{ ...card, problem: 'Worker support is unavailable', changeSummary: words }] }, actions);
  expect(allowDisabled()).toBe(true);
  expect(tree.root.findAllByType('p').some((p: { props: { children: unknown } }) => p.props.children === words)).toBe(true);
  expect(JSON.stringify(tree.toJSON())).toContain('worker credentials');
});
