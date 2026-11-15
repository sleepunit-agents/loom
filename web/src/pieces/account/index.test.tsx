import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import {act,create} from 'react-test-renderer';
const f=vi.hoisted(()=>({feed:{status:'live',data:{account:{member:'sam',passkeys:[{ref:'a'.repeat(64),label:'Laptop',createdAt:'2026-11-15T00:00:00Z',lastUsedAt:null,ended:false}],sessions:[{ref:'b'.repeat(64),device:'Chrome on Mac',issuedAt:'2026-11-15T00:00:00Z',seenAt:'2026-11-15T01:00:00Z',ended:false}]}}} as {status:string;data?:unknown},runtime:{status:'live',data:{modelAccounts:[{__typename:'RuntimeAccountSummary',label:'Visible model subscription',level:'plenty'}],agentModels:[{agent:'sam-agent',model:'visible-preferred-model',position:0}],deskTime:{timezone:'America/Chicago'}}},operation:vi.fn()}));
vi.mock('../../data/graphql',()=>({useDataQuery:(query:string)=>query.includes('RuntimeModelAccounts')?f.runtime:f.feed}));
vi.mock('../../data/operation',()=>({memberOperation:f.operation}));
vi.mock('../../kit',()=>Object.fromEntries(['AppFrame','Button','Input','Empty','Error','Loading'].map(name=>[name,(props:object)=>h(name==='Button'?'button':name==='Input'?'input':'div',props)])));
import Account from './index';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({viewer:{id:'sam'}})));vi.clearAllMocks();f.feed.status='live';f.operation.mockResolvedValue({});});
afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
it('renders shared account metadata and sends only the selected opaque personal reference',async()=>{
 await act(async()=>{tree=create(h(Account));});
 expect(JSON.stringify(tree.toJSON())).toContain('Chrome on Mac');
 expect(JSON.stringify(tree.toJSON())).toContain('Models and accounts');expect(JSON.stringify(tree.toJSON())).toContain('Visible model subscription');expect(JSON.stringify(tree.toJSON())).toContain('visible-preferred-model');
 const button=tree.root.findAllByType('button').find((node:{props:{children:unknown}})=>node.props.children==='Remove passkey');
 await act(async()=>button.props.onClick());expect(f.operation).toHaveBeenCalledExactlyOnceWith('account.removePasskey',{ref:'a'.repeat(64)});
});
it('disables account actions when inactive or disconnected and hides retained metadata when account is absent',async()=>{
 for(const [status,active] of [['offline',true],['live',false]] as const){f.feed.status=status;await act(async()=>{tree=create(h(Account,{active}));});expect(tree.root.findAllByType('button').every((node:{props:{disabled?:boolean}})=>node.props.disabled)).toBe(true);await act(async()=>tree.unmount());}
 const saved=f.feed.data;f.feed.data=undefined;await act(async()=>{tree=create(h(Account));});expect(JSON.stringify(tree.toJSON())).not.toContain('Chrome on Mac');f.feed.data=saved;
});

it.each([true,false])('replaces stale account UI after this browser revokes its own session (operation success: %s)',async success=>{if(!success)f.operation.mockRejectedValue(Error('Could not save'));vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({viewer:null})));vi.stubGlobal('location',{reload:vi.fn()});await act(async()=>{tree=create(h(Account));});await act(async()=>tree.root.findAllByType('button').find((node:{props:{children:unknown}})=>node.props.children==='Sign out browser').props.onClick());expect(location.reload).toHaveBeenCalledOnce();expect(JSON.stringify(tree.toJSON())).not.toContain('Could not');expect(JSON.stringify(tree.toJSON())).not.toContain('Saved');expect(f.operation).toHaveBeenCalledExactlyOnceWith('account.revokeSession',{ref:'b'.repeat(64)});});

it.each([true,false])('confirms another-browser revocation without hiding a refusal (operation success: %s)',async success=>{if(!success)f.operation.mockRejectedValue(Error('Could not save'));vi.stubGlobal('location',{reload:vi.fn()});await act(async()=>{tree=create(h(Account));});await act(async()=>tree.root.findAllByType('button').find((node:{props:{children:unknown}})=>node.props.children==='Sign out browser').props.onClick());expect(location.reload).not.toHaveBeenCalled();expect(JSON.stringify(tree.toJSON())).toContain(success?'Saved':'Could not confirm sign-out');if(!success)expect(JSON.stringify(tree.toJSON())).not.toContain('Saved');expect(f.operation).toHaveBeenCalledOnce();});
