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
  expect(words()).not.toContain('keep_days');
  expect(tree.root.findAllByType('Button')).toHaveLength(2);
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

it('opens the exact change from a Comms deep link and follows shell navigation and back', async () => {
  fixture();
  const id = 'github:acme/app#3';
  feed.changes.changes[0] = { ...feed.changes.changes[0], id };
  const go = vi.fn();
  const route = `/p/changes-preview/change/${encodeURIComponent(id)}`;
  await draw(h(ChangesApp, { path: route, go }));
  expect(words()).toContain('first-head');
  await act(async () => tree.root.findByType('Split').props.onBack());
  expect(go).toHaveBeenLastCalledWith('/p/changes-preview');
  await act(async () => tree.update(h(ChangesApp, { path: '/p/changes-preview', go })));
  expect(words()).not.toContain('first-head');
  await selectRow();
  expect(go).toHaveBeenLastCalledWith(route);
  await act(async () => tree.update(h(ChangesApp, { path: route, go })));
  expect(words()).toContain('first-head');
  await act(async () => tree.root.findByType('Split').props.onFolder('you'));
  expect(go).toHaveBeenLastCalledWith('/p/changes-preview/you');
  for (const path of ['/p/changes-preview/change/%broken', '/p/changes-preview/change/missing', '/p/changes-preview/change/']) {
    await act(async () => tree.update(h(ChangesApp, { path, go })));
    expect(words()).not.toContain('first-head');
  }
});

it('linked work opens the Tasks reader route and unavailability withdraws the deep-linked reader', async () => {
  fixture();
  feed.changes.changeTasks = [{ change: 'c-one', task: 't-42', taskRow: { id: 't-42', title: 'Linked task', status: 'open' } }];
  const go = vi.fn();
  const node = h(ChangesApp, { go });
  await draw(node);
  await selectRow();
  await act(async () => tree.update(h(ChangesApp, { path: '/p/changes-preview/change/c-one', go })));
  const linked = tree.root.findAllByType('Row').find((row: { props: { title: string } }) => row.props.title === 'Linked task');
  await act(async () => linked.props.onClick());
  expect(go).toHaveBeenLastCalledWith('/p/tasks-preview/task/t-42');
  for (const status of ['offline', 'denied', 'loading']) {
    feed.status = status;
    await act(async () => tree.update(h(ChangesApp, { path: '/p/changes-preview/change/c-one', go })));
    expect(words()).not.toContain('first-head');
    expect(words()).not.toContain('Linked task');
  }
});


it('opens approval and reported-step links from Attention and follows shell folder navigation', async () => {
  fixture();
  const id = 'a-one/encoded?';
  feed.approvals.approvals[0] = { ...feed.approvals.approvals[0], id };
  const go = vi.fn();
  const route = `/p/approvals-preview/approval/${encodeURIComponent(id)}`;
  await draw(h(ApprovalsApp, { path: route, go }));
  expect(words()).toContain('Keep one day?');
  await act(async () => tree.root.findByType('Split').props.onBack());
  expect(go).toHaveBeenLastCalledWith('/p/approvals-preview');
  await act(async () => tree.update(h(ApprovalsApp, { path: '/p/approvals-preview', go })));
  expect(words()).not.toContain('Keep one day?');
  await selectRow();
  expect(go).toHaveBeenLastCalledWith(route);
  await act(async () => tree.update(h(ApprovalsApp, { path: route, go })));
  await act(async () => tree.root.findByType('Split').props.onFolder('notices'));
  expect(go).toHaveBeenLastCalledWith('/p/approvals-preview/notices');
  await act(async () => tree.update(h(ApprovalsApp, { path: '/p/approvals-preview/notices', go })));
  expect(tree.root.findByType('Split').props.folder).toBe('notices');
  expect(words()).toContain('Current reported step');
  expect(words()).not.toContain('Keep one day?');
  for (const folder of ['history', 'rules', 'pending']) {
    await act(async () => tree.root.findByType('Split').props.onFolder(folder));
    const path = folder === 'pending' ? '/p/approvals-preview' : `/p/approvals-preview/${folder}`;
    expect(go).toHaveBeenLastCalledWith(path);
    await act(async () => tree.update(h(ApprovalsApp, { path, go })));
    expect(tree.root.findByType('Split').props.folder).toBe(folder);
  }
  for (const path of ['/p/approvals-preview/approval/%broken', '/p/approvals-preview/approval/missing', '/p/approvals-preview/approval/']) {
    await act(async () => tree.update(h(ApprovalsApp, { path, go })));
    expect(words()).not.toContain('Keep one day?');
  }
});

it('approval deep links show the current answer and withdraw the reader when unavailable', async () => {
  fixture();
  const node = h(ApprovalsApp, { path: '/p/approvals-preview/approval/a-one', go: vi.fn() });
  await draw(node);
  expect(words()).toContain('Keep one day?');
  feed.approvals.approvals[0] = { ...feed.approvals.approvals[0], state: 'denied', ask: 'Current question' };
  await act(async () => tree.update(h(ApprovalsApp, { path: '/p/approvals-preview/approval/a-one', go: vi.fn() })));
  expect(words()).toContain('Current question');
  expect(words()).toContain('denied');
  for (const status of ['offline', 'denied', 'loading']) {
    feed.status = status;
    await act(async () => tree.update(h(ApprovalsApp, { path: '/p/approvals-preview/approval/a-one', go: vi.fn() })));
    expect(words()).not.toContain('Current question');
    expect(words()).not.toContain('Measuring settings change');
    expect(tree.root.findAllByType('Button')).toHaveLength(0);
  }
});


it('restores Changes folders from shell routes, including encoded projects and base navigation', async () => {
  fixture();
  const project = 'pond / field?';
  feed.changes.changes[0] = { ...feed.changes.changes[0], project };
  feed.changes.changes.push({ ...feed.changes.changes[0], id: 'c-other', title: 'Other project change', project: 'other', waitingOn: 'ci' });
  const go = vi.fn();
  for (const [folder, path] of [
    ['you', '/p/changes-preview/you'], ['lately', '/p/changes-preview/lately'],
    [`project:${project}`, `/p/changes-preview/project/${encodeURIComponent(project)}`], ['all', '/p/changes-preview'],
  ]) {
    await draw(h(ChangesApp, { path, go }));
    expect(tree.root.findByType('Split').props.folder).toBe(folder);
    expect(words().includes('Other project change')).toBe(folder === 'all' || folder === 'lately');
    await act(async () => tree.root.findByType('Split').props.onFolder(folder));
    expect(go).toHaveBeenLastCalledWith(path);
    await act(async () => tree.unmount());
  }
  await draw(h(ChangesApp, { path: '/p/changes-preview/project/%broken', go }));
  expect(tree.root.findByType('Split').props.folder).toBe('all');
  expect(words()).toContain('Other project change');
});

it('restores Changes folder selection on browser back and forward without a shell callback', async () => {
  fixture();
  const location = { pathname: '/p/changes-preview/you' };
  let pop: (() => void) | undefined;
  const removeEventListener = vi.fn();
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { pushState: vi.fn((_state, _unused, path) => { location.pathname = path; }) });
  vi.stubGlobal('window', { addEventListener: (_event: string, listener: () => void) => { pop = listener; }, removeEventListener });
  try {
    await draw(h(ChangesApp, {}));
    expect(tree.root.findByType('Split').props.folder).toBe('you');
    await act(async () => tree.root.findByType('Split').props.onFolder('lately'));
    expect(location.pathname).toBe('/p/changes-preview/lately');
    expect(tree.root.findByType('Split').props.folder).toBe('lately');
    for (const [path, folder] of [['/p/changes-preview/you', 'you'], ['/p/changes-preview/lately', 'lately']]) {
      location.pathname = path;
      await act(async () => pop?.());
      expect(tree.root.findByType('Split').props.folder).toBe(folder);
    }
    await act(async () => tree.unmount());
    expect(removeEventListener).toHaveBeenCalledWith('popstate', pop);
  } finally { await act(async () => tree.unmount()); vi.unstubAllGlobals(); }
});

it('answers a Measuring card through the mounted authenticated API without changing its local state', async () => {
 fixture();
 const request = vi.fn(async (_url:string,_options:RequestInit) => ({ok:true,json:async()=>({ok:true})}));
 vi.stubGlobal('fetch', request);
 try {
  await draw(h(LiveApprovalCard, {id:'a-one'}));
  await act(async()=>{tree.root.findAllByType('Button')[0].props.onClick();});
  expect(request).toHaveBeenCalledWith('/api/measuring/answer', expect.objectContaining({method:'POST',credentials:'same-origin'}));
  expect(JSON.parse(String(request.mock.calls[0][1].body))).toMatchObject({input:{id:'a-one',allow:true}});
  expect(feed.approvals.approvals[0].state).toBe('pending');
 } finally {vi.unstubAllGlobals();}
});
