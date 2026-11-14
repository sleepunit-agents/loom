import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, Suspense, type ReactNode } from 'react';
// @ts-expect-error The renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import type { ApprovalsResult, ChangesResult } from './work-query';
const feed = vi.hoisted(() => ({ status: 'live', approvals: {} as ApprovalsResult, changes: {} as ChangesResult }));
vi.mock('./graphql', () => ({ useDataQuery: (query: string) => ({ status: feed.status, data: query.includes('ApprovalsView') ? feed.approvals : feed.changes }) }));
vi.mock('../kit', () => Object.fromEntries(['Split', 'List', 'Row', 'Empty', 'Error', 'Loading', 'Button', 'Input'].map(name => [name, (props: { children?: ReactNode; reader?: ReactNode; list?: ReactNode; search?: ReactNode }) => h(name, Object.fromEntries(Object.entries(props).filter(([key]) => !['children', 'reader', 'list', 'search', 'blank', 'folders', 'listTop'].includes(key))), props.children, ...(name === 'Split' ? [props.search, props.list, props.reader] : []))])));
import { approvalsApp } from '../pieces/approvals/registration';
import { changesApp } from '../pieces/changes/registration';
import { ApprovalsApp, ChangesApp, LiveApprovalCard, LiveChangeCard } from './work-views';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); feed.status = 'live'; });
function fixture() {
  const before = { on: true, send_outside: false, outside_address: '', keep_days: 7 };
  const after = { ...before, keep_days: 1 };
  feed.approvals = { approvals: [{ id: 'a-one', kind: 'setting', target: 'measuring', what: 'Change measuring', why: 'Keep less', agent: 'art', project: null, member: null, conversation: null, state: 'pending', ask: 'Keep one day?', ifYes: 'Keep one', ifNo: 'Keep seven', details: JSON.stringify({ before, after }), changeSummary: `Measuring: ${JSON.stringify(before)} → ${JSON.stringify(after)}`, askedAt: '2026-11-14T00:00:00Z', decidedBy: null, expiresAt: null }], approvalRules: [], approvalNotices: [{ id: 'n-one', agent: 'art', kind: 'command', target: 'fixture', what: 'Current reported step', at: '2026-11-14T00:00:00Z' }], approvalRecord: [] };
  feed.changes = { changes: [{ id: 'c-one', repository: 'acme/app', number: 1, title: 'Current change', body: '', url: 'https://example.test/1', state: 'open', draft: false, authorLogin: 'sam', project: null, agent: 'art', branch: 'work', headCommit: 'first-head', baseBranch: 'next', checks: 'passing', review: 'approved', mergeable: 'yes', waitingOn: 'you', openedAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z', closedAt: null }], changeChecks: [], changePeople: [], changeTasks: [], changeSync: [] };
}
const words = () => JSON.stringify(tree.toJSON());
async function draw(node: ReactNode) { await act(async () => { tree = create(node); }); }
async function selectRow() { await act(async () => tree.root.findByType('Row').props.onClick()); }

it('the registered lazy tiles actually render the generated shared rows', async () => {
  fixture();
  await draw(h(Suspense, { fallback: 'Opening' }, h(approvalsApp.Screen, {})));
  expect(words()).toContain('Change measuring');
  await selectRow();
  expect(words()).toContain('Keep one day?');
  expect(words()).toContain('Measuring settings change');
  expect(tree.root.findAllByType('Button')).toHaveLength(0);
  await act(async () => tree.update(h(Suspense, { fallback: 'Opening' }, h(changesApp.Screen, {}))));
  expect(words()).toContain('Current change');
  await selectRow();
  expect(words()).toContain('first-head');
});

it('tile and inline cards follow the same current answer/head and clear retained rows on disconnect', async () => {
  fixture();
  const allow = vi.fn(async () => {}), deny = vi.fn(async () => {}), answer = vi.fn(async () => {});
  await draw(h(ApprovalsApp, { timezone: 'America/Chicago', actions: { allow, deny } }));
  await selectRow();
  await act(async () => tree.root.findAllByType('Button').find((button: { props: { children: string } }) => button.props.children === 'Allow').props.onClick());
  expect(allow).toHaveBeenCalledExactlyOnceWith('a-one');
  await act(async () => tree.update(h(LiveApprovalCard, { id: 'a-one', actions: { allow, deny } })));
  expect(words()).toContain('Keep one day?');
  expect(words()).toContain('Measuring settings change');
  feed.approvals = { ...feed.approvals, approvals: [{ ...feed.approvals.approvals[0], state: 'denied' }] };
  await act(async () => tree.update(h(LiveApprovalCard, { id: 'a-one', actions: { allow, deny } })));
  expect(words()).toContain('denied');
  expect(tree.root.findAllByType('Button')).toHaveLength(0);
  await act(async () => tree.update(h(ChangesApp, { actions: { refresh: vi.fn(), answer } })));
  await selectRow();
  feed.changes = { ...feed.changes, changes: [{ ...feed.changes.changes[0], headCommit: 'current-head' }] };
  await act(async () => tree.update(h(ChangesApp, { actions: { refresh: vi.fn(), answer } })));
  await act(async () => tree.root.findAllByType('Button').find((button: { props: { children: string } }) => button.props.children === 'Yes, merge it').props.onClick());
  expect(answer).toHaveBeenCalledExactlyOnceWith('c-one', 'current-head', 'yes');
  for (const status of ['offline', 'denied', 'loading']) {
    feed.status = status;
    for (const node of [h(ApprovalsApp, {}), h(ChangesApp, {}), h(LiveApprovalCard, { id: 'a-one' }), h(LiveChangeCard, { id: 'c-one', open: vi.fn() })]) {
      await act(async () => tree.update(node));
      expect(words()).not.toContain('Keep one day?');
      expect(words()).not.toContain('Current change');
      expect(tree.root.findAllByType('Button')).toHaveLength(0);
    }
  }
});
