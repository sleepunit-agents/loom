import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../kit', () => Object.fromEntries(['Button', 'Error'].map(name => [name, (props: { children?: ReactNode }) => h(name, props, props.children)])));
import { InboxActionNotices, type InboxResultsSnapshot } from './outcomes';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const snapshot: InboxResultsSnapshot = { status: 'live', results: [
  { id: 'saved', at: '2026-11-14T20:00:00Z', ok: true, text: 'Close task: saved', page: '/tasks/t-12' },
  { id: 'failed', at: '2026-11-14T20:01:00Z', ok: false, text: 'Answer: failed', page: 'javascript:alert(1)' },
  { id: 'read', at: '2026-11-14T20:02:00Z', ok: false, text: 'Already dismissed', readAt: '2026-11-14T20:03:00Z' },
] };
it('shows current undismissed outcomes, filters errors, and withdraws retained text on query loss', async () => {
  await act(async () => { tree = create(h(InboxActionNotices, { snapshot })); });
  expect(JSON.stringify(tree.toJSON())).toContain('Close task: saved');
  expect(JSON.stringify(tree.toJSON())).not.toContain('Already dismissed');
  expect(tree.root.findAllByType('a').map((a: { props: { href: string } }) => a.props.href)).toEqual(['/tasks/t-12']);
  await act(async () => { tree.update(h(InboxActionNotices, { snapshot, errorsOnly: true })); });
  expect(JSON.stringify(tree.toJSON())).not.toContain('Close task: saved');
  expect(JSON.stringify(tree.toJSON())).toContain('Answer: failed');
  for (const status of ['loading', 'offline', 'denied'] as const) {
    await act(async () => { tree.update(h(InboxActionNotices, { snapshot: { ...snapshot, status } })); });
    expect(tree.toJSON()).toBeNull();
  }
});
it('serializes dismissals and keeps failed outcomes visible for retry until the query acknowledges', async () => {
  let reject!: (error: Error) => void;
  const dismiss = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no; }));
  await act(async () => { tree = create(h(InboxActionNotices, { snapshot, errorsOnly: true, dismiss })); });
  await act(async () => { const button = tree.root.findByType('Button'); button.props.onClick(); button.props.onClick(); });
  expect(dismiss).toHaveBeenCalledExactlyOnceWith('failed');
  await act(async () => { reject(new Error('private server detail')); });
  expect(tree.root.findAllByType('Error')).toHaveLength(1);
  expect(JSON.stringify(tree.toJSON())).not.toContain('private server detail');
  expect(JSON.stringify(tree.toJSON())).toContain('Answer: failed');
  await act(async () => { tree.update(h(InboxActionNotices, { snapshot: { ...snapshot, results: snapshot.results.map(row => ({ ...row, readAt: 'now' })) }, dismiss })); });
  expect(tree.toJSON()).toBeNull();
});
