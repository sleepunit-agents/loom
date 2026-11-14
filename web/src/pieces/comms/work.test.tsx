import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
const state=vi.hoisted(()=>({status:'live',records:[] as Record<string,unknown>[]}));
vi.mock('../../data',()=>({useRecords:()=>state}));
vi.mock('../../kit',()=>Object.fromEntries(['Loading','Button'].map(name=>[name,(props:{children?:ReactNode})=>h(name,props,props.children)])));
import { Work } from './work';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());state.status='live';state.records=[];});
it('renders fixed work links, unlinked note paths and Made here only for provenance',async()=>{
 state.records=[{id:'th:1',failed:[],items:[
  {ref:'t-1',title:'Made task',status:'Open',from:'tasks',made:true,url:'/p/tasks-preview/task/t-1'},
  {ref:'github:acme/app#3',title:'Cited change',status:'Not tracked',from:'changes',url:'https://github.com/acme/app/issues/3'},
  {ref:'note:pond/plan',title:'pond/plan',status:'Note',from:'notes'},
 ]}];
 await act(async()=>{tree=create(h(Work,{thread:'th:1',agent:'art',member:'jonathan'}));});
 expect(tree.root.findAllByType('a').map((a:{props:{href:string}})=>a.props.href)).toEqual(['/p/tasks-preview/task/t-1','https://github.com/acme/app/issues/3']);
 expect(tree.root.findByType('code').props.children).toBe('pond/plan');
 const rows=tree.root.findAllByType('li');
 expect(rows.map((row:{findByType:(type:string)=>{children:unknown[]}})=>row.findByType('p').children.includes(' · Made here'))).toEqual([true,false,false]);
 state.status='connecting';
 await act(async()=>tree.update(h(Work,{thread:'th:1',agent:'art',member:'jonathan'})));
 expect(tree.root.findAllByType('a')).toHaveLength(0);
 expect(tree.root.findAllByType('code')).toHaveLength(0);
});
