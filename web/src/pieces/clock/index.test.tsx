import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
const f=vi.hoisted(()=>({receipt:undefined as ReturnType<typeof import('./request').useRequest>}));
vi.mock('./request',()=>({send:vi.fn(),useRequest:()=>f.receipt}));
vi.mock('../approvals',()=>({ApprovalReader:()=>null}));
vi.mock('../../data',()=>({useRecords:(type:string)=>({status:'live',records:type==='wake'?[{id:'w-visible',agent:'art',note:'Ordinary work',prompt:'Public work',state:'pending',due:1}]:[]})}));
vi.mock('../../kit',()=>({Split:({reader}:{reader:ReactNode})=>h('main',null,reader),...Object.fromEntries(['List','Row','Empty','Error','Loading','Button','Input'].map(name=>[name,(props:{children?:ReactNode})=>h(name,props,props.children)]))}));
import ClockApp from './index';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();f.receipt=undefined;});
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
