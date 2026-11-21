import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Renderer dependency has no declarations.
import {act,create} from 'react-test-renderer';
const feed=vi.hoisted(()=>({status:'live',data:{projects:[{id:'pond',name:'Pond',projectMembersByProject:[{member:'sam'},{member:'lee'},{member:'jo'}]}],agents:[{id:'art',removedAt:null},{id:'mark',removedAt:'2026-11-19'}],members:[{id:'sam'},{id:'lee'}]}}));
vi.mock('./graphql',()=>({useDataQuery:()=>feed}));
vi.mock('./task-command',()=>({useTaskCommandSubmitter:()=>async()=>{}}));
vi.mock('../pieces/tasks',()=>({default:(props:unknown)=>h('Tasks',props as object)}));
import {DeskMember} from '../signin/desk-member';
import TasksScreen from './tasks-app';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
it('uses only live filtered members/agents/projects and drops withdrawn choices without retaining their IDs',async()=>{
  const fetch=vi.fn().mockRejectedValue(new Error('Disconnected'));vi.stubGlobal('fetch',fetch);
  const screen=()=>h(DeskMember.Provider,{value:'sam'},h(TasksScreen));
  await act(async()=>{tree=create(screen());});
  expect(fetch).not.toHaveBeenCalled();
  const props=()=>tree.root.findByType('Tasks').props;
  expect(props().people.map((person:{id:string})=>person.id)).toEqual(['sam','lee','jo','art']);
  expect([...props().liveAgentIds]).toEqual(['art']);
  expect(props().questionFor).toBe('sam');
  feed.status='offline';await act(async()=>tree.update(screen()));
  expect(props().people.map((person:{id:string})=>person.id)).toEqual(['sam']);expect(props().projects).toEqual([]);
  feed.status='live';feed.data={...feed.data,members:[{id:'sam'}],projects:[{id:'pond',name:'Pond',projectMembersByProject:[{member:'sam'}]}]};await act(async()=>tree.update(screen()));
  expect(props().people.map((person:{id:string})=>person.id)).toEqual(['sam','art']);expect(props().projects).toEqual([{id:'pond',label:'Pond'}]);
});
