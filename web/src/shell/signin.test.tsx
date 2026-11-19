import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import Signin, { greetingAt } from './signin';
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
const words=(node:unknown):string=>typeof node==='string'?node:Array.isArray(node)?node.map(words).join(''):node&&typeof node==='object'?words((node as {children?:unknown;props?:{children?:unknown}}).children??(node as {props?:{children?:unknown}}).props?.children??''):'';
const gate=()=>tree.root.findByType('main');
it('is one page in its three states: the same wordmark and ground, one status line, and only what is under it changes',async()=>{
  const {fetch}=environment();let finish!:(value:unknown)=>void;
  fetch.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  const mark=()=>words(tree.root.findByType('h1').props.children),status=()=>tree.root.findByProps({role:'status'});
  expect([gate().props['data-state'],mark(),status().props['data-tone'],words(status().props.children)]).toEqual(['connecting','LOOM//OS','calm','Connecting to loom…']);
  expect(tree.root.findAllByType('button')).toHaveLength(0);
  const first=status(),ground=tree.root.findByType('svg');
  await act(async()=>finish({json:async()=>({viewer:null})}));
  expect([gate().props['data-state'],mark(),words(status().props.children)]).toEqual(['out','LOOM//OS','']);
  expect(status()).toBe(first);expect(tree.root.findByType('svg')).toBe(ground);
  expect(tree.root.findByType('button').props.autoFocus).toBe(true);
  expect(words(tree.toJSON())).toContain('Have a one-time sign-in link? Open it and press Sign in.');
  expect(words(tree.toJSON())).not.toContain('Connecting');
});
it('says only that loom could not be reached when it cannot, as an error, and offers a reload',async()=>{
  const {fetch}=environment(),reload=vi.fn();vi.stubGlobal('location',{reload});fetch.mockRejectedValue(Error('offline'));
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  const status=tree.root.findByProps({role:'status'});
  expect([gate().props['data-state'],status.props['data-tone'],words(status.props.children)]).toEqual(['down','error','Could not reach loom. Reload to try again.']);
  expect(words(tree.toJSON())).not.toContain('Connecting');
  const button=tree.root.findByType('button');expect(button.props.children).toBe('Reload');
  await act(async()=>button.props.onClick());expect(reload).toHaveBeenCalledOnce();expect(fetch).toHaveBeenCalledExactlyOnceWith('/auth/session');
});
it('shows a failed passkey attempt as an error in the same status line',async()=>{
  const {fetch}=environment();
  vi.stubGlobal('navigator',{credentials:{get:vi.fn().mockRejectedValue(Error('Device cancelled'))}});vi.stubGlobal('location',{reload:vi.fn()});
  fetch.mockResolvedValueOnce({json:async()=>({viewer:null})}).mockResolvedValueOnce({ok:true,json:async()=>({challenge:'AQID',rpId:'loom.test',timeout:60000})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  await act(async()=>{await tree.root.findByType('button').props.onClick();});
  const status=tree.root.findByProps({role:'status'});
  expect([gate().props['data-state'],status.props['data-tone'],words(status.props.children)]).toEqual(['out','error','Device cancelled']);
});
it('before sign-in says nothing of the household: its words are fixed, and it asks loom only for the session',async()=>{
  const {fetch}=environment();fetch.mockResolvedValue({json:async()=>({viewer:null,household:'The Fixture Family',members:['Fixture Person']})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  expect(words(tree.toJSON())).toBe(greetingAt(new Date().getHours())+'LOOM//OSSign in to loomSign in with a passkeyHave a one-time sign-in link? Open it and press Sign in.');
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/auth/session');
});
it('greets by the time of day on this device',()=>{
  expect([0,4,5,11,12,17,18,23].map(greetingAt)).toEqual(['Good evening','Good evening','Good morning','Good morning','Good afternoon','Good afternoon','Good evening','Good evening']);
});
