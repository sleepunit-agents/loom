import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../attention/agent-face',async original=>({...await original<object>(),useAgentDisplays:()=>[{agent:'art',mark:{bg:'#123',fg:'#fff'},face:{shape:'pebble',eyes:'dot'},sprite:{base:'/portrait-player/',v:'1',facings:['south']}}]}));
vi.mock('../../access',()=>({reducedMotion:()=>false,motionQuery:()=>({addEventListener(){},removeEventListener(){}})}));
import { CommPortrait } from './portrait';
import { PixelContext } from '../../look';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('a real sprite completes exactly its requested beats and latest reader callbacks restore working',async()=>{
 vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(.5);
 vi.stubGlobal('window',{setTimeout,clearTimeout});
 vi.stubGlobal('document',{visibilityState:'visible',addEventListener(){},removeEventListener(){}});
 vi.stubGlobal('requestAnimationFrame',(f:()=>void)=>setTimeout(f,16));vi.stubGlobal('cancelAnimationFrame',clearTimeout);
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 vi.stubGlobal('IntersectionObserver',class{constructor(private cb:(entries:{isIntersecting:boolean}[])=>void){}observe(){this.cb([{isIntersecting:true}]);}disconnect(){}});
 vi.stubGlobal('Image',class{width=96;async decode(){}});
 const variant={row:0,frames:2,weight:1};
 vi.stubGlobal('fetch',async()=>({json:async()=>({cell:[96,84],states:{idle:{south:[variant]},working:{south:[variant]},talking:{south:[variant]},done:{south:[variant]}}})}));
 const context={clearRect(){},save(){},restore(){},drawImage(){},translate(){},scale(){}};
 const render=(fresh=false,retained=true,seq=1)=>h(PixelContext.Provider,{value:true},h(CommPortrait,{agent:'art',messages:fresh?[{id:`r${seq}`,thread:'th:a',seq,at:1,kind:'reply',from:'art',text:retained?'x'.repeat(151):null}]:[],connected:true,working:true,thinking:false}));
 let tree!:ReturnType<typeof create>;
 try{
  await act(async()=>{tree=create(render(),{createNodeMock:()=>({clientWidth:192,dataset:{},getContext:()=>context})});});
  // Settle the real lazy player inside act before advancing its animation clock.
  await act(async()=>{await import('../../pixel-face');});
  const face=()=>tree.root.findByType('section').props['data-face'];
  await act(async()=>tree.update(render(true)));await act(async()=>vi.advanceTimersByTime(32));await act(async()=>vi.advanceTimersByTime(250));
  expect(face()).toBe('talking');
  await act(async()=>vi.advanceTimersByTime(180+800+179));expect(face()).toBe('talking');
  await act(async()=>vi.advanceTimersByTime(1));expect(face()).toBe('complete');
  await act(async()=>vi.advanceTimersByTime(180));expect(face()).toBe('working');
  // Source loss during the next run fences the actual player's subsequent callbacks too.
  await act(async()=>tree.update(render(true,true,2)));await act(async()=>vi.advanceTimersByTime(32));await act(async()=>vi.advanceTimersByTime(250));
  expect(face()).toBe('talking');
  await act(async()=>tree.update(render(true,false,2)));expect(face()).toBe('working');
  await act(async()=>vi.advanceTimersByTime(2000));expect(face()).toBe('working');
 }finally{if(tree)await act(async()=>tree.unmount());}
});
