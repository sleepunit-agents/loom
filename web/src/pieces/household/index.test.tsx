import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { CallState, Result, Snapshot } from '../../data';
const f = vi.hoisted(() => ({ snapshot: { status: 'live', records: [] } as Snapshot, call: vi.fn(), profiles: [] as Array<{ id: string; agent: string; description: string }> }));
vi.mock('../../data', () => ({ useRecords: (type: string) => type === 'household.sharing' ? f.snapshot : { status: 'live', records: type === 'household.profile' ? f.profiles : [] }, call: f.call }));
vi.mock('../../kit', () => Object.fromEntries(['AppFrame', 'Button', 'Input', 'Empty', 'Error', 'Loading'].map(name => [name, (props: object) => h(name === 'Button' ? 'button' : name === 'Input' ? 'input' : 'div', props)])));
import Setup from './index';
import { mutation } from './model';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
function request() {
  let state: CallState = { pending: true, status: 'pending' }; const listeners = new Set<() => void>();
  const retry = vi.fn();
  const handle = { id: 'same-id', result: new Promise<Result>(() => {}), retry, getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  return { handle, finish: async (result: Result) => act(async () => { state = { pending: false, status: 'done', result }; listeners.forEach(fn => fn()); }) };
}
beforeEach(async () => {
  vi.clearAllMocks(); f.profiles = [{ id: 'art', agent: 'art', description: 'Imported profile.' }]; f.snapshot = { status: 'live', records: [{ id: 'household', members: ['jonathan'], membership: [{ person: 'jonathan', role: 'owner', agents: '*' }], agents: ['art'], defaultAgent: 'art', agentAccounts: { art: { github: [] } } }] };
  const done = request(); await done.finish({ ok: true, value: {} }); mutation.set(done.handle, 'previous');
});
afterEach(async () => { await act(async () => tree?.unmount()); vi.unstubAllGlobals(); });
it('keeps an uncertain save blocked through unmount and retries the original request', async () => {
  const r = request(); mutation.set(r.handle, 'Save ownership'); await act(async () => { tree = create(h(Setup)); });
  expect(tree.root.findAllByType('fieldset').every((node: { props: { disabled?: boolean } }) => node.props.disabled !== false)).toBe(true);
  await r.finish({ ok: false, code: 'unavailable', message: 'Connection closed' });
  await act(async () => tree.unmount()); await act(async () => { tree = create(h(Setup)); });
  const button = tree.root.findAllByType('button').find((node: { props: { children?: unknown } }) => node.props.children === 'Retry this change');
  await act(async () => button.props.onClick()); expect(r.handle.retry).toHaveBeenCalledOnce(); expect(f.call).not.toHaveBeenCalled();
});
it('does not render retained membership on denied access and disables offline edits', async () => {
  f.snapshot = { ...f.snapshot, status: 'denied' }; await act(async () => { tree = create(h(Setup)); });
  expect(tree.root.findAllByType('form')).toHaveLength(0);
  await act(async () => { f.snapshot = { ...f.snapshot, status: 'offline' }; tree.update(h(Setup)); });
  expect(tree.root.findAllByType('form').length).toBeGreaterThan(0);
  expect(tree.root.findAllByType('fieldset').filter((node: { props: { disabled?: boolean } }) => node.props.disabled === false)).toHaveLength(0);
});
it('dispatches the form to the existing operation once and clears its confirmation', async () => {
  const r = request(); f.call.mockReturnValue(r.handle);
  const Original = FormData;
  vi.stubGlobal('FormData', class extends Original { constructor() { super(); this.set('github', 'art-bot'); } });
  await act(async () => { tree = create(h(Setup)); });
  const confirmed = { checked: true };
  const event = { preventDefault: vi.fn(), currentTarget: { querySelectorAll: () => [confirmed] } };
  await act(async () => tree.root.findByProps({ 'aria-label': 'Save accounts for art' }).props.onSubmit(event));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('household.setAgentAccounts', { agent: 'art', accounts: { github: ['art-bot'] } });
  expect(confirmed.checked).toBe(false);
  await act(async () => tree.root.findByProps({ 'aria-label': 'Save accounts for art' }).props.onSubmit(event));
  expect(f.call).toHaveBeenCalledOnce();
});

it('creates a context through the shared retry handle and shows next-mode configuration only after success', async () => {
  const r = request(); f.call.mockReturnValue(r.handle);
  const Original = FormData;
  vi.stubGlobal('FormData', class extends Original { constructor() { super(); for (const [k, v] of Object.entries({ agent: 'gabe', name: 'Gabe', purpose: 'Garden', voice: 'Warm', rules: 'Private', ask: 'Money' })) this.set(k, v); } });
  await act(async () => { tree = create(h(Setup)); });
  const confirm = { checked: true }, event = { preventDefault: vi.fn(), currentTarget: { querySelectorAll: () => [confirm] } };
  await act(async () => tree.root.findByProps({ 'aria-label': 'Create agent' }).props.onSubmit(event));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('household.bootstrapAgent', { agent: 'gabe', name: 'Gabe', purpose: 'Garden', voice: 'Warm', rules: 'Private', ask: 'Money' });
  expect(confirm.checked).toBe(false);
  expect(tree.root.findAllByProps({ 'aria-label': 'Harness configuration' })).toHaveLength(0);
  await r.finish({ ok: true, value: { agent: 'gabe', contextDir: '/home/agents/gabe', mcp: { command: 'loom', args: ['mcp', '--next', '--home', '/home', '--agent', 'gabe'] } } });
  expect(tree.root.findByProps({ 'aria-label': 'Harness configuration' }).props.children).toContain('--next');
  await act(async () => tree.unmount()); await act(async () => { tree = create(h(Setup)); });
  expect(tree.root.findByProps({ 'aria-label': 'Harness configuration' }).props.children).toContain('gabe');
});

it('saves profile text through the common operation and refuses inactive forms and uncertain retries', async () => {
  const r = request(); f.call.mockReturnValue(r.handle);
  const Original = FormData;
  vi.stubGlobal('FormData', class extends Original { constructor() { super(); this.set('text', 'Owner words.'); } });
  await act(async () => { tree = create(h(Setup)); });
  const event = { preventDefault: vi.fn(), currentTarget: { querySelectorAll: () => [] } };
  await act(async () => tree.root.findByProps({ 'aria-label': 'Save description for art' }).props.onSubmit(event));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('household.setProfile', { agent: 'art', text: 'Owner words.' });
  await r.finish({ ok: false, code: 'unavailable', message: 'Lost connection' });
  await act(async () => tree.update(h(Setup, { active: false })));
  const retry = tree.root.findAllByType('button').find((node: { props: { children?: unknown } }) => node.props.children === 'Retry this change');
  expect(retry.props.disabled).toBe(true); await act(async () => retry.props.onClick()); expect(r.handle.retry).not.toHaveBeenCalled();
  await act(async () => tree.root.findByProps({ 'aria-label': 'Save description for art' }).props.onSubmit(event));
  expect(f.call).toHaveBeenCalledOnce();
});
