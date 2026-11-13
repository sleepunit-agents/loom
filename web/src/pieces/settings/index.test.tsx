import { afterEach,expect,it,vi } from 'vitest';
import { createElement as h,useSyncExternalStore } from 'react';
// @ts-expect-error Renderer is an existing dependency without declarations.
import { act,create } from 'react-test-renderer';
import type { Call,CallState,Result,Snapshot } from '../../data';
// Renderer trees and mock DOM props include arbitrary callbacks/attributes; any
// below is confined to that dynamic renderer boundary (no declaration package).
const f=vi.hoisted(()=>({feeds:{} as Record<string,Snapshot>,listeners:new Set<()=>void>(),call:vi.fn()}));
vi.mock('../../data',()=>({useRecords:(type:string)=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.feeds[type]),call:f.call}));
vi.mock('../../kit',()=>({
 Split:(p:any)=>h('div',{},...p.folders.map((x:any)=>h('button',{key:x.id,onClick:()=>p.onFolder(x.id)},x.label)),p.listTop,p.search,p.list,p.reader),
 List:(p:any)=>h('div',{},p.children),Row:(p:any)=>h('button',{onClick:p.onClick},p.title,p.meta,p.status),
 Empty:(p:any)=>h('p',{},p.title,p.text),Error:(p:any)=>h('p',{role:'alert'},p.text),Loading:(p:any)=>h('p',{},p.label),
 Button:(p:any)=>h('button',p,p.children),Input:(p:any)=>h('input',p),Textarea:(p:any)=>h('textarea',p),
}));
import SettingsApp,{ValueForm,RequestActions} from './index';
import { settingsWrites } from './writes';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:any;
function pending<T>() {
 let state:CallState<T>={pending:true,status:'pending'},resolve!:(r:Result<T>)=>void;const listeners=new Set<()=>void>();
 const request:Call<T>={id:'stable-call',result:new Promise(r=>resolve=r),retry:vi.fn(),getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};}};
 return {request,finish:async(result:Result<T>)=>act(async()=>{state={pending:false,status:'done',result};resolve(result);listeners.forEach(fn=>fn());})};
}
async function draw(element:any){await act(async()=>{tree=create(element);});}
function text(){return JSON.stringify(tree.toJSON());}
function button(label:string){return tree.root.findAllByType('button').find((b:any)=>b.children.join('')===label);}
afterEach(async()=>{await act(async()=>{tree?.unmount();settingsWrites.dispose();});f.call.mockReset();vi.unstubAllGlobals();});
it.each([false,true])('clears credential input before dispatch and retains its uncertain call across remounts (replace=%s)',async replace=>{
 const write=pending();let cleared=false;
 vi.stubGlobal('window',{addEventListener(){},removeEventListener(){}});
 vi.stubGlobal('FormData',class{get(key:string){return key==='value'?'SECRET-SENTINEL':'API';}});
 f.call.mockImplementation(()=>{expect(cleared).toBe(true);return write.request;});
 await draw(h(ValueForm,{enabled:true,replace,name:replace?'API':undefined}));
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{reset(){cleared=true;}}}));
 expect(f.call).toHaveBeenCalledWith('secrets.set',expect.objectContaining({name:'API',value:'SECRET-SENTINEL',mode:replace?'replace':'add'}));
 expect(text()).not.toContain('SECRET-SENTINEL');
 await write.finish({ok:false,code:'unavailable',message:'Uncertain'});
 await act(async()=>tree.unmount());await draw(h(ValueForm,{enabled:true,name:'OTHER',replace:true}));
 expect(tree.root.findByType('fieldset').props.disabled).toBe(true);
 await act(async()=>button('Retry this save').props.onClick());expect(write.request.retry).toHaveBeenCalledOnce();
 expect(f.call).toHaveBeenCalledTimes(1);
});
it('requires opening and immediate daemon confirmation and sends nothing if the request changes',async()=>{
 const r={id:'q-1',agent:'art',kind:'secret' as const,target:'API',state:'pending',why:'Work'};
 const open=pending<{requests:typeof r[]}>(),fresh=pending<{requests:typeof r[]}>();
 f.call.mockReturnValue(fresh.request);
 await draw(h(RequestActions,{request:r,enabled:true,onCheck(){}}));expect(button('Allow once')).toBeUndefined();
 await act(async()=>tree.update(h(RequestActions,{request:r,enabled:true,confirmation:{record:r,request:open.request},onCheck(){}})));
 expect(button('Allow once')).toBeUndefined();await open.finish({ok:true,value:{requests:[r]}});
 await act(async()=>button('Allow once').props.onClick());expect(f.call).toHaveBeenCalledWith('secrets.list',{});
 await fresh.finish({ok:true,value:{requests:[{...r,state:'allowed'}]}});expect(f.call).toHaveBeenCalledTimes(1);
 expect(text()).toContain('Nothing was recorded');
});
it.each(['navigation','offline'] as const)('does not answer after %s during the fresh check',async mode=>{
 const r={id:'q-1',agent:'art',kind:'secret' as const,target:'API',state:'pending',why:'Work'};
 const open=pending<{requests:typeof r[]}>(),fresh=pending<{requests:typeof r[]}>();f.call.mockReturnValue(fresh.request);
 await open.finish({ok:true,value:{requests:[r]}});
 await draw(h(RequestActions,{request:r,enabled:true,confirmation:{record:r,request:open.request},onCheck(){}}));
 await act(async()=>button('Allow once').props.onClick());
 await act(async()=>{if(mode==='navigation')tree.unmount();else tree.update(h(RequestActions,{request:r,enabled:false,confirmation:{record:r,request:open.request},onCheck(){}}));});await fresh.finish({ok:true,value:{requests:[r]}});expect(f.call).toHaveBeenCalledTimes(1);
});
function feeds(valuesAvailable=true){
 f.feeds=Object.fromEntries(['secret.settings','secret.name','secret.grant','secret.request','secret.policy','secret.use','secret.change'].map(type=>[type,{status:'live',records:[]}]));
 f.feeds['secret.settings'].records=[{id:'settings',agents:['art'],valuesAvailable,now:1000}];
 f.feeds['secret.name'].records=[{id:'API',description:'',by:'jonathan',changedAt:1}];
 f.feeds['secret.policy'].records=[{id:'policy',default:'ask',secrets:{}}];
}
it('disables add, replace and removal without mutation operations, removes editors on feed loss and routes piece configuration',async()=>{
 feeds(false);await draw(h(SettingsApp,{path:'/p/settings-preview/add'}));expect(tree.root.findByType('fieldset').props.disabled).toBe(true);
 await act(async()=>tree.update(h(SettingsApp,{path:'/p/settings-preview/secrets/API'})));
 expect(tree.root.findAllByType('fieldset').every((n:any)=>n.props.disabled)).toBe(true);expect(button('Remove API').props.disabled).toBe(true);
 await act(async()=>{f.feeds['secret.name']={status:'offline',records:[]};f.listeners.forEach(fn=>fn());});expect(tree.root.findAllByType('input')).toHaveLength(0);expect(tree.root.findAllByType('form')).toHaveLength(0);
 const go=vi.fn();feeds();await act(async()=>{tree.update(h(SettingsApp,{path:'/p/settings-preview/pieces',go}));f.listeners.forEach(fn=>fn());});
 await act(async()=>button('SharingProject membership').props.onClick());expect(go).toHaveBeenCalledWith('/p/sharing-preview');
});
it('removal requires confirmation and shares the same lock as value entry',async()=>{
 feeds();const write=pending();f.call.mockReturnValue(write.request);
 await draw(h(SettingsApp,{path:'/p/settings-preview/secrets/API'}));
 await act(async()=>button('Remove API').props.onClick());expect(f.call).not.toHaveBeenCalled();
 await act(async()=>button('Confirm removal').props.onClick());expect(f.call).toHaveBeenCalledWith('secrets.remove',expect.objectContaining({name:'API'}));
 expect(tree.root.findByType('fieldset').props.disabled).toBe(true);
 await write.finish({ok:false,code:'unavailable',message:'Uncertain'});
 await act(async()=>tree.update(h(SettingsApp,{path:'/p/settings-preview/add'})));
 expect(tree.root.findByType('fieldset').props.disabled).toBe(true);expect(f.call).toHaveBeenCalledTimes(1);
});

it.each([['Allow once',true,undefined],['Always allow',true,true],['Deny',false,undefined]] as const)('dispatches %s only after the fresh pending check',async(label,allow,always)=>{
 const r={id:'q-1',agent:'art',kind:'secret' as const,target:'API',state:'pending',why:'Work'};
 const open=pending<{requests:typeof r[]}>(),fresh=pending<{requests:typeof r[]}>(),write=pending();
 await open.finish({ok:true,value:{requests:[r]}});f.call.mockReturnValueOnce(fresh.request).mockReturnValueOnce(write.request);
 await draw(h(RequestActions,{request:r,enabled:true,confirmation:{record:r,request:open.request},onCheck(){}}));
 await act(async()=>button(label).props.onClick());await fresh.finish({ok:true,value:{requests:[r]}});
 expect(f.call).toHaveBeenLastCalledWith('secrets.answer',{id:'q-1',allow,...(always?{always}:{})});
});
it('does not reuse a completed confirmation after leaving a request and navigating Back',async()=>{
 feeds();const r={id:'q-1',agent:'art',kind:'secret' as const,target:'API',state:'pending',why:'Work'};
 f.feeds['secret.request'].records=[r];const open=pending<{requests:typeof r[]}>();f.call.mockReturnValue(open.request);
 const go=vi.fn();await draw(h(SettingsApp,{path:'/p/settings-preview/requests',go}));
 await act(async()=>button('art: APIWorkpending').props.onClick());
 await act(async()=>tree.update(h(SettingsApp,{path:'/p/settings-preview/requests/q-1',go})));
 await open.finish({ok:true,value:{requests:[r]}});expect(button('Allow once')).toBeDefined();
 await act(async()=>tree.update(h(SettingsApp,{path:'/p/settings-preview/secrets',go})));
 await act(async()=>tree.update(h(SettingsApp,{path:'/p/settings-preview/requests/q-1',go})));
 expect(button('Allow once')).toBeUndefined();expect(button('Check request')).toBeDefined();expect(f.call).toHaveBeenCalledTimes(1);
});
it('shows startup membership, delivery uncertainty and change history without treating unknown delivery as success',async()=>{
 feeds();f.feeds['secret.policy'].records=[{id:'policy',default:'ask',secrets:{API:{houses:['art']}}}];
 f.feeds['secret.use'].records=[{id:'u1',name:'API',at:1,state:'released',by:{kind:'agent',id:'art'}},{id:'u2',name:'API',at:2,state:'started',by:{kind:'agent',id:'mark'}}];
 f.feeds['secret.change'].records=[{id:'c',name:'API',at:1,action:'replace',by:'jonathan'}];
 await draw(h(SettingsApp,{path:'/p/settings-preview/secrets/API'}));
 expect(text()).toContain('At startup: ');expect(text()).toContain('art');expect(text()).toContain('Delivered');expect(text()).toContain('Delivery unconfirmed');expect(text()).toContain('replace');expect(text()).toContain('jonathan');
});
