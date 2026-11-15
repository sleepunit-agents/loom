import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import {act,create} from 'react-test-renderer';
vi.mock('../kit',()=>({Button:(props:object)=>h('button',props)}));
import DeviceLink from './DeviceLink';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;const path='/login/'+'a'.repeat(64);
beforeEach(()=>{vi.stubGlobal('location',{origin:'https://loom.example'});});afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
function pending(){let finish!:(value:Response)=>void;const fetch=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetch);return{fetch,finish:()=>act(async()=>finish(Response.json({ok:true,value:{path}})))};}
it('calls the canonical member ceremony once, without caller-selected identity, and clears across scope changes',async()=>{
 const request=pending();await act(async()=>{tree=create(h(DeviceLink,{enabled:true,member:'sam'}));});await act(async()=>{tree.root.findByType('button').props.onClick();tree.root.findByType('button').props.onClick();});expect(request.fetch).toHaveBeenCalledOnce();expect(request.fetch.mock.calls[0]).toMatchObject(['/api/signin/link',{method:'POST',credentials:'same-origin',redirect:'error',body:'{}'}]);
 await request.finish();expect(JSON.stringify(tree.toJSON())).toContain(path);await act(async()=>tree.update(h(DeviceLink,{enabled:false,member:'sam'})));await act(async()=>tree.update(h(DeviceLink,{enabled:true,member:'sam'})));expect(JSON.stringify(tree.toJSON())).not.toContain(path);
 const next=pending();await act(async()=>tree.root.findByType('button').props.onClick());await next.finish();await act(async()=>tree.update(h(DeviceLink,{enabled:true,member:'other'})));await act(async()=>tree.update(h(DeviceLink,{enabled:true,member:'sam'})));expect(JSON.stringify(tree.toJSON())).not.toContain(path);
});
it('discards late replies on disable, member change or unmount',async()=>{
 for(const change of ['disabled','member','unmounted']){const request=pending();await act(async()=>{tree=create(h(DeviceLink,{enabled:true,member:'sam'}));});await act(async()=>tree.root.findByType('button').props.onClick());await act(async()=>{if(change==='unmounted')tree.unmount();else tree.update(h(DeviceLink,{enabled:change!=='disabled',member:change==='member'?'other':'sam'}));});await request.finish();await act(async()=>{if(change==='unmounted')tree=create(h(DeviceLink,{enabled:true,member:'sam'}));else tree.update(h(DeviceLink,{enabled:true,member:'sam'}));});expect(JSON.stringify(tree.toJSON())).not.toContain(path);await act(async()=>tree.unmount());}
});
it('never retries a lost reply and Hide clears a delivered link',async()=>{
 const fetch=vi.fn().mockRejectedValueOnce(Error('PRIVATE TRANSPORT')).mockResolvedValueOnce(Response.json({ok:true,value:{path}}));vi.stubGlobal('fetch',fetch);await act(async()=>{tree=create(h(DeviceLink,{enabled:true,member:'sam'}));});await act(async()=>tree.root.findByType('button').props.onClick());expect(fetch).toHaveBeenCalledOnce();expect(JSON.stringify(tree.toJSON())).toContain('not retried');expect(JSON.stringify(tree.toJSON())).not.toContain('PRIVATE TRANSPORT');await act(async()=>tree.root.findByType('button').props.onClick());expect(JSON.stringify(tree.toJSON())).toContain(path);await act(async()=>tree.root.findAllByType('button')[1].props.onClick());expect(JSON.stringify(tree.toJSON())).not.toContain(path);
});
