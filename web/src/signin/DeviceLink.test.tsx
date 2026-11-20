import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { Result } from '../data';
const f=vi.hoisted(()=>({once:vi.fn()}));
vi.mock('../data',()=>({callOnce:f.once}));
vi.mock('../kit',()=>({Button:(p:object)=>h('button',p)}));
import DeviceLink from './DeviceLink';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('location',{origin:'https://loom.example'});});
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
function pending(){let done!:(r:Result<{path:string}>)=>void;f.once.mockReturnValue({result:new Promise(r=>{done=r;})});return (r:Result<{path:string}>)=>act(async()=>done(r));}
const success={ok:true as const,value:{path:'/login/private-test-link'}};
it('uses a single-send call and hides credentials on disable, target change and navigation, including late replies',async()=>{
  const finish=pending();await act(async()=>{tree=create(h(DeviceLink,{enabled:true}));});
  await act(async()=>{tree.root.findByType('button').props.onClick();tree.root.findByType('button').props.onClick();});expect(f.once).toHaveBeenCalledExactlyOnceWith('signin.browserLink',{});
  await finish(success);expect(JSON.stringify(tree.toJSON())).toContain('https://loom.example/login/private-test-link');
  await act(async()=>tree.update(h(DeviceLink,{enabled:false})));expect(JSON.stringify(tree.toJSON())).not.toContain('private-test-link');
  await act(async()=>tree.update(h(DeviceLink,{enabled:true})));expect(JSON.stringify(tree.toJSON())).not.toContain('private-test-link');
  const late=pending();await act(async()=>tree.root.findByType('button').props.onClick());await act(async()=>tree.update(h(DeviceLink,{enabled:false})));await late(success);await act(async()=>tree.update(h(DeviceLink,{enabled:true})));expect(JSON.stringify(tree.toJSON())).not.toContain('private-test-link');
  const next=pending();await act(async()=>tree.update(h(DeviceLink,{enabled:true,member:'pollock'})));await act(async()=>tree.root.findByType('button').props.onClick());expect(f.once).toHaveBeenLastCalledWith('signin.browserLink',{member:'pollock'});await next(success);
  await act(async()=>tree.update(h(DeviceLink,{enabled:true,member:'jonathan'})));expect(JSON.stringify(tree.toJSON())).not.toContain('private-test-link');
  const unmounted=pending();await act(async()=>tree.root.findByType('button').props.onClick());await act(async()=>tree.unmount());await unmounted(success);await act(async()=>{tree=create(h(DeviceLink,{enabled:true}));});expect(JSON.stringify(tree.toJSON())).not.toContain('private-test-link');
});
it('offers no replay after a lost reply, and Hide clears the displayed link',async()=>{
  const finish=pending();await act(async()=>{tree=create(h(DeviceLink,{enabled:true}));});await act(async()=>tree.root.findByType('button').props.onClick());await finish({ok:false,code:'unavailable',message:'Uncertain'});expect(JSON.stringify(tree.toJSON())).toContain('not retried');expect(f.once).toHaveBeenCalledOnce();
  const next=pending();await act(async()=>tree.root.findByType('button').props.onClick());await next(success);await act(async()=>tree.root.findAllByType('button')[1].props.onClick());expect(JSON.stringify(tree.toJSON())).not.toContain('private-test-link');
});
