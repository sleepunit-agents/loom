import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, Suspense, type ComponentType } from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import type { DataQuerySnapshot } from '../../data/graphql';
import type { SettingsData } from './data';
import { settingsQuery } from './data';
import SettingsApp from './index';
const feed = vi.hoisted(() => ({ query: { status: 'loading' } as DataQuerySnapshot<SettingsData>, hook: vi.fn() }));
vi.mock('../attention/home-composer',()=>({HomeMessageComposer:(props:{suggestedText:string})=>h('textarea',{value:props.suggestedText,readOnly:true})}));
const requestedInput=()=>JSON.parse(tree.root.findByType('textarea').props.value.split('\n').slice(1).join('\n'));
vi.mock('../../data/graphql', () => ({ useDataQuery: (query: string) => { feed.hook(query);return query.includes('homeComms')?{status:'live',data:{homeComms:{member:'jonathan',agents:['art']},householdSetup:{defaultAgent:'art'}}}:feed.query; } }));
vi.mock('../../data', () => ({ useRecords() { throw Error('Legacy records used'); }, call() { throw Error('Legacy command used'); } }));
vi.mock('../../kit', () => ({Reader:'article',Title:'h1',Meta:'p',Facts:'dl',Fact:'dd',Section:'section',
  Button: (p: any) => h('button', p), Input: (p: any) => h('input', p),
  Split: (p: any) => h('main', {}, ...p.folders.map((f: any) => h('button', { key: f.id, onClick: () => p.onFolder(f.id) }, f.label)), p.list, p.reader ?? p.blank, h('button', { onClick: p.onBack }, p.backLabel)),
  List: (p: any) => h('div', {}, p.children), Row: (p: any) => h('button', { onClick: p.onClick }, p.title, p.meta, p.status),
  Empty: (p: any) => h('p', {}, p.title), Error: (p: any) => h('p', { role: 'alert' }, p.text), Loading: (p: any) => h('p', {}, p.label),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: any;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; feed.hook.mockClear(); vi.unstubAllGlobals(); });
const text = () => JSON.stringify(tree.toJSON());
function data(): SettingsData {
  return { secretsReader: { id: 'jonathan', defaultAnswer: 'ask' }, secrets: [{ name: 'API', description: 'Reads the forge', changedAt: '2026-11-14T12:00:00.000Z', changedBy: 'jonathan' }], secretGrants: [], secretRequests: [], secretRules: [], secretRuleAgents: [], secretUses: [], secretChanges: [] };
}
async function draw(path = '/p/settings-preview', go = vi.fn()) {
  await act(async () => { const app = <SettingsApp path={path} go={go} />; if (tree) tree.update(app); else tree = create(app); });
  return go;
}
it('the registered Settings app reads generated metadata and navigates to its write-only secret reader', async () => {
  feed.query = { status: 'live', data: data() }; const go = await draw();
  expect(feed.hook).toHaveBeenCalledWith(settingsQuery); expect(text()).toContain('Reads the forge');
  const row = tree.root.findAllByType('button').find((b: any) => b.children.includes('API'));
  await act(async () => row.props.onClick()); expect(go).toHaveBeenCalledWith('/p/settings-preview/item/secrets/API');
  await draw(go.mock.calls[0][0], go); expect(text()).toContain('The value is write-only.'); expect(text()).toContain('Household default: ask');
});
it.each(['loading', 'offline', 'denied'] as const)('hides retained secret metadata while %s', async status => {
  feed.query = { status: 'live', data: data() }; await draw('/p/settings-preview/item/secrets/API'); expect(text()).toContain('Reads the forge');
  feed.query = { status, data: data() }; await draw('/p/settings-preview/item/secrets/API'); expect(text()).not.toContain('Reads the forge'); expect(text()).not.toContain('API');
});
it('requires the authenticated member from the same selection and discards the old reader after a principal change', async () => {
  const initial = data(); feed.query = { status: 'live', data: initial }; await draw('/p/settings-preview/item/secrets/API');
  feed.query = { status: 'live', data: { ...initial, secretsReader: null } }; await draw('/p/settings-preview/item/secrets/API'); expect(text()).not.toContain('Reads the forge'); expect(text()).toContain('Household owners manage Settings'); expect(text()).not.toContain('Reconnect');
  feed.query = { status: 'live', data: { ...initial, secretsReader: { id: 'other', defaultAnswer: 'ask' }, secrets: [] } }; await draw('/p/settings-preview/item/secrets/API');
  expect(text()).not.toContain('Reads the forge'); expect(text()).toContain('This item is no longer available');
});
it('handles malformed selection ids and never requests a value field', async () => {
  feed.query = { status: 'live', data: data() }; await draw('/p/settings-preview/item/secrets/%');
  expect(text()).toContain('Choose an item'); expect(settingsQuery).not.toMatch(/\bvalue\b/);
});

it('opens an existing secret from the list while the add form is open',async()=>{
 feed.query={status:'live',data:data()};
 const go=await draw('/p/settings-preview/add');
 const row=tree.root.findAllByType('button').find((button:any)=>button.children.includes('API'));
 await act(async()=>row.props.onClick());
 expect(go).toHaveBeenCalledWith('/p/settings-preview/item/secrets/API');
});
it('opens the actual add form and clears its controls immediately when the reader feed is lost', async () => {
 feed.query={status:'live',data:data()};await draw('/p/settings-preview/add');
 expect(text()).toContain('Add a secret');expect(tree.root.findAllByType('input').filter((input: any) => input.props.type === 'password')).toHaveLength(1);
 feed.query={status:'offline',data:data()};await draw('/p/settings-preview/add');
 expect(tree.root.findAllByType('input').filter((input: any) => input.props.type === 'password')).toHaveLength(0);
});
it('mounts the household default in the selected Piece settings reader', async () => {
 feed.query={status:'live',data:data()};await draw('/p/settings-preview/item/pieces/secret-default');
 expect(text()).toContain('Review household default');
 feed.query={status:'live',data:{...data(),secretsReader:null}};await draw('/p/settings-preview/item/pieces/secret-default');
 expect(text()).not.toContain('Review household default');
});

it('replaces controls on a direct live-reader change retaining the same selected secret', async () => {
 feed.query={status:'live',data:data()};await draw('/p/settings-preview/item/secrets/API');
 const before=tree.root.findAllByType('input').find((input:any)=>input.props.type==='password');
 feed.query={status:'live',data:{...data(),secretsReader:{id:'another-owner',defaultAnswer:'ask'}}};await draw('/p/settings-preview/item/secrets/API');
 const after=tree.root.findAllByType('input').find((input:any)=>input.props.type==='password');expect(after).not.toBe(before);
});
it('routes the real app registry and Inbox request link to the live registered controls', async () => {
 const {appAt}=await import('../../apps');const path='/p/settings-preview/requests/pending',app=appAt(path);expect(app?.id).toBe('settings');
 feed.query={status:'live',data:{...data(),secretRequests:[{id:'pending',secret:'API',agent:'art',job:null,conversation:null,why:'Use it',state:'pending',minutes:5,answeredBy:null,always:false,askedAt:'2026-11-14T12:00:00Z',answeredAt:null}]}};
 await act(async()=>{tree=create(h(Suspense,{fallback:h('p',null,'Loading')},h(app!.Screen as ComponentType<{path:string;go:(path:string)=>void}>,{path,go:vi.fn()})));});
 expect(text()).toContain('Cancel request');expect(text()).toContain('Use it');
 const request=vi.fn<typeof fetch>(async()=>Response.json({ok:true,value:{saved:true}}));vi.stubGlobal('fetch',request);
 const allow=tree.root.findAllByType('button').find((button:any)=>button.children.includes('Allow'));
 await act(async()=>allow.props.onClick());
 expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][0]).toBe('/api/secrets/command');
 expect(JSON.parse(String(request.mock.calls[0][1]?.body)).input).toEqual({action:'answer',id:'pending',allow:true,always:false});
});

it('the registered rule form neither reads nor sends its sibling unsent password', async () => {
 const {appAt}=await import('../../apps');const path='/p/settings-preview/item/secrets/API',app=appAt(path)!;
 feed.query={status:'live',data:data()};const passwordRead=vi.fn(()=>{throw Error('Unsent password read');});
 const field=Object.defineProperty({},'value',{get:passwordRead,set(){throw Error('Unrelated password erased');}});
 const request=vi.fn<typeof fetch>(async()=>Response.json({ok:true,value:{saved:true}}));vi.stubGlobal('fetch',request);
 vi.stubGlobal('FormData',class{get(name:string){return ({answer:'auto',minutes:'10',on_request:'art',at_start:'mark'} as Record<string,string>)[name]??null;}});
 await act(async()=>{tree=create(h(Suspense,{fallback:h('p',null,'Loading')},h(app.Screen as ComponentType<{path:string;go:(path:string)=>void}>,{path,go:vi.fn()})),{createNodeMock:(element:any)=>element.type==='input'&&element.props.type==='password'?field:null});});
 const rule=tree.root.findAllByType('form').find((form:any)=>form.findAllByType('button').some((button:any)=>button.children.includes('Review rule')));
 await act(async()=>rule.props.onSubmit({preventDefault(){},currentTarget:{}}));
 expect(passwordRead).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
 expect(requestedInput()).toEqual({secret:'API',answer:'auto',minutes:10,agents:[{agent:'art',when:'on_request'},{agent:'mark',when:'at_start'}]});
});
