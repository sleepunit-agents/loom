import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import { SealedQuestionReader, type SealedQuestion } from './sealed-question';
import type { Ask } from './model';
import type { Snapshot } from '../../data';
const f=vi.hoisted(()=>({snapshot:{records:[],status:'live'} as Snapshot<SealedQuestion>,listeners:new Set<()=>void>(),call:vi.fn(),read:vi.fn()}));
vi.mock('../../data',()=>({useRecords:(type:string,scope:string)=>{f.read(type,scope);return useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshot);},callOnce:(...args:unknown[])=>f.call(...args)}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const ask:Ask={id:'comms:abc',agent:'art',member:'jonathan',ask:'Private question',source:{kind:'conversation',id:'cv-one'},state:'open',createdAt:1,changedAt:1,privateQuestion:{thread:'th:one',seq:2}};
const row=():SealedQuestion=>({id:ask.id,thread:'th:one',seq:2,state:'open',createdAt:1,changedAt:1,keepUntil:Date.now()+1000,question:{ask:'Secret question?',why:'Secret reason',if_yes:'Secret yes',if_no:'Secret no',answers:'yes-no'}});
let tree:ReturnType<typeof create>;
const guard=()=>({lock:{current:false},busy:false,setBusy:vi.fn()});
const text=()=>JSON.stringify(tree.toJSON());
// Renderer callbacks expose arbitrary DOM props; this mirrors the existing Inbox renderer harness.
const words=(n:any):string=>typeof n==='string'?n:(n.children??[]).map(words).join('');
const buttons=(label:string)=>tree.root.findAllByType('button').filter((n:any)=>words(n)===label);
const click=async(label:string)=>act(async()=>{buttons(label)[0].props.onClick();});
const publish=async(s:Snapshot<SealedQuestion>)=>act(async()=>{f.snapshot=s;f.listeners.forEach(fn=>fn());});
const draw=async(a:Ask=ask,go=vi.fn())=>act(async()=>{tree=create(h(SealedQuestionReader,{ask:a,guard:guard(),go}));});
function pending(){let resolve!:(r:unknown)=>void;return {result:new Promise(r=>resolve=r),finish:async(r:unknown)=>act(async()=>resolve(r))};}
beforeEach(()=>{vi.useFakeTimers();f.call.mockReset();f.read.mockReset();f.listeners.clear();f.snapshot={records:[row()],status:'live'};});
afterEach(async()=>{await act(async()=>tree?.unmount());vi.useRealTimers();vi.restoreAllMocks();});
it('reads exactly the selected scope, shows words and requires fresh display and send checks',async()=>{
 const q=f.snapshot.records[0];f.call.mockReturnValue({result:Promise.resolve({ok:true,value:q})});await draw();
 expect(f.read).toHaveBeenCalledWith('comms.question',ask.id);expect(text()).toContain('Secret question?');expect(text()).toContain('Secret no');expect(buttons('Yes')).toHaveLength(0);
 await click('Check private question');expect(buttons('Yes')).toHaveLength(1);
 const check=pending();f.call.mockReturnValueOnce(check);await click('Yes');expect(f.call).toHaveBeenLastCalledWith('comms.question',{ref:ask.id});
 f.call.mockReturnValueOnce({result:Promise.resolve({ok:true,value:{}})});await check.finish({ok:true,value:q});
 expect(f.call).toHaveBeenLastCalledWith('comms.answer',{thread:'th:one',ref:ask.id,verdict:'yes'});expect(text()).toContain('Private answer saved');expect(buttons('Mark done')).toHaveLength(0);
});
it('keeps refused typed words in the mounted window and uses only the ephemeral reply seam',async()=>{
 const q=f.snapshot.records[0];f.call.mockReturnValue({result:Promise.resolve({ok:true,value:q})});await draw();await click('Check private question');
 await act(async()=>tree.root.findByType('textarea').props.onChange({target:{value:'Private words'}}));
 f.call.mockReturnValueOnce({result:Promise.resolve({ok:true,value:q})}).mockReturnValueOnce({result:Promise.resolve({ok:false,message:'Refused'})});await click('Send private reply');
 expect(f.call).toHaveBeenLastCalledWith('comms.replyToAsk',{ref:ask.id,text:'Private words'});expect(tree.root.findAllByType('textarea')).toHaveLength(0);
 await click('Check private question');expect(tree.root.findByType('textarea').props.value).toBe('Private words');
});
it.each(['offline','denied','loading'] as const)('hides retained words immediately on %s and drops drafts',async(status)=>{
 const q=f.snapshot.records[0];f.call.mockReturnValue({result:Promise.resolve({ok:true,value:q})});await draw();await click('Check private question');
 await act(async()=>tree.root.findByType('textarea').props.onChange({target:{value:'Draft'}}));
 await publish({records:f.snapshot.records,status});expect(text()).not.toContain('Secret question?');expect(text()).not.toContain('Draft');expect(buttons('Yes')).toHaveLength(0);expect(buttons('Open private conversation')).toHaveLength(0);
 await publish({records:[q],status:'live'});await click('Check private question');expect(tree.root.findByType('textarea').props.value).toBe('');
});
it('expires words and controls at keepUntil without another socket change',async()=>{
 await draw();await act(async()=>vi.advanceTimersByTime(1000));expect(text()).not.toContain('Secret question?');expect(text()).toContain('Words no longer kept');expect(buttons('Check private question')).toHaveLength(0);
});
it.each(['changed','expired','unmounted','denied'] as const)('refuses a send after %s during the fresh read',async(mode)=>{
 const q=f.snapshot.records[0];f.call.mockReturnValue({result:Promise.resolve({ok:true,value:q})});await draw();await click('Check private question');const fresh=pending();f.call.mockReturnValueOnce(fresh);await click('No');
 if(mode==='changed')await publish({records:[{...q,changedAt:2}],status:'live'});
 if(mode==='expired')await act(async()=>vi.advanceTimersByTime(1000));
 if(mode==='unmounted')await act(async()=>tree.unmount());
 await fresh.finish(mode==='denied'?{ok:false,message:'Denied'}:{ok:true,value:q});expect(f.call.mock.calls.filter((c:unknown[])=>c[0]==='comms.answer')).toHaveLength(0);
});
it.each([{thread:'th:other'},{seq:99},{changedAt:99},{state:'answered' as const}])('hides inconsistent route/current state %j',async(fields)=>{
 f.snapshot={records:[{...row(),...fields}],status:'live'};await draw();expect(text()).not.toContain('Secret question?');expect(buttons('Check private question')).toHaveLength(0);
});
it('shows answered history and wordless receipt navigation after retention',async()=>{
 const answer={kind:'replied',by:{kind:'member',id:'jonathan'},at:2,reply:{thread:'th:one',seq:3}};
 const go=vi.fn();f.snapshot={records:[{...row(),state:'answered',question:null,answer:{...answer,reply:{thread:'th:reply',seq:3}}}],status:'live'};await draw({...ask,state:'answered'},go);
 expect(text()).toContain('replied');expect(text()).toContain('Words no longer kept');expect(buttons('Open private reply')).toHaveLength(1);expect(buttons('Check private question')).toHaveLength(0);
 await click('Open private conversation');expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/one');
 await click('Open private reply');expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/reply');
});

it.each([{state:'answered' as const},{changedAt:2},{privateQuestion:{thread:'th:other',seq:2}}])('refuses stale Attention props while the scoped feed has not yet updated: %j',async(fields)=>{
 const q=f.snapshot.records[0],g=guard(),go=vi.fn();f.call.mockReturnValue({result:Promise.resolve({ok:true,value:q})});
 await act(async()=>{tree=create(h(SealedQuestionReader,{ask,guard:g,go}));});await click('Check private question');
 const fresh=pending();f.call.mockReturnValueOnce(fresh);await click('Yes');
 await act(async()=>tree.update(h(SealedQuestionReader,{ask:{...ask,...fields},guard:g,go})));
 await fresh.finish({ok:true,value:q});expect(f.call.mock.calls.filter((c:unknown[])=>c[0]==='comms.answer')).toHaveLength(0);
 expect(text()).not.toContain('Secret question?');expect(buttons('Open private conversation')).toHaveLength(0);
});

it.each(['offline','denied','loading','empty'] as const)('withdraws answered history and both navigation controls on %s',async(mode)=>{
 const answer={kind:'replied',by:{kind:'member',id:'jonathan'},at:2,reply:{thread:'th:one',seq:3}};
 const q={...row(),state:'answered' as const,answer};f.snapshot={records:[q],status:'live'};await draw({...ask,state:'answered'});
 expect(text()).toContain('replied');expect(buttons('Open private reply')).toHaveLength(1);
 await publish({records:mode==='empty'?[]:[q],status:mode==='empty'?'live':mode});
 expect(text()).not.toContain('replied');expect(text()).not.toContain('jonathan');expect(buttons('Open private conversation')).toHaveLength(0);expect(buttons('Open private reply')).toHaveLength(0);
});

it('withdraws words when retention expires between render and the passive effect',async()=>{
 const before=Date.now(),deadline=f.snapshot.records[0].keepUntil;
 vi.spyOn(Date,'now').mockReturnValueOnce(before).mockReturnValueOnce(before).mockReturnValue(deadline);
 await draw();expect(text()).not.toContain('Secret question?');expect(text()).toContain('Words no longer kept');expect(buttons('Check private question')).toHaveLength(0);
});
