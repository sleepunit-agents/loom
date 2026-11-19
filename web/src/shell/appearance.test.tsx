import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { Snapshot } from '../data';
import type { Prefs } from '../look';
const f = vi.hoisted(() => ({ snapshot: { records: [], status: 'loading' } as Snapshot, listeners: new Set<() => void>(), look: vi.fn(), keep: vi.fn(), motion: vi.fn(), contrast: vi.fn(), zoom: vi.fn() }));
vi.mock('./member-preferences', () => ({ useMemberPreferences: () => useSyncExternalStore(fn => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.snapshot) }));
vi.mock('../look', async original => ({ ...await original<typeof import('../look')>(), wearLook: f.look, keep: f.keep }));
vi.mock('../access', () => ({ wearMotion: f.motion, wearContrast: f.contrast }));
vi.mock('../immersion', () => ({ allowZoom: f.zoom }));
vi.mock('../ground', () => ({ Depth: () => null, Contours: () => null }));
vi.mock('../haptic', async () => { const { createContext } = await import('react'); return { HapticsContext: createContext(true), warmHaptics: vi.fn() }; });
import Appearance from './appearance';
let tree: ReturnType<typeof create>, dataset: Record<string, string>;
const live = (prefs: Prefs): Snapshot => ({ status: 'live', records: [{ id: 'jonathan', prefs }] });
async function publish(snapshot: Snapshot) { await act(async () => { f.snapshot = snapshot; f.listeners.forEach(fn => fn()); }); }
async function draw() { await act(async () => { tree = create(h(Appearance, null, h('main'))); }); }
beforeEach(() => {
  vi.clearAllMocks(); f.snapshot = { status: 'loading', records: [] }; f.listeners.clear(); dataset = { mode: 'dark' };
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('document', { documentElement: { dataset } }); vi.stubGlobal('navigator', { maxTouchPoints: 0 });
});
afterEach(async () => { await act(async () => tree?.unmount()); vi.unstubAllGlobals(); });

// The shell wears a person's choices whether or not the Appearance app is open: nothing in the top bar does it.
it('wears saved choices and cross-window live changes, overriding device cache even when choices are absent', async () => {
  f.snapshot = live({ look: '000h', mode: 'light', motion: 'on', contrast: 'off', zoom: true, ground: 'wash', sound: true, oneWindow: true }); await draw();
  expect(f.look).toHaveBeenLastCalledWith('daylight'); expect(f.motion).toHaveBeenLastCalledWith('on'); expect(f.contrast).toHaveBeenLastCalledWith('off'); expect(f.zoom).toHaveBeenLastCalledWith(true);
  expect(f.keep).toHaveBeenCalledWith('loom-look', 'daylight'); expect(f.keep).toHaveBeenCalledWith('loom-one-window', 'on');
  expect(dataset).toMatchObject({ ground: 'wash', sound: 'on', oneWindow: 'on', pixel: 'on', haptics: 'on', zoom: 'on' });
  await publish(live({ look: 'lowlight' })); expect(f.look).toHaveBeenLastCalledWith('lowlight');
  expect(f.motion).toHaveBeenLastCalledWith('follow'); expect(f.contrast).toHaveBeenLastCalledWith('follow'); expect(f.zoom).toHaveBeenLastCalledWith(false);
  expect(dataset).toMatchObject({ ground: 'depth', sound: 'off', oneWindow: 'off', zoom: 'off' });
  await publish(live({})); expect(f.look).toHaveBeenLastCalledWith('neon');
});
it('wears nothing while loading, and the defaults when access ends', async () => {
  await draw(); expect(f.look).not.toHaveBeenCalled();
  await publish(live({ look: 'daylight' })); expect(f.look).toHaveBeenLastCalledWith('daylight');
  await publish({ status: 'denied', records: [] }); expect(f.look).toHaveBeenLastCalledWith('neon');
});
