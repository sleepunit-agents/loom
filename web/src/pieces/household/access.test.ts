import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { CallState, Result } from '../../data';
const f = vi.hoisted(() => ({ status: 'live', call: vi.fn(), once: vi.fn() }));
vi.mock('../../data', () => ({ call: f.call, callOnce: f.once, useRecords: (name: string) => ({ status: f.status, records: name === 'signin.admin' ? [{ id: 'household', tokens: [{ label: 'operator', role: 'owner', created: '2026-11-12T12:00:00Z' }], sessions: [{ ref: '0123456789abcdef', issuedAt: 1, expiresAt: 2, member: 'jonathan', agent: false }] }] : [{ id: 'household', members: ['jonathan'], agents: ['art'] }] }) }));
vi.mock('../../kit', () => Object.fromEntries(['Button', 'Input', 'Empty', 'Error', 'Loading'].map(name => [name, (props: object) => h(name === 'Button' ? 'button' : name === 'Input' ? 'input' : 'div', props)])));
import AccessAdmin, { tokenInput } from './access';
import { mutation } from './model';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
function request() {
  let state: CallState = { pending: true, status: 'pending' }; const listeners = new Set<() => void>();
  const handle = { id: 'request', result: new Promise<Result>(() => {}), getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  return { handle, finish: async (result: Result) => act(async () => { state = { pending: false, status: 'done', result }; listeners.forEach(fn => fn()); }) };
}
beforeEach(async () => { vi.clearAllMocks(); f.status = 'live'; const done = request(); await done.finish({ ok: true, value: {} }); mutation.set(done.handle, 'previous'); });
afterEach(async () => { await act(async () => tree?.unmount()); vi.unstubAllGlobals(); });
it('returns only the chosen identity fields and explicit expiry', () => {
  const data = new FormData(); data.set('role', 'owner'); data.set('label', 'work'); data.set('member', 'jonathan'); data.set('agent', 'ignored');
  expect(tokenInput(data)).toEqual({ role: 'owner', label: 'work', member: 'jonathan' });
  data.set('role', 'agent'); data.set('agent', 'art'); expect(tokenInput(data)).toEqual({ role: 'agent', label: 'work', agent: 'art' });
  data.set('role', 'runner'); data.set('principal', 'box'); data.set('expires', '2027-01-01T00:00:00Z');
  expect(tokenInput(data)).toEqual({ role: 'runner', label: 'work', principal: 'box', expires: '2027-01-01T00:00:00Z' });
});
it('uses single-send creation and clears its bearer after connection loss and remount', async () => {
  const r = request(); f.once.mockReturnValue(r.handle);
  const Original = FormData;
  vi.stubGlobal('FormData', class extends Original { constructor() { super(); this.set('role', 'owner'); this.set('label', 'new'); this.set('member', 'jonathan'); } });
  await act(async () => { tree = create(h(AccessAdmin)); });
  const event = { preventDefault: vi.fn(), currentTarget: {} };
  await act(async () => tree.root.findByProps({ 'aria-label': 'Create token' }).props.onSubmit(event));
  await act(async () => tree.root.findByProps({ 'aria-label': 'Create token' }).props.onSubmit(event));
  expect(f.once).toHaveBeenCalledExactlyOnceWith('token.create', { role: 'owner', label: 'new', member: 'jonathan' });
  await r.finish({ ok: true, value: { token: 'fixture-bearer' } });
  expect(tree.root.findByProps({ 'aria-label': 'Token value' }).props.children).toBe('fixture-bearer');
  await act(async () => { f.status = 'offline'; tree.update(h(AccessAdmin)); });
  expect(tree.root.findAllByProps({ 'aria-label': 'Token value' })).toHaveLength(0);
  await act(async () => { f.status = 'live'; tree.update(h(AccessAdmin)); });
  expect(tree.root.findAllByProps({ 'aria-label': 'Token value' })).toHaveLength(0);
  await act(async () => tree.unmount()); await act(async () => { tree = create(h(AccessAdmin)); });
  expect(tree.root.findAllByProps({ 'aria-label': 'Token value' })).toHaveLength(0); expect(f.call).not.toHaveBeenCalled();
});
it('hides retained rows on denial and revokes the exact session with the shared retry handle', async () => {
  const r = request(); f.call.mockReturnValue(r.handle);
  await act(async () => { tree = create(h(AccessAdmin)); });
  const confirm = { checked: true };
  await act(async () => tree.root.findByProps({ 'aria-label': 'Revoke session 0123456789abcdef' }).props.onSubmit({ preventDefault: vi.fn(), currentTarget: { querySelectorAll: () => [confirm] } }));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('sessions.revoke', { ref: '0123456789abcdef' });
  expect(confirm.checked).toBe(false); expect(mutation.getSnapshot().request).toBe(r.handle);
  await act(async () => { f.status = 'denied'; tree.update(h(AccessAdmin)); });
  expect(tree.root.findAllByType('form')).toHaveLength(0);
});
