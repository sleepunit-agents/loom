import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { CallState, Result, Snapshot } from '../data';
import type { Prefs } from '../look';
const f = vi.hoisted(() => ({ snapshot: { records: [], status: 'loading' } as Snapshot, listeners: new Set<() => void>(), call: vi.fn(), look: vi.fn(), keep: vi.fn(), motion: vi.fn(), contrast: vi.fn(), zoom: vi.fn() }));
vi.mock('../data', () => ({ useRecords: (type: string) => { expect(type).toBe('household.preferences'); return useSyncExternalStore(fn => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.snapshot); }, call: f.call }));
vi.mock('../look', async original => ({ ...await original<typeof import('../look')>(), wearLook: f.look, keep: f.keep }));
vi.mock('../access', () => ({ wearMotion: f.motion, wearContrast: f.contrast }));
vi.mock('../immersion', () => ({ allowZoom: f.zoom }));
vi.mock('../kit', () => ({ Button: (props: object) => h('button', props) }));
import Preferences from './preferences';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
const live = (prefs: Prefs): Snapshot => ({ status: 'live', records: [{ id: 'jonathan', prefs }] });
async function publish(snapshot: Snapshot) { await act(async () => { f.snapshot = snapshot; f.listeners.forEach(fn => fn()); }); }
async function draw() { await act(async () => { tree = create(h(Preferences)); }); }
function request() {
  let state: CallState<Prefs> = { pending: true, status: 'pending' };
  const listeners = new Set<() => void>();
  const retry = vi.fn(() => { state = { pending: true, status: 'pending' }; listeners.forEach(fn => fn()); });
  const handle = { id: 'same-id', result: new Promise<Result<Prefs>>(() => {}), retry, getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  return { handle, finish: async (result: Result<Prefs>) => act(async () => { state = { pending: false, status: 'done', result }; listeners.forEach(fn => fn()); }) };
}
beforeEach(() => { vi.clearAllMocks(); f.snapshot = { status: 'loading', records: [] }; f.listeners.clear(); });
afterEach(async () => { await act(async () => tree?.unmount()); });
it('applies saved choices and cross-window live changes, overriding device cache even when choices are absent', async () => {
  f.snapshot = live({ look: '000h', mode: 'light', motion: 'on', contrast: 'off', zoom: true }); await draw();
  expect(f.look).toHaveBeenLastCalledWith('daylight'); expect(f.motion).toHaveBeenLastCalledWith('on'); expect(f.contrast).toHaveBeenLastCalledWith('off'); expect(f.zoom).toHaveBeenLastCalledWith(true);
  expect(f.keep).toHaveBeenCalledWith('loom-look', 'daylight');
  await publish(live({ look: 'lowlight' })); expect(f.look).toHaveBeenLastCalledWith('lowlight');
  expect(f.motion).toHaveBeenLastCalledWith('follow'); expect(f.contrast).toHaveBeenLastCalledWith('follow'); expect(f.zoom).toHaveBeenLastCalledWith(false);
  await publish(live({})); expect(f.look).toHaveBeenLastCalledWith('neon');
});
it('sends only the changed choice over the shared operation and waits for live confirmation before applying it', async () => {
  f.snapshot = live({ look: 'neon' }); const r = request(); f.call.mockReturnValue(r.handle); await draw();
  await act(async () => tree.root.findByProps({ 'aria-label': 'Look' }).props.onChange({ target: { value: 'daylight' } }));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('household.setPreferences', { look: 'daylight' });
  expect(f.look).toHaveBeenLastCalledWith('neon'); expect(tree.root.findByProps({ 'aria-label': 'Look' }).props.disabled).toBe(true);
  await r.finish({ ok: true, value: { look: 'daylight', at: 9 } });
  expect(f.look).toHaveBeenLastCalledWith('neon'); await publish(live({ look: 'daylight', at: 9 })); expect(f.look).toHaveBeenLastCalledWith('daylight');
});
it('disables edits while loading or disconnected and resets displayed choices when access ends', async () => {
  await draw(); expect(tree.root.findByProps({ 'aria-label': 'Look' }).props.disabled).toBe(true); expect(f.look).not.toHaveBeenCalled();
  await publish(live({ look: 'daylight' })); await publish({ status: 'offline', records: [{ id: 'jonathan', prefs: { look: 'daylight' } }] });
  expect(tree.root.findByProps({ 'aria-label': 'Look' }).props.disabled).toBe(true); expect(f.look).toHaveBeenLastCalledWith('daylight');
  await publish({ status: 'denied', records: [] }); expect(f.look).toHaveBeenLastCalledWith('neon'); expect(JSON.stringify(tree.toJSON())).toContain('Sign in again'); expect(f.call).not.toHaveBeenCalled();
});
it('surfaces a failed save and retries the original handle without inventing another operation', async () => {
  f.snapshot = live({}); const r = request(); f.call.mockReturnValue(r.handle); await draw();
  await act(async () => tree.root.findByProps({ 'aria-label': 'Reduce motion' }).props.onChange({ target: { value: 'on' } }));
  expect(f.call).toHaveBeenCalledWith('household.setPreferences', { motion: 'on' });
  await r.finish({ ok: false, code: 'unavailable', message: 'Try again' }); expect(JSON.stringify(tree.toJSON())).toContain('Try again');
  await act(async () => tree.root.findByType('button').props.onClick()); expect(r.handle.retry).toHaveBeenCalledOnce(); expect(f.call).toHaveBeenCalledOnce();
});
