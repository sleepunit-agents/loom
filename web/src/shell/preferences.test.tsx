import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { Result, Snapshot } from '../data';
import type { Prefs } from '../look';
const f = vi.hoisted(() => ({ snapshot: { records: [], status: 'loading' } as Snapshot, listeners: new Set<() => void>(), call: vi.fn(), look: vi.fn(), keep: vi.fn(), motion: vi.fn(), contrast: vi.fn(), zoom: vi.fn() }));
vi.mock('../data/operation', () => ({ memberOperation: f.call }));
vi.mock('./member-preferences', () => ({ useMemberPreferences: () => useSyncExternalStore(fn => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.snapshot) }));
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
  let resolve!:()=>void,reject!:(error:Error)=>void;
  const handle=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  return {handle,finish:async(result:Result<Prefs>)=>act(async()=>{if(result.ok)resolve();else reject(new Error(result.message));})};
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
it('saves a ground choice through the existing member operation and waits for the record', async () => {
  f.snapshot = live({ground:'depth'}); const r = request(); f.call.mockReturnValue(r.handle); await draw();
  await act(async () => tree.root.findByProps({'aria-label':'Ground'}).props.onChange({target:{value:'contours'}}));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('household.setPreferences',{ground:'contours'});
  expect(tree.root.findByProps({'aria-label':'Ground'}).props.value).toBe('depth');
  expect(tree.root.findByProps({'aria-label':'Ground'}).props.disabled).toBe(true);
  await r.finish({ok:true,value:{ground:'contours'}}); await publish(live({ground:'contours'}));
  expect(tree.root.findByProps({'aria-label':'Ground'}).props.value).toBe('contours');
});
it('disables edits while loading or disconnected and resets displayed choices when access ends', async () => {
  await draw(); expect(tree.root.findByProps({ 'aria-label': 'Look' }).props.disabled).toBe(true); expect(f.look).not.toHaveBeenCalled();
  await publish(live({ look: 'daylight' })); await publish({ status: 'offline', records: [{ id: 'jonathan', prefs: { look: 'daylight' } }] });
  expect(tree.root.findByProps({ 'aria-label': 'Look' }).props.disabled).toBe(true); expect(tree.root.findByProps({ 'aria-label': 'Look' }).props.value).toBe('neon');
  await publish({ status: 'denied', records: [] }); expect(f.look).toHaveBeenLastCalledWith('neon'); expect(JSON.stringify(tree.toJSON())).toContain('Sign in again'); expect(f.call).not.toHaveBeenCalled();
});
it('surfaces a failed HTTP save and retries only on an explicit request', async () => {
  f.snapshot = live({}); const r = request(); f.call.mockReturnValue(r.handle); await draw();
  await act(async () => tree.root.findByProps({ 'aria-label': 'Reduce motion' }).props.onChange({ target: { value: 'on' } }));
  expect(f.call).toHaveBeenCalledWith('household.setPreferences', { motion: 'on' });
  await r.finish({ ok: false, code: 'unavailable', message: 'Try again' }); expect(JSON.stringify(tree.toJSON())).toContain('Could not confirm the save');
  expect(f.call).toHaveBeenCalledOnce();const next=request();f.call.mockReturnValue(next.handle);
  await act(async () => tree.root.findByType('button').props.onClick());expect(f.call).toHaveBeenCalledTimes(2);expect(f.call.mock.calls[1]).toEqual(f.call.mock.calls[0]);await next.finish({ok:true,value:{motion:'on'}});
});
it.each([
  ['Sound', 'sound', false], ['Pixel faces', 'pixel', true],
  ['Pixel icons', 'icons', false], ['Haptics', 'haptics', true],
  ['One window at a time', 'oneWindow', false], ['Allow zoom', 'zoom', false],
] as const)('saves %s as one member choice and waits for its live record', async (label, key, fallback) => {
  f.snapshot = live({}); const r = request(); f.call.mockReturnValue(r.handle); await draw();
  const field = () => tree.root.findByProps({'aria-label':label});
  expect(field().props.checked).toBe(fallback);
  await act(async () => field().props.onChange({target:{checked:!fallback}}));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('household.setPreferences',{[key]:!fallback});
  expect(field().props.checked).toBe(fallback);
  expect(field().props.disabled).toBe(true);
  await r.finish({ok:true,value:{[key]:!fallback}});
  await publish(live({[key]:!fallback}));
  expect(field().props.checked).toBe(!fallback);
});
it('locks a pending HTTP save and never resubmits it on reconnection',async()=>{
  f.snapshot=live({look:'neon'});const r=request();f.call.mockReturnValue(r.handle);await draw();
  const change=()=>tree.root.findByProps({'aria-label':'Look'}).props.onChange({target:{value:'daylight'}});
  await act(async()=>{change();change();});expect(f.call).toHaveBeenCalledTimes(1);
  await r.finish({ok:false,code:'unavailable',message:'Disconnected'});
  await publish({status:'offline',records:[]});await publish(live({look:'neon'}));
  expect(f.call).toHaveBeenCalledTimes(1);expect(f.look).toHaveBeenLastCalledWith('neon');
});
