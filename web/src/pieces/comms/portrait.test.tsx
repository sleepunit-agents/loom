import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no declarations.
import { act, create } from 'react-test-renderer';
const fixture=vi.hoisted(()=>({motion:false,change:()=>{},displays:[] as unknown[]}));
vi.mock('../attention/agent-face',()=>({default:(p:object)=>h('agent-face',p),useAgentDisplays:()=>fixture.displays}));
vi.mock('../../access',()=>({reducedMotion:()=>fixture.motion,motionQuery:()=>({get matches(){return fixture.motion;},addEventListener:(_:string,f:()=>void)=>{fixture.change=f;},removeEventListener:()=>{}})}));
import { CommPortrait, portraitState, talkBeats } from './portrait';
import { PixelContext } from '../../look';
import type { Message } from './message';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const reply=(seq:number,text:string|null='hello'):Message=>({id:`m${seq}`,thread:'th:a',seq,at:1,kind:'reply',from:'art',text});
const props={agent:'art',connected:true,working:false,thinking:false};
let tree:ReturnType<typeof create>|undefined;
let width=192,resize:()=>void;
const draw=(messages:Message[],extra:Partial<typeof props>={},pixel=false)=>h(PixelContext.Provider,{value:pixel},h(CommPortrait,{...props,...extra,messages}));
const show=async(messages:Message[],extra:Partial<typeof props>={},pixel=false)=>act(async()=>{
 const element=draw(messages,extra,pixel);
 if(tree)tree.update(element);else tree=create(element,{createNodeMock:()=>({get clientWidth(){return width;}})});
});
const face=()=>tree!.root.findByType('section').props;
const player=()=>tree!.root.findByType('agent-face').props;
const signal=async()=>{await act(async()=>vi.advanceTimersByTime(32));await act(async()=>vi.advanceTimersByTime(250));};
beforeEach(()=>{
 vi.useFakeTimers();fixture.displays=[];fixture.motion=false;width=192;
 vi.stubGlobal('requestAnimationFrame',(f:()=>void)=>setTimeout(f,16));
 vi.stubGlobal('cancelAnimationFrame',clearTimeout);
 vi.stubGlobal('ResizeObserver',class{constructor(f:()=>void){resize=f;}observe(){}disconnect(){}});
});
afterEach(async()=>{if(tree)await act(async()=>tree.unmount());tree=undefined;vi.useRealTimers();vi.unstubAllGlobals();});
it('uses retained asks and real connection before working or thinking',()=>{
 const ask={...reply(2,'Allow?'),kind:'ask',ask:{ask:'Allow?'},ref:'ask'};
 expect(portraitState([ask],true,true,true)).toBe('needs-input');
 expect(portraitState([ask],false,true,true)).toBe('error');
 expect(portraitState([{...reply(3),kind:'message',delivery:'failed'}],true,false,true)).toBe('error');
 expect(portraitState([{...ask,text:null,ask:undefined}],true,false,true)).toBe('thinking');
 expect(portraitState([{...ask,answer:{verdict:'yes'}}],true,true,false)).toBe('working');
 expect([0,150,151,301,451,900].map(talkBeats)).toEqual([1,1,2,3,4,4]);
});
it('baselines history, holds painted signal, then drawn beats with breaths, completion, and base',async()=>{
 await show([reply(1)]);expect(face()['data-face']).toBe('idle');
 await show([reply(1),reply(2,'x'.repeat(151))],{working:true});
 expect(face()['data-signal']).toBe(true);
 await act(async()=>vi.advanceTimersByTime(32));
 await act(async()=>vi.advanceTimersByTime(249));expect(face()['data-signal']).toBe(true);
 await act(async()=>vi.advanceTimersByTime(1));expect(face()['data-face']).toBe('talking');
 await act(async()=>vi.advanceTimersByTime(2*1530+800-1));expect(face()['data-face']).toBe('talking');
 await act(async()=>vi.advanceTimersByTime(1));expect(face()['data-face']).toBe('complete');
 await act(async()=>vi.advanceTimersByTime(900));expect(face()['data-face']).toBe('working');
});
it('lets the sprite player count and complete, rather than ending on an estimated timer',async()=>{
 fixture.displays=[{agent:'art',sprite:{base:'/faces/art/',v:'1',facings:['south']}}];
 await show([reply(1)],{},true);
 await act(async()=>player().onReady(true));
 await show([reply(1),reply(2,'x'.repeat(301)),reply(3)],{working:true},true);
 await signal();expect(player().talk).toEqual({n:4,key:3});
 await act(async()=>player().onShown('talking'));expect(face()['data-face']).toBe('talking');
 await act(async()=>vi.advanceTimersByTime(60000));expect(face()['data-face']).toBe('talking');
 await act(async()=>player().onFrom('done'));expect(face()['data-anim']).toBe('done');
 await act(async()=>player().onShown('complete'));expect(face()['data-face']).toBe('complete');
 await act(async()=>player().onShown('idle'));expect(face()['data-face']).toBe('working');
});
it('drops expired sources, refuses stale callbacks and never replays reconnect history',async()=>{
 await show([reply(1)]);await show([reply(1),reply(2)]);await signal();
 const stale=player().onShown;
 await show([reply(1),reply(2,null)]);expect(face()['data-face']).toBe('idle');
 await act(async()=>stale('talking'));expect(face()['data-face']).toBe('idle');
 await show([reply(3)],{connected:false});expect(face()['data-face']).toBe('error');
 await show([reply(3)]);expect(face()['data-signal']).toBeFalsy();
 await show([reply(3),reply(4)]);expect(face()['data-signal']).toBe(true);
 await show([reply(3),reply(4)],{connected:false});await signal();expect(face()['data-face']).toBe('error');
});
it('asks and failures cancel a run and motion reduction skips it',async()=>{
 await show([]);await show([reply(1)]);await signal();expect(face()['data-face']).toBe('talking');
 const ask={...reply(2),kind:'ask',ask:{ask:'Allow?'},ref:'a'};
 await show([reply(1),ask]);expect(face()['data-face']).toBe('needs-input');expect(player().talk).toBeUndefined();
 await show([reply(1),{...ask,answer:{verdict:'yes'}}]);expect(face()['data-face']).toBe('idle');
 fixture.motion=true;await show([reply(3)]);expect(face()['data-signal']).toBeFalsy();
 await show([{...reply(4),kind:'error'}]);expect(face()['data-face']).toBe('error');
});
it('uses a whole 1x scale in compact glass and 2x when resized wide',async()=>{
 await show([]);expect(player().scale).toBe(2);expect(player().size).toBe(192);
 width=96;await act(async()=>resize());expect(player().scale).toBe(1);expect(player().size).toBe(96);
 width=192;await act(async()=>resize());expect(player().scale).toBe(2);
});
it('uses drawn completion for an unavailable sprite sheet',async()=>{
 fixture.displays=[{agent:'art',sprite:{}}];await show([reply(1)],{},true);
 await act(async()=>player().onReady(false));await show([reply(2)],{},true);await signal();
 expect(face()['data-face']).toBe('talking');await act(async()=>vi.advanceTimersByTime(1530));expect(face()['data-face']).toBe('complete');
});

it('stops an existing run immediately when reduced motion is enabled',async()=>{
 await show([]);await show([reply(1)]);await signal();expect(face()['data-face']).toBe('talking');
 fixture.motion=true;await act(async()=>fixture.change());expect(face()['data-face']).toBe('idle');
 await act(async()=>vi.advanceTimersByTime(10000));expect(face()['data-face']).toBe('idle');
});

it('sums replies during the signal and extends active sprite runs without interrupting their phase',async()=>{
 fixture.displays=[{agent:'art',sprite:{}}];await show([],{},true);await act(async()=>player().onReady(true));
 await show([reply(1)],{},true);await show([reply(1),reply(2,'x'.repeat(151))],{},true);await signal();
 expect(player().talk).toEqual({n:3,key:2});await act(async()=>player().onShown('talking'));
 await show([reply(1),reply(2,'x'.repeat(151)),reply(3)],{},true);expect(face()['data-face']).toBe('talking');
 await signal();expect(player().talk).toEqual({n:1,key:3});expect(face()['data-face']).toBe('talking');
 await show([reply(1,null),reply(2),reply(3)],{},true);expect(player().talk).toBeUndefined();expect(face()['data-face']).toBe('idle');
});
