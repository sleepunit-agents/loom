import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import Signin from './signin';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
function environment(){
  const append=vi.fn(),fetch=vi.fn(),windowTarget=new EventTarget();vi.stubGlobal('window',windowTarget);vi.stubGlobal('location',{reload:vi.fn()});
  const documentTarget=Object.assign(new EventTarget(),{visibilityState:'visible',createElement:()=>({}),querySelector:()=>null,head:{append}});vi.stubGlobal('document',documentTarget);
  vi.stubGlobal('fetch',fetch);
  return {append,fetch,windowTarget,documentTarget};
}
it('gates the desk until the session arrives, then leaves account actions to Your account',async()=>{
  const {append,fetch}=environment();let finish!:(value:unknown)=>void;
  fetch.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  await act(async()=>{tree=create(h(Signin,null,h('section',{'aria-label':'Desk'},'Desk content')));});
  expect(tree.root.findAllByType('section')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('Connecting to loom');
  await act(async()=>finish({ok:true,json:async()=>({viewer:{id:'jonathan'},csrf:'fixture-csrf'})}));
  expect(tree.root.findByType('section').props['aria-label']).toBe('Desk');
  expect(tree.root.findAllByType('button')).toHaveLength(0);
  expect(append).toHaveBeenCalledWith({name:'loom-csrf',content:'fixture-csrf'});
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/auth/session',{credentials:'same-origin',cache:'no-store',redirect:'error'});
});
it('keeps signed-out visitors at the passkey sign-in gate',async()=>{
  const {fetch}=environment();fetch.mockResolvedValue({ok:true,json:async()=>({viewer:null})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  expect(tree.root.findAllByType('section')).toHaveLength(0);
  expect(tree.root.findByType('button').props.children).toBe('Sign in with a passkey');
});
it('never mounts the desk when the session cannot be read',async()=>{
  const {fetch}=environment();fetch.mockRejectedValue(Error('offline'));
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  expect(tree.root.findAllByType('section')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('Could not reach loom');
});
it('sends the passkey assertion and reloads only after successful sign-in',async()=>{
  const {fetch}=environment(),reload=vi.fn();
  const bytes=Uint8Array.of(1,2,3).buffer;
  const get=vi.fn().mockResolvedValue({rawId:bytes,response:{clientDataJSON:bytes,authenticatorData:bytes,signature:bytes}});
  vi.stubGlobal('navigator',{credentials:{get}});vi.stubGlobal('location',{reload});
  fetch.mockResolvedValueOnce({ok:true,json:async()=>({viewer:null})})
    .mockResolvedValueOnce({ok:true,json:async()=>({challenge:'AQID',rpId:'loom.test',timeout:60000})})
    .mockResolvedValueOnce({ok:true,json:async()=>({ok:true})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  await act(async()=>{await tree.root.findByType('button').props.onClick();});
  expect(fetch).toHaveBeenNthCalledWith(2,'/login/passkey/options',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  expect(get).toHaveBeenCalledExactlyOnceWith({publicKey:{challenge:new Uint8Array(bytes),rpId:'loom.test',userVerification:'required',timeout:60000}});
  expect(fetch).toHaveBeenNthCalledWith(3,'/login/passkey',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'AQID',clientDataJSON:'AQID',authenticatorData:'AQID',signature:'AQID'})});
  expect(reload).toHaveBeenCalledOnce();
  expect(tree.root.findAllByType('section')).toHaveLength(0);
});
it('keeps the gate and reports a cancelled passkey attempt without submitting or reloading',async()=>{
  const {fetch}=environment(),reload=vi.fn();
  vi.stubGlobal('navigator',{credentials:{get:vi.fn().mockRejectedValue(Error('Device cancelled'))}});vi.stubGlobal('location',{reload});
  fetch.mockResolvedValueOnce({ok:true,json:async()=>({viewer:null})})
    .mockResolvedValueOnce({ok:true,json:async()=>({challenge:'AQID',rpId:'loom.test',timeout:60000})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  await act(async()=>{await tree.root.findByType('button').props.onClick();});
  expect(fetch).toHaveBeenCalledTimes(2);expect(reload).not.toHaveBeenCalled();
  expect(tree.root.findAllByType('section')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('Device cancelled');
});

it('rechecks the current browser when its tab regains focus and hides an ended identity',async()=>{
 const {fetch,windowTarget}=environment();fetch.mockResolvedValueOnce({ok:true,json:async()=>({viewer:{id:'sam'}})}).mockResolvedValueOnce({ok:true,json:async()=>({viewer:null})});await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});expect(tree.root.findAllByType('section')).toHaveLength(1);await act(async()=>{windowTarget.dispatchEvent(new Event('focus'));});expect(tree.root.findAllByType('section')).toHaveLength(0);expect(JSON.stringify(tree.toJSON())).toContain('Sign in to loom');
});
it('unmounts the previous member before restarting its shared client for a changed cookie identity',async()=>{
 const {fetch,windowTarget}=environment();fetch.mockResolvedValueOnce({ok:true,json:async()=>({viewer:{id:'sam'}})}).mockResolvedValueOnce({ok:true,json:async()=>({viewer:{id:'other'}})});await act(async()=>{tree=create(h(Signin,null,h('section',null,'Sam private desk')));});await act(async()=>{windowTarget.dispatchEvent(new Event('focus'));});expect(location.reload).toHaveBeenCalledOnce();expect(tree.root.findAllByType('section')).toHaveLength(0);
});

it('keeps the same member desk mounted across a normal focus check',async()=>{
 const {fetch,windowTarget}=environment();fetch.mockResolvedValue({ok:true,json:async()=>({viewer:{id:'sam'}})});await act(async()=>{tree=create(h(Signin,null,h('section',null,'Sam desk')));});await act(async()=>{windowTarget.dispatchEvent(new Event('focus'));});expect(location.reload).not.toHaveBeenCalled();expect(tree.root.findAllByType('section')).toHaveLength(1);
});
it('does not infer sign-out from an offline refresh',async()=>{
 const {fetch,windowTarget}=environment();fetch.mockResolvedValueOnce({ok:true,json:async()=>({viewer:{id:'sam'}})}).mockRejectedValueOnce(Error('offline'));await act(async()=>{tree=create(h(Signin,null,h('section',null,'Sam desk')));});await act(async()=>{windowTarget.dispatchEvent(new Event('focus'));});expect(location.reload).not.toHaveBeenCalled();expect(tree.root.findAllByType('section')).toHaveLength(1);
});
it('ignores an older session reply after a newer focus check has confirmed signed out',async()=>{
 const {fetch,windowTarget}=environment();let finish!:(value:unknown)=>void;fetch.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({ok:true,json:async()=>({viewer:null})});await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});await act(async()=>{windowTarget.dispatchEvent(new Event('focus'));});await act(async()=>finish({ok:true,json:async()=>({viewer:{id:'sam'}})}));expect(tree.root.findAllByType('section')).toHaveLength(0);expect(JSON.stringify(tree.toJSON())).toContain('Sign in to loom');
});
it('checks only visible transitions and removes refresh listeners on unmount',async()=>{
 const {fetch,documentTarget,windowTarget}=environment();fetch.mockResolvedValue({ok:true,json:async()=>({viewer:null})});await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});documentTarget.visibilityState='hidden';await act(async()=>{documentTarget.dispatchEvent(new Event('visibilitychange'));});expect(fetch).toHaveBeenCalledTimes(1);documentTarget.visibilityState='visible';await act(async()=>{documentTarget.dispatchEvent(new Event('visibilitychange'));});expect(fetch).toHaveBeenCalledTimes(2);await act(async()=>tree.unmount());await act(async()=>{windowTarget.dispatchEvent(new Event('focus'));documentTarget.dispatchEvent(new Event('visibilitychange'));});expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([{ok:false,json:async()=>({viewer:{id:'sam'}})},{ok:true,json:async()=>({})},{ok:true,json:async()=>({viewer:{id:4}})}])('refuses an unconfirmed initial identity',async response=>{
 const {fetch}=environment();fetch.mockResolvedValue(response);await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});expect(tree.root.findAllByType('section')).toHaveLength(0);expect(JSON.stringify(tree.toJSON())).toContain('Could not reach loom');
});
