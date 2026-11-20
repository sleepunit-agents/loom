import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import type { DataQuerySnapshot } from '../../data/graphql';
import type { BridgesData } from './data';
import { bridgesQuery } from './data';
import BridgesApp from './index';
const feed = vi.hoisted(() => ({ query: { status: 'loading' } as DataQuerySnapshot<BridgesData>, hook: vi.fn() }));
vi.mock('../attention/home-composer',()=>({HomeMessageComposer:(props:{suggestedText:string})=>h('textarea',{value:props.suggestedText,readOnly:true})}));
const requestedInput=()=>JSON.parse(tree.root.findAllByType('textarea').find((n:any)=>n.props.readOnly).props.value.split('\n').slice(1).join('\n'));
vi.mock('../../data/graphql', () => ({ useDataQuery: (query: string) => { feed.hook(query); return query.includes('query LiveAgents')
  ? { status: 'live', data: { agents: [{ id: 'art', removedAt: null }, { id: 'mark', removedAt: '2026-11-19' }] } }
  : query.includes('homeComms')?{status:'live',data:{homeComms:{member:'jonathan',agents:['art']},householdSetup:{defaultAgent:'art'}}}:feed.query; } }));
vi.mock('../../data', () => ({ useRecords() { throw Error('Legacy records used'); }, call() { throw Error('Legacy command used'); } }));
vi.mock('../../kit', () => ({Reader:'article',Title:'h1',Meta:'p',Facts:'dl',Fact:'dd',Section:'section',
  Split: (p: any) => h('main', {}, ...p.folders.map((f: any) => h('button', { key: f.id, onClick: () => p.onFolder(f.id) }, f.label)), p.listAction,p.listTop,p.list, p.reader ?? p.blank, h('button', { onClick: p.onBack }, p.backLabel)),
  Button:(p:any)=>h('button',p,p.children), Input:(p:any)=>h('input',p),
  List: (p: any) => h('div', {}, p.children), Row: (p: any) => h('button', { onClick: p.onClick }, p.title, p.meta, p.status),
  Empty: (p: any) => h('p', {}, p.title), Error: (p: any) => h('p', { role: 'alert' }, p.text), Loading: (p: any) => h('p', {}, p.label),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: any;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; feed.hook.mockClear(); });
const text = () => JSON.stringify(tree.toJSON());
function data(): BridgesData {
  return { bridgeReader: { id: 'jonathan' }, bridgeActivity: [{ id: 'connection', received: 12, delivered: 10, held: 2 }], bridgeConnections: [{ id: 'connection', platform: 'slack', agent: 'art', workspace: 'Pond workspace', botUser: 'U-BOT', tokenSecret: 'bot-token', appSecret: 'app-token', enabled: true, state: 'connected', stateAt: '2026-11-14T12:00:00.000Z' }], bridgeChannelFilters: [], bridgeChannels: [], bridgePeople: [], bridgeSends: [] };
}
async function draw(path = '/p/bridges-preview', go = vi.fn()) {
  await act(async () => { const app = <BridgesApp path={path} go={go}/>; if (tree) tree.update(app); else tree = create(app); });
  return go;
}
it('the registered app reads generated rows itself and selects a connection through tile navigation', async () => {
  feed.query = { status: 'live', data: data() }; const go = await draw();
  expect(feed.hook).toHaveBeenCalledWith(bridgesQuery); expect(text()).toContain('Pond workspace');
  const row = tree.root.findAllByType('button').find((b: any) => b.children.includes('art · slack'));
  await act(async () => row.props.onClick());
  expect(go).toHaveBeenCalledWith('/p/bridges-preview/item/connections/connection');
  await draw(go.mock.calls[0][0], go); expect(text()).toContain('Bot token: '); expect(text()).toContain('bot-token'); expect(text()).toContain('12');
});
it.each(['loading', 'offline', 'denied'] as const)('hides retained rows while %s', async status => {
  feed.query = { status: 'live', data: data() }; await draw(); expect(text()).toContain('Pond workspace');
  feed.query = { status, data: data() }; await draw(); expect(text()).not.toContain('Pond workspace'); expect(text()).not.toContain('bot-token');
});
it('requires the query member and drops a previous reader on a new principal', async () => {
  const initial = data(); feed.query = { status: 'live', data: initial }; await draw('/p/bridges-preview/item/connections/connection');
  expect(text()).toContain('bot-token');
  feed.query = { status: 'live', data: { ...initial, bridgeReader: null } }; await draw(); expect(text()).not.toContain('Pond workspace');
  feed.query = { status: 'live', data: { ...initial, bridgeReader: { id: 'other' }, bridgeConnections: [] } }; await draw();
  expect(text()).not.toContain('Pond workspace'); expect(text()).not.toContain('bot-token');
});
it('handles malformed selection ids without guessing a record', async () => {
  feed.query = { status: 'live', data: data() }; await draw('/p/bridges-preview/item/connections/%');
  expect(text()).toContain('Choose an item'); expect(text()).not.toContain('Bot token: ');
});
it('shows actual controls only for the live household owner and withdraws them on demotion',async()=>{
 const initial=data();feed.query={status:'live',data:{...initial,bridgeReader:{id:'jonathan',manage:true}}};await draw('/p/bridges-preview/item/connections/connection');expect(text()).toContain('Review connection');
 feed.query={status:'live',data:{...initial,bridgeReader:{id:'jonathan',manage:false}}};await draw('/p/bridges-preview/item/connections/connection');expect(text()).not.toContain('Review connection');
});
it('prepares the selected connection for the owner to review before sending',async()=>{
 const initial=data();feed.query={status:'live',data:{...initial,bridgeReader:{id:'jonathan',manage:true}}};
 const request=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify({ok:false,message:'PRIVATE upstream text'}),{status:503}));
 vi.stubGlobal('fetch',request);vi.stubGlobal('FormData',class{constructor(private form:{fields:Record<string,string>}){}get(name:string){return this.form.fields[name]??null;}has(name:string){return name in this.form.fields;}});
 try{
  await draw('/p/bridges-preview/item/connections/connection');
  const forms=tree.root.findAllByType('form'),form=forms[forms.length-1];
  await act(async()=>{const event={preventDefault(){},currentTarget:{fields:{platform:'slack',workspace:'w',agent:'forged-agent',botUser:'bot',tokenSecret:'BOT_NAME',appSecret:'APP_NAME',enabled:'on',only:'one\ntwo',ignore:'noise'}}};form.props.onSubmit(event);form.props.onSubmit(event);});
  expect(request).not.toHaveBeenCalled();
  expect(requestedInput()).toEqual({action:'connection',id:'connection',platform:'slack',workspace:'Pond workspace',agent:'art',botUser:'U-BOT',tokenSecret:'BOT_NAME',appSecret:'APP_NAME',only:['one','two'],ignore:['noise'],enabled:true});
  expect(text()).not.toContain('PRIVATE upstream');
  await act(async()=>form.props.onChange());
  expect(text()).not.toContain('Bridge change request');
 }finally{vi.unstubAllGlobals();}
});
it('registered send review exposes no release for uncertain delivery and submits dismissal',async()=>{
 const initial=data();initial.bridgeSends=[{id:'send',incoming:'in',connection:'connection',channel:'room',thread:null,text:'Reply',state:'uncertain',createdAt:'2026-11-14T12:00:00.000Z'}];feed.query={status:'live',data:{...initial,bridgeReader:{id:'jonathan',manage:true}}};
 const request=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify({ok:true,value:{saved:true}})));vi.stubGlobal('fetch',request);
 try{await draw('/p/bridges-preview/item/sends/send');expect(text()).not.toContain('Release send');const button=tree.root.findAllByType('button').find((b:any)=>b.children.includes('Dismiss send'));await act(async()=>button.props.onClick());expect(JSON.parse(String(request.mock.calls[0][1]?.body)).input).toEqual({action:'review',id:'send',decision:'dismiss'});}finally{vi.unstubAllGlobals();}
});
it.each(['channels','people'] as const)('keeps the selected %s composite identity while editing its settings',async folder=>{
 const initial=data();initial.bridgeChannels=[{platform:'discord',workspace:'original',channel:'room',answers:'art',botsMayTalk:false}];initial.bridgePeople=[{platform:'discord',workspace:'original',user:'outside',member:'jonathan'}];feed.query={status:'live',data:{...initial,bridgeReader:{id:'jonathan',manage:true}}};
 const request=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify({ok:true,value:{saved:true}})));vi.stubGlobal('fetch',request);vi.stubGlobal('FormData',class{constructor(private form:{fields:Record<string,string>}){}get(name:string){return this.form.fields[name]??null;}has(name:string){return name in this.form.fields;}});
 try{
  const key=JSON.stringify(['discord','original',folder==='channels'?'room':'outside']);await draw('/p/bridges-preview/item/'+folder+'/'+encodeURIComponent(key));const forms=tree.root.findAllByType('form');
  await act(async()=>forms[forms.length-1].props.onSubmit({preventDefault(){},currentTarget:{fields:{platform:'slack',workspace:'forged-key',channel:'forged',user:'forged',answers:'art',member:'other',botsMayTalk:'on'}}}));
  expect(request).not.toHaveBeenCalled();expect(requestedInput()).toEqual(folder==='channels'?{action:'channel',platform:'discord',workspace:'original',channel:'room',answers:'art',botsMayTalk:true}:{action:'person',platform:'discord',workspace:'original',user:'outside',member:'other'});
 }finally{vi.unstubAllGlobals();}
});
it.each(['connections','channels','people'] as const)('creates %s through its registered folder form',async folder=>{
 const initial=data();feed.query={status:'live',data:{...initial,bridgeReader:{id:'jonathan',manage:true}}};
 const request=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify({ok:true,value:{saved:true}})));vi.stubGlobal('fetch',request);vi.stubGlobal('FormData',class{constructor(private form:{fields:Record<string,string>}){}get(name:string){return this.form.fields[name]??null;}has(name:string){return name in this.form.fields;}});
 try{
  const go=await draw('/p/bridges-preview/'+folder);
  await act(async()=>tree.root.findAllByType('button').find((b:any)=>String(b.props.children).startsWith('New ')).props.onClick());
  expect(go).toHaveBeenCalledWith('/p/bridges-preview/new/'+folder);
  await draw(go.mock.calls[0][0]);
  await act(async()=>tree.root.findAllByType('form')[0].props.onSubmit({preventDefault(){},currentTarget:{fields:{platform:'discord',workspace:'w',agent:'forged-agent',botUser:'bot',tokenSecret:'BOT_NAME',enabled:'on',channel:'room',answers:'art',user:'outside',member:'jonathan'}}}));
  expect(request).not.toHaveBeenCalled();const input=requestedInput();
  expect(input.action).toBe(folder==='connections'?'connection':folder==='channels'?'channel':'person');
  expect(input.workspace).toBe('w');if(folder==='connections')expect(input.id).toMatch(/^[0-9a-f-]{36}$/);
 }finally{vi.unstubAllGlobals();}
});
it.each(['Disconnect','Remove channel rule','Remove person link','Release send','Dismiss send'])('registered control %s submits its intended owner decision',async label=>{
 const initial=data();initial.bridgeChannels=[{platform:'discord',workspace:'w',channel:'room',answers:'art',botsMayTalk:false}];initial.bridgePeople=[{platform:'discord',workspace:'w',user:'outside',member:'jonathan'}];initial.bridgeSends=[{id:'send',incoming:'in',connection:'connection',channel:'room',thread:null,text:'Reply',state:'held',createdAt:'2026-11-14T12:00:00.000Z'}];feed.query={status:'live',data:{...initial,bridgeReader:{id:'jonathan',manage:true}}};
 const request=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify({ok:true,value:{saved:true}})));vi.stubGlobal('fetch',request);
 try{
  const selected=label==='Disconnect'?'connections/connection':label==='Remove channel rule'?'channels/'+encodeURIComponent(JSON.stringify(['discord','w','room'])):label==='Remove person link'?'people/'+encodeURIComponent(JSON.stringify(['discord','w','outside'])):'sends/send';
  await draw('/p/bridges-preview/item/'+selected);const button=tree.root.findAllByType('button').find((b:any)=>b.children.includes(label));await act(async()=>button.props.onClick());
  const send=label==='Release send'||label==='Dismiss send';
  expect(request).toHaveBeenCalledTimes(send?1:0);
  const input=send?JSON.parse(String(request.mock.calls[0][1]?.body)).input:requestedInput();
  expect(input).toEqual(label==='Disconnect'?{action:'disconnect',id:'connection'}:label==='Remove channel rule'?{action:'removeChannel',platform:'discord',workspace:'w',channel:'room'}:label==='Remove person link'?{action:'removePerson',platform:'discord',workspace:'w',user:'outside'}:{action:'review',id:'send',decision:label==='Release send'?'release':'dismiss'});if(send)expect(text()).toContain('Saved.');
 }finally{vi.unstubAllGlobals();}
});

it('locks existing connection identity while leaving new connection identity fields editable',async()=>{
 const initial=data();feed.query={status:'live',data:{...initial,bridgeReader:{id:'jonathan',manage:true}}};for(const [path,fixed] of [['item/connections/connection',true],['new/connections',false]] as const){
  await draw('/p/bridges-preview/'+path);
  const forms=tree.root.findAllByType('form');expect(forms).toHaveLength(1);
  const form=forms[0];
  expect(form.findAllByType('select')[0].props.disabled).toBe(fixed);
  for(const name of ['workspace','botUser'])expect(form.findAllByType('input').find((input:any)=>input.props.name===name).props.readOnly).toBe(fixed);
  if(fixed)expect(form.findAllByType('input').find((input:any)=>input.props.name==='agent').props.readOnly).toBe(true);
  else expect(form.findByProps({name:'agent'}).findAllByType('option').map((option:any)=>option.props.children)).toEqual(['Choose an agent','art']);
 }
});
