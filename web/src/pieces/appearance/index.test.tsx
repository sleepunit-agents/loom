import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore, type ReactNode } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { Result, Snapshot } from '../../data';
import type { Prefs } from '../../look';
const f = vi.hoisted(() => ({ snapshot: { records: [], status: 'loading' } as Snapshot, listeners: new Set<() => void>(), call: vi.fn() }));
vi.mock('../../data/operation', () => ({ memberOperation: f.call }));
vi.mock('../../shell/member-preferences', () => ({ useMemberPreferences: () => useSyncExternalStore(fn => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.snapshot) }));
vi.mock('../../kit', () => ({ Button: (props: object) => h('button', props), AppFrame: ({ title, children }: { title: string; children: ReactNode }) => h('main', { 'data-app': title }, children) }));
// The styled controls, as what they are told: the Radix parts need a browser.
vi.mock('@/components/ui/switch', () => ({ Switch: (props: object) => h('ui-switch', props), SwitchRow: ({ children }: { children: ReactNode }) => h('label', null, children) }));
vi.mock('@/components/ui/toggle-group', () => ({ ToggleGroup: ({ children, ...props }: { children: ReactNode }) => h('ui-choice', props, children), ToggleGroupItem: ({ children, ...props }: { children: ReactNode }) => h('ui-option', props, children) }));
import Appearance from './index';
import { appearanceApp } from './registration';
import { apps, appAt } from '../../apps';
import { launcherSections } from '../../shell/launch-list';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
type Node = { type: unknown; props: Record<string, any>; findAllByType(type: string): Node[] };
const live = (prefs: Prefs): Snapshot => ({ status: 'live', records: [{ id: 'jonathan', prefs }] });
async function publish(snapshot: Snapshot) { await act(async () => { f.snapshot = snapshot; f.listeners.forEach(fn => fn()); }); }
async function draw() { await act(async () => { tree = create(h(Appearance)); }); }
const choice = (label: string): Node => tree.root.find((n: Node) => n.type === 'ui-choice' && n.props['aria-label'] === label);
const toggle = (label: string): Node => tree.root.find((n: Node) => n.type === 'ui-switch' && n.props['aria-label'] === label);
function request() {
  let resolve!:()=>void,reject!:(error:Error)=>void;
  const handle=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  return {handle,finish:async(result:Result<Prefs>)=>act(async()=>{if(result.ok)resolve();else reject(new Error(result.message));})};
}
beforeEach(() => { vi.clearAllMocks(); f.snapshot = { status: 'loading', records: [] }; f.listeners.clear(); });
afterEach(async () => { await act(async () => tree?.unmount()); });

it('is a registered app that opens in a tile and is listed under Look & feel in the launcher', () => {
  expect(apps).toContain(appearanceApp);
  expect(appearanceApp).toMatchObject({ id: 'appearance', title: 'Appearance', path: '/p/appearance' });
  expect(appAt('/p/appearance')).toBe(appearanceApp);
  const group = launcherSections(apps, '').find(section => section.name === 'Look & feel');
  expect(group?.apps.map(app => app.title)).toEqual(['Appearance']);
  // Found by its name, its group, and the words a person would use for what it holds.
  for (const words of ['appear', 'look', 'desk background', 'contrast']) expect(launcherSections(apps, words).flatMap(section => section.apps), words).toContain(appearanceApp);
});
it('lays every setting the bar’s panel held out in labelled sections, on styled controls and in plain words', async () => {
  f.snapshot = live({}); await draw();
  expect(tree.root.findByProps({ 'data-app': 'Appearance' })).toBeTruthy();
  const sections = tree.root.findAllByType('section').map((section: Node) => [section.props['aria-label'],
    [...section.findAllByType('ui-choice'), ...section.findAllByType('ui-switch')].map(control => control.props['aria-label'])]);
  expect(sections).toEqual([
    ['How it looks', ['Look', 'Desk background', 'Pixel faces', 'Pixel icons']],
    ['Sound and touch', ['Sound', 'Haptics']],
    ['Motion and contrast', ['Reduce motion', 'Higher contrast']],
    ['Windows', ['One window at a time', 'Allow zoom']],
  ]);
  expect(choice('Look').findAllByType('ui-option').map(option => [option.props.value, option.props.children])).toEqual([['neon', 'Neon Noir'], ['lowlight', 'Low Light'], ['daylight', 'Daylight']]);
  expect(choice('Desk background').findAllByType('ui-option').map(option => option.props.value)).toEqual(['depth', 'contours', 'wash']);
  for (const label of ['Reduce motion', 'Higher contrast']) expect(choice(label).findAllByType('ui-option').map(option => [option.props.value, option.props.children])).toEqual([['follow', 'Follow this device'], ['on', 'On'], ['off', 'Off']]);
  for (const native of ['select', 'input', 'details', 'summary']) expect(tree.root.findAllByType(native), native).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).not.toContain('Ground');
});
it('shows the saved choices, and a 000h look from before as the look nearest it', async () => {
  f.snapshot = live({ look: '000h', mode: 'light', ground: 'wash', motion: 'on', contrast: 'off', sound: true, oneWindow: true }); await draw();
  expect(choice('Look').props.value).toBe('daylight'); expect(choice('Desk background').props.value).toBe('wash');
  expect(choice('Reduce motion').props.value).toBe('on'); expect(choice('Higher contrast').props.value).toBe('off');
  expect(toggle('Sound').props.checked).toBe(true); expect(toggle('One window at a time').props.checked).toBe(true);
  await publish(live({ look: 'lowlight' }));
  expect(choice('Look').props.value).toBe('lowlight'); expect(choice('Reduce motion').props.value).toBe('follow'); expect(toggle('Sound').props.checked).toBe(false);
});
it('sends only the changed choice over the shared operation and waits for live confirmation before showing it', async () => {
  f.snapshot = live({ look: 'neon' }); const r = request(); f.call.mockReturnValue(r.handle); await draw();
  await act(async () => choice('Look').props.onValueChange('daylight'));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('household.setPreferences', { look: 'daylight' });
  expect(choice('Look').props.value).toBe('neon'); expect(choice('Look').props.disabled).toBe(true);
  expect(JSON.stringify(tree.toJSON())).toContain('Saving…');
  await r.finish({ ok: true, value: { look: 'daylight', at: 9 } });
  expect(choice('Look').props.value).toBe('neon'); expect(JSON.stringify(tree.toJSON())).toContain('Saved.');
  await publish(live({ look: 'daylight', at: 9 })); expect(choice('Look').props.value).toBe('daylight');
});
it('saves a desk background through the existing member operation, as the ground it always was, and waits for the record', async () => {
  f.snapshot = live({ground:'depth'}); const r = request(); f.call.mockReturnValue(r.handle); await draw();
  await act(async () => choice('Desk background').props.onValueChange('contours'));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('household.setPreferences',{ground:'contours'});
  expect(choice('Desk background').props.value).toBe('depth');
  expect(choice('Desk background').props.disabled).toBe(true);
  await r.finish({ok:true,value:{ground:'contours'}}); await publish(live({ground:'contours'}));
  expect(choice('Desk background').props.value).toBe('contours');
});
it('saves nothing when the choice already shown is pressed again', async () => {
  f.snapshot = live({ look: 'neon' }); await draw();
  // A segmented control reports an emptied choice when its pressed option is pressed; a setting always has a value.
  await act(async () => { choice('Look').props.onValueChange(''); choice('Look').props.onValueChange('neon'); });
  expect(f.call).not.toHaveBeenCalled();
});
it('disables edits while loading or disconnected and resets displayed choices when access ends', async () => {
  await draw(); expect(choice('Look').props.disabled).toBe(true); expect(toggle('Sound').props.disabled).toBe(true); expect(JSON.stringify(tree.toJSON())).toContain('Loading appearance…');
  await publish(live({ look: 'daylight' })); expect(choice('Look').props.disabled).toBe(false);
  await publish({ status: 'offline', records: [{ id: 'jonathan', prefs: { look: 'daylight' } }] });
  expect(choice('Look').props.disabled).toBe(true); expect(choice('Look').props.value).toBe('neon'); expect(JSON.stringify(tree.toJSON())).toContain('Offline. Reconnect before changing appearance.');
  await publish({ status: 'denied', records: [] }); expect(JSON.stringify(tree.toJSON())).toContain('Sign in again');
  await act(async () => choice('Look').props.onValueChange('lowlight')); expect(f.call).not.toHaveBeenCalled();
});
it('surfaces a failed HTTP save and retries only on an explicit request', async () => {
  f.snapshot = live({}); const r = request(); f.call.mockReturnValue(r.handle); await draw();
  await act(async () => choice('Reduce motion').props.onValueChange('on'));
  expect(f.call).toHaveBeenCalledWith('household.setPreferences', { motion: 'on' });
  await r.finish({ ok: false, code: 'unavailable', message: 'Try again' }); expect(JSON.stringify(tree.toJSON())).toContain('Could not confirm the save');
  expect(f.call).toHaveBeenCalledOnce();const next=request();f.call.mockReturnValue(next.handle);
  await act(async () => tree.root.findByType('button').props.onClick());expect(f.call).toHaveBeenCalledTimes(2);expect(f.call.mock.calls[1]).toEqual(f.call.mock.calls[0]);await next.finish({ok:true,value:{motion:'on'}});
  expect(tree.root.findAllByType('button')).toHaveLength(0);
});
it('saves higher contrast as its own choice', async () => {
  f.snapshot = live({}); const r = request(); f.call.mockReturnValue(r.handle); await draw();
  await act(async () => choice('Higher contrast').props.onValueChange('off'));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('household.setPreferences', { contrast: 'off' }); await r.finish({ ok: true, value: { contrast: 'off' } });
});
it.each([
  ['Sound', 'sound', false], ['Pixel faces', 'pixel', true],
  ['Pixel icons', 'icons', false], ['Haptics', 'haptics', true],
  ['One window at a time', 'oneWindow', false], ['Allow zoom', 'zoom', false],
] as const)('saves %s as one member choice and waits for its live record', async (label, key, fallback) => {
  f.snapshot = live({}); const r = request(); f.call.mockReturnValue(r.handle); await draw();
  expect(toggle(label).props.checked).toBe(fallback);
  await act(async () => toggle(label).props.onCheckedChange(!fallback));
  expect(f.call).toHaveBeenCalledExactlyOnceWith('household.setPreferences',{[key]:!fallback});
  expect(toggle(label).props.checked).toBe(fallback);
  expect(toggle(label).props.disabled).toBe(true);
  await r.finish({ok:true,value:{[key]:!fallback}});
  await publish(live({[key]:!fallback}));
  expect(toggle(label).props.checked).toBe(!fallback);
});
it('locks a pending HTTP save and never resubmits it on reconnection',async()=>{
  f.snapshot=live({look:'neon'});const r=request();f.call.mockReturnValue(r.handle);await draw();
  const change=()=>choice('Look').props.onValueChange('daylight');
  await act(async()=>{change();change();});expect(f.call).toHaveBeenCalledTimes(1);
  await r.finish({ok:false,code:'unavailable',message:'Disconnected'});
  await publish({status:'offline',records:[]});await publish(live({look:'neon'}));
  expect(f.call).toHaveBeenCalledTimes(1);expect(choice('Look').props.value).toBe('neon');
});
