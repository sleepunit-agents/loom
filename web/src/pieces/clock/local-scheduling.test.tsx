import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import type { Snapshot } from '../../data';
import type { Approval } from '../approvals/model';
const f=vi.hoisted(()=>({send:vi.fn(),receipt:undefined as ReturnType<typeof import('./request').useRequest>}));
vi.mock('./request',()=>({send:f.send,useRequest:()=>f.receipt}));
vi.mock('../../kit',()=>Object.fromEntries(['Button','Input','Error','Loading'].map(name=>[name,(props:{children?:ReactNode})=>h(name,props,props.children)])));
import { LocalScheduling } from './local-scheduling';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const approval={id:'a-12345678',state:'allowed',details:'Complete saved words',kind:'local-wake'} as Approval;
let tree:ReturnType<typeof create>;
const button=(text:string)=>tree.root.findAllByType('Button').find((b:{props:{children?:unknown}})=>b.props.children===text);
const render=async(snapshot:Snapshot<Approval>={records:[approval],status:'live'},a=approval)=>{await act(async()=>{tree ? tree.update(h(LocalScheduling,{approval:a,snapshot})) : tree=create(h(LocalScheduling,{approval:a,snapshot}));});};
const review=async(standing=false, mode='at', authority=standing?'standing':'once')=>{
 const form=new FormData();form.set('mode',mode);form.set('when','2026-11-14 08:31');form.set('authority',authority);
 const original=globalThis.FormData;globalThis.FormData=class {constructor(){return form;}} as typeof FormData;
 try{await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));}finally{globalThis.FormData=original;}
};
afterEach(async()=>{await act(async()=>tree?.unmount());tree=undefined;f.send.mockClear();f.receipt=undefined;});
it.each([false,true])('sends only saved approval and explicit timing/standing=%s after confirmation',async standing=>{
 await render();await review(standing);expect(f.send).not.toHaveBeenCalled();
 const paragraphs=tree.root.findByProps({'aria-label':'Confirm local timing'}).findAllByType('p').map((p:{children:unknown[]})=>p.children.join(''));
 expect(paragraphs).toEqual(['Complete saved words','At (CT): 2026-11-14 08:31',standing?'Use existing Allow every time':'Spend one-time Allow']);
 await act(async()=>button('Schedule these saved words').props.onClick());
 expect(f.send).toHaveBeenCalledExactlyOnceWith('scheduleLocalFromWindow',{approval:approval.id,mode:'at',when:'2026-11-14 08:31',standing});
 expect(button('Schedule these saved words')).toBeUndefined();
});
it.each(['offline','denied','loading'] as const)('cannot confirm stale words when approvals become %s',async status=>{
 const records=[approval];await render({records,status:'live'});await review();
 await render({records,status});expect(button('Schedule these saved words').props.disabled).toBe(true);
 await act(async()=>button('Schedule these saved words').props.onClick());expect(f.send).not.toHaveBeenCalled();
});
it('invalidates review after any new approval snapshot, including changed saved details',async()=>{
 await render();await review();const changed={...approval,details:'Changed words'};
 await render({records:[changed],status:'live'},changed);
 expect(button('Schedule these saved words')).toBeUndefined();expect(f.send).not.toHaveBeenCalled();
});
it.each(['pending','denied','expired','withdrawn'] as const)('offers no timing for %s requests',async state=>{
 const a={...approval,state};await render({records:[a],status:'live'},a);
 expect(tree.root.findAllByType('form')).toHaveLength(0);expect(f.send).not.toHaveBeenCalled();
});
it('honors the shared pending lock and scopes result to this exact operation/card',async()=>{
 const snapshot={records:[approval],status:'live' as const};await render(snapshot);await review();
 f.receipt={pending:true,status:'pending',operation:'pause',input:{agent:'art'}};await render(snapshot);
 expect(button('Schedule these saved words').props.disabled).toBe(true);
 await act(async()=>button('Schedule these saved words').props.onClick());expect(f.send).not.toHaveBeenCalled();
 f.receipt={pending:false,status:'done',operation:'scheduleLocalFromWindow',input:{approval:'a-other'},result:{ok:true,value:{id:'w-other',due:1}}};await render(snapshot);
 expect(tree.root.findAllByProps({role:'status'})).toHaveLength(0);
 f.receipt={...f.receipt,input:{approval:approval.id}};await render(snapshot);
 expect(tree.root.findByProps({role:'status'}).children.join('')).toContain('Local delivery remains held');
});

it.each([['','once'],['at','']])('requires explicit timing mode %j and authority %j',async(mode,authority)=>{
 await render();await review(false,mode,authority);
 expect(button('Schedule these saved words')).toBeUndefined();expect(f.send).not.toHaveBeenCalled();
});
