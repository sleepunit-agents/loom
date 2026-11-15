import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, Suspense, type ReactNode } from 'react';
// @ts-expect-error The renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import type { ApprovalsResult, ChangesResult } from './work-query';
const feed = vi.hoisted(() => ({ status: 'live', ownerStatus:'live', owner:false, refresh:false, approvals: {} as ApprovalsResult, changes: {} as ChangesResult }));
vi.mock('./graphql', () => ({ useDataQuery: (query: string) => ({ status: query.includes('WorkAnswerOwner') ? feed.ownerStatus : feed.status, data: query.includes('WorkAnswerOwner') ? {workAnswerOwner:feed.owner,workChangesRefresh:feed.refresh} : query.includes('WorkMergeRequests') ? {approvals:feed.approvals.approvals} : query.includes('ApprovalsView') ? feed.approvals : feed.changes }) }));
vi.mock('../kit', () => Object.fromEntries(['Split', 'List', 'Row', 'Empty', 'Error', 'Loading', 'Button', 'Input'].map(name => [name, (props: { children?: ReactNode; reader?: ReactNode; list?: ReactNode; search?: ReactNode; listTop?: ReactNode }) => h(name, Object.fromEntries(Object.entries(props).filter(([key]) => !['children', 'reader', 'list', 'search', 'blank', 'folders', 'listTop'].includes(key))), props.children, ...(name === 'Split' ? [props.search, props.listTop, props.list, props.reader] : []))])));
import { approvalsApp } from '../pieces/approvals/registration';
import { changesApp } from '../pieces/changes/registration';
import { ApprovalsApp, ChangesApp, LiveApprovalCard, LiveChangeCard } from './work-views';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); feed.status = 'live'; feed.owner=false; feed.refresh=false; feed.ownerStatus='live'; vi.unstubAllGlobals(); });
function fixture() {
  const before = { on: true, send_outside: false, outside_address: '', keep_days: 7 };
  const after = { ...before, keep_days: 1 };
  feed.approvals = { approvals: [{ id: 'a-one', kind: 'setting', target: 'measuring', what: 'Change measuring', why: 'Keep less', agent: 'art', project: null, member: null, conversation: null, state: 'pending', ask: 'Keep one day?', ifYes: 'Keep one', ifNo: 'Keep seven', details: JSON.stringify({ before, after }), changeSummary: `Measuring settings change ${JSON.stringify(before)} → ${JSON.stringify(after)}`, askedAt: '2026-11-14T00:00:00Z', decidedBy: null, expiresAt: null }], approvalRules: [], approvalNotices: [{ id: 'n-one', agent: 'art', kind: 'command', target: 'fixture', what: 'Current reported step', at: '2026-11-14T00:00:00Z' }], approvalRecord: [] };
  feed.changes = { changes: [{ id: 'c-one', repository: 'acme/app', number: 1, title: 'Current change', body: '', url: 'https://example.test/1', state: 'open', draft: false, authorLogin: 'sam', project: null, agent: 'art', branch: 'work', headCommit: 'first-head', baseBranch: 'next', checks: 'passing', review: 'approved', mergeable: 'yes', waitingOn: 'you', openedAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z', closedAt: null }], changeChecks: [], changePeople: [], changeTasks: [], changeSync: [] };
}
const words = () => JSON.stringify(tree.toJSON());
async function draw(node: ReactNode) { await act(async () => { tree = create(node); }); }
async function selectRow() { await act(async () => tree.root.findByType('Row').props.onClick()); }

it('the registered lazy tiles actually render the generated shared rows', async () => {
  fixture();
  await draw(h(Suspense, { fallback: 'Opening' }, h(approvalsApp.Screen, {})));
  expect(words()).toContain('Change measuring');
  await selectRow();
  expect(words()).toContain('Keep one day?');
  expect(words()).toContain('Measuring settings change');
  expect(tree.root.findAllByType('Button')).toHaveLength(0);
  await act(async () => tree.update(h(Suspense, { fallback: 'Opening' }, h(changesApp.Screen, {}))));
  expect(words()).toContain('Current change');
  await selectRow();
  expect(words()).toContain('first-head');
});

it('tile and inline cards follow the same current answer/head and clear retained rows on disconnect', async () => {
  fixture();
  const allow = vi.fn(async () => {}), deny = vi.fn(async () => {}), answer = vi.fn(async () => {});
  await draw(h(ApprovalsApp, { timezone: 'America/Chicago', actions: { allow, deny } }));
  await selectRow();
  await act(async () => tree.root.findAllByType('Button').find((button: { props: { children: string } }) => button.props.children === 'Allow').props.onClick());
  expect(allow).toHaveBeenCalledExactlyOnceWith('a-one');
  await act(async () => tree.update(h(LiveApprovalCard, { id: 'a-one', actions: { allow, deny } })));
  expect(words()).toContain('Keep one day?');
  expect(words()).toContain('Measuring settings change');
  feed.approvals = { ...feed.approvals, approvals: [{ ...feed.approvals.approvals[0], state: 'denied' }] };
  await act(async () => tree.update(h(LiveApprovalCard, { id: 'a-one', actions: { allow, deny } })));
  expect(words()).toContain('denied');
  expect(tree.root.findAllByType('Button')).toHaveLength(0);
  await act(async () => tree.update(h(ChangesApp, { actions: { refresh: vi.fn(), answer } })));
  await selectRow();
  feed.changes = { ...feed.changes, changes: [{ ...feed.changes.changes[0], headCommit: 'current-head' }] };
  await act(async () => tree.update(h(ChangesApp, { actions: { refresh: vi.fn(), answer } })));
  await act(async () => tree.root.findAllByType('Button').find((button: { props: { children: string } }) => button.props.children === 'Yes, merge it').props.onClick());
  expect(answer).toHaveBeenCalledExactlyOnceWith('c-one', 'current-head', 'yes');
  for (const status of ['offline', 'denied', 'loading']) {
    feed.status = status;
    for (const node of [h(ApprovalsApp, {}), h(ChangesApp, {}), h(LiveApprovalCard, { id: 'a-one' }), h(LiveChangeCard, { id: 'c-one', open: vi.fn() })]) {
      await act(async () => tree.update(node));
      expect(words()).not.toContain('Keep one day?');
      expect(words()).not.toContain('Current change');
      expect(tree.root.findAllByType('Button')).toHaveLength(0);
    }
  }
});

it('opens the exact change from a Comms deep link and follows shell navigation and back', async () => {
  fixture();
  const id = 'github:acme/app#3';
  feed.changes.changes[0] = { ...feed.changes.changes[0], id };
  const go = vi.fn();
  const route = `/p/changes-preview/change/${encodeURIComponent(id)}`;
  await draw(h(ChangesApp, { path: route, go }));
  expect(words()).toContain('first-head');
  await act(async () => tree.root.findByType('Split').props.onBack());
  expect(go).toHaveBeenLastCalledWith('/p/changes-preview');
  await act(async () => tree.update(h(ChangesApp, { path: '/p/changes-preview', go })));
  expect(words()).not.toContain('first-head');
  await selectRow();
  expect(go).toHaveBeenLastCalledWith(route);
  await act(async () => tree.update(h(ChangesApp, { path: route, go })));
  expect(words()).toContain('first-head');
  await act(async () => tree.root.findByType('Split').props.onFolder('you'));
  expect(go).toHaveBeenLastCalledWith('/p/changes-preview/you');
  for (const path of ['/p/changes-preview/change/%broken', '/p/changes-preview/change/missing', '/p/changes-preview/change/']) {
    await act(async () => tree.update(h(ChangesApp, { path, go })));
    expect(words()).not.toContain('first-head');
  }
});

it('linked work opens the Tasks reader route and unavailability withdraws the deep-linked reader', async () => {
  fixture();
  feed.changes.changeTasks = [{ change: 'c-one', task: 't-42', taskRow: { id: 't-42', title: 'Linked task', status: 'open' } }];
  const go = vi.fn();
  const node = h(ChangesApp, { go });
  await draw(node);
  await selectRow();
  await act(async () => tree.update(h(ChangesApp, { path: '/p/changes-preview/change/c-one', go })));
  const linked = tree.root.findAllByType('Row').find((row: { props: { title: string } }) => row.props.title === 'Linked task');
  await act(async () => linked.props.onClick());
  expect(go).toHaveBeenLastCalledWith('/p/tasks-preview/task/t-42');
  for (const status of ['offline', 'denied', 'loading']) {
    feed.status = status;
    await act(async () => tree.update(h(ChangesApp, { path: '/p/changes-preview/change/c-one', go })));
    expect(words()).not.toContain('first-head');
    expect(words()).not.toContain('Linked task');
  }
});


it('opens approval and reported-step links from Attention and follows shell folder navigation', async () => {
  fixture();
  const id = 'a-one/encoded?';
  feed.approvals.approvals[0] = { ...feed.approvals.approvals[0], id };
  const go = vi.fn();
  const route = `/p/approvals-preview/approval/${encodeURIComponent(id)}`;
  await draw(h(ApprovalsApp, { path: route, go }));
  expect(words()).toContain('Keep one day?');
  await act(async () => tree.root.findByType('Split').props.onBack());
  expect(go).toHaveBeenLastCalledWith('/p/approvals-preview');
  await act(async () => tree.update(h(ApprovalsApp, { path: '/p/approvals-preview', go })));
  expect(words()).not.toContain('Keep one day?');
  await selectRow();
  expect(go).toHaveBeenLastCalledWith(route);
  await act(async () => tree.update(h(ApprovalsApp, { path: route, go })));
  await act(async () => tree.root.findByType('Split').props.onFolder('notices'));
  expect(go).toHaveBeenLastCalledWith('/p/approvals-preview/notices');
  await act(async () => tree.update(h(ApprovalsApp, { path: '/p/approvals-preview/notices', go })));
  expect(tree.root.findByType('Split').props.folder).toBe('notices');
  expect(words()).toContain('Current reported step');
  expect(words()).not.toContain('Keep one day?');
  for (const folder of ['history', 'rules', 'pending']) {
    await act(async () => tree.root.findByType('Split').props.onFolder(folder));
    const path = folder === 'pending' ? '/p/approvals-preview' : `/p/approvals-preview/${folder}`;
    expect(go).toHaveBeenLastCalledWith(path);
    await act(async () => tree.update(h(ApprovalsApp, { path, go })));
    expect(tree.root.findByType('Split').props.folder).toBe(folder);
  }
  for (const path of ['/p/approvals-preview/approval/%broken', '/p/approvals-preview/approval/missing', '/p/approvals-preview/approval/']) {
    await act(async () => tree.update(h(ApprovalsApp, { path, go })));
    expect(words()).not.toContain('Keep one day?');
  }
});

it('approval deep links show the current answer and withdraw the reader when unavailable', async () => {
  fixture();
  const node = h(ApprovalsApp, { path: '/p/approvals-preview/approval/a-one', go: vi.fn() });
  await draw(node);
  expect(words()).toContain('Keep one day?');
  feed.approvals.approvals[0] = { ...feed.approvals.approvals[0], state: 'denied', ask: 'Current question' };
  await act(async () => tree.update(h(ApprovalsApp, { path: '/p/approvals-preview/approval/a-one', go: vi.fn() })));
  expect(words()).toContain('Current question');
  expect(words()).toContain('denied');
  for (const status of ['offline', 'denied', 'loading']) {
    feed.status = status;
    await act(async () => tree.update(h(ApprovalsApp, { path: '/p/approvals-preview/approval/a-one', go: vi.fn() })));
    expect(words()).not.toContain('Current question');
    expect(words()).not.toContain('Measuring settings change');
    expect(tree.root.findAllByType('Button')).toHaveLength(0);
  }
});


it('restores Changes folders from shell routes, including encoded projects and base navigation', async () => {
  fixture();
  const project = 'pond / field?';
  feed.changes.changes[0] = { ...feed.changes.changes[0], project };
  feed.changes.changes.push({ ...feed.changes.changes[0], id: 'c-other', title: 'Other project change', project: 'other', waitingOn: 'ci' });
  const go = vi.fn();
  for (const [folder, path] of [
    ['you', '/p/changes-preview/you'], ['lately', '/p/changes-preview/lately'],
    [`project:${project}`, `/p/changes-preview/project/${encodeURIComponent(project)}`], ['all', '/p/changes-preview'],
  ]) {
    await draw(h(ChangesApp, { path, go }));
    expect(tree.root.findByType('Split').props.folder).toBe(folder);
    expect(words().includes('Other project change')).toBe(folder === 'all' || folder === 'lately');
    await act(async () => tree.root.findByType('Split').props.onFolder(folder));
    expect(go).toHaveBeenLastCalledWith(path);
    await act(async () => tree.unmount());
  }
  await draw(h(ChangesApp, { path: '/p/changes-preview/project/%broken', go }));
  expect(tree.root.findByType('Split').props.folder).toBe('all');
  expect(words()).toContain('Other project change');
});

it('restores Changes folder selection on browser back and forward without a shell callback', async () => {
  fixture();
  const location = { pathname: '/p/changes-preview/you' };
  let pop: (() => void) | undefined;
  const removeEventListener = vi.fn();
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { pushState: vi.fn((_state, _unused, path) => { location.pathname = path; }) });
  vi.stubGlobal('window', { addEventListener: (_event: string, listener: () => void) => { pop = listener; }, removeEventListener });
  try {
    await draw(h(ChangesApp, {}));
    expect(tree.root.findByType('Split').props.folder).toBe('you');
    await act(async () => tree.root.findByType('Split').props.onFolder('lately'));
    expect(location.pathname).toBe('/p/changes-preview/lately');
    expect(tree.root.findByType('Split').props.folder).toBe('lately');
    for (const [path, folder] of [['/p/changes-preview/you', 'you'], ['/p/changes-preview/lately', 'lately']]) {
      location.pathname = path;
      await act(async () => pop?.());
      expect(tree.root.findByType('Split').props.folder).toBe(folder);
    }
    await act(async () => tree.unmount());
    expect(removeEventListener).toHaveBeenCalledWith('popstate', pop);
  } finally { await act(async () => tree.unmount()); vi.unstubAllGlobals(); }
});

it('binds actual default approval answers only for current live owner metadata and hides them on demotion', async () => {
  fixture(); const request=vi.fn<typeof fetch>(async (_url,init)=>Response.json({ok:true,value:{id:JSON.parse(String(init!.body)).input.id}})); vi.stubGlobal('fetch',request);
  feed.owner=true; await draw(h(LiveApprovalCard,{id:'a-one'}));
  await act(async () => tree.root.findAllByType('Button').find((button: {props:{children:string}})=>button.props.children==='Allow').props.onClick());
  await expect.poll(()=>request.mock.calls.length).toBe(1);
  await expect.poll(async()=>{await act(async()=>{});return tree.root.findAllByType('Button').find((button:{props:{children:string;disabled:boolean}})=>button.props.children==='Allow')?.props.disabled;}).toBe(false);
  expect(words()).toContain('pending'); expect(tree.root.findAllByType('Error')).toHaveLength(0);
  expect(request.mock.calls[0][0]).toBe('/api/approvals/answer');
  expect(JSON.parse(String(request.mock.calls[0][1]!.body)).input).toEqual({id:'a-one',answer:'allow'});
  feed.owner=false; await act(async () => tree.update(h(LiveApprovalCard,{id:'a-one'})));
  expect(tree.root.findAllByType('Button')).toHaveLength(0);
});
it('offers merge answers only for the current head, agent and project request and never invents a refresh operation', async () => {
  fixture(); feed.owner=true;
  await draw(h(ChangesApp,{})); await selectRow();
  expect(tree.root.findAllByType('Button')).toHaveLength(0);
  const change=feed.changes.changes[0];
  feed.approvals.approvals=[{...feed.approvals.approvals[0],id:'a-merge',kind:'merge',target:`${change.id}@${change.headCommit}`,agent:change.agent!,project:change.project,operation:null} as typeof feed.approvals.approvals[number]];
  await act(async () => tree.update(h(ChangesApp,{})));
  expect(tree.root.findAllByType('Button').map((button:{props:{children:string}})=>button.props.children)).toEqual(['Yes, merge it','Not yet']);
  const matching=feed.approvals.approvals[0];
  for (const mismatch of [{target:`${change.id}@other-head`},{agent:'other-agent'},{project:'other-project'},{operation:'not-a-merge'},{state:'allowed'},{state:'denied'},{state:'used'},{state:'withdrawn'},{state:'expired'}]) {
    feed.approvals.approvals=[{...matching,...mismatch} as typeof matching];
    await act(async () => tree.update(h(ChangesApp,{})));
    expect(tree.root.findAllByType('Button')).toHaveLength(0);
  }
});

it('hides default controls when only owner metadata loses liveness while record data remains live', async () => {
  fixture(); feed.owner=true;
  for (const status of ['loading','offline','denied','error']) {
    feed.ownerStatus='live'; await draw(h(LiveApprovalCard,{id:'a-one'}));
    expect(tree.root.findAllByType('Button').map((button:{props:{children:string}})=>button.props.children)).toEqual(['Allow','Deny']);
    feed.ownerStatus=status; await act(async()=>tree.update(h(LiveApprovalCard,{id:'a-one'})));
    expect(words()).toContain('Keep one day?');
    expect(tree.root.findAllByType('Button')).toHaveLength(0);
    await act(async()=>tree.unmount());
  }
});

it('offers configured Refresh only to a live owner and sends one explicit native request',async()=>{
  fixture();feed.owner=true;feed.refresh=true;
  const request=vi.fn(async()=>Response.json({ok:true,value:{refreshed:true}}));vi.stubGlobal('fetch',request);
  await draw(h(ChangesApp,{}));
  const refresh=()=>tree.root.findAllByType('Button').find((button:{props:{children:string}})=>button.props.children==='Refresh');
  expect(refresh()).toBeDefined();await act(async()=>refresh()!.props.onClick());
  expect(request).toHaveBeenCalledExactlyOnceWith('/api/changes/refresh',expect.objectContaining({body:JSON.stringify({input:{}}),credentials:'same-origin'}));
  feed.refresh=false;await act(async()=>tree.update(h(ChangesApp,{})));expect(refresh()).toBeUndefined();
  feed.refresh=true;feed.owner=false;await act(async()=>tree.update(h(ChangesApp,{})));expect(refresh()).toBeUndefined();
  feed.owner=true;feed.ownerStatus='offline';await act(async()=>tree.update(h(ChangesApp,{})));expect(refresh()).toBeUndefined();
});

it('retains canonical records during pending Refresh and after acknowledgment until publication',async()=>{
  fixture();feed.owner=true;feed.refresh=true;
  let finish!:(response:Response)=>void;
  const request=vi.fn(()=>new Promise<Response>(done=>{finish=done;}));vi.stubGlobal('fetch',request);
  await draw(h(ChangesApp,{}));
  await act(async()=>tree.root.findAllByType('Button').find((button:{props:{children:string}})=>button.props.children==='Refresh')!.props.onClick());
  expect(request).toHaveBeenCalledTimes(1);expect(words()).toContain('Current change');expect(feed.changes.changes[0].title).toBe('Current change');
  await act(async()=>finish(Response.json({ok:true,value:{refreshed:true}})));
  expect(words()).toContain('Current change');expect(feed.changes.changes[0].title).toBe('Current change');
  feed.changes={...feed.changes,changes:[{...feed.changes.changes[0],title:'Canonical refreshed change'}]};
  await act(async()=>tree.update(h(ChangesApp,{})));
  expect(words()).toContain('Canonical refreshed change');expect(words()).not.toContain('Current change');
});

const tempoAnswerCases=['app','inline'].flatMap(surface=>[true,false].flatMap(allow=>[true,false].map(success=>({surface,allow,success}))));
it.each(tempoAnswerCases)('awaits the actual $surface Tempo answer (allow=$allow, success=$success)',async({surface,allow,success})=>{
 fixture();feed.owner=true;const card=feed.approvals.approvals[0];
 Object.assign(card,{target:'tempo:person:sam',details:JSON.stringify({who:{kind:'person',id:'sam'},before:{settleSeconds:5,dimDays:1,muteDays:7},after:{settleSeconds:60,dimDays:1,muteDays:7}}),changeSummary:'Tempo for person sam: settle 5 → 60 seconds; dim 1 → 1 days; mute 7 → 7 days'});
 const selected={...card,id:'a-two',what:'Second Tempo timing',ask:'Second timing change?'};feed.approvals.approvals=[card,selected];
 let accept!:()=>void,refuse!:()=>void;
 const request=vi.fn((_url:string,_options:RequestInit)=>new Promise((resolve,reject)=>{accept=()=>resolve({ok:true,json:async()=>({ok:true,value:{id:selected.id}})});refuse=()=>reject(new Error('refused'));}));vi.stubGlobal('fetch',request);
 try{
  await draw(surface==='app'?h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id}):h(LiveApprovalCard,{id:card.id}));expect(words()).toContain('Tempo settings change');
  await act(async()=>tree.update(surface==='app'?h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+selected.id}):h(LiveApprovalCard,{id:selected.id})));
  expect(words()).toContain('Second timing change?');
  const button=tree.root.findAllByType('Button').find((node:{props:{children:unknown}})=>node.props.children===(allow?'Allow':'Deny'))!;
  await act(async()=>button.props.onClick());expect(words()).toContain('Saving answer…');
  expect(tree.root.findAllByType('Button').every((node:{props:{disabled:boolean}})=>node.props.disabled)).toBe(true);expect(card.state).toBe('pending');expect(selected.state).toBe('pending');
  expect(request).toHaveBeenCalledWith('/api/approvals/answer',expect.objectContaining({method:'POST',credentials:'same-origin'}));
  expect(JSON.parse(String(request.mock.calls[0][1].body))).toMatchObject({input:{id:selected.id,answer:allow?'allow':'deny'}});
  await act(async()=>{if(success)accept();else refuse();});
  expect(words()).not.toContain('Saving answer…');expect(card.state).toBe('pending');expect(selected.state).toBe('pending');
  if(success)expect(words()).not.toContain('Could not save your answer');else expect(words()).toContain('Could not save your answer');
 }finally{vi.unstubAllGlobals();}
});

it('mounts standing-rule editing only for the live current-owner metadata',async()=>{
 fixture();feed.owner=true;
 await draw(h(ApprovalsApp,{path:'/p/approvals-preview/rules'}));
 const form=()=>tree.root.findAllByProps({'aria-label':'Standing rule'});
 expect(form()).toHaveLength(1);
 feed.owner=false;await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/rules'})));expect(form()).toHaveLength(0);
 feed.owner=true;for(const status of ['loading','offline','denied','error']){feed.ownerStatus=status;await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/rules'})));expect(form()).toHaveLength(0);}
});
