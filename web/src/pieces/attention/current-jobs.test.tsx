import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import type { DataQuerySnapshot } from '../../data/graphql';
import type { CurrentJob } from './current-jobs';
const f = vi.hoisted(() => ({ snapshot: {} as DataQuerySnapshot<{currentJobs: CurrentJob[]}>, query: vi.fn() }));
vi.mock('../../data/graphql', () => ({ useDataQuery: (document: string, variables: object) => { f.query(document, variables); return f.snapshot; } }));
import { CurrentJobs, currentJobsQuery } from './current-jobs';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); f.query.mockClear(); });
it('uses the scoped projection, preserves queued order and concurrent titles, and renders null assignment and words safely', async () => {
  f.snapshot = {status:'live',data:{currentJobs:[
    {id:'z',agent:'art',title:'<script>same</script>',state:'queued',box:null,queuedAt:'2026-11-14T01:00:00Z'},
    {id:'a',agent:'art',title:'<script>same</script>',state:'running',box:'worker',queuedAt:'2026-11-14T02:00:00Z'},
    {id:'foreign',agent:'other',title:'Foreign job',state:'running',box:null,queuedAt:'2026-11-14T02:00:00Z'},
  ]}};
  await act(async()=>{tree=create(h(CurrentJobs,{agent:'art',name:'Art'}));});
  expect(f.query).toHaveBeenCalledWith(currentJobsQuery,{agent:'art'});
  expect(currentJobsQuery).toContain('currentJobs(agent: $agent) { id agent title state box queuedAt }');
  expect(tree.root.findAllByType('li').map((node:any)=>node.findAllByType('p')[0].children.join(''))).toEqual(['queued · Unassigned','running · Box worker']);
  expect(tree.root.findAllByType('h4').map((node:any)=>node.children.join(''))).toEqual(['<script>same</script>','<script>same</script>']);
  expect(tree.root.findAllByType('script')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).not.toContain('Foreign job');
  for (const status of ['loading','offline','denied'] as const) {
    f.snapshot = {...f.snapshot,status};
    await act(async()=>tree.update(h(CurrentJobs,{agent:'art',name:'Art'})));
    expect(tree.root.findAllByType('li')).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).not.toContain('same');
    expect(JSON.stringify(tree.toJSON())).not.toContain('No current runtime jobs.');
  }
  f.snapshot={status:'live',data:{currentJobs:[]}};
  await act(async()=>tree.update(h(CurrentJobs,{agent:'art',name:'Art'})));
  expect(JSON.stringify(tree.toJSON())).toContain('No current runtime jobs.');
});
it('asks the rail to measure again when a mounted job selection changes', async()=>{
  const changed=vi.fn(); f.snapshot={status:'loading'};
  await act(async()=>{tree=create(h(CurrentJobs,{agent:'art',name:'Art',compact:true,onChange:changed}));});
  expect(changed).not.toHaveBeenCalled();
  f.snapshot={status:'live',data:{currentJobs:[]}};
  await act(async()=>tree.update(h(CurrentJobs,{agent:'art',name:'Art',compact:true,onChange:changed})));
  expect(changed).toHaveBeenCalledTimes(1);
});
