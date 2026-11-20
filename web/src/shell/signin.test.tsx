import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import Signin from './signin';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
function environment(){
  const append=vi.fn(),fetch=vi.fn();
  vi.stubGlobal('document',{createElement:()=>({}),head:{append}});
  vi.stubGlobal('fetch',fetch);
  return {append,fetch};
}
it('gates the desk until the session arrives, then leaves account actions to Your account',async()=>{
  const {append,fetch}=environment();let finish!:(value:unknown)=>void;
  fetch.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  await act(async()=>{tree=create(h(Signin,null,h('section',{'aria-label':'Desk'},'Desk content')));});
  expect(tree.root.findAllByType('section')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('Connecting to loom');
  await act(async()=>finish({json:async()=>({viewer:{id:'jonathan'},csrf:'fixture-csrf'})}));
  expect(tree.root.findByType('section').props['aria-label']).toBe('Desk');
  expect(tree.root.findAllByType('button')).toHaveLength(0);
  expect(append).toHaveBeenCalledWith({name:'loom-csrf',content:'fixture-csrf'});
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/auth/session');
});
it('keeps signed-out visitors at the passkey sign-in gate',async()=>{
  const {fetch}=environment();fetch.mockResolvedValue({json:async()=>({viewer:null})});
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
  fetch.mockResolvedValueOnce({json:async()=>({viewer:null})})
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
  fetch.mockResolvedValueOnce({json:async()=>({viewer:null})})
    .mockResolvedValueOnce({ok:true,json:async()=>({challenge:'AQID',rpId:'loom.test',timeout:60000})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  await act(async()=>{await tree.root.findByType('button').props.onClick();});
  expect(fetch).toHaveBeenCalledTimes(2);expect(reload).not.toHaveBeenCalled();
  expect(tree.root.findAllByType('section')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('Device cancelled');
});
