import {expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Existing renderer has no declarations.
import {act,create} from 'react-test-renderer';
import {RailContext,type RailLink} from '../../desk-rail';
const f=vi.hoisted(()=>({reads:0}));
vi.mock('./agent-displays',()=>({useDeskAgentDisplays:()=>{f.reads++;return [];}}));
vi.mock('./agent-directory',()=>({useDeskAgentDirectory:()=>({status:'denied',records:[]})}));
vi.mock('./roster',()=>({useDeskRoster:()=>({status:'live',records:[{id:'art'}]})}));
vi.mock('./agent-status',()=>({useDeskAgentStatuses:()=>({status:'denied',records:[]})}));
vi.mock('./waiting',()=>({useDeskWaitingCounts:()=>({status:'denied',agents:new Map()})}));
vi.mock('./agent-face',()=>({default:()=>null,faceState:()=> 'idle'}));
vi.mock('../../kit',()=>({Button:'button'}));
import Companion from './comms-companion';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('announces only a visible reader and clears the same source on selection changes and hiding',async()=>{
 const onAir=vi.fn(),rail:RailLink={onAir,shown:false,screen:null};
 const view=(agent:string,visible:boolean)=>h(RailContext.Provider,{value:rail},h(Companion,{agent,visible,working:false,go:vi.fn()}));
 let tree!:ReturnType<typeof create>;f.reads=0;
 await act(async()=>{tree=create(view('art',false));});
 try{
  expect(onAir).not.toHaveBeenCalled();expect(f.reads).toBe(0);
  await act(async()=>tree.update(view('art',true)));
  expect(onAir.mock.calls[0][0]).toEqual({agent:'art'});const source=onAir.mock.calls[0][1];
  // Without the rail it is a small face beside the thread's title: no screen, no name and no status line over the conversation.
  expect(tree.root.findAllByType('section')).toHaveLength(0);expect(tree.root.findAllByType('p')).toHaveLength(0);
  expect(tree.root.findByProps({'data-location':'inline'}).findByType('button').props).toMatchObject({'aria-label':'Open Art',title:'No status reported'});
  await act(async()=>tree.update(view('birch',true)));
  expect(onAir.mock.calls.slice(1)).toEqual([[null,source],[{agent:'birch'},source]]);
  await act(async()=>tree.update(view('birch',false)));
  expect(onAir.mock.calls.at(-1)).toEqual([null,source]);expect(tree.toJSON()).toBeNull();
 }finally{await act(async()=>tree.unmount());}
});
