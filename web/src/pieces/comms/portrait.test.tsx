import { expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../attention/agent-face',()=>({default:()=>null,useAgentDisplays:()=>[]}));
vi.mock('../../access',()=>({reducedMotion:()=>false}));
import { CommPortrait, portraitState } from './portrait';
import type { Message } from './message';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const reply=(seq:number,text:string|null='hello'):Message=>({id:`m${seq}`,thread:'th:a',seq,at:1,kind:'reply',from:'art',text});
it('uses retained asks and real connection before working or thinking',()=>{
 const ask={...reply(2,'Allow?'),kind:'ask',ask:{ask:'Allow?'},ref:'ask'};
 expect(portraitState([ask],true,true,true)).toBe('needs-input');
 expect(portraitState([ask],false,true,true)).toBe('error');
 expect(portraitState([{...reply(3),kind:'message',delivery:'failed'}],true,false,true)).toBe('error');
 expect(portraitState([{...ask,text:null,ask:undefined}],true,false,true)).toBe('thinking');
 expect(portraitState([{...ask,answer:{verdict:'yes'}}],true,true,false)).toBe('working');
});
it('does not replay old replies, bounds a fresh reply and clears expired words',async()=>{
 vi.useFakeTimers();let tree!:ReturnType<typeof create>;
 const props={agent:'art',connected:true,working:false,thinking:false};
 const face=()=>tree.root.findByType('section').props;
 try{
  await act(async()=>{tree=create(h(CommPortrait,{...props,messages:[]}));});
  expect(face()['data-face']).toBe('idle');
  await act(async()=>tree.update(h(CommPortrait,{...props,messages:[reply(1)]})));
  expect(face()['data-face']).toBe('idle');
  await act(async()=>tree.update(h(CommPortrait,{...props,messages:[reply(1),reply(2)]})));
  expect(face()['data-signal']).toBe(true);
  await act(async()=>vi.advanceTimersByTime(250));expect(face()['data-face']).toBe('talking');
  await act(async()=>tree.update(h(CommPortrait,{...props,messages:[reply(1),reply(2,null)]})));
  expect(face()['data-face']).toBe('idle');expect(face()['data-signal']).toBeFalsy();
  await act(async()=>tree.update(h(CommPortrait,{...props,messages:[reply(3)]})));
  await act(async()=>vi.advanceTimersByTime(250));expect(face()['data-face']).toBe('talking');
  await act(async()=>vi.advanceTimersByTime(1530));expect(face()['data-face']).toBe('idle');
 }finally{if(tree)await act(async()=>tree.unmount());vi.useRealTimers();}
});
