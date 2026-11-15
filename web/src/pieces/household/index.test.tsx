import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import {act,create} from 'react-test-renderer';
const f=vi.hoisted(()=>({feed:{status:'live',data:{householdSetup:{defaultAgent:null,members:[{id:'sam',role:'owner',fullOwner:true,agents:[]}],agents:[],tokens:[{fingerprint:'f'.repeat(64),label:'Fixture token',kind:'owner',identity:'sam',createdAt:'2026-11-15T00:00:00Z',expiresAt:null,revokedAt:null,lastUsedAt:null}],sessions:[]},boxes:[]}} as {status:string;data?:unknown},operation:vi.fn(),programFeed:{status:'live',data:{programSetup:null}} as {status:string;data?:unknown}}));
vi.mock('../../data/graphql',()=>({useDataQuery:(query:string)=>query.includes('programSetup')?f.programFeed:f.feed}));vi.mock('../../data/operation',()=>({memberOperation:f.operation}));
vi.mock('../../kit',()=>Object.fromEntries(['AppFrame','Button','Input','Empty','Error','Loading'].map(name=>[name,(props:object)=>h(name==='Button'?'button':name==='Input'?'input':'div',props)])));
import Setup from './index';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;const original=f.feed.data,privateBearer='loom_'+'p'.repeat(43);beforeEach(()=>{f.feed.data=original;f.programFeed={status:'live',data:{programSetup:null}};vi.clearAllMocks();f.feed.status='live';f.operation.mockResolvedValue({});});afterEach(async()=>{await act(async()=>tree?.unmount());vi.unstubAllGlobals();});
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
function programData(owner='sam'){return{owner,catalogue:{records:['tasks','projects'],operations:['tasks.command']},tokens:[{fingerprint:'c'.repeat(64),label:'Task client',member:'sam',ended:false,records:['tasks'],operations:[]}]};}
async function programForm(){
 await act(async()=>tree.root.findAllByType('select').find((node:{props:{value?:string}})=>node.props.value==='owner').props.onChange({target:{value:'program'}}));
 vi.stubGlobal('FormData',class{get(name:string){return({label:'Narrow client',member:'sam',expiresAt:''} as Record<string,string>)[name]??null;}getAll(name:string){return name==='records'?['tasks']:[];}});
 return{preventDefault(){},currentTarget:{}};
}
it('creates a narrow program through its one-time ceremony and never adds a retry receipt',async()=>{
 f.programFeed.data={programSetup:programData()};const fetch=vi.fn().mockResolvedValue(Response.json({ok:true,value:{token:privateBearer,fingerprint:'d'.repeat(64)}}));vi.stubGlobal('fetch',fetch);
 await act(async()=>{tree=create(h(Setup));});const event=await programForm();await act(async()=>tree.root.findByProps({'aria-label':'Create token'}).props.onSubmit(event));
 expect(fetch).toHaveBeenCalledOnce();const [path,options]=fetch.mock.calls[0];expect(path).toBe('/api/signin/program');expect(options).toMatchObject({credentials:'same-origin',redirect:'error'});expect(JSON.parse(options.body)).toEqual({member:'sam',label:'Narrow client',records:['tasks'],operations:[]});expect(JSON.stringify(tree.toJSON())).toContain(privateBearer);
 expect(tree.root.findByProps({'aria-label':'Create token'}).findByType('fieldset').props.disabled).toBe(true);
});
it.each(['offline','owner-change','unavailable'])('hides late program credentials across %s',async reason=>{
 f.programFeed.data={programSetup:programData()};let release!:(value:Response)=>void;const fetch=vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;}));vi.stubGlobal('fetch',fetch);
 await act(async()=>{tree=create(h(Setup));});const event=await programForm();await act(async()=>tree.root.findByProps({'aria-label':'Create token'}).props.onSubmit(event));
 await act(async()=>{if(reason==='offline')f.programFeed.status='offline';else f.programFeed.data={programSetup:reason==='owner-change'?programData('other'):null};tree.update(h(Setup));});
 await act(async()=>release(Response.json({ok:true,value:{token:privateBearer,fingerprint:'d'.repeat(64)}})));await act(async()=>{f.programFeed.status='live';f.programFeed.data={programSetup:programData()};tree.update(h(Setup));});
 expect(JSON.stringify(tree.toJSON())).not.toContain(privateBearer);expect(JSON.stringify(tree.toJSON())).toContain('may have completed');expect(fetch).toHaveBeenCalledOnce();
});
it('edits exact program grants through the shared operation, including an empty set',async()=>{
 f.programFeed.data={programSetup:programData()};vi.stubGlobal('FormData',class{getAll(){return[];}});
 await act(async()=>{tree=create(h(Setup));});await act(async()=>tree.root.findByProps({'aria-label':'Save grants for Task client'}).props.onSubmit({preventDefault(){},currentTarget:{}}));expect(f.operation).toHaveBeenCalledExactlyOnceWith('program.setGrants',{fingerprint:'c'.repeat(64),records:[],operations:[]});
});

it.each(['offline','owner-change','unavailable'])('clears an already delivered program credential across %s',async reason=>{
 f.programFeed.data={programSetup:programData()};const fetch=vi.fn().mockResolvedValue(Response.json({ok:true,value:{token:privateBearer,fingerprint:'d'.repeat(64)}}));vi.stubGlobal('fetch',fetch);
 await act(async()=>{tree=create(h(Setup));});const event=await programForm();await act(async()=>tree.root.findByProps({'aria-label':'Create token'}).props.onSubmit(event));expect(JSON.stringify(tree.toJSON())).toContain(privateBearer);
 await act(async()=>{if(reason==='offline')f.programFeed.status='offline';else f.programFeed.data={programSetup:reason==='owner-change'?programData('other'):null};tree.update(h(Setup));});expect(JSON.stringify(tree.toJSON())).not.toContain(privateBearer);
 await act(async()=>{f.programFeed.status='live';f.programFeed.data={programSetup:programData()};tree.update(h(Setup));});expect(JSON.stringify(tree.toJSON())).not.toContain(privateBearer);expect(fetch).toHaveBeenCalledOnce();
});

it('uses the owner catalogue checkboxes and optional expiry in program issuance',async()=>{
 f.programFeed.data={programSetup:programData()};const fetch=vi.fn().mockResolvedValue(Response.json({ok:true,value:{token:privateBearer,fingerprint:'d'.repeat(64)}}));vi.stubGlobal('fetch',fetch);
 await act(async()=>{tree=create(h(Setup));});await programForm();
 const form=tree.root.findByProps({'aria-label':'Create token'});expect(form.findAllByType('input').filter((node:{props:{type?:string}})=>node.props.type==='checkbox').map((node:{props:{name:string;value:string}})=>[node.props.name,node.props.value])).toEqual([['records','tasks'],['records','projects'],['operations','tasks.command']]);
 vi.stubGlobal('FormData',class{get(name:string){return({label:'Expiring client',member:'sam',expiresAt:'2026-12-01T00:00:00Z'} as Record<string,string>)[name]??null;}getAll(name:string){return name==='records'?['tasks']:['tasks.command'];}});
 await act(async()=>form.props.onSubmit({preventDefault(){},currentTarget:{}}));expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({member:'sam',label:'Expiring client',expiresAt:'2026-12-01T00:00:00Z',records:['tasks'],operations:['tasks.command']});
 await act(async()=>tree.root.findByProps({'aria-label':'Create token'}).props.onSubmit({preventDefault(){},currentTarget:{}}));expect(fetch).toHaveBeenCalledOnce();
 await act(async()=>tree.root.findAllByType('button').find((node:{props:{children:unknown}})=>node.props.children==='Hide token').props.onClick());expect(tree.root.findByProps({'aria-label':'Create token'}).findByType('fieldset').props.disabled).toBe(false);
});
it('saves selected record and operation grants rather than clearing them',async()=>{
 f.programFeed.data={programSetup:programData()};vi.stubGlobal('FormData',class{getAll(name:string){return name==='records'?['projects']:['tasks.command'];}});await act(async()=>{tree=create(h(Setup));});
 await act(async()=>tree.root.findByProps({'aria-label':'Save grants for Task client'}).props.onSubmit({preventDefault(){},currentTarget:{}}));expect(f.operation).toHaveBeenCalledExactlyOnceWith('program.setGrants',{fingerprint:'c'.repeat(64),records:['projects'],operations:['tasks.command']});
});
it.each(['ended','inactive','offline','denied'] as const)('refuses program grant edits when %s',async reason=>{
 const data=programData();if(reason==='ended')data.tokens[0].ended=true;f.programFeed.data={programSetup:data};if(reason==='offline')f.programFeed.status='offline';if(reason==='denied')f.feed.data={householdSetup:null,boxes:[]};
 await act(async()=>{tree=create(h(Setup,{active:reason!=='inactive'}));});const forms=tree.root.findAllByProps({'aria-label':'Save grants for Task client'});
 if(reason==='denied')expect(forms).toHaveLength(0);else{expect(forms[0].findByType('fieldset').props.disabled).toBe(true);await act(async()=>forms[0].props.onSubmit({preventDefault(){},currentTarget:{}}));}expect(f.operation).not.toHaveBeenCalled();
});
it.each(['offline','unavailable'])('refuses program issuance when catalogue is %s',async reason=>{
 f.programFeed.data={programSetup:programData()};const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await act(async()=>{tree=create(h(Setup));});const event=await programForm();
 await act(async()=>{if(reason==='offline')f.programFeed.status='offline';else f.programFeed.data={programSetup:null};tree.update(h(Setup));});expect(tree.root.findAllByType('option').find((node:{props:{value?:string}})=>node.props.value==='program').props.disabled).toBe(true);
 await act(async()=>tree.root.findByProps({'aria-label':'Create token'}).props.onSubmit(event));expect(fetch).not.toHaveBeenCalled();
});
