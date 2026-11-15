import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import {act,create} from 'react-test-renderer';
const f=vi.hoisted(()=>({feed:{status:'live',data:{householdSetup:{defaultAgent:null,members:[{id:'sam',role:'owner',fullOwner:true,agents:[]}],agents:[],tokens:[{fingerprint:'f'.repeat(64),label:'Fixture token',kind:'owner',identity:'sam',createdAt:'2026-11-15T00:00:00Z',expiresAt:null,revokedAt:null,lastUsedAt:null}],sessions:[]},boxes:[]}} as {status:string;data?:unknown},operation:vi.fn()}));
vi.mock('../../data/graphql',()=>({useDataQuery:()=>f.feed}));vi.mock('../../data/operation',()=>({memberOperation:f.operation}));
vi.mock('../../kit',()=>Object.fromEntries(['AppFrame','Button','Input','Empty','Error','Loading'].map(name=>[name,(props:object)=>h(name==='Button'?'button':name==='Input'?'input':'div',props)])));
import Setup from './index';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;const original=f.feed.data,privateBearer='loom_'+'p'.repeat(43);beforeEach(()=>{f.feed.data=original;vi.clearAllMocks();f.feed.status='live';f.operation.mockResolvedValue({});});afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
it('shows safe shared metadata and sends the exact canonical token reference',async()=>{await act(async()=>{tree=create(h(Setup));});expect(JSON.stringify(tree.toJSON())).toContain('Fixture token');const revoke=tree.root.findAllByType('button').find((node:{props:{children:unknown}})=>node.props.children==='Revoke token');await act(async()=>revoke.props.onClick());expect(f.operation).toHaveBeenCalledExactlyOnceWith('token.revoke',{fingerprint:'f'.repeat(64)});});
it('hides owner metadata on denied data and disables inactive changes',async()=>{await act(async()=>{tree=create(h(Setup,{active:false}));});expect(tree.root.findAllByType('button').every((node:{props:{disabled?:boolean}})=>node.props.disabled)).toBe(true);const saved=f.feed.data;f.feed.data=undefined;await act(async()=>tree.update(h(Setup)));expect(JSON.stringify(tree.toJSON())).not.toContain('Fixture token');f.feed.data=saved;});

function tokenForm(){vi.stubGlobal('FormData',class{get(name:string){return({label:'Fixture issue',member:'sam',expiresAt:''} as Record<string,string>)[name]??null;}});return{preventDefault:vi.fn(),currentTarget:{}};}
it.each(['inactive','offline','denied'] as const)('clears a returned credential after %s and refuses to resurrect late issuance',async reason=>{
 let release!:(value:Response)=>void;const pending=new Promise<Response>(resolve=>{release=resolve;}),fetch=vi.fn(()=>pending);vi.stubGlobal('fetch',fetch);
 await act(async()=>{tree=create(h(Setup));});await act(async()=>tree.root.findByProps({'aria-label':'Create token'}).props.onSubmit(tokenForm()));expect(fetch).toHaveBeenCalledOnce();
 await act(async()=>{if(reason==='offline')f.feed.status='offline';if(reason==='denied')f.feed.data={householdSetup:null,boxes:[]};tree.update(h(Setup,{active:reason!=='inactive'}));});
 await act(async()=>{release(Response.json({ok:true,value:{token:privateBearer,fingerprint:'a'.repeat(64)}}));});
 await act(async()=>{f.feed.status='live';f.feed.data=original;tree.update(h(Setup,{active:true}));});expect(JSON.stringify(tree.toJSON())).not.toContain(privateBearer);expect(fetch).toHaveBeenCalledOnce();
});

it.each(['inactive','offline','denied'] as const)('clears an already delivered credential across %s and reauthorization',async reason=>{
 const fetch=vi.fn().mockResolvedValue(Response.json({ok:true,value:{token:privateBearer,fingerprint:'a'.repeat(64)}}));vi.stubGlobal('fetch',fetch);
 await act(async()=>{tree=create(h(Setup));});await act(async()=>tree.root.findByProps({'aria-label':'Create token'}).props.onSubmit(tokenForm()));expect(JSON.stringify(tree.toJSON())).toContain(privateBearer);
 await act(async()=>{if(reason==='offline')f.feed.status='offline';if(reason==='denied')f.feed.data={householdSetup:null,boxes:[]};tree.update(h(Setup,{active:reason!=='inactive'}));});
 await act(async()=>{f.feed.status='live';f.feed.data=original;tree.update(h(Setup,{active:true}));});expect(JSON.stringify(tree.toJSON())).not.toContain(privateBearer);expect(fetch).toHaveBeenCalledOnce();
});
it('never retries uncertain issuance on a timer, render or remount',async()=>{
 vi.useFakeTimers();const fetch=vi.fn().mockRejectedValue(Error('network'));vi.stubGlobal('fetch',fetch);
 try{await act(async()=>{tree=create(h(Setup));});await act(async()=>tree.root.findByProps({'aria-label':'Create token'}).props.onSubmit(tokenForm()));expect(JSON.stringify(tree.toJSON())).toContain('may have completed');
 await act(async()=>{await vi.advanceTimersByTimeAsync(10000);tree.update(h(Setup));});await act(async()=>tree.unmount());await act(async()=>{tree=create(h(Setup));});expect(fetch).toHaveBeenCalledOnce();expect(JSON.stringify(tree.toJSON())).not.toContain(privateBearer);}finally{vi.useRealTimers();}
});
it('shows no owner data for the actual live denial shape',async()=>{f.feed.data={householdSetup:null,boxes:[]};await act(async()=>{tree=create(h(Setup));});expect(JSON.stringify(tree.toJSON())).not.toContain('Fixture token');expect(tree.root.findAllByType('form')).toHaveLength(0);});

it('explains an invalid full-owner role without sending a grant',async()=>{
 vi.stubGlobal('FormData',class{get(name:string){return({id:'pat',role:'member',fullOwner:'on'} as Record<string,string>)[name]??null;}getAll(){return[];}});
 await act(async()=>{tree=create(h(Setup));});await act(async()=>tree.root.findByProps({'aria-label':'Add member'}).props.onSubmit({preventDefault(){},currentTarget:{}}));expect(f.operation).not.toHaveBeenCalled();expect(JSON.stringify(tree.toJSON())).toContain('Choose Household owner');
});
