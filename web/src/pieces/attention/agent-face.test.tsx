import { expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../face',()=>({default:(p:object)=>h('drawn-face',p)}));
vi.mock('../../pixel-face',()=>({default:(p:object)=>h('pixel-face',p)}));
import AgentFace from './agent-face';
import { PixelContext } from '../../look';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('uses supplied sprite metadata, follows Pixel faces, and drops unavailable display data',async()=>{
 const display={id:'art',agent:'art',mark:{bg:'#B8A6FF',fg:'#fff'},face:{shape:'pebble' as const,eyes:'dot' as const},sprite:{facings:['south'],v:'saved',base:'/faces/art/'}};
 let tree:ReturnType<typeof create>;
 const draw=(pixel:boolean,shown=display)=>h(PixelContext.Provider,{value:pixel},h(AgentFace,{display:shown,name:'Art',state:'working',size:96}));
 await act(async()=>{tree=create(draw(true));});
 expect(tree!.root.findByType('pixel-face').props.sprite).toEqual(display.sprite);
 expect(tree!.root.findByType('pixel-face').props.state).toBe('working');
 await act(async()=>{tree!.update(draw(false));});expect(tree!.root.findAllByType('pixel-face')).toHaveLength(0);expect(tree!.root.findByType('drawn-face').props.state).toBe('working');
 await act(async()=>{tree!.update(h(AgentFace,{name:'Art',state:'idle',size:40}));});
 expect(tree!.root.findAllByType('pixel-face')).toHaveLength(0);expect(tree!.root.findAllByType('drawn-face')).toHaveLength(0);
 await act(async()=>{tree!.unmount();});
});

it('forwards the comm screen player contract without changing drawn faces',async()=>{
 const onShown=vi.fn(),onFrom=vi.fn(),onReady=vi.fn(),talk={n:3,key:7};
 const display={id:'art',agent:'art',mark:{bg:'#B8A6FF',fg:'#fff'},face:{shape:'pebble' as const,eyes:'dot' as const},sprite:{facings:['south'],v:'saved',base:'/faces/art/'}};
 let tree!:ReturnType<typeof create>;
 await act(async()=>{tree=create(h(PixelContext.Provider,{value:true},h(AgentFace,{display,name:'Art',state:'working',size:96,scale:1,talk,onShown,onFrom,onReady})));});
 const p=tree.root.findByType('pixel-face').props;
 expect(p.scale).toBe(1);expect(p.talk).toEqual(talk);
 p.onShown('complete');p.onFrom('done');p.onReady(true);
 expect(onShown).toHaveBeenCalledWith('complete');expect(onFrom).toHaveBeenCalledWith('done');expect(onReady).toHaveBeenCalledWith(true);
 await act(async()=>tree.unmount());
});
