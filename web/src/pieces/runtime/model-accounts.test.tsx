import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import {act,create} from 'react-test-renderer';
import type {DataQuerySnapshot} from '../../data/graphql';
import type {RuntimeAccount,AgentModel} from './model-accounts';
const f=vi.hoisted(()=>({snapshot:{} as DataQuerySnapshot<{modelAccounts:RuntimeAccount[];agentModels?:AgentModel[];agents?:{id:string;removedAt:string|null}[];deskTime?:{timezone:string}}>,query:vi.fn()}));
vi.mock('../../kit',async importOriginal=>({...await importOriginal<typeof import('../../kit')>(),Button:'button'}));
vi.mock('../../data/graphql',()=>({useDataQuery:(query:string,variables?:unknown)=>{if(variables)f.query(query,variables);else f.query(query);return f.snapshot;}}));
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
 expect(tree.root.findAllByType('li').map((node:{children:unknown[]})=>node.children.join(''))).toEqual(['preferred · Primary','fallback']);
 const text=JSON.stringify(tree.toJSON());expect(text).toContain('6:00 AM');
 f.snapshot={status:'live',data:{modelAccounts:[{__typename:'RuntimeAccountSummary',label:'Main subscription',level:'almost full'}],agents:[{id:'mark',removedAt:null}],agentModels:[{agent:'mark',model:'mark-only',position:0}]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(tree.root.findAllByType('li').map((node:{children:unknown[]})=>node.children.join(''))).toEqual(['mark-only · Primary']);
 expect(JSON.stringify(tree.toJSON())).not.toContain('preferred');expect(JSON.stringify(tree.toJSON())).not.toContain('private-provider');
});

it('keeps server tie order and reports a missing household zone honestly',async()=>{
 f.snapshot={status:'live',data:{modelAccounts:[detail],agents:[{id:'art',removedAt:null}],agentModels:[{agent:'art',model:'Z-order',position:0},{agent:'art',model:'a-order',position:0}]}};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 expect(tree.root.findAllByType('li').map((node:{children:unknown[]})=>node.children.join(''))).toEqual(['Z-order · Primary','a-order']);
 const text=JSON.stringify(tree.toJSON());expect(text).toContain('Nov 15, 2026');expect(text).not.toContain(' UTC');
});

it('keeps visible preferences while the agent roster is unavailable',async()=>{
 const data={modelAccounts:[detail],agentModels:[{agent:'art',model:'preferred',position:0}]};
 f.snapshot={status:'live',data};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 expect(tree.root.findAllByType('li').map(node=>node.children.join(''))).toEqual(['preferred · Primary']);
 f.snapshot={status:'live',data:{...data,agents:[]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(tree.root.findAllByType('li')).toHaveLength(0);
});

it('shows each provider window and sign-in only while detail remains visible',async()=>{
 const windows=[{window:'week',usage:.41,reserve:.05,usageReadAt:'2026-11-15T12:00:00Z',resetsAt:null}];
 const logins=[{reporting:true,expired:false,needsSignIn:true,canRequest:true,box:{id:'box',name:'Workshop'},place:'containers' as const,harness:'Codex',state:'signed-out' as const,expiresAt:null,checkedAt:'2026-11-15T12:00:00Z'}];
 f.snapshot={status:'live',data:{modelAccounts:[{...detail,windows,logins}]}};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 expect(tree.root.findByType('meter').props.value).toBe(.41);
 const settings=tree.root.findByProps({'aria-label':'Settings'});
 expect(settings.findAllByType('dt').map(node=>node.children.join(''))).toEqual(['Label','Owner','Service','Configured machines','Week reserve']);
 expect(settings.findAllByType('dd').map(node=>node.children.join(''))).toEqual(['Main subscription','alice','private-provider','Workshop','5%']);
 expect(JSON.stringify(tree.toJSON())).toContain('Signed out');
 expect(JSON.stringify(tree.toJSON())).toContain('In houses');
 f.snapshot={status:'live',data:{modelAccounts:[{__typename:'RuntimeAccountSummary',label:'Main subscription',level:'plenty'}]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(tree.root.findAllByType('meter')).toHaveLength(0);
 expect(JSON.stringify(tree.toJSON())).not.toContain('Workshop');
});

it('updates the closed account row when sign-ins change and clears it on a visibility change',async()=>{
 const healthy={reporting:true,expired:false,needsSignIn:false,canRequest:false,box:{id:'a',name:'Studio'},place:'host' as const,harness:'codex',state:'signed-in' as const,expiresAt:null,checkedAt:'2026-11-15T12:00:00Z'};
 const missing={...healthy,box:{id:'b',name:'Library'},state:'signed-out' as const,needsSignIn:true};
 const offline={...healthy,box:{id:'c',name:'Workshop'},reporting:false};
 const account={...detail,logins:[healthy,missing,offline],pendingSignIns:[missing.box]};
 f.snapshot={status:'live',data:{modelAccounts:[account]}};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 const title=()=>tree.root.findAllByType('summary').map(node=>node.children.join('')).find(words=>words.includes('Main subscription'));
 expect(title()).toBe('Main subscription · alice · plenty · 1 signed in · 1 needs attention · 1 last known · Sign-in requested');
 f.snapshot={status:'live',data:{modelAccounts:[{...account,logins:[healthy,{...healthy,box:missing.box},offline],pendingSignIns:[]}]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(title()).toBe('Main subscription · alice · plenty · 2 signed in · 1 last known');
 f.snapshot={status:'live',data:{modelAccounts:[detail]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(title()).toContain('No sign-ins reported');
 f.snapshot={status:'live',data:{modelAccounts:[{__typename:'RuntimeAccountSummary',label:detail.label,level:detail.level}]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(title()).toBeUndefined();
 expect(JSON.stringify(tree.toJSON())).not.toContain('No sign-ins reported');
});

it('marks an open usage reading stale after one hour and clears the warning on refresh',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-15T12:59:59Z'));
 try{
  f.snapshot={status:'live',data:{modelAccounts:[detail]}};
  await act(async()=>{tree=create(h(RuntimeAccounts));});
  expect(JSON.stringify(tree.toJSON())).not.toContain('Stale reading');
  await act(async()=>{vi.advanceTimersByTime(1002);});
  expect(JSON.stringify(tree.toJSON())).toContain('Stale reading');
  f.snapshot={status:'live',data:{modelAccounts:[{...detail,usageReadAt:new Date().toISOString()}]}};
  await act(async()=>tree.update(h(RuntimeAccounts)));
  expect(JSON.stringify(tree.toJSON())).not.toContain('Stale reading');
 }finally{vi.useRealTimers();}
});

it('filters by visible owner and machines together with sign-in or capacity warnings',async()=>{
 const nearlyFull:RuntimeAccount={__typename:'RuntimeAccountSummary',label:'Shared account',level:'almost full'};
 const login={reporting:true,expired:false,needsSignIn:true,canRequest:false,box:{id:'observed',name:'Studio'},place:'host' as const,harness:'claude',state:'signed-out' as const,expiresAt:null,checkedAt:'2026-11-15T12:00:00Z'};
 const account={...detail,logins:[login],pendingSignIns:[{id:'waiting',name:'Library'}]};
 f.snapshot={status:'live',data:{modelAccounts:[account,nearlyFull,{__typename:'RuntimeAccountSummary',label:'Quiet account',level:'plenty'}]}};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 const search=async(value:string)=>act(async()=>tree.root.findByProps({type:'search'}).props.onChange({target:{value}}));
 await act(async()=>tree.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
 expect(JSON.stringify(tree.toJSON())).toContain('Shared account');
 expect(JSON.stringify(tree.toJSON())).not.toContain('Quiet account');
 for(const term of [' ALICE ','workshop','studio','library']){
  await search(term);const result=JSON.stringify(tree.toJSON());expect(result).toContain('Main subscription');expect(result).not.toContain('Shared account');
 }
 f.snapshot={status:'live',data:{modelAccounts:[{...account,logins:[{...login,reporting:false,needsSignIn:false}]}]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(JSON.stringify(tree.toJSON())).toContain('No matching subscriptions.');
 f.snapshot={status:'live',data:{modelAccounts:[{__typename:'RuntimeAccountSummary',label:'Main subscription',level:'almost full'}]}};
 await act(async()=>tree.update(h(RuntimeAccounts)));
 expect(JSON.stringify(tree.toJSON())).toContain('No matching subscriptions.');
 await search('main');expect(JSON.stringify(tree.toJSON())).toContain('Main subscription');
});

it('keeps all weekly readings in the household report, including updates while grouped by conversation',async()=>{
 const reset=new Date(Date.now()+86400000).toISOString();
 const group=(title:string)=>({key:title,title,share:.1,href:null});
 const week={window:'week',resetsAt:reset,usage:.3,unattributed:.2,agents:[group('Garden agent')],triggers:[],conversations:[group('Garden talk')]};
 const rows=[{...detail,weeklyUsage:[week]},{...detail,id:'other',label:'Second subscription',weeklyUsage:[week]}];
 f.snapshot={status:'live',data:{modelAccounts:rows}};
 await act(async()=>{tree=create(h(RuntimeAccounts));});
 const summary=tree.root.findAllByType('summary').find(node=>node.children.includes('Weekly usage across subscriptions'));
 await act(async()=>summary.parent.props.onToggle({currentTarget:{open:true}}));
 expect(f.query).toHaveBeenCalledWith(expect.stringContaining('WeeklySubscriptions'),{detailId:null});
 const report=()=>JSON.stringify(tree.toJSON());
 expect(report()).toContain('Garden agent');expect(report()).not.toContain('Garden talk');
 await act(async()=>tree.root.findByType('select').props.onChange({target:{value:'conversations'}}));
 expect(report()).toContain('Garden talk');expect(report()).not.toContain('Garden agent');
 const updated=[rows[0],{...rows[1],weeklyUsage:[{...week,usage:.6,conversations:[group('Second conversation')]}]}];
 f.snapshot={status:'live',data:{modelAccounts:updated}};await act(async()=>tree.update(h(RuntimeAccounts)));
 const headings=tree.root.findAllByType('h4').map(node=>node.children.join(''));
 expect(headings).toContain('Main subscription · week · 30% used');
 expect(headings).toContain('Second subscription · week · 60% used');
 expect(report()).toContain('Garden talk');expect(report()).toContain('Second conversation');
});
it('opens the weekly report with the subscription and retires it at reset without another write',async()=>{
 vi.useFakeTimers();
 try {
  const start=new Date('2026-11-18T00:00:00Z');
  vi.setSystemTime(start);
  const end=new Date(start.getTime()+60000).toISOString();
  const group={key:'art',title:'Weekly worker',share:.125,href:null};
  const account={...detail,weeklyUsage:[{window:'week',resetsAt:end,usage:.25,unattributed:.125,agents:[group],conversations:[],triggers:[]}]};
  f.snapshot={status:'live',data:{modelAccounts:[account]}};
  await act(async()=>{tree=create(h(RuntimeAccounts));});
  const reportVisible=()=>JSON.stringify(tree.toJSON()).includes('Weekly worker');
  expect(reportVisible()).toBe(false);
  const summary=tree.root.findAllByType('summary').find((node:{children:unknown[]})=>node.children.includes('Main subscription'));
  await act(async()=>summary.parent.props.onToggle({currentTarget:{open:true}}));
  expect(reportVisible()).toBe(true);
  expect(f.query).toHaveBeenCalledWith(expect.stringContaining('modelAccounts(detailId:$detailId)'),{detailId:detail.id});
  await act(async()=>{vi.advanceTimersByTime(60000);});
  expect(reportVisible()).toBe(false);
  expect(JSON.stringify(tree.toJSON())).toContain('No current weekly reading');
 } finally {vi.useRealTimers();}
});
