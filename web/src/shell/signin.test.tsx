import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import Signin, { greetingAt } from './signin';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();vi.useRealTimers();});
const CANVAS:Record<string,string>={neon:'#07070C',lowlight:'#15171a',daylight:'#F5F3EE'};
/** A page as boot left it: <html>'s look and its light or dark, the browser bar's two colours, this device's kept
 * choices and whether it prefers light. `touched` lists every write to any of them. */
function environment(page:{look?:string;mode?:string;kept?:Record<string,string>;light?:boolean}={look:'neon',mode:'dark'}){
  const append=vi.fn(),fetch=vi.fn(),touched:string[]=[];
  const recorded=(name:string,values:Record<string,string>)=>new Proxy(values,{
    set(target,key,value){touched.push(`${name}.${String(key)}=${value}`);target[String(key)]=String(value);return true;},
    deleteProperty(target,key){touched.push(`${name}.${String(key)} removed`);delete target[String(key)];return true;}});
  const root={dataset:recorded('html',{...(page.look?{look:page.look}:{}),...(page.mode?{mode:page.mode}:{})})};
  const bar=['#f8f6f1','#15171a'].map((content,i)=>recorded(`bar${i}`,{content}) as Record<string,string>&{dataset:Record<string,string>});
  for(const [i,meta] of bar.entries())Object.defineProperty(meta,'dataset',{value:recorded(`bar${i}.dataset`,{})});
  vi.stubGlobal('document',{createElement:()=>({}),head:{append},documentElement:root,querySelectorAll:()=>bar});
  vi.stubGlobal('getComputedStyle',()=>({getPropertyValue:()=>CANVAS[root.dataset.look]??''}));
  vi.stubGlobal('localStorage',{getItem:(key:string)=>page.kept?.[key]??null});
  vi.stubGlobal('matchMedia',(query:string)=>({matches:query==='(prefers-color-scheme: light)'&&!!page.light}));
  vi.stubGlobal('fetch',fetch);
  const worn=()=>({look:root.dataset.look,mode:root.dataset.mode,bar:bar.map(meta=>meta.content)});
  return {append,fetch,touched,worn};
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
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/auth/session',expect.objectContaining({signal:expect.any(AbortSignal)}));
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
  await act(async()=>finish({ok:true,json:async()=>({viewer:null})}));
  expect([gate().props['data-state'],mark(),status().props['data-tone'],words(status().props.children)]).toEqual(['out','LOOM//OS',undefined,'']);
  expect(status()).toBe(first);expect(tree.root.findByType('svg')).toBe(ground);
  expect(tree.root.findByType('button').props.autoFocus).toBe(true);
  expect(words(tree.toJSON())).toContain('Have a one-time sign-in link? Open it and press Sign in.');
  expect(words(tree.toJSON())).not.toContain('Connecting');
});
it('says only that loom could not be reached when it cannot, as an error, and offers a reload',async()=>{
  const {fetch}=environment(),reload=vi.fn();vi.stubGlobal('location',{reload});fetch.mockRejectedValue(Error('offline'));
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  const status=tree.root.findByProps({role:'status'});
  expect([gate().props['data-state'],status.props['data-tone'],words(status.props.children)]).toEqual(['down','error','Could not reach loom. Reconnecting…']);
  expect(words(tree.toJSON())).not.toContain('Connecting');
  const button=tree.root.findByType('button');expect([button.props.children,button.props.autoFocus]).toEqual(['Reload',true]);
  await act(async()=>button.props.onClick());expect(reload).toHaveBeenCalledOnce();expect(fetch).toHaveBeenCalledExactlyOnceWith('/auth/session',expect.objectContaining({signal:expect.any(AbortSignal)}));
});
it('shows a failed passkey attempt as an error in the same status line',async()=>{
  const {fetch}=environment();
  vi.stubGlobal('navigator',{credentials:{get:vi.fn().mockRejectedValue(Error('Device cancelled'))}});vi.stubGlobal('location',{reload:vi.fn()});
  fetch.mockResolvedValueOnce({ok:true,json:async()=>({viewer:null})}).mockResolvedValueOnce({ok:true,json:async()=>({challenge:'AQID',rpId:'loom.test',timeout:60000})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  await act(async()=>{await tree.root.findByType('button').props.onClick();});
  const status=tree.root.findByProps({role:'status'});
  expect([gate().props['data-state'],status.props['data-tone'],words(status.props.children)]).toEqual(['out','error','Device cancelled']);
});
it('before sign-in says nothing of the household: its words are fixed, and it asks loom only for the session',async()=>{
  const {fetch}=environment();fetch.mockResolvedValue({ok:true,json:async()=>({viewer:null,household:'The Fixture Family',members:['Fixture Person']})});
  vi.useFakeTimers({toFake:['Date'],now:new Date(2026,10,19,11,59,59)});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  expect(words(tree.toJSON())).toBe('Good morningLOOM//OSSign in to loomSign in with a passkeyHave a one-time sign-in link? Open it and press Sign in.');
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/auth/session',expect.objectContaining({signal:expect.any(AbortSignal)}));
});
it('greets by the time of day on this device',()=>{
  expect([0,4,5,11,12,17,18,23].map(greetingAt)).toEqual(['Good evening','Good evening','Good morning','Good morning','Good afternoon','Good afternoon','Good evening','Good evening']);
});
it('puts the error after the button for someone moving on from it, and shows hostile words as words',async()=>{
  const {fetch}=environment(),hostile='<img src=x onerror=1>';vi.stubGlobal('location',{reload:vi.fn()});
  fetch.mockResolvedValueOnce({ok:true,json:async()=>({viewer:null})}).mockResolvedValueOnce({ok:false,json:async()=>({error:hostile})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  await act(async()=>{await tree.root.findByType('button').props.onClick();});
  const status=tree.root.findByProps({role:'status'}),order=tree.root.findAll(node=>node.type==='button'||node.props.role==='status').map(node=>node.type);
  expect(order).toEqual(['button','p']);
  expect([status.props['data-tone'],status.props.children]).toEqual(['error',hostile]);
  expect(tree.root.findAllByType('img')).toHaveLength(0);expect(JSON.stringify(tree.toJSON())).toContain(JSON.stringify(hostile).slice(1,-1));
});
const light={look:'neon',mode:'dark',light:true};
it('never touches the look of someone who is signed in, while it waits or after',async()=>{
  const {fetch,touched,worn}=environment(light);let finish!:(value:unknown)=>void;
  fetch.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Desk')));});
  expect(gate().props['data-state']).toBe('connecting');expect(touched).toEqual([]);
  await act(async()=>finish({ok:true,json:async()=>({viewer:{id:'fixture'},csrf:''})}));
  expect(tree.root.findAllByType('section')).toHaveLength(1);
  expect(touched).toEqual([]);expect(worn()).toEqual({look:'neon',mode:'dark',bar:['#f8f6f1','#15171a']});
});
it('wears the device\'s light on the gate when no look is kept, and puts back what was there when the gate goes',async()=>{
  for(const answer of ['out','down']){
    const {fetch,worn}=environment(light);
    if(answer==='out')fetch.mockResolvedValue({ok:true,json:async()=>({viewer:null})});else fetch.mockRejectedValue(Error('offline'));
    await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
    expect([gate().props['data-state'],worn()]).toEqual([answer,{look:'daylight',mode:'light',bar:['#F5F3EE','#F5F3EE']}]);
    await act(async()=>tree.unmount());
    expect(worn()).toEqual({look:'neon',mode:'dark',bar:['#f8f6f1','#15171a']});
  }
});
it('puts back a page that had no look at all, and takes the gate\'s look off when a signed-in page replaces it',async()=>{
  const bare=environment({light:true});bare.fetch.mockResolvedValue({ok:true,json:async()=>({viewer:null})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  expect(bare.worn().look).toBe('daylight');
  await act(async()=>tree.unmount());
  expect(bare.worn()).toEqual({look:undefined,mode:undefined,bar:['#f8f6f1','#15171a']});
  const {fetch,worn}=environment(light);fetch.mockResolvedValueOnce({ok:true,json:async()=>({viewer:null})}).mockResolvedValueOnce({ok:true,json:async()=>({viewer:{id:'fixture'}})});
  const Twice=({again}:{again:boolean})=>h(Signin,{key:String(again),children:h('section',null,'Desk')});
  await act(async()=>{tree=create(h(Twice,{again:false}));});
  expect(worn().look).toBe('daylight');
  await act(async()=>tree.update(h(Twice,{again:true})));
  expect(tree.root.findAllByType('section')).toHaveLength(1);expect(worn()).toEqual({look:'neon',mode:'dark',bar:['#f8f6f1','#15171a']});
});
it('keeps a kept look over the device\'s light or dark, and leaves a page already wearing it alone',async()=>{
  const kept=environment({look:'lowlight',mode:'dark',kept:{'loom-look':'lowlight','loom-mode':'dark'},light:true});kept.fetch.mockResolvedValue({ok:true,json:async()=>({viewer:null})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  expect(kept.touched).toEqual([]);expect(kept.worn().look).toBe('lowlight');
  await act(async()=>tree.unmount());
  const dev=environment({kept:{'loom-look':'daylight','loom-mode':'light'}});dev.fetch.mockResolvedValue({ok:true,json:async()=>({viewer:null})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Private desk')));});
  expect(dev.worn()).toMatchObject({look:'daylight',mode:'light'});
});

it('opens the desk automatically when the initial session read recovers',async()=>{
  vi.useFakeTimers();
  const {fetch}=environment();
  fetch.mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true,json:async()=>({viewer:{id:'fixture'}})});
  await act(async()=>{tree=create(h(Signin,null,h('section',null,'Desk content')));});
  expect(gate().props['data-state']).toBe('down');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1_000);});
  expect(gate().props['data-state']).toBe('down');
  await act(async()=>{await vi.advanceTimersByTimeAsync(2_000);});
  expect(tree.root.findByType('section').props.children).toBe('Desk content');
  expect(fetch).toHaveBeenCalledTimes(3);
});
