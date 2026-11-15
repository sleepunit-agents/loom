// Companion presentation is covered separately; these fixtures model Comms data only.
vi.mock('../attention/comms-companion', () => ({ default: () => null }));
import { afterEach, expect, it, vi } from 'vitest';
import { Children, createElement as h, type ReactNode } from 'react';
// @ts-expect-error Renderer has no declarations.
import { act, create } from 'react-test-renderer';
const f = vi.hoisted(() => ({ status: 'live', data: {} as Record<string, unknown>, requests: [] as { query: string; variables: Record<string, unknown> }[], call: vi.fn(), queued: vi.fn(), records: vi.fn() }));
vi.mock('../../data/graphql', () => ({ useDataQuery(query: string, variables: Record<string, unknown>) {
  f.requests.push({ query, variables });
  return { status: f.status, data: f.status === 'live' ? query.includes('ConversationQuestions(') ? {approvals:(f.data.ordinaryApprovals as {id:string}[]|undefined)??[],inboxItems:((f.data.questions as {id:string}[]|undefined)??[]).slice(Number(variables.offset),Number(variables.offset)+11)} : query.includes('WorkAnswerOwner') ? {workAnswerOwner:f.data.owner===true,workChangesRefresh:false} : query.includes('MentionedChange(') ? { conversationMadeChanges:((f.data.sourceMembership ?? f.data.madeChanges ?? []) as {id:string}[]).filter(row=>row.id===variables.id),changes: (f.data.mentionedChanges as Record<string,unknown[]> | undefined)?.[String(variables.id)] ?? [] } : query.includes('InlineQuestion') ? { inboxItem: (f.data.items as Record<string,unknown>|undefined)?.[String(variables.id)] ?? f.data.item ?? null } : query.includes('ConversationWork(') ? { tasks: f.data.sourceTasks ?? [], conversationMadeChanges:f.data.madeChanges ?? [] } : query.includes('MentionedWork(') ? { tasks: (f.data.mentionedTasks as Record<string, unknown[]> | undefined)?.[String(variables.id)] ?? [] } : f.data : undefined };
} }));
vi.mock('../../data', () => ({ callOnce: (name: string, input: unknown) => f.call(name, input), call: (name: string, input: unknown) => f.queued(name, input), useRecords: f.records }));
vi.mock('../../kit', () => Object.fromEntries(['Split','List','Row','Empty','Error','Loading','Button','Input','Textarea'].map(name => [name,
  (props: { children?: ReactNode; listTop?: ReactNode; list?: ReactNode; reader?: ReactNode; search?: ReactNode; folders?: unknown; onFolder?: unknown }) => name === 'Split'
    ? h(name, { folders: props.folders, onFolder: props.onFolder }, props.listTop, props.list, props.reader, props.search) : h(name, props, props.children)])));
import CommsApp from './index';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); vi.useRealTimers(); f.requests = []; f.call.mockReset(); f.queued.mockReset(); vi.unstubAllGlobals(); });
const thread = (extra = {}) => ({ id: 'th:pump', conversation: 'cv-pump', title: 'Private pump', agent: 'art', member: 'alice', pinned: false, archivedAt: null, lastAt: '2026-11-14T18:00:00Z', readSeq: 0, working: true, stopRequested: false, ...extra });
const message = (extra = {}) => ({ thread: 'th:pump', seq: 1, kind: 'reply', sender: 'art', at: '2026-11-14T18:00:00Z', words: 'PRIVATE REPLY', wordsKeepUntil: new Date(Date.now()+60000).toISOString(), ...extra });
function setup() {
  f.status = 'live'; f.requests = []; f.records.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const name = url.replace('/api/','').replace('/','.');
    const body = JSON.parse(String(init.body));
    const result = await f.call(name, body.input).result;
    return { ok: result.ok, json: async () => result };
  }));
  for (const call of [f.call, f.queued]) call.mockImplementation(() => ({ result: Promise.resolve({ ok: true, value: { saved: true } }) }));
  f.data = { approvals:[],approvalRules:[],approvalNotices:[],approvalRecord:[],questions:[], homeComms: { member: 'alice', agents: ['art'] }, commsFolders: { threads: 120, archived: 13 }, commsThreads: [thread()], commsThread: thread(), commsMessages: [message()], commsRefs: [] };
}
const named = (label: string) => tree.root.findAllByType('Button').find((b: { props: { children: ReactNode } }) => Children.toArray(b.props.children).join('') === label);
const text = () => JSON.stringify(tree.toJSON());
async function draw(path = '/p/comms-preview/thread/pump', go = vi.fn()) { await act(async () => { tree = create(h(CommsApp, { path, go })); }); return go; }
it('mounts the shared Comms app, records reads and sends through authenticated shared HTTP operations', async () => {
  setup(); await draw(); expect(text()).toContain('PRIVATE REPLY'); expect(f.records).not.toHaveBeenCalled();
  expect(f.call).toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'read', seq: 1 });
  const input = tree.root.findAllByType('Textarea').find((n: { props: { 'aria-label': string } }) => n.props['aria-label'] === 'Message art');
  await act(async () => { input.props.onChange({ target: { value: 'Find a pump' } }); });
  await act(async () => { named('Send').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('comms.send', { thread: 'th:pump', words: 'Find a pump', clientId: expect.any(String) });
  expect(fetch).toHaveBeenCalledWith('/api/comms/send', expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: expect.any(String) }));
  await act(async () => { named('Pin').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'pin', pinned: true });
});
it('creates conversations for owned agents without passing a member identity', async () => {
  setup(); f.data.commsThread = null; delete f.data.commsMessages; delete f.data.commsRefs; const go = await draw('/p/comms-preview');
  expect(named('Chat with art')).toBeDefined(); expect(named('Chat with bob')).toBeUndefined();
  await act(async () => { named('Chat with art').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('comms.open', { agent: 'art', thread: expect.stringMatching(/^th:/) });
  expect(go).toHaveBeenCalledWith(expect.stringMatching(/^\/p\/comms-preview\/thread\//));
});
it('uses server counts, search and thread/message pages without caching old private words', async () => {
  setup(); f.data.commsThreads = Array.from({ length: 51 }, (_, n) => thread({ id: `th:${n}` }));
  f.data.commsMessages = Array.from({ length: 51 }, (_, n) => message({ seq: n+1 }));
  await draw(); expect(tree.root.findAllByType('Row')).toHaveLength(50);
  expect(tree.root.findByType('Split').props.folders[0].count).toBe(120);
  await act(async () => { named('Next page').props.onClick(); }); expect(f.requests.findLast(row => row.query.includes('query Comms('))?.variables.offset).toBe(50);
  await act(async () => { tree.root.findByType('Input').props.onChange({ target: { value: 'needle' } }); });
  expect(f.requests.findLast(row => row.query.includes('query Comms('))?.variables).toMatchObject({ search: 'needle', offset: 0 });
  await act(async () => { named('Earlier messages').props.onClick(); });
  expect(f.requests.findLast(row => row.query.includes('query Comms('))?.variables.before).toBe(2);
  await act(async () => { named('Latest messages').props.onClick(); });
  expect(f.requests.findLast(row => row.query.includes('query Comms('))?.variables.before).toBeNull();
});
it('withdraws still-retained private words and drafts when the read is denied', async () => {
  setup(); await draw(); expect(text()).toContain('PRIVATE REPLY');
  await act(async () => { tree.root.findByType('Textarea').props.onChange({ target: { value: 'PRIVATE DRAFT' } }); });
  f.status = 'denied'; await act(async () => { tree.update(h(CommsApp, { path: '/p/comms-preview/thread/pump', go: vi.fn() })); });
  expect(text()).not.toContain('PRIVATE REPLY'); expect(text()).not.toContain('PRIVATE DRAFT'); expect(named('Send')).toBeUndefined();
});
it('expires private message wording locally at its effective server deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T18:00:00Z')); setup();
  f.data.commsMessages = [message({ wordsKeepUntil: '2026-11-14T18:00:01Z' })]; await draw();
  expect(text()).toContain('PRIVATE REPLY');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(text()).not.toContain('PRIVATE REPLY');
});
it('keeps another member’s owner-visible thread read-only', async () => {
  setup(); f.data.commsThread = thread({ member: 'bob' }); await draw();
  expect(text()).toContain('PRIVATE REPLY'); expect(named('Send')).toBeUndefined(); expect(named('Delete')).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
});
it('answers the exact shared Inbox question inline', async () => {
  setup(); f.data.commsMessages = [message({ kind: 'ask', inboxItem: 'in-ask' })];
  f.data.item = { id: 'in-ask', source: 'thread', thread: 'th:pump', state: 'waiting', answers: 'yes-no', at: '2026-11-14T18:00:00Z', read: true, refs: [], body: { words: 'PRIVATE QUESTION' }, bodyKeepUntil: new Date(Date.now()+60000).toISOString() };
  await draw(); expect(text()).toContain('PRIVATE QUESTION'); expect(text()).not.toContain('PRIVATE REPLY');
  await act(async () => { named('Allow').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('inbox.answer', { item: 'in-ask', answer: 'yes' });
});

it('expires inline private question and answer wording independently without a feed update', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T18:00:00Z')); setup();
  f.data.commsMessages = [message({ kind: 'ask', inboxItem: 'in-ask' })];
  f.data.item = { id: 'in-ask', source: 'thread', thread: 'th:pump', state: 'answered', answers: 'yes-no', at: '2026-11-14T18:00:00Z', read: true, refs: [], body: { words: 'INLINE PRIVATE QUESTION' }, answer: 'words', answerText: 'INLINE PRIVATE ANSWER',
    bodyKeepUntil: '2026-11-14T18:00:01Z', answerKeepUntil: '2026-11-14T18:00:02Z' };
  await draw(); expect(text()).toContain('INLINE PRIVATE QUESTION'); expect(text()).toContain('INLINE PRIVATE ANSWER');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(text()).not.toContain('INLINE PRIVATE QUESTION'); expect(text()).toContain('INLINE PRIVATE ANSWER');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(text()).not.toContain('INLINE PRIVATE ANSWER');
});
it('renders actual source and mentioned task work and withdraws it on current visibility changes', async () => {
  setup(); f.data.commsRefs = [{ ref: 't-12', messageSeq: 1 }];
  f.data.sourceTasks = [{ id: 't-10', title: 'SOURCE TASK', status: 'open' }];
  f.data.mentionedTasks = { 't-12': [{ id: 't-12', title: 'MENTIONED TASK', status: 'in_progress' }] };
  const go = await draw(); expect(text()).toContain('SOURCE TASK'); expect(text()).toContain('MENTIONED TASK'); expect(text()).toContain('in_progress');
  f.data.sourceTasks = [{ id: 't-10', title: 'UPDATED TASK', status: 'closed' }];
  await act(async () => { tree.update(h(CommsApp, { path: '/p/comms-preview/thread/pump', go })); });
  expect(text()).toContain('UPDATED TASK'); expect(text()).toContain('closed'); expect(text()).not.toContain('SOURCE TASK');
  f.data.sourceTasks = []; f.data.mentionedTasks = { 't-12': [] };
  await act(async () => { tree.update(h(CommsApp, { path: '/p/comms-preview/thread/pump', go })); });
  expect(text()).not.toContain('UPDATED TASK'); expect(text()).not.toContain('MENTIONED TASK');
});

it('pages source work beyond fifty visible tasks', async () => {
  setup(); f.data.sourceTasks = Array.from({ length: 51 }, (_, n) => ({ id: `t-${n}`, title: `SOURCE-${n}`, status: 'open' }));
  await draw(); expect(text()).toContain('SOURCE-49'); expect(text()).not.toContain('SOURCE-50');
  const next = tree.root.findAllByType('button').find((node: { props: { children: ReactNode } }) => node.props.children === 'Next work');
  f.data.sourceTasks = [{ id: 't-50', title: 'SOURCE-50', status: 'open' }];
  await act(async () => { next.props.onClick(); });
  expect(f.requests.findLast(row => row.query.includes('ConversationWork('))?.variables.offset).toBe(50);
  expect(text()).toContain('SOURCE-50'); expect(text()).not.toContain('SOURCE-49');
});
it('archives, restores and confirms deletion through shared operations', async () => {
  setup(); const go = await draw();
  await act(async () => { named('Archive').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'archive', archived: true });
  f.data.commsThread = thread({ archivedAt: '2026-11-14T18:00:01Z' });
  await act(async () => { tree.update(h(CommsApp, { path: '/p/comms-preview/thread/pump', go })); });
  expect(named('Send')).toBeUndefined();
  await act(async () => { named('Restore').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'archive', archived: false });
  await act(async () => { named('Delete').props.onClick(); });
  expect(f.call).not.toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'delete' });
  await act(async () => { named('Delete thread').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'delete' }); expect(go).toHaveBeenCalledWith('/p/comms-preview');
});

it('keeps hidden-tile arrivals unread and marks the latest reply when the tile becomes visible', async () => {
  setup(); const go = vi.fn();
  await act(async () => { tree = create(h(CommsApp, { path: '/p/comms-preview/thread/pump', go, visible: false })); });
  expect(f.call).not.toHaveBeenCalled();
  f.data.commsMessages = [message(),message({seq:2,words:'UNSEEN REPLY'})];
  await act(async () => { tree.update(h(CommsApp, { path: '/p/comms-preview/thread/pump', go, visible: false })); });
  expect(f.call).not.toHaveBeenCalled();
  await act(async () => { tree.update(h(CommsApp, { path: '/p/comms-preview/thread/pump', go, visible: true })); });
  expect(f.call).toHaveBeenCalledWith('comms.change',{thread:'th:pump',change:'read',seq:2});
});
it('keeps replies unread while scrolled into earlier messages and reads them on following down', async () => {
  setup(); const listeners = new Map<string,()=>void>();
  const scroll = {scrollTop:800,scrollHeight:1000,clientHeight:200,querySelector:()=>({}),addEventListener:(name:string,fn:()=>void)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name)};
  vi.stubGlobal('ResizeObserver',class {observe() {} disconnect() {}});
  const go = vi.fn();
  await act(async () => { tree = create(h(CommsApp,{path:'/p/comms-preview/thread/pump',go}),{createNodeMock:(node:{type:string})=>node.type==='article'?{closest:()=>scroll}:null}); });
  f.call.mockClear(); f.data.commsThread = thread({readSeq:1});
  await act(async () => { scroll.scrollTop=0; listeners.get('scroll')?.(); });
  f.data.commsMessages = [message(),message({seq:2,words:'UNSEEN AT BOTTOM'})];
  await act(async () => { tree.update(h(CommsApp,{path:'/p/comms-preview/thread/pump',go})); });
  expect(f.call).not.toHaveBeenCalledWith('comms.change',{thread:'th:pump',change:'read',seq:2});
  await act(async () => { named('1 new messages').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('comms.change',{thread:'th:pump',change:'read',seq:2});
});
it('shows a current mentioned pull request card, updates it and withdraws denied metadata', async () => {
  setup(); const id='github:house/loom#7'; f.data.commsRefs=[{ref:id,messageSeq:1}];
  f.data.mentionedChanges = {[id]:[{id,title:'CURRENT PR TITLE',state:'open',checks:'running',review:'required',waitingOn:'ci',draft:false}]};
  const go=await draw(); expect(text()).toContain('CURRENT PR TITLE'); expect(text()).toContain('CI running');
  await act(async()=>{named('Open').props.onClick();}); expect(go).toHaveBeenCalledWith('/p/changes-preview/change/github%3Ahouse%2Floom%237');
  f.data.mentionedChanges = {[id]:[{id,title:'UPDATED PR TITLE',state:'merged',checks:'passing',review:'approved',waitingOn:'done',draft:false}]};
  await act(async()=>{tree.update(h(CommsApp,{path:'/p/comms-preview/thread/pump',go}));});
  expect(text()).toContain('UPDATED PR TITLE'); expect(text()).toContain('merged'); expect(text()).not.toContain('CURRENT PR TITLE');
  f.data.mentionedChanges = {[id]:[]};
  await act(async()=>{tree.update(h(CommsApp,{path:'/p/comms-preview/thread/pump',go}));}); expect(text()).not.toContain('UPDATED PR TITLE');
});
it('marks an owner-visible inline question read for its reader without offering another recipient’s answers',async()=>{
 setup();f.data.homeComms={member:'owner',agents:[]};f.data.commsMessages=[message({kind:'ask',inboxItem:'in-ask'})];
 f.data.item={id:'in-ask',source:'thread',thread:'th:pump',state:'waiting',answers:'yes-no',at:'2026-11-14T18:00:00Z',read:false,refs:[],body:{words:'OWNER VISIBLE QUESTION'},bodyKeepUntil:new Date(Date.now()+60000).toISOString()};
 await draw();expect(text()).toContain('OWNER VISIBLE QUESTION');expect(f.call).toHaveBeenCalledExactlyOnceWith('inbox.read',{item:'in-ask'});expect(named('Allow')).toBeUndefined();expect(named('Deny')).toBeUndefined();expect(named('Record answer')).toBeUndefined();
});

function timingQuestion() {
 const before={settleSeconds:5,dimDays:1,muteDays:7},after={...before,settleSeconds:60};
 f.data.owner=true;
 f.data.approvals=[{id:'a-tempo',kind:'setting',target:'tempo:person:alice',what:'Change Tempo',why:'Requested here',agent:'art',project:null,member:'alice',conversation:'cv-pump',state:'pending',ask:'Change timings?',ifYes:'Apply',ifNo:'Keep',details:JSON.stringify({who:{kind:'person',id:'alice'},before,after}),changeSummary:'Tempo for person alice: settle 5 → 60 seconds; dim 1 → 1 days; mute 7 → 7 days',askedAt:'2026-11-14T18:00:00Z',decidedBy:null,expiresAt:null}];
 f.data.questions=[{id:'in-timing'}];
 f.data.items={'in-timing':{id:'in-timing',source:'approval',sourceId:'a-tempo',waitsOnKind:'approval',waitsOnId:'a-tempo',thread:'th:pump',state:'waiting',answers:'yes-no',at:'2026-11-14T18:00:00Z',read:false,refs:[],body:{words:'Change timings?'},bodyKeepUntil:'2026-11-14T18:00:01Z'}};
}
it.each([['Allow',true],['Deny',false]])('answers actual source timing cards inside chat with %s, without a message copy',async(label,allow)=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-14T18:00:00Z'));setup();timingQuestion();f.data.commsMessages=[];
 f.call.mockImplementation((_name,input)=>({result:Promise.resolve({ok:true,value:{saved:true,id:input.id}})}));
 await draw();
 expect(text()).toContain('Tempo settings change');expect(text()).toContain('Before');expect(text()).toContain('After');
 expect(f.requests.find(row=>row.query.includes('ConversationQuestions('))?.variables).toEqual({conversation:'cv-pump',offset:0});
 expect(f.call).toHaveBeenCalledWith('inbox.read',{item:'in-timing'});
 await act(async()=>{named(label).props.onClick();});
 expect(f.call).toHaveBeenCalledWith('approvals.answer',{id:'a-tempo',answer:allow?'allow':'deny'});
 expect(f.call).not.toHaveBeenCalledWith('inbox.answer',expect.anything());
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
 expect(text()).not.toContain('Tempo settings change');expect(named('Allow')).toBeUndefined();
});
it('does not mount source question controls or read marks in another member’s thread',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-14T18:00:00Z'));setup();timingQuestion();f.data.commsMessages=[];f.data.commsThread=thread({member:'bob'});
 await draw();expect(named('Allow')).toBeUndefined();expect(f.call).not.toHaveBeenCalled();
 expect(f.requests.some(row=>row.query.includes('ConversationQuestions('))).toBe(false);
});

it('shows ordinary private approval cards to the conversation member even when the owner Inbox is elsewhere',async()=>{
 setup();f.data.owner=false;f.data.commsMessages=[];
 f.data.ordinaryApprovals=[{id:'a-command'}];f.data.questions=[];
 f.data.approvals=[{id:'a-command',kind:'command',target:'fixture:read',what:'Read fixture',why:'PRIVATE COMMAND REASON',agent:'art',project:null,member:'alice',conversation:'cv-pump',state:'pending',ask:'Run the fixture?',ifYes:'Read it',ifNo:'Leave it',details:'',changeSummary:null,askedAt:'2026-11-14T18:00:00Z',decidedBy:null,expiresAt:null}];
 const go=await draw();expect(text()).toContain('PRIVATE COMMAND REASON');expect(text()).toContain('Run the fixture?');expect(named('Allow')).toBeUndefined();
 f.data.owner=true;await act(async()=>{tree.update(h(CommsApp,{path:'/p/comms-preview/thread/pump',go}));});expect(named('Allow')).toBeDefined();
 f.data.approvals=[];f.data.ordinaryApprovals=[];await act(async()=>{tree.update(h(CommsApp,{path:'/p/comms-preview/thread/pump',go}));});expect(text()).not.toContain('PRIVATE COMMAND REASON');
});
it('renders an ordinary approval only once when its Inbox item is also present',async()=>{
 setup();f.data.owner=true;f.data.commsMessages=[];
 f.data.ordinaryApprovals=[{id:'a-command'}];f.data.questions=[{id:'in-command',sourceId:'a-command'}];
 f.data.approvals=[{id:'a-command',kind:'command',target:'fixture:read',what:'Read fixture',why:'ONLY ONE COMMAND',agent:'art',project:null,member:'alice',conversation:'cv-pump',state:'pending',ask:'Run the fixture?',ifYes:'Read it',ifNo:'Leave it',details:'',changeSummary:null,askedAt:'2026-11-14T18:00:00Z',decidedBy:null,expiresAt:null}];
 await draw();expect(tree.root.findAllByType('Button').filter((button:{props:{children:ReactNode}})=>button.props.children==='Allow')).toHaveLength(1);
});

it('shows a change filed on work made in the conversation even without a chat mention',async()=>{
 setup();f.data.madeChanges=[{id:'github:house/loom#9'}];f.data.commsRefs=[];
 f.data.mentionedChanges={'github:house/loom#9':[{id:'github:house/loom#9',title:'FILED ON SOURCE TASK',state:'open',checks:'passing',review:'approved',waitingOn:'agent',draft:false}]};
 await draw();expect(text()).toContain('FILED ON SOURCE TASK');expect(text()).toContain('Made here');
});

it('labels source tasks as Made here and pages a change-only source list without hiding a mentioned sentinel',async()=>{
 setup();f.data.sourceTasks=[{id:'t-90',title:'SOURCE TASK LABEL',status:'open'}];
 f.data.madeChanges=Array.from({length:51},(_,n)=>({id:`github:house/loom#${n+1}`}));
 f.data.mentionedChanges=Object.fromEntries(Array.from({length:51},(_,n)=>[`github:house/loom#${n+1}`,[{id:`github:house/loom#${n+1}`,title:`CHANGE TITLE ${n+1}`,state:'open',checks:'passing',review:'approved',waitingOn:'agent',draft:false}]]));
 f.data.commsRefs=[{ref:'github:house/loom#51',messageSeq:1}];
 await draw();
 expect(tree.root.findAllByType('button').find((node:{props:{children:ReactNode}})=>JSON.stringify(node.props.children).includes('SOURCE TASK LABEL')).props.children).toContain(' · Made here');
 expect(text()).toContain('CHANGE TITLE 50');expect(text()).toContain('CHANGE TITLE 51');expect(JSON.stringify(tree.root.findByProps({'aria-label':'Conversation change github:house/loom#51'}).findAllByType('p').map((node:{props:{children:ReactNode}})=>node.props.children))).toContain('Made here');
 const next=tree.root.findAllByType('button').find((node:{props:{children:ReactNode}})=>node.props.children==='Next work');expect(next.props.disabled).toBe(false);
 f.data.sourceTasks=[];f.data.madeChanges=[{id:'github:house/loom#51'}];
 await act(async()=>{next.props.onClick();});
 expect(f.requests.findLast(row=>row.query.includes('ConversationWork('))?.variables.offset).toBe(50);expect(text()).not.toContain('CHANGE TITLE 50');expect(text()).toContain('CHANGE TITLE 51');
});

it('keeps a mentioned source task labelled Made here while the source list is on a different page',async()=>{
 setup();f.data.sourceTasks=[];f.data.commsRefs=[{ref:'t-77',messageSeq:1}];f.data.mentionedTasks={'t-77':[{id:'t-77',title:'MENTIONED SOURCE',status:'open',sourceKind:'conversation',sourceId:'cv-pump'}]};
 await draw();expect(tree.root.findAllByType('button').find((node:{props:{children:ReactNode}})=>JSON.stringify(node.props.children).includes('MENTIONED SOURCE')).props.children).toContain(' · Made here');
});
