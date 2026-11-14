import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error The existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
const f=vi.hoisted(()=>({status:'live',records:[{id:'new',agent:'art',kind:'merge',at:'2026-11-14T00:00:00Z',what:'Fix for a person',target:'github:acme/app#12@head',for:'loren'},{id:'old',agent:'art',kind:'host',at:'2026-11-13T00:00:00Z',what:'Earlier reported step',target:'restart:fixture.service'}]}));
vi.mock('../../data',()=>({useRecords:(type:string)=>({records:type==='approval.notice'?f.records:[],status:f.status}),call:vi.fn()}));
import ApprovalsApp from './index';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());f.status='live';});
it('shows source words, target and principal in the owning live reported view, newest first, with search',async()=>{
  await act(async()=>{tree=create(h(ApprovalsApp,{path:'/p/approvals-preview/notices'}));});
  const text=()=>JSON.stringify(tree.toJSON());
  expect(text()).toContain('Merge and host reports appear in the list.');expect(text()).toContain('Fix for a person');expect(text()).toContain('github:acme/app#12@head');expect(text()).toContain('for loren');expect(text()).toContain('11/13/26, 6:00 PM CT');
  expect(text().indexOf('Fix for a person')).toBeLessThan(text().indexOf('Earlier reported step'));
  await act(async()=>tree.root.findByProps({type:'search'}).props.onChange({target:{value:'fixture.service'}}));
  expect(text()).toContain('Earlier reported step');expect(text()).not.toContain('Fix for a person');
});
it('hides stale source words when disconnected',async()=>{
  f.status='offline';await act(async()=>{tree=create(h(ApprovalsApp,{path:'/p/approvals-preview/notices'}));});
  expect(JSON.stringify(tree.toJSON())).toContain('Waiting for connection.');expect(JSON.stringify(tree.toJSON())).not.toContain('Fix for a person');
});
