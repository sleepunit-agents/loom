import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
const f=vi.hoisted(()=>({status:'live',schedules:[] as Array<Record<string,unknown>>,receipt:undefined as ReturnType<typeof import('./request').useRequest>}));
vi.mock('./request',()=>({send:vi.fn(),useRequest:()=>f.receipt}));
vi.mock('../approvals',()=>({ApprovalReader:()=>null}));
vi.mock('../../data',()=>({useRecords:(type:string)=>({status:f.status,records:type==='wake'?[{id:'w-visible',agent:'art',note:'Ordinary work',prompt:'Public work',state:'pending',due:1}]:type==='schedule'?f.schedules:[]})}));
vi.mock('../../kit',()=>({Split:({reader}:{reader:ReactNode})=>h('main',null,reader),...Object.fromEntries(['List','Row','Empty','Error','Loading','Button','Input','Textarea'].map(name=>[name,(props:{children?:ReactNode})=>h(name,props,props.children)]))}));
import { send } from './request';
import ClockApp from './index';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();f.receipt=undefined;f.schedules=[];f.status='live';vi.clearAllMocks();});
it.each([true,false])('does not reuse local scheduling success=%s on an unrelated wake reader',async ok=>{
 vi.stubGlobal('location',{pathname:'/p/clock-preview/item/w-visible'});
 f.receipt={operation:'scheduleLocalFromWindow',input:{approval:'a-12345678'},pending:false,status:'done',result:ok?{ok:true,value:{id:'w-private',due:1}}:{ok:false,code:'invalid',message:'Private scheduling failure'}};
 await act(async()=>{tree=create(h(ClockApp,{go:vi.fn()}));});
 expect(tree.root.findAllByProps({role:'status'})).toHaveLength(0);
 expect(tree.root.findAllByType('Error')).toHaveLength(0);
 // A prior local receipt must not hide a fresh ordinary action confirmation.
 const now=tree.root.findAllByType('Button').find((b:{props:{children?:unknown}})=>b.props.children==='Run now');
 await act(async()=>now.props.onClick());
 expect(tree.root.findByProps({'aria-label':'Confirm clock action'})).toBeTruthy();
});

it.each([true,false])('offers separate recovery for eligible=%s disabled schedules with no ordinary edit or run',async eligible=>{
 f.schedules=[{id:'art/daily',agent:'art',note:'Archived note',prompt:'Archive words',at:['03:47'],days:'',enabled:false,canRecover:eligible}];
 vi.stubGlobal('location',{pathname:'/p/clock-preview/item/art%2Fdaily'});
 await act(async()=>{tree=create(h(ClockApp,{go:vi.fn()}));});
 expect(tree.root.findAllByProps({'aria-label':'Recover imported schedule'})).toHaveLength(eligible?1:0);
 const labels=tree.root.findAllByType('Button').map((b:{props:{children?:unknown}})=>b.props.children);
 expect(labels).not.toContain('Edit schedule');expect(labels).not.toContain('Run once');
});

it('blocks a reviewed recovery while an unrelated request is pending and removes it on offline feed',async()=>{
 f.schedules=[{id:'art/daily',agent:'art',note:'Archived note',at:['03:47'],days:'',enabled:false,canRecover:true}];
 vi.stubGlobal('location',{pathname:'/p/clock-preview/item/art%2Fdaily'});
 await act(async()=>{tree=create(h(ClockApp,{go:vi.fn()}));});
 const data=new FormData();data.set('prompt','Fresh work');data.set('note','');data.set('at','13:17');data.set('days','');
 vi.stubGlobal('FormData',class {constructor(){return data;}});
 await act(async()=>tree.root.findByProps({'aria-label':'Recover imported schedule'}).props.onSubmit({preventDefault(){},currentTarget:{}}));
 f.receipt={operation:'pause',input:{agent:'art'},pending:true,status:'pending'};
 const go=vi.fn();await act(async()=>tree.update(h(ClockApp,{go})));
 expect(tree.root.findByType('fieldset').props.disabled).toBe(true);
 const save=tree.root.findAllByType('Button').find((b:{props:{children?:unknown}})=>b.props.children==='Save my new schedule');
 expect(save.props.disabled).toBe(true);await act(async()=>save.props.onClick());expect(send).not.toHaveBeenCalled();
 f.status='offline';await act(async()=>tree.update(h(ClockApp,{go})));
 expect(tree.root.findAllByProps({'aria-label':'Recover imported schedule'})).toHaveLength(0);
 expect(tree.root.findAllByProps({'aria-label':'Confirm schedule recovery'})).toHaveLength(0);expect(send).not.toHaveBeenCalled();
});
