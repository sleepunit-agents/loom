import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../data',()=>({call:vi.fn(),useRecords:()=>({status:'live',records:[]})}));
vi.mock('./composer',()=>({Composer:(props:object)=>h('Composer',props),Answer:()=>null,useRequest:()=>({pending:false,result:{ok:true,value:{member:'jonathan',agents:['art','mark']}}})}));
vi.mock('../../kit',()=>({Split:({reader,listTop,open}:{reader:ReactNode;listTop:ReactNode;open:boolean})=>h('main',{'data-open':open},listTop,reader),...Object.fromEntries(['List','Empty','Error','Loading','Button','Input'].map(name=>[name,(props:{children?:ReactNode})=>h(name,props,props.children)]))}));
import CommsApp from './index';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
it('opens the existing private composer on the new-thread route, including reload and shell navigation',async()=>{
 vi.stubGlobal('location',{pathname:'/p/comms-preview/new'});const go=vi.fn();
 await act(async()=>{tree=create(h(CommsApp,{path:'/p/comms-preview/new',go}));});
 expect(tree.root.findByType('main').props['data-open']).toBe(true);
 expect(tree.root.findByType('Composer').props).toMatchObject({member:'jonathan',agent:'art',enabled:true});
 await act(async()=>tree.root.findByType('Composer').props.onOpened('th:private123'));
 expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/private123');
 await act(async()=>tree.update(h(CommsApp,{path:'/p/comms-preview',go})));
 expect(tree.root.findAllByType('Composer')).toHaveLength(0);
 const button=tree.root.findAllByType('Button').find((b:{props:{children:unknown}})=>b.props.children==='New thread');
 await act(async()=>button.props.onClick());expect(go).toHaveBeenLastCalledWith('/p/comms-preview/new');
});
