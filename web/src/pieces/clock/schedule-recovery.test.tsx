import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
vi.mock('./request',()=>({send:vi.fn()}));
vi.mock('../../kit',()=>Object.fromEntries(['Button','Input','Textarea'].map(name=>[name,(props:{children?:ReactNode})=>h(name,props,props.children)])));
import { ScheduleRecovery } from './schedule-recovery';
import { send } from './request';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();vi.clearAllMocks();});
const schedule={id:'art/daily',agent:'art',note:'ARCHIVED_NOTE',prompt:'ARCHIVED_WORDS',at:['03:47'],days:'sun',enabled:false,canRecover:true};
async function mount(enabled=true) {await act(async()=>{tree=create(h(ScheduleRecovery,{schedule,enabled}));});}
const button=(label:string)=>tree.root.findAllByType('Button').find((b:{props:{children?:unknown}})=>b.props.children===label);
async function review() {
 vi.stubGlobal('FormData',class { get(key:string){return ({prompt:'Fresh words',note:'',at:'13:17',days:''} as Record<string,string>)[key];}});
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));
}
it('starts with blank work and timing, reviews and sends only a fresh complete owner submission',async()=>{
 await mount();
 expect(JSON.stringify(tree.toJSON())).not.toContain('ARCHIVED');
 for(const name of ['prompt','note','at','days'])expect(tree.root.findByProps({name}).props.defaultValue).toBeUndefined();
 await review();expect(send).not.toHaveBeenCalled();
 expect(tree.root.findByProps({'aria-label':'Confirm schedule recovery'})).toBeTruthy();
 await act(async()=>button('Save my new schedule').props.onClick());
 expect(send).toHaveBeenCalledExactlyOnceWith('scheduleRecover',{id:'art/daily',agent:'art',prompt:'Fresh words',note:'',at:'13:17',days:''});
});
it('clears confirmation when any field changes or the owner keeps work disabled',async()=>{
 await mount();await review();await act(async()=>tree.root.findByType('form').props.onChange());
 expect(button('Save my new schedule')).toBeUndefined();
 await review();await act(async()=>button('Keep disabled').props.onClick());expect(send).not.toHaveBeenCalled();
 expect(button('Save my new schedule')).toBeUndefined();
});
it('refuses a stale confirmation after readiness is lost',async()=>{
 await mount();await review();await act(async()=>tree.update(h(ScheduleRecovery,{schedule,enabled:false})));
 await act(async()=>button('Save my new schedule').props.onClick());expect(send).not.toHaveBeenCalled();
});
