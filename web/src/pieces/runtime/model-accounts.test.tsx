import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import {act,create} from 'react-test-renderer';
import type {DataQuerySnapshot} from '../../data/graphql';
import type {RuntimeAccount,AgentModel} from './model-accounts';
const f=vi.hoisted(()=>({snapshot:{} as DataQuerySnapshot<{modelAccounts:RuntimeAccount[];agentModels?:AgentModel[];agents?:{id:string;removedAt:string|null}[];deskTime?:{timezone:string}}>,query:vi.fn()}));
vi.mock('../../kit',async importOriginal=>({...await importOriginal<typeof import('../../kit')>(),Button:'button'}));
vi.mock('../../data/graphql',()=>({useDataQuery:(query:string)=>{f.query(query);return f.snapshot;}}));
import {RuntimeAccounts,runtimeAccountsQuery} from './model-accounts';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());f.query.mockClear();});
const detail:RuntimeAccount={__typename:'RuntimeAccountDetail',id:'private-account-id',label:'Main subscription',level:'plenty',owner:'alice',provider:'private-provider',usage:.58,usageReadAt:'2026-11-15T12:00:00Z',resetsAt:'2026-11-19T12:00:00Z',hasRoom:true,pendingSignIns:[],windows:[],logins:[],signedInOn:[{id:'opaque-machine',name:'Workshop'}]};
it('renders the actual detailed account selection and immediately replaces it with a coarse summary',async()=>{
 f.snapshot={status:'live',data:{modelAccounts:[detail]}};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 expect(f.query).toHaveBeenCalledWith(runtimeAccountsQuery);
 let text=JSON.stringify(tree.toJSON());for(const word of ['Main subscription','alice','private-provider','58%','Workshop','Yes'])expect(text).toContain(word);
 expect(text).not.toContain('opaque-machine');expect(text).not.toContain('private-account-id');
 f.snapshot={status:'live',data:{modelAccounts:[{__typename:'RuntimeAccountSummary',label:'Main subscription',level:'getting full'}]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 text=JSON.stringify(tree.toJSON());expect(text).toContain('getting full');expect(text).toContain('Main subscription');
 for(const privateWord of ['alice','private-provider','58%','Workshop','Has room','Signed in on'])expect(text).not.toContain(privateWord);
});
it('hides retained details whenever the live selection becomes unavailable and distinguishes empty from unread',async()=>{
 f.snapshot={status:'live',data:{modelAccounts:[detail]}};await act(async()=>{tree=create(h(RuntimeAccounts));});
 for(const status of ['loading','offline','denied'] as const){
  f.snapshot={status,data:{modelAccounts:[detail],agentModels:[{agent:'hidden-agent',model:'hidden-preference',position:0}]}};await act(async()=>tree.update(h(RuntimeAccounts)));
  const text=JSON.stringify(tree.toJSON());expect(text).not.toContain('private-provider');expect(text).not.toContain('Workshop');expect(text).not.toContain('hidden-preference');expect(text).not.toContain('No model accounts yet.');
 }
 f.snapshot={status:'live',data:{modelAccounts:[]}};await act(async()=>tree.update(h(RuntimeAccounts)));expect(JSON.stringify(tree.toJSON())).toContain('No model accounts yet.');
 f.snapshot={status:'live',data:{modelAccounts:[{...detail,usage:null,usageReadAt:null,resetsAt:null,hasRoom:false,signedInOn:[]}]}};await act(async()=>tree.update(h(RuntimeAccounts)));
 const text=JSON.stringify(tree.toJSON());expect(text).toContain('Not read yet');expect(text).toContain('Not available');expect(text).toContain('No machines');expect(text).not.toContain('58%');
});

it('orders each visible agents models and uses household time for account timestamps',async()=>{
 f.snapshot={status:'live',data:{modelAccounts:[detail],agents:[{id:'art',removedAt:null},{id:'mark',removedAt:'2026-11-19'}],deskTime:{timezone:'America/Chicago'},agentModels:[{agent:'art',model:'preferred',position:0},{agent:'art',model:'fallback',position:1},{agent:'mark',model:'mark-only',position:0}]}};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 expect(tree.root.findAllByType('li').map((node:{children:unknown[]})=>node.children.join(''))).toEqual(['preferred','fallback']);
 const text=JSON.stringify(tree.toJSON());expect(text).toContain('6:00 AM');
 f.snapshot={status:'live',data:{modelAccounts:[{__typename:'RuntimeAccountSummary',label:'Main subscription',level:'almost full'}],agents:[{id:'mark',removedAt:null}],agentModels:[{agent:'mark',model:'mark-only',position:0}]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(tree.root.findAllByType('li').map((node:{children:unknown[]})=>node.children.join(''))).toEqual(['mark-only']);
 expect(JSON.stringify(tree.toJSON())).not.toContain('preferred');expect(JSON.stringify(tree.toJSON())).not.toContain('private-provider');
});

it('keeps server tie order and reports a missing household zone honestly',async()=>{
 f.snapshot={status:'live',data:{modelAccounts:[detail],agents:[{id:'art',removedAt:null}],agentModels:[{agent:'art',model:'Z-order',position:0},{agent:'art',model:'a-order',position:0}]}};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 expect(tree.root.findAllByType('li').map((node:{children:unknown[]})=>node.children.join(''))).toEqual(['Z-order','a-order']);
 const text=JSON.stringify(tree.toJSON());expect(text).toContain('Nov 15, 2026');expect(text).not.toContain(' UTC');
});

it('keeps visible preferences while the agent roster is unavailable',async()=>{
 const data={modelAccounts:[detail],agentModels:[{agent:'art',model:'preferred',position:0}]};
 f.snapshot={status:'live',data};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 expect(tree.root.findAllByType('li').map(node=>node.children.join(''))).toEqual(['preferred']);
 f.snapshot={status:'live',data:{...data,agents:[]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(tree.root.findAllByType('li')).toHaveLength(0);
});

it('shows each provider window and sign-in only while detail remains visible',async()=>{
 const windows=[{window:'week',usage:.41,reserve:.05,usageReadAt:'2026-11-15T12:00:00Z',resetsAt:null}];
 const logins=[{reporting:true,needsSignIn:true,canRequest:true,box:{id:'box',name:'Workshop'},place:'containers' as const,harness:'Codex',state:'signed-out' as const,expiresAt:null,checkedAt:'2026-11-15T12:00:00Z'}];
 f.snapshot={status:'live',data:{modelAccounts:[{...detail,windows,logins}]}};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 expect(tree.root.findByType('meter').props.value).toBe(.41);
 expect(JSON.stringify(tree.toJSON())).toContain('Signed out');
 expect(JSON.stringify(tree.toJSON())).toContain('In houses');
 f.snapshot={status:'live',data:{modelAccounts:[{__typename:'RuntimeAccountSummary',label:'Main subscription',level:'plenty'}]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(tree.root.findAllByType('meter')).toHaveLength(0);
 expect(JSON.stringify(tree.toJSON())).not.toContain('Workshop');
});
