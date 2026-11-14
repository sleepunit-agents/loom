import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { CallState, Result, Snapshot } from '../../data';
const f=vi.hoisted(()=>({snapshot:{status:'live',records:[]} as Snapshot,call:vi.fn(),once:vi.fn()}));
vi.mock('../../data',()=>({useRecords:()=>f.snapshot,call:f.call,callOnce:f.once}));
vi.mock('../../kit',()=>Object.fromEntries(['AppFrame','Button','Input','Empty','Error','Loading'].map(name=>[name,(props:object)=>h(name==='Button'?'button':name==='Input'?'input':'div',props)])));
import Account from './index';
import { mutation } from './model';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
function request(){let state:CallState={pending:true,status:'pending'};const listeners=new Set<()=>void>();const retry=vi.fn();const handle={id:'stable',result:new Promise<Result>(()=>{}),retry,getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};}};return{handle,finish:async(result:Result)=>act(async()=>{state={pending:false,status:'done',result};listeners.forEach(fn=>fn());})};}
beforeEach(async()=>{vi.clearAllMocks();f.snapshot={status:'live',records:[{id:'jonathan',member:'jonathan',passkeys:[{ref:'a'.repeat(64),label:'Phone',created:0,ended:false,made:1}],sessions:[{ref:'b'.repeat(64),device:'Browser',issuedAt:0,ended:false}]}]};const r=request();await r.finish({ok:true,value:{}});mutation.set(r.handle,'previous');});
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
it('hides retained private data on denial/empty snapshot and disables offline and inactive changes',async()=>{
  f.snapshot={...f.snapshot,status:'denied'};await act(async()=>{tree=create(h(Account));});expect(tree.root.findAllByType('form')).toHaveLength(0);
  for(const [status,active] of [['offline',true],['live',false]] as const){await act(async()=>{f.snapshot={...f.snapshot,status};tree.update(h(Account,{active}));});expect(tree.root.findAllByType('fieldset').every((x:{props:{disabled?:boolean}})=>x.props.disabled)).toBe(true);}
  await act(async()=>{f.snapshot={status:'live',records:[]};tree.update(h(Account));});expect(tree.root.findAllByType('form')).toHaveLength(0);
});
it('sends exact opaque target and cascade choice once, clears confirmation, retains uncertain retry across navigation',async()=>{
  const r=request();f.call.mockReturnValue(r.handle);const Original=FormData;vi.stubGlobal('FormData',class extends Original{constructor(){super();this.set('made','on');}});
  await act(async()=>{tree=create(h(Account));});const reset=vi.fn(),e={preventDefault:vi.fn(),currentTarget:{reset}};
  await act(async()=>tree.root.findByProps({'aria-label':'Remove passkey Phone'}).props.onSubmit(e));expect(f.call).toHaveBeenCalledExactlyOnceWith('account.removePasskey',{ref:'a'.repeat(64),withMade:true});expect(reset).toHaveBeenCalledOnce();
  await act(async()=>tree.root.findByProps({'aria-label':'Remove passkey Phone'}).props.onSubmit(e));expect(f.call).toHaveBeenCalledOnce();
  await r.finish({ok:false,code:'unavailable',message:'Uncertain'});await act(async()=>tree.unmount());await act(async()=>{tree=create(h(Account,{active:false}));});
  const inactive=tree.root.findAllByType('button').find((x:{props:{children?:unknown}})=>x.props.children==='Retry this change');expect(inactive.props.disabled).toBe(true);await act(async()=>inactive.props.onClick());expect(r.handle.retry).not.toHaveBeenCalled();
  await act(async()=>tree.update(h(Account,{active:true})));
  await act(async()=>tree.root.findAllByType('button').find((x:{props:{children?:unknown}})=>x.props.children==='Retry this change').props.onClick());expect(r.handle.retry).toHaveBeenCalledOnce();expect(f.call).toHaveBeenCalledOnce();
});
it('keeps browser/device, link label and both dates visible together and distinguishes same-name keys',async()=>{
  const issuedAt=1760000000,seenAt=1760009000;
  f.snapshot={status:'live',records:[{id:'jonathan',member:'jonathan',passkeys:[{ref:'1'.repeat(64),label:'Phone',created:0,ended:false,made:0},{ref:'2'.repeat(64),label:'Phone',created:0,ended:false,made:0}],sessions:[{ref:'3'.repeat(64),label:'Daily',device:'Chrome on Linux',issuedAt,seenAt,ended:false}]}]};
  await act(async()=>{tree=create(h(Account));});const text=JSON.stringify(tree.toJSON());
  for(const value of ['Chrome on Linux','Daily',new Date(issuedAt*1000).toLocaleString(),new Date(seenAt*1000).toLocaleString(),'1'.repeat(64),'2'.repeat(64)])expect(text).toContain(value);
});

it('wires device links to the correct member and clears them through actual app inactive/offline/denied states',async()=>{
  vi.stubGlobal('location',{origin:'https://loom.example'});
  f.once.mockReturnValue({result:Promise.resolve({ok:true,value:{path:'/login/app-integration-marker'}})});
  await act(async()=>{tree=create(h(Account));});
  const section=()=>tree.root.findByProps({'aria-label':'Sign in another device'});
  await act(async()=>section().findByType('button').props.onClick());
  expect(f.once).toHaveBeenCalledExactlyOnceWith('signin.browserLink',{});
  expect(JSON.stringify(tree.toJSON())).toContain('app-integration-marker');
  await act(async()=>tree.update(h(Account,{active:false})));
  expect(JSON.stringify(tree.toJSON())).not.toContain('app-integration-marker');
  expect(section().findByType('button').props.disabled).toBe(true);
  await act(async()=>section().findByType('button').props.onClick());expect(f.once).toHaveBeenCalledOnce();
  await act(async()=>tree.update(h(Account,{active:true})));
  expect(JSON.stringify(tree.toJSON())).not.toContain('app-integration-marker');
  await act(async()=>section().findByType('button').props.onClick());expect(f.once).toHaveBeenCalledTimes(2);
  await act(async()=>{f.snapshot={...f.snapshot,status:'offline'};tree.update(h(Account));});
  expect(JSON.stringify(tree.toJSON())).not.toContain('app-integration-marker');expect(section().findByType('button').props.disabled).toBe(true);
  await act(async()=>section().findByType('button').props.onClick());expect(f.once).toHaveBeenCalledTimes(2);
  await act(async()=>{f.snapshot={...f.snapshot,status:'denied'};tree.update(h(Account));});
  expect(tree.root.findAllByProps({'aria-label':'Sign in another device'})).toHaveLength(0);
});
