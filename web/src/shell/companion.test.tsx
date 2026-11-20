import { expect, it } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { useCompanion } from './companion';
import type { RailLink } from '../desk-rail';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('retains selection while hidden and refuses late cleanup from a previous pane',async()=>{
 let link!:RailLink;
 function Probe({shown}:{shown:boolean}){link=useCompanion(shown);return null;}
 let tree!:ReturnType<typeof create>;
 await act(async()=>{tree=create(h(Probe,{shown:true}));});
 try {
  const first={},second={};
  await act(async()=>link.onAir({agent:'art'},first));expect(link.selected).toBe('art');
  await act(async()=>link.onAir({agent:'mark'},second));
  await act(async()=>link.onAir(null,first));expect(link.selected).toBe('mark');
  await act(async()=>tree.update(h(Probe,{shown:false})));expect(link.shown).toBe(false);expect(link.selected).toBe('mark');
  await act(async()=>link.onAir(null,second));expect(link.selected).toBeUndefined();
 } finally {await act(async()=>tree.unmount());}
});
it('publishes only the selected shown destination and fences late slot cleanup',async()=>{
 let link!:RailLink;
 function Probe({shown}:{shown:boolean}){link=useCompanion(shown);return null;}
 let tree!:ReturnType<typeof create>;
 await act(async()=>{tree=create(h(Probe,{shown:true}));});
 try {
  const first={},second={},pane={},el={} as HTMLElement,other={} as HTMLElement;
  await act(async()=>link.onAir({agent:'art'},pane));
  await act(async()=>link.setScreen!({agent:'art',el},first));expect(link.screen?.el).toBe(el);
  await act(async()=>link.setScreen!({agent:'mark',el:other},second));expect(link.screen).toBeNull();
  await act(async()=>link.onAir({agent:'mark'},pane));expect(link.screen?.el).toBe(other);
  await act(async()=>link.setScreen!(null,first));expect(link.screen?.el).toBe(other);
  await act(async()=>tree.update(h(Probe,{shown:false})));expect(link.screen).toBeNull();
  await act(async()=>tree.update(h(Probe,{shown:true})));expect(link.screen?.el).toBe(other);
  await act(async()=>link.onAir(null,pane));expect(link.screen).toBeNull();
 } finally {await act(async()=>tree.unmount());}
});
