import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h,useSyncExternalStore,type ReactNode} from 'react';
// @ts-expect-error Existing renderer has no declarations.
import {act,create} from 'react-test-renderer';
const f=vi.hoisted(()=>({snapshot:{status:'live',records:[] as unknown[]},listeners:new Set<()=>void>(),once:vi.fn()}));
vi.mock('../../data',()=>({useRecords:(type:string,scope:string)=>{expect(type).toBe('comms.question');expect(scope).toBe('sealed');return useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshot);},callOnce:f.once}));
vi.mock('../../kit',()=>Object.fromEntries(['Button','Textarea','Error','Loading'].map(name=>[name,(props:{children?:ReactNode})=>h(name,props,props.children)])));
import {SealedQuestion} from './question';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const thread={id:'th:one',member:'jonathan',agent:'art',archived:null as number|null};
const row={id:'sealed',thread:thread.id,member:thread.member,agent:thread.agent,seq:2,state:'open',keepUntil:20000,question:{ask:'Private wording',answers:'words'}};
let tree:ReturnType<typeof create>;
async function publish(records:unknown[],status='live'){await act(async()=>{f.snapshot={records,status};f.listeners.forEach(fn=>fn());});}
async function open(){vi.useFakeTimers();vi.setSystemTime(10000);f.once.mockReset();f.snapshot={status:'live',records:[row]};await act(async()=>{tree=create(h(SealedQuestion,{thread,seq:2,refId:'sealed'}));});}
const editor=()=>tree.root.findByType('Textarea');
const send=()=>tree.root.findAllByType('Button').find((b:{props:{children:unknown}})=>b.props.children==='Send private reply');
async function type(text='PRIVATE DRAFT'){await act(async()=>editor().props.onChange({target:{value:text}}));}
afterEach(async()=>{await act(async()=>tree?.unmount());vi.useRealTimers();});
it('reads current words and sends only after a fresh exact snapshot check, with ephemeral calls',async()=>{
 await open();await type();f.once.mockImplementation((op:string)=>({result:Promise.resolve({ok:true,value:op==='comms.question'?row:{}})}));
 await act(async()=>{await send().props.onClick();});
 expect(f.once.mock.calls).toEqual([['comms.question',{ref:'sealed'}],['comms.replyToAsk',{ref:'sealed',text:'PRIVATE DRAFT'}]]);expect(editor().props.value).toBe('');
});
for(const change of ['disconnect','missing','member','agent','thread','seq','expired','answered'] as const)it(`withdraws editor and draft on ${change}`,async()=>{
 await open();await type();
 if(change==='disconnect')await publish([row],'offline');else if(change==='missing')await publish([]);else if(change==='expired')await act(async()=>{vi.advanceTimersByTime(10001);});else await publish([{...row,...(change==='answered'?{state:'answered'}:{[change]:change==='seq'?3:'other'})}]);
 expect(tree.root.findAllByType('Textarea')).toHaveLength(0);expect(JSON.stringify(tree.toJSON())).not.toContain('PRIVATE DRAFT');
 await publish([row]);if(change!=='expired')expect(editor().props.value).toBe('');
});
it('discards a draft on wording change and requires explicit unarchive',async()=>{
 await open();await type();await publish([{...row,question:{...row.question,ask:'Replacement wording'}}]);expect(editor().props.value).toBe('');
 await act(async()=>tree.update(h(SealedQuestion,{thread:{...thread,archived:1},seq:2,refId:'sealed'})));expect(tree.root.findAllByType('Textarea')).toHaveLength(0);expect(f.once).not.toHaveBeenCalled();
});
it('refuses writes when the fresh result differs or the live question disappears during the check',async()=>{
 await open();await type();f.once.mockReturnValue({result:Promise.resolve({ok:true,value:{...row,state:'answered'}})});await act(async()=>{await send().props.onClick();});expect(f.once).toHaveBeenCalledTimes(1);
 let resolve!:(v:unknown)=>void;f.once.mockReset().mockReturnValue({result:new Promise(r=>{resolve=r;})});await act(async()=>{send().props.onClick();});await publish([]);await act(async()=>{resolve({ok:true,value:row});});expect(f.once).toHaveBeenCalledTimes(1);
});
it('coalesces double clicks and caps private replies at 4000 characters',async()=>{
 await open();await type('x'.repeat(4001));expect(send().props.disabled).toBe(true);await act(async()=>{send().props.onClick();});expect(f.once).not.toHaveBeenCalled();
 await type();let resolve!:(v:unknown)=>void;f.once.mockReturnValue({result:new Promise(r=>{resolve=r;})});await act(async()=>{send().props.onClick();send().props.onClick();});expect(f.once).toHaveBeenCalledTimes(1);await act(async()=>{resolve({ok:false,message:'Changed'});});
});
