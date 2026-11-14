import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
const state=vi.hoisted(()=>({status:'live',records:[] as Record<string,unknown>[]}));
vi.mock('../../data',()=>({useRecords:()=>state}));
import { FromConversation } from './from';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());state.status='live';state.records=[];});
it('shows only the exact current live source and hides the private label on disconnect or replacement',async()=>{
 state.records=[{id:'cv-one',label:'From: Private title',url:'/p/comms-preview/thread/one'}];
 await act(async()=>{tree=create(h(FromConversation,{conversation:'cv-one'}));});
 expect(tree.root.findByType('a').props.href).toBe('/p/comms-preview/thread/one');
 for(const status of ['connecting','offline','denied']){
  state.status=status;await act(async()=>tree.update(h(FromConversation,{conversation:'cv-one'})));
  expect(tree.root.findAllByType('a')).toHaveLength(0);expect(tree.root.findByType('p').children).toEqual(['From a conversation']);
 }
 state.status='live';await act(async()=>tree.update(h(FromConversation,{conversation:'cv-other'})));
 expect(tree.root.findAllByType('a')).toHaveLength(0);expect(tree.root.findByType('p').children).toEqual(['From a conversation']);
 state.records=[{id:'cv-other',label:'From a Comms thread'}];await act(async()=>tree.update(h(FromConversation,{conversation:'cv-other'})));
 expect(tree.root.findByType('p').children).toEqual(['From a Comms thread']);
});
