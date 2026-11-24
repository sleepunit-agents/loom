import {expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Existing renderer has no declarations.
import {act,create} from 'react-test-renderer';
import type {CommsMessage} from '../comms-view/model';
import {RailContext,type RailLink} from '../../desk-rail';
const f=vi.hoisted(()=>({reads:0,work:0}));
vi.mock('./agent-displays',()=>({useDeskAgentDisplays:()=>{f.reads++;return [];}}));
vi.mock('./agent-directory',()=>({useDeskAgentDirectory:()=>({status:'denied',records:[]})}));
vi.mock('./roster',()=>({useDeskRoster:()=>({status:'live',records:[{id:'art'}]})}));
vi.mock('./agent-status',()=>({useDeskAgentStatuses:()=>({status:'denied',records:[]})}));
vi.mock('./waiting',()=>({useDeskWaitingCounts:()=>({status:'denied',agents:new Map()})}));
vi.mock('../../access',()=>({motionQuery:()=>({matches:false,addEventListener(){},removeEventListener(){}}),reducedMotion:()=>false}));
vi.mock('./doing',()=>({useDoing:()=>({items:Array(f.work)})}));
vi.mock('./agent-face',async importOriginal=>({...await importOriginal<typeof import('./agent-face')>(),default:()=>null}));
vi.mock('../../kit',()=>({Button:'button'}));
import Companion from './comms-companion';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('announces only a visible reader and clears the same source on selection changes and hiding',async()=>{
 const onAir=vi.fn(),rail:RailLink={onAir,shown:false,screen:null};
 const view=(agent:string,visible:boolean)=>h(RailContext.Provider,{value:rail},h(Companion,{agent,visible,messages:[],needs:false,working:false,go:vi.fn()}));
 let tree!:ReturnType<typeof create>;f.reads=0;
 await act(async()=>{tree=create(view('art',false));});
 try{
  expect(onAir).not.toHaveBeenCalled();expect(f.reads).toBe(0);
  await act(async()=>tree.update(view('art',true)));
  expect(onAir.mock.calls[0][0]).toEqual({agent:'art'});const source=onAir.mock.calls[0][1];
  // Without the rail it is a small face beside the thread's title: no screen, no name and no status line over the conversation.
  expect(tree.root.findAllByType('section')).toHaveLength(0);expect(tree.root.findAllByType('p')).toHaveLength(0);
  expect(tree.root.findByProps({'data-location':'inline'}).findByType('button').props).toMatchObject({'aria-label':'Open Art',title:'Quiet'});
  f.work=1;
  await act(async()=>tree.update(view('art',true)));
  expect(tree.root.findByType('button').props.title).toBe('Working');
  f.work=0;
  await act(async()=>tree.update(view('art',true)));
  expect(tree.root.findByType('button').props.title).toBe('Quiet');
  await act(async()=>tree.update(view('birch',true)));
  expect(onAir.mock.calls.slice(1)).toEqual([[null,source],[{agent:'birch'},source]]);
  await act(async()=>tree.update(view('birch',false)));
  expect(onAir.mock.calls.at(-1)).toEqual([null,source]);expect(tree.toJSON()).toBeNull();
 }finally{await act(async()=>tree.unmount());}
});

it('plays a newly retained reply, skips history and drops the animation when the words expire',async()=>{
 vi.useFakeTimers();
 const reply=(seq:number,words:string|null):CommsMessage=>({thread:'th:a',seq,words,kind:'reply',sender:'art',at:'2026-11-21T00:00:00Z'});
 const view=(messages:CommsMessage[])=>h(Companion,{agent:'art',visible:true,working:false,needs:false,messages,go:vi.fn()});
 let tree!:ReturnType<typeof create>;
 try {
  await act(async()=>{tree=create(view([reply(1,'Previous reply')]));});
  const inline=()=>tree.root.findByProps({'data-location':'inline'}).props;
  expect(inline()['data-signal']).toBeUndefined();
  await act(async()=>tree.update(view([reply(1,'Previous reply'),reply(2,'New reply')])));
  expect(inline()['data-signal']).toBe('on');
  await act(async()=>vi.advanceTimersByTime(250));
  expect(inline()['data-face']).toBe('talking');
  await act(async()=>vi.advanceTimersByTime(1530));
  expect(inline()['data-face']).toBe('complete');
  await act(async()=>tree.update(view([reply(1,'Previous reply'),reply(2,null)])));
  expect(inline()['data-face']).toBe('idle');
 } finally {await act(async()=>tree?.unmount());vi.useRealTimers();}
});

it('starts fresh reply tracking when the same agent opens another conversation',async()=>{
 const row=(thread:string,seq:number):CommsMessage=>({thread,seq,words:'Reply',kind:'reply',sender:'art',at:'2026-11-21T00:00:00Z'});
 const view=(threadId:string|undefined,messages:CommsMessage[])=>h(Companion,{agent:'art',threadId,visible:true,working:false,needs:false,messages,go:vi.fn()});
 let tree!:ReturnType<typeof create>;
 try {
  await act(async()=>{tree=create(view('th:a',[row('th:a',4)]));});
  const signal=()=>tree.root.findByProps({'data-location':'inline'}).props['data-signal'];
  await act(async()=>tree.update(view('th:a',[row('th:a',5)])));
  expect(signal()).toBe('on');
  await act(async()=>tree.update(view(undefined,[])));
  expect(signal()).toBeUndefined();
  await act(async()=>tree.update(view('th:b',[row('th:b',15)])));
  expect(signal()).toBeUndefined();
  await act(async()=>tree.update(view('th:b',[row('th:b',16)])));
  expect(signal()).toBe('on');
 } finally {await act(async()=>tree?.unmount());}
});
