import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
const f=vi.hoisted(()=>({once:vi.fn()}));
vi.mock('../../data',()=>({callOnce:f.once}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
vi.mock('../../data/operation',()=>({memberOperation:(name:string,input:object)=>f.once(name,input).result.then((result:any)=>{if(!result.ok)throw new Error(result.message);return result.value;})}));
import { HomeMessageComposer } from './home-composer';
import { readDraft, writeDraft } from '../comms/drafts';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>|undefined;
const opened=vi.fn();
const ok=(value:unknown)=>({ok:true,value});
function deferred(){let finish!:(value:any)=>void;const result=new Promise<any>(resolve=>{finish=resolve;});return {result,finish};}
async function draw(){await act(async()=>{tree=create(h(HomeMessageComposer,{member:'sam',agent:'art',onOpened:opened}));});}
async function edit(text:string){await act(async()=>tree!.root.findByType('textarea').props.onChange({target:{value:text}}));}
const submit=()=>tree!.root.findByType('form').props.onSubmit({preventDefault:vi.fn()});
const text=()=>tree!.root.findByType('textarea').props.value;
beforeEach(()=>{
 const storage=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});
 f.once.mockReset();opened.mockReset();
 f.once.mockImplementation((_name:string,input:{thread:string})=>({result:Promise.resolve(ok({thread:input.thread,seq:1}))}));
});
afterEach(async()=>{if(tree)await act(async()=>tree!.unmount());tree=undefined;vi.unstubAllGlobals();});
it('opens with wordless metadata, sends through the shared contract, then clears only the acknowledged draft',async()=>{
 await draw();await edit('Private message words');const sent=readDraft('sam','new:art');
 await act(async()=>submit());
 expect(f.once.mock.calls).toEqual([
  ['comms.open',{thread:`th:${sent.id}`,agent:'art'}],
  ['comms.send',{thread:`th:${sent.id}`,clientId:sent.id,words:'Private message words'}],
 ]);
 expect(JSON.stringify(f.once.mock.calls[0])).not.toContain('Private message words');
 expect(opened).toHaveBeenCalledExactlyOnceWith(`th:${sent.id}`);expect(text()).toBe('');
 expect(readDraft('sam','new:art').text).toBe('');
});
it('keeps an uncertain send draft and reuses its thread and client IDs on a deliberate retry',async()=>{
 await draw();await edit('Keep these words');const sent=readDraft('sam','new:art');
 f.once.mockImplementation((name:string,input:{thread:string})=>({result:Promise.resolve(name==='comms.send'?{ok:false,message:'Could not confirm send'}:ok({thread:input.thread}))}));
 await act(async()=>submit());
 expect(text()).toBe('Keep these words');expect(readDraft('sam','new:art')).toEqual(sent);expect(opened).not.toHaveBeenCalled();expect(f.once).toHaveBeenCalledTimes(2);
 await act(async()=>Promise.resolve());expect(f.once).toHaveBeenCalledTimes(2);
 f.once.mockImplementation((_name:string,input:{thread:string})=>({result:Promise.resolve(ok({thread:input.thread,seq:1}))}));
 await act(async()=>submit());
 expect(f.once.mock.calls[2]).toEqual(f.once.mock.calls[0]);expect(f.once.mock.calls[3]).toEqual(f.once.mock.calls[1]);
 expect(opened).toHaveBeenCalledTimes(1);expect(text()).toBe('');
});
it('locks synchronously against duplicate submits while opening',async()=>{
 const held=deferred();await draw();await edit('Send once');
 f.once.mockImplementationOnce(()=>({result:held.result}));let sending!:Promise<void>;
 await act(async()=>{sending=submit();void submit();});expect(f.once).toHaveBeenCalledTimes(1);
 const thread=f.once.mock.calls[0][1].thread;
 await act(async()=>{held.finish(ok({thread}));await sending;});expect(f.once).toHaveBeenCalledTimes(2);
});
it('does not send private words after the eligible composer unmounts during open',async()=>{
 const held=deferred();await draw();await edit('Never send after scope loss');
 f.once.mockImplementationOnce(()=>({result:held.result}));let sending!:Promise<void>;
 await act(async()=>{sending=submit();});const thread=f.once.mock.calls[0][1].thread;
 await act(async()=>tree!.unmount());tree=undefined;
 await act(async()=>{held.finish(ok({thread}));await sending;});
 expect(f.once).toHaveBeenCalledTimes(1);expect(opened).not.toHaveBeenCalled();
 expect(readDraft('sam','new:art').text).toBe('Never send after scope loss');
});
it('does not erase a newer draft saved by another window when an older send is acknowledged',async()=>{
 const held=deferred();await draw();await edit('Older message');
 f.once.mockImplementation((name:string,input:{thread:string})=>({result:name==='comms.open'?Promise.resolve(ok({thread:input.thread})):held.result}));
 let sending!:Promise<void>;await act(async()=>{sending=submit();});expect(f.once).toHaveBeenCalledTimes(2);
 const newer={id:'bbbbbbbbbbbbbbbb',text:'Newer window draft'};writeDraft('sam','new:art',newer);
 await act(async()=>{held.finish(ok({thread:f.once.mock.calls[1][1].thread,seq:1}));await sending;});
 expect(readDraft('sam','new:art')).toEqual(newer);
});
it.each(['comms.open','comms.send'])('keeps its draft when %s acknowledges another thread',async phase=>{
 await draw();await edit('Keep until this thread is confirmed');const sent=readDraft('sam','new:art');
 f.once.mockImplementation((name:string,input:{thread:string})=>({result:Promise.resolve(ok({thread:name===phase?'th:other':input.thread,seq:1}))}));
 await act(async()=>submit());
 expect(readDraft('sam','new:art')).toEqual(sent);expect(opened).not.toHaveBeenCalled();
 expect(f.once).toHaveBeenCalledTimes(phase==='comms.open'?1:2);
});
