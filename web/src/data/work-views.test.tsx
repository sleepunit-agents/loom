import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, Suspense, type ReactNode } from 'react';
// @ts-expect-error The renderer dependency has no declarations.
import { act, create } from 'react-test-renderer';
import type { ReviewRound } from '../pieces/change-view/model';
import type { ApprovalsResult, ChangesResult } from './work-query';
const feed = vi.hoisted(() => ({ reviews: [] as ReviewRound[], status: 'live', ownerStatus:'live', owner:false, refresh:false, people:[] as {id:string;role:string}[], changeStatus:undefined as string|undefined, requestStatus:undefined as string|undefined, approvals: {} as ApprovalsResult, changes: {} as ChangesResult }));
vi.mock('./graphql', () => ({ useDataQuery: (query: string) => ({ status: query.includes('WorkAnswerOwner') ? feed.ownerStatus : query.includes('ChangesView') ? feed.changeStatus ?? feed.status : query.includes('WorkMergeRequests') ? feed.requestStatus ?? feed.status : feed.status, data: query.includes('ChangeReviewHistory') ? {changeReviewHistory:feed.reviews} : query.includes('WorkAnswerOwner') ? {workAnswerOwner:feed.owner,workChangesRefresh:feed.refresh,members:feed.people} : query.includes('WorkMergeRequests') ? {approvals:feed.approvals.approvals} : query.includes('ApprovalsView') ? feed.approvals : feed.changes }) }));
vi.mock('../kit', async () => ({ ...Object.fromEntries(['Split', 'List', 'Row', 'NoteRow', 'Empty', 'Error', 'Loading', 'Button', 'LinkButton', 'Actions', 'Search', 'Input', 'Textarea', 'Field', 'Fields', 'Reader', 'Meta', 'Title', 'Facts', 'Fact', 'Section', 'Disclosure', 'ShortIdentifier', 'Clamp', 'Body', 'Chip', 'RefCard', 'Markdown', 'Pager'].map(name => [name, (props: { children?: ReactNode; reader?: ReactNode; list?: ReactNode; search?: ReactNode; listTop?: ReactNode; listAction?: ReactNode }) => h(name, Object.fromEntries(Object.entries(props).filter(([key]) => !['children', 'reader', 'list', 'search', 'blank', 'folders', 'listTop', 'listAction'].includes(key))), props.children, ...(name === 'Split' ? [props.search, props.listAction, props.listTop, props.list, props.reader] : []))])), Disclosure: ((Real) => (props: { label: string; children?: ReactNode }) => props.label === 'Exact request' ? h(Real, props) : h('Disclosure', { label: props.label }, props.children))((await import('../kit/reader')).Disclosure) }));
vi.mock('./graphql/selection', () => ({ useSelection: () => ({ status: 'live', data: {
  ordinary: feed.approvals.approvals, questions: [], hasNext: false,
} }) }));
import { ConversationQuestions } from '../pieces/comms/conversation-questions';
import { approvalsApp } from '../pieces/approvals/registration';
import { changesApp } from '../pieces/changes/registration';
import { ApprovalsApp, ChangesApp, LiveApprovalCard, LiveChangeCard } from './work-views';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); feed.status = 'live'; feed.owner=false; feed.reviews=[]; feed.refresh=false; feed.people=[]; feed.changeStatus=undefined;feed.requestStatus=undefined; feed.ownerStatus='live'; vi.unstubAllGlobals(); });
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
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(words()).toContain('Change measuring');
  await selectRow();
  expect(words()).toContain('Keep one day?');
  expect(words()).toContain('Measuring settings change');
  expect(tree.root.findAllByType('Button')).toHaveLength(0);
  await act(async () => tree.update(h(Suspense, { fallback: 'Opening' }, h(changesApp.Screen, {}))));
  await act(async () => { await vi.dynamicImportSettled(); });
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
  expect(words()).toContain('Linked task');
  const linked = tree.root.findAllByType('Chip').find((chip: { props: { children: string } }) => chip.props.children === 't-42');
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
 // A rule is edited in the reader: New rule (the list's one action) opens a blank one there.
 const form=()=>tree.root.findAllByProps({'aria-label':'Standing rule'}).filter((node:{type:unknown})=>node.type==='form');
 const fresh=()=>tree.root.findAllByType('Button').find((button:{props:{children:unknown}})=>button.props.children==='New rule');
 expect(form()).toHaveLength(0);await act(async()=>fresh()!.props.onClick());expect(form()).toHaveLength(1);
 feed.owner=false;await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/rules'})));expect(form()).toHaveLength(0);expect(fresh()).toBeUndefined();
 feed.owner=true;for(const status of ['loading','offline','denied','error']){feed.ownerStatus=status;await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/rules'})));expect(form()).toHaveLength(0);expect(fresh()).toBeUndefined();}
});

function standingFixture(){
 fixture();feed.owner=true;feed.people=[{id:'pat',role:'owner'},{id:'sam',role:'member'}];
 const change={...feed.changes.changes[0],id:'github:acme/app#1',project:'pond',headCommit:'a'.repeat(40)};
 const card={...feed.approvals.approvals[0],id:'a-merge',kind:'merge' as const,target:`${change.id}@${change.headCommit}`,project:'pond',actingFor:'pat',operation:null,changeSummary:null,details:''};
 feed.changes={...feed.changes,changes:[change]};feed.approvals={...feed.approvals,approvals:[card]};return {change,card};
}
it.each(['approvals','changes'])('sends atomic Always from current %s without optimistic state or duplicate pending requests',async surface=>{
 const {card,change}=standingFixture();let finish!:(value:Response)=>void;const request=vi.fn<typeof fetch>(()=>new Promise<Response>(done=>{finish=done;}));vi.stubGlobal('fetch',request);
 const view=()=>surface==='approvals'?h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id}):h(ChangesApp,{path:'/p/changes-preview/change/'+encodeURIComponent(change.id)});
 await draw(view());
 const button=()=>tree.root.findAllByType('Button').find((button:{props:{children:unknown}})=>button.props.children==='Always for pond');
 const headerState=()=>{const value=tree.root.findByType('Reader').findAllByType('Meta')[surface==='changes'?1:0].props.children;return Array.isArray(value)?value.join(''):String(value);};
 expect(button()).toBeDefined();await act(async()=>button()!.props.onClick());await act(async()=>button()!.props.onClick());
 expect(request).toHaveBeenCalledExactlyOnceWith('/api/approvals/always',expect.objectContaining({credentials:'same-origin'}));expect(JSON.parse(String(request.mock.calls[0][1]!.body))).toMatchObject({input:{approval:card.id,change:change.id,head:change.headCommit,project:'pond',person:''}});
 expect(button()!.props.disabled).toBe(true);expect(headerState()).toContain(surface==='changes'?'Waiting on you':'merge · pending');
 await act(async()=>finish(Response.json({ok:true,value:{id:card.id}})));
 expect(headerState()).toContain(surface==='changes'?'Waiting on you':'merge · pending');expect(button()).toBeDefined();expect(card.state).toBe('pending');expect(change.waitingOn).toBe('you');
 card.state='allowed';change.waitingOn='agent';await act(async()=>tree.update(view()));expect(button()).toBeUndefined();expect(headerState()).toContain(surface==='changes'?'Waiting on Art':'merge · allowed');
});
it.each(['approvals','changes'])('rebinds Always after selecting a different current card in %s',async surface=>{
 const {card,change}=standingFixture(),otherChange={...change,id:'github:acme/app#2',headCommit:'b'.repeat(40),project:'other'},otherCard={...card,id:'a-other',target:`${otherChange.id}@${otherChange.headCommit}`,project:'other',actingFor:'sam'};
 feed.changes={...feed.changes,changes:[change,otherChange]};feed.approvals={...feed.approvals,approvals:[card,otherCard]};const request=vi.fn<typeof fetch>(async()=>Response.json({ok:true,value:{id:otherCard.id}}));vi.stubGlobal('fetch',request);
 const view=(id:string,changeId:string)=>surface==='approvals'?h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+id}):h(ChangesApp,{path:'/p/changes-preview/change/'+encodeURIComponent(changeId)});
 await draw(view(card.id,change.id));await act(async()=>tree.update(view(otherCard.id,otherChange.id)));
 await act(async()=>tree.root.findAllByType('Button').find((button:{props:{children:unknown}})=>button.props.children==='Always for other, Sam’s work only')!.props.onClick());
 expect(JSON.parse(String(request.mock.calls[0][1]!.body))).toMatchObject({input:{approval:otherCard.id,change:otherChange.id,head:otherChange.headCommit,project:'other',person:'sam'}});
});
it('names personal Always grants and hides them for stale rows, principals or owner capability independently',async()=>{
 const {card,change}=standingFixture();card.actingFor='sam';
 await draw(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id}));const labels=()=>tree.root.findAllByType('Button').map((button:{props:{children:unknown}})=>button.props.children);
 expect(labels()).toContain('Always for pond, Sam’s work only');
 feed.changeStatus='offline';await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id})));expect(labels()).not.toContain('Always for pond, Sam’s work only');expect(labels()).toContain('Allow');
 feed.changeStatus=undefined;card.actingFor='unknown';await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id})));expect(labels().some((label:unknown)=>String(label).startsWith('Always'))).toBe(false);
 card.actingFor='pat';for(const state of ['allowed','denied','used','withdrawn','expired'] as const){card.state=state;await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id})));expect(labels().some((label:unknown)=>String(label).startsWith('Always'))).toBe(false);}
 card.state='pending';change.headCommit='b'.repeat(40);await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id})));expect(labels().some((label:unknown)=>String(label).startsWith('Always'))).toBe(false);
 change.headCommit='a'.repeat(40);for(const status of ['loading','offline','denied','error']){feed.ownerStatus=status;await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id})));expect(labels().some((label:unknown)=>String(label).startsWith('Always'))).toBe(false);}
 feed.ownerStatus='live';feed.owner=false;await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id})));expect(labels().some((label:unknown)=>String(label).startsWith('Always'))).toBe(false);
 feed.owner=true;feed.people=[];await act(async()=>tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id})));expect(labels().some((label:unknown)=>String(label).startsWith('Always'))).toBe(false);
});

it('keeps a merge approval inline to one-request Allow/Deny without a standing grant',async()=>{
 const {card}=standingFixture(),request=vi.fn<typeof fetch>(async()=>Response.json({ok:true,value:{id:card.id}}));vi.stubGlobal('fetch',request);
 await draw(h(LiveApprovalCard,{id:card.id}));const buttons=tree.root.findAllByType('Button');expect(buttons.map((button:{props:{children:unknown}})=>button.props.children)).toEqual(['Allow','Deny']);
 await act(async()=>buttons[0].props.onClick());expect(request.mock.calls[0][0]).toBe('/api/approvals/answer');expect(JSON.parse(String(request.mock.calls[0][1]!.body)).input).toEqual({id:card.id,answer:'allow'});
});

it.each(['ci','reviewer','author','agent','you'] as const)('offers a bound standing answer while waiting on %s without clearing that blocker',async waitingOn=>{
 const {card,change}=standingFixture();change.waitingOn=waitingOn;
 const request=vi.fn<typeof fetch>(async()=>Response.json({ok:true,value:{id:card.id}}));vi.stubGlobal('fetch',request);
 await draw(h(ChangesApp,{path:'/p/changes-preview/change/'+encodeURIComponent(change.id)}));
 const buttons=tree.root.findAllByType('Button'),labels=buttons.map((button:{props:{children:unknown}})=>button.props.children);
 expect(labels).toContain('Always for pond');expect(labels.includes('Yes, merge it')).toBe(waitingOn==='you');expect(words()).toContain({ci:'Waiting on the checks',reviewer:'Waiting on a reviewer',author:'Waiting on its author',agent:'Waiting on Art',you:'Waiting on you'}[waitingOn]);
 await act(async()=>buttons.find((button:{props:{children:unknown}})=>button.props.children==='Always for pond')!.props.onClick());
 expect(request).toHaveBeenCalledExactlyOnceWith('/api/approvals/always',expect.anything());expect(change.waitingOn).toBe(waitingOn);expect(card.state).toBe('pending');
});
it('shows private reported steps from the currently visible approval record and removes them when that approval is withdrawn from the query',async()=>{
 fixture();feed.approvals.approvals=[{...feed.approvals.approvals[0],kind:'command',state:'used',member:'alice',what:'Private fixture'}];
 feed.approvals.approvalRecord=[{seq:7,at:'2026-11-14T00:00:00Z',event:'use',approval:'a-one',agent:'art',note:'Reported step: PRIVATE STEP RESULT'}];
 await draw(h(ApprovalsApp,{path:'/p/approvals-preview/notices'}));expect(words()).toContain('PRIVATE STEP RESULT');expect(words()).toContain('Current reported step');
 feed.approvals.approvals=[];
 await act(async()=>{tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/notices'}));});expect(words()).not.toContain('PRIVATE STEP RESULT');
});

it.each(['app','inline'])('shows a household owner what a waiting household card would replace, read for them and never taken from the card (%s)',async surface=>{
 fixture();const card=feed.approvals.approvals[0];
 Object.assign(card,{operation:'household.change',target:'household:member:lee',details:JSON.stringify({change:'member',after:{id:'lee',role:'owner'},seal:{nonce:'n',digest:'d'}}),changeSummary:'member lee: {"id":"lee","role":"owner"}'});
 const told={summary:'Role: Member → Owner of the household',problem:'That is how it already is',blocked:'This cannot be allowed: it is already so, and nothing would change. Deny it.',
  card:{title:'Change what Lee is in the household',nothing:false,facts:[{label:'Role',value:'Member → Owner of the household'}],exact:JSON.stringify({id:'lee',role:'owner'},null,2)}};
 const request=vi.fn(async(_url:string,_options:RequestInit)=>({ok:true,json:async()=>({ok:true,value:told})}));vi.stubGlobal('fetch',request);
 const node=()=>surface==='app'?h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id}):h(LiveApprovalCard,{id:card.id});
 // Someone who is not an owner sees the card in plain words made from what the card itself keeps, and nothing
 // is asked for them: no name, nothing of what is there now, and no raw JSON.
 await draw(node());await act(async()=>{});
 expect(request).not.toHaveBeenCalled();expect(words()).toContain('Set lee as a');expect(words()).not.toContain('→');expect(words()).not.toContain('{\\"');
 await act(async()=>tree.unmount());
 feed.owner=true;await draw(node());await act(async()=>{});
 if (surface==='inline') {
  expect(request).not.toHaveBeenCalled();
  await act(async()=>tree.root.findAllByType('Button').find((button:{props:{children:unknown}})=>button.props.children==='Details').props.onClick());
 }
 expect(request).toHaveBeenCalledExactlyOnceWith('/api/household/proposalPreview',expect.objectContaining({method:'POST',credentials:'same-origin',body:JSON.stringify({input:{id:card.id}})}));
 expect(words()).toContain('Change what Lee is in the household');expect(words()).toContain('Member → Owner of the household');expect(words()).toContain('it is already so, and nothing would change');expect(words()).not.toContain('{\\"');
 // The caution leaves both buttons available.
 const buttons=tree.root.findAllByType('Button' as never);
 expect(buttons.find((button:{props:{children:unknown}})=>button.props.children==='Allow')?.props).toMatchObject({disabled:false});
 expect(buttons.find((button:{props:{children:unknown}})=>button.props.children==='Deny')?.props.disabled).toBe(false);
 if (surface==='app') {
  const disclose=tree.root.findAllByType('button').find((button:{props:{children:unknown}})=>button.props.children==='Exact request');
  expect(disclose).toBeDefined();
  await act(async()=>disclose!.props.onClick());
  const exact=tree.root.findByType('pre');
  expect(JSON.parse(exact.props.children)).toEqual({id:'lee',role:'owner'});
  const outsideExact=tree.root.findAll((node: { type: unknown; props: { children?: unknown } }) => typeof node.type==='string' && node.type!=='pre' && typeof node.props.children==='string');
  for (const node of outsideExact) expect(node.props.children).not.toMatch(/\{\s*"/);
 }

});

it('sends the revision shown on an updated approval',async()=>{
 fixture(); feed.owner=true;
 const selected={...feed.approvals.approvals[0],kind:'setting' as const,operation:'household.change'};
 feed.approvals.approvals=[selected];
 const review='a'.repeat(64),card={title:'Update garden settings',facts:[],exact:'{}',nothing:false};
 const request=vi.fn<typeof fetch>()
  .mockResolvedValueOnce(Response.json({ok:true,value:{summary:'',problem:null,card,blocked:null,review}}))
  .mockResolvedValueOnce(Response.json({ok:true,value:{id:selected.id}}));
 vi.stubGlobal('fetch',request);
 await draw(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+selected.id}));
 expect(words()).toContain('The request has been refreshed.');
 const allow=tree.root.findAllByType('Button' as never).find((entry:{props:{children:unknown}})=>entry.props.children==='Allow')!;
 await act(async()=>allow.props.onClick());
 expect(JSON.parse(String(request.mock.calls[1][1]?.body)).input).toEqual({id:selected.id,answer:'allow',review});
});

it('shows a quoted decision in approval notices while the card is visible', async () => {
 fixture();
 const card=feed.approvals.approvals[0], note='Denied by sam through art, on their words: “Leave it alone”';
 feed.approvals.approvalRecord=[{seq:2,at:card.askedAt,event:'deny',approval:card.id,agent:'art',note}];
 await draw(h(ApprovalsApp,{path:'/p/approvals-preview/notices'}));
 expect(words()).toContain(note);
 feed.approvals.approvals=[];
 await act(async()=>{tree.update(h(ApprovalsApp,{path:'/p/approvals-preview/notices'}));});
 expect(words()).not.toContain(note);
});

it('reads only the open card, keeps the dangerous confirmation available, and refreshes after refusal', async () => {
 fixture(); feed.owner=true;
 const selected={...feed.approvals.approvals[0],operation:'household.change',kind:'dangerous' as const,
  details:JSON.stringify({change:'tokenRevoke',after:{label:'spare'}})};
 feed.approvals.approvals=[selected,{...selected,id:'a-other'}];
 const card={title:'Revoke the token spare',nothing:false,facts:[],exact:'{}'};
 let complete!: (response: Response) => void;
 const pending=new Promise<Response>(resolve=>{complete=resolve;});
 const request=vi.fn<typeof fetch>()
  .mockReturnValueOnce(pending)
  .mockResolvedValueOnce(Response.json({ok:false,code:'conflict',message:'Actual refusal'},{status:409}))
  .mockResolvedValueOnce(Response.json({ok:true,value:{summary:'',problem:null,card,blocked:'Fresh caution'}}))
  .mockResolvedValueOnce(Response.json({ok:true,value:{id:selected.id}}));
 vi.stubGlobal('fetch',request);
 const root='/p/approvals-preview';
 await draw(h(ApprovalsApp,{path:root}));
 expect(request).not.toHaveBeenCalled();
 await act(async()=>tree.update(h(ApprovalsApp,{path:root+'/approval/'+selected.id})));
 expect(request).toHaveBeenCalledTimes(1);
 expect(request.mock.calls[0][1]?.body).toBe(JSON.stringify({input:{id:selected.id}}));
 const button=(label:string)=>tree.root.findAllByType('Button' as never).find((entry:{props:{children:unknown}})=>entry.props.children===label)!;
 expect(button('Allow').props.disabled).toBe(false);
 await act(async()=>button('Allow').props.onClick());
 expect(button('Yes, allow it').props.disabled).toBe(false);
 await act(async()=>complete(Response.json({ok:true,value:{summary:'',problem:null,card,blocked:'Initial caution'}})));
 expect(words()).toContain('Initial caution');
 expect(button('Yes, allow it').props.disabled).toBe(false);
 await act(async()=>button('Yes, allow it').props.onClick());
 expect(JSON.parse(String(request.mock.calls[1][1]?.body)).input).toMatchObject({id:selected.id,answer:'allow',confirm:true});
 expect(request.mock.calls[2][0]).toBe('/api/household/proposalPreview');
 expect(words()).toContain('Actual refusal');
 expect(words()).toContain('Fresh caution');
 expect(words()).not.toContain('Initial caution');
 await act(async()=>button('Yes, allow it').props.onClick());
 expect(words()).not.toContain('Fresh caution');
 expect(request).toHaveBeenCalledTimes(4);
});

it('requests details for only the opened card in a conversation with ten household approvals', async () => {
 fixture();feed.owner=true;
 feed.approvals.approvals=Array.from({length:10},(_,i)=>({...feed.approvals.approvals[0],id:'a-'+i,operation:'household.change',
  details:JSON.stringify({change:'member',after:{id:'lee',role:'owner'}})}));
 const request=vi.fn(async()=>({ok:false,json:async()=>({})}));vi.stubGlobal('fetch',request);
 await draw(h(ConversationQuestions,{conversation:'cv',go:vi.fn(),readVisible:true}));
 expect(words()).toContain('Set lee as a');
 expect(request).not.toHaveBeenCalled();
 const details=tree.root.findAllByType('Button').filter((button:{props:{children:string}})=>button.props.children==='Details');
 expect(details).toHaveLength(10);
 await act(async()=>details[6].props.onClick());
 expect(request).toHaveBeenCalledExactlyOnceWith('/api/household/proposalPreview',expect.objectContaining({body:JSON.stringify({input:{id:'a-6'}})}));
});

it('opens Exact request from History and omits the caution and live facts', async () => {
 fixture();feed.owner=true;
 const card=feed.approvals.approvals[0], input={id:'lee',role:'owner'};
 Object.assign(card,{state:'used',operation:'household.change',details:JSON.stringify({change:'member',after:input})});
 const request=vi.fn(async()=>({ok:true,json:async()=>({ok:true,value:{summary:'Stored summary',problem:null,blocked:null,card:null,exact:JSON.stringify(input)}})}));
 vi.stubGlobal('fetch',request);
 await draw(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+card.id}));
 const exact=tree.root.findAllByType('button').find((button:{props:{children:string}})=>button.props.children==='Exact request');
 expect(exact).toBeDefined();
 await act(async()=>exact.props.onClick());
 expect(JSON.parse(tree.root.findByType('pre').props.children)).toEqual(input);
 expect(words()).not.toContain('loom will refuse');
});

it.each(['app','inline'])('shows older household summaries only inside the owner disclosure (%s)',async surface=>{
 fixture();
 const row=feed.approvals.approvals[0], summary='{"saved":"private settings"}';
 Object.assign(row,{operation:'household.change',what:'Saved title',why:'Saved reason',changeSummary:summary,details:JSON.stringify({change:'olderKind',after:{}})});
 const view=()=>surface==='app'?h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+row.id}):h(LiveApprovalCard,{id:row.id});
 const request=vi.fn(async()=>Response.json({ok:true,value:{summary:'',problem:null,card:null,blocked:null,exact:JSON.stringify({summary},null,2)}}));
 vi.stubGlobal('fetch',request);
 await draw(view());
 for (const word of ['Saved title','Saved reason']) expect(words()).toContain(word);
 expect(words()).not.toContain('private settings');
 expect(words()).not.toContain('Exact request');
 expect(request).not.toHaveBeenCalled();
 feed.owner=true;
 await draw(view());
 if(surface==='inline') {
  const details=tree.root.findAllByType('Button').find((button:{props:{children:string}})=>button.props.children==='Details');
  await act(async()=>details!.props.onClick());
 }
 const disclosure=tree.root.findAllByType('button').find((button:{props:{children:string}})=>button.props.children==='Exact request');
 expect(disclosure).toBeDefined();
 expect(words()).not.toContain('private settings');
 await act(async()=>disclosure!.props.onClick());
 expect(JSON.parse(tree.root.findByType('pre').props.children)).toEqual({summary});
});

it('refreshes an open caution on focus, visibility, the interval, and a refused Allow', async () => {
 fixture();feed.owner=true;
 const row=feed.approvals.approvals[0];
 Object.assign(row,{operation:'household.change',details:JSON.stringify({change:'member',after:{id:'lee',role:'owner'}})});
 const tab = new EventTarget(), page = new EventTarget();
 let tick: (()=>void) | undefined;
 Object.assign(tab,{setInterval:(fn:()=>void,ms:number)=>{expect(ms).toBe(60_000);tick=fn;return 1;},clearInterval:()=>{tick=undefined;}});
 Object.assign(page,{visibilityState:'hidden'});
 vi.stubGlobal('window',tab);vi.stubGlobal('document',page);
 let failed=false;
 const request=vi.fn(async()=>({ok:!failed,json:async()=>({ok:true,value:{
  summary:'',problem:null,blocked:'This cannot be allowed as it stands: Missing token.',
  card:{title:'Test preview',nothing:false,facts:[],exact:'{}'},
 }})}));
 vi.stubGlobal('fetch',request);
 const allow=vi.fn(async()=>{throw Error('Refused');});
 await draw(h(ApprovalsApp,{path:'/p/approvals-preview/approval/'+row.id,go:vi.fn(),actions:{allow,deny:vi.fn()}}));
 expect(words()).toContain('Missing token');
 expect(request).toHaveBeenCalledTimes(1);
 failed=true;
 await act(async()=>tab.dispatchEvent(new Event('focus')));
 expect(request).toHaveBeenCalledTimes(2);expect(words()).not.toContain('Missing token');
 await act(async()=>page.dispatchEvent(new Event('visibilitychange')));
 expect(request).toHaveBeenCalledTimes(2);
 Object.assign(page,{visibilityState:'visible'});failed=false;
 await act(async()=>page.dispatchEvent(new Event('visibilitychange')));
 expect(request).toHaveBeenCalledTimes(3);expect(words()).toContain('Missing token');
 await act(async()=>tick!());
 expect(request).toHaveBeenCalledTimes(4);
 const button=tree.root.findAllByType('Button').find((button:{props:{children:string}})=>button.props.children==='Allow');
 expect(button.props.disabled).toBe(false);
 await act(async()=>button.props.onClick());
 expect(request).toHaveBeenCalledTimes(5);
 await act(async()=>tree.unmount());
 expect(tick).toBeUndefined();
});

it('discards a late review response for a previously open change', async () => {
  fixture();
  const first = feed.changes.changes[0], second = { ...first, id: 'c-two' };
  feed.changes = { ...feed.changes, changes: [first, second] };
  const round: ReviewRound = { change: first.id, job: 'job', round: 1, tier: 'high', verdict: 'CLEAR', findings: 'First findings', headCommit: first.headCommit };
  const app = (id: string) => h(ChangesApp, { path: '/p/changes-preview/change/' + id });
  feed.reviews = [round];
  await draw(app(first.id));
  expect(words()).toContain('First findings');
  await act(async () => tree.update(app(second.id)));
  expect(words()).not.toContain('First findings');
  feed.reviews = [{ ...round, change: second.id, findings: 'Second findings' }];
  await act(async () => tree.update(app(second.id)));
  expect(words()).toContain('Second findings');
  feed.reviews = [round];
  await act(async () => tree.update(app(second.id)));
  expect(words()).not.toContain('First findings');
});

it('opens the owner explanation when Allow is refused on a collapsed Inbox kit grant',async()=>{
 fixture();feed.owner=true;
 const row=feed.approvals.approvals[0];
 Object.assign(row,{operation:'household.change',details:JSON.stringify({change:'kitGrant',after:{agent:'art',kit:'livonia',grant:true,to:{platform:'slack',workspace:'ws',user:'user'}}})});
 const request=vi.fn<typeof fetch>(async url=>String(url).endsWith('/answer')
   ? Response.json({ok:false,code:'invalid',message:'Choose an outside account already known to the agent or household'},{status:400})
   : Response.json({ok:true,value:{summary:'',problem:null,blocked:'This cannot be allowed yet: Art does not know this Slack contact.',card:{title:'Grant the Livonia kit',nothing:false,facts:[],exact:'{}'}}}));
 vi.stubGlobal('fetch',request);
 await draw(h(LiveApprovalCard,{id:row.id}));
 expect(request).not.toHaveBeenCalled();
 await act(async()=>tree.root.findAllByType('Button').find((button:{props:{children:unknown}})=>button.props.children==='Allow').props.onClick());
 expect(request.mock.calls.map(([url])=>url)).toEqual(['/api/approvals/answer','/api/household/proposalPreview']);
 expect(words()).toContain('Art does not know this Slack contact.');
 expect(tree.root.findByType('Error').props.title).toBe('Couldn’t save your answer');
});
