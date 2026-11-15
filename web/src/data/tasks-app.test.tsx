import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Renderer dependency has no declarations.
import {act,create} from 'react-test-renderer';
const feed=vi.hoisted(()=>({status:'live',data:{projects:[{id:'pond',name:'Pond'}],agents:[{id:'art'}],members:[{id:'sam'},{id:'lee'}]}}));
vi.mock('./graphql',()=>({useDataQuery:()=>feed}));
vi.mock('./task-command',()=>({useTaskCommandSubmitter:()=>async()=>{}}));
vi.mock('../pieces/tasks',()=>({default:(props:unknown)=>h('Tasks',props as object)}));
import TasksScreen from './tasks-app';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
it('uses only live filtered members/agents/projects and drops withdrawn choices without retaining their IDs',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({viewer:{kind:'member',id:'sam'}})));
  await act(async()=>{tree=create(h(TasksScreen));});
  const props=()=>tree.root.findByType('Tasks').props;
  expect(props().people.map((person:{id:string})=>person.id)).toEqual(['sam','lee','art']);
  expect(props().questionFor).toBe('sam');
  feed.status='offline';await act(async()=>tree.update(h(TasksScreen)));
  expect(props().people.map((person:{id:string})=>person.id)).toEqual(['sam']);expect(props().projects).toEqual([]);
  feed.status='live';feed.data={...feed.data,members:[{id:'sam'}]};await act(async()=>tree.update(h(TasksScreen)));
  expect(props().people.map((person:{id:string})=>person.id)).toEqual(['sam','art']);expect(props().projects).toEqual([{id:'pond',label:'Pond'}]);
});
