// Companion presentation is covered separately; these fixtures model Comms data only.
vi.mock('../attention/comms-companion', () => ({ default: () => null }));
import { afterEach, expect, it, vi } from 'vitest';
import { Children, createElement as h, type ReactNode } from 'react';
// @ts-expect-error Renderer has no declarations.
import { act, create } from 'react-test-renderer';
// `thread` is the state of the open thread's own reading; `hold` and `heldThread` make the list and the thread answer as
// the data hook does while their next variables load (the last answer again, marked settling).
const f = vi.hoisted(() => ({ status: 'live', thread: 'live', hold: false, heldThread: false, last: undefined as unknown, lastThread: undefined as unknown, data: {} as Record<string, unknown>, requests: [] as { query: string; variables: Record<string, unknown>; options?: { keep?: boolean; pause?: boolean } }[], call: vi.fn(), queued: vi.fn(), records: vi.fn() }));
vi.mock('../../data/graphql', () => ({ useDataQuery(query: string, variables: Record<string, unknown>, options?: { keep?: boolean; pause?: boolean }) {
  f.requests.push({ query, variables, options });
  if (options?.pause) return { status: 'loading' };
  if (f.status === 'live' && query.includes('query CommsThread(')) {
    if (f.thread !== 'live') return { status: f.thread };
    if (f.heldThread && options?.keep) return { status: 'live', data: f.lastThread, settling: true };
    // A page of messages is the ones before its cursor, as the server answers it.
    const before = variables.before as number | null, rows = f.data.commsMessages as { seq: number }[] | undefined;
    return { status: 'live', data: f.lastThread = { commsThread: f.data.commsThread, commsMessages: before == null ? rows : rows?.filter(row => row.seq < before), commsRefs: f.data.commsRefs } };
  }
  if (f.status === 'live' && query.includes('query Comms(')) return f.hold && options?.keep ? { status: 'live', data: f.last, settling: true } : { status: 'live', data: f.last = { ...f.data } };
  return { status: f.status, data: f.status === 'live' ? query.includes('ConversationQuestions(') ? {taskQuestions:((f.data.taskQuestions as {id:string}[]|undefined)??[]).slice(Number(variables.offset),Number(variables.offset)+11),approvals:(f.data.ordinaryApprovals as {id:string}[]|undefined)??[],inboxItems:((f.data.questions as {id:string}[]|undefined)??[]).slice(Number(variables.offset),Number(variables.offset)+11)} : query.includes('WorkAnswerOwner') ? {workAnswerOwner:f.data.owner===true,workChangesRefresh:false} : query.includes('MentionedChange(') ? { conversationMadeChanges:((f.data.sourceMembership ?? f.data.madeChanges ?? []) as {id:string}[]).filter(row=>row.id===variables.id),changes: (f.data.mentionedChanges as Record<string,unknown[]> | undefined)?.[String(variables.id)] ?? [] } : query.includes('InlineQuestion') ? { inboxItem: (f.data.items as Record<string,unknown>|undefined)?.[String(variables.id)] ?? f.data.item ?? null } : query.includes('ConversationWork(') ? { tasks: f.data.sourceTasks ?? [], conversationMadeChanges:f.data.madeChanges ?? [] } : query.includes('MentionedWork(') ? { tasks: (f.data.mentionedTasks as Record<string, unknown[]> | undefined)?.[String(variables.id)] ?? [] } : f.data : undefined };
} }));
vi.mock('../../data', () => ({ callOnce: (name: string, input: unknown) => f.call(name, input), call: (name: string, input: unknown) => f.queued(name, input), useRecords: f.records }));
vi.mock('../../kit', () => Object.fromEntries(['Split','List','Row','NoteRow','Empty','Error','Loading','Button','LinkButton','Input','Textarea','Actions','Search','Pager','Reader','Head','Meta','Title','Facts','Fact','Section','Body','Foot','Chips','Chip'].map(name => [name,
  (props: { children?: ReactNode; listTop?: ReactNode; listAction?: ReactNode; list?: ReactNode; reader?: ReactNode; search?: ReactNode; folders?: unknown; onFolder?: unknown; listBusy?: boolean; icon?: ReactNode }) => name === 'Split'
    ? h(name, { folders: props.folders, onFolder: props.onFolder, listBusy: props.listBusy }, props.listAction, props.listTop, props.list, props.reader, props.search)
    // (A row's icon is an element: drawn as a child, so the tree still prints.)
    : name === 'Row' ? h(name, { ...props, icon: undefined }, props.icon)
    // (So is what a head carries at its sides.)
    : name === 'Head' ? h('header', null, (props as { leading?: ReactNode }).leading, props.children, (props as { actions?: ReactNode }).actions) : h(name, props, props.children)])));
import CommsApp from './index';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); vi.useRealTimers(); f.requests = []; f.call.mockReset(); f.queued.mockReset(); vi.unstubAllGlobals(); });
const thread = (extra = {}) => ({ id: 'th:pump', conversation: 'cv-pump', title: 'Private pump', agent: 'art', member: 'alice', pinned: false, archivedAt: null, lastAt: '2026-11-14T18:00:00Z', readSeq: 0, working: true, stopRequested: false, ...extra });
const message = (extra = {}) => ({ thread: 'th:pump', seq: 1, kind: 'reply', sender: 'art', at: '2026-11-14T18:00:00Z', words: 'PRIVATE REPLY', wordsKeepUntil: new Date(Date.now()+60000).toISOString(), ...extra });
function setup() {
  f.status = 'live'; f.thread = 'live'; f.hold = false; f.heldThread = false; f.requests = []; f.records.mockClear();
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
const press = async (label: string) => act(async () => { named(label).props.onClick(); });
/** Send is the bar's submit button: sending is submitting its form. */
const send = async () => act(async () => { void tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
const pager = (label: string) => tree.root.findAllByType('Pager').find((node: { props: { label: string } }) => node.props.label === label);
type Drawn = { children: (Drawn | string)[] };
const words = (node: Drawn): string => node.children.map(child => typeof child === 'string' ? child : words(child)).join('');
/** A piece of work: its row (the kit's), by a word of its title. */
const work = (word: string) => tree.root.findByProps({ className: 'comms__work' }).findAllByType('Row').find((node: { props: { title: string } }) => node.props.title.includes(word));
const drawnMessages = () => tree.root.findAll((node: { type: unknown; props: { className?: string } }) => node.type === 'div' && node.props.className === 'comms-msg').length;
async function draw(path = '/p/comms-preview/thread/pump', go = vi.fn()) { await act(async () => { tree = create(h(CommsApp, { path, go })); }); return go; }
it('mounts the shared Comms app, records reads and sends through authenticated shared HTTP operations', async () => {
  setup(); await draw(); expect(text()).toContain('PRIVATE REPLY'); expect(f.records).not.toHaveBeenCalled();
  expect(f.call).toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'read', seq: 1 });
  const input = tree.root.findAllByType('Textarea').find((n: { props: { 'aria-label': string } }) => n.props['aria-label'] === 'Message Art');
  await act(async () => { input.props.onChange({ target: { value: 'Find a pump' } }); });
  await send();
  expect(f.call).toHaveBeenCalledWith('comms.send', { thread: 'th:pump', words: 'Find a pump', clientId: expect.any(String) });
  expect(fetch).toHaveBeenCalledWith('/api/comms/send', expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: expect.any(String) }));
  await press('More'); await press('Pin');
  expect(f.call).toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'pin', pinned: true });
});
it('creates conversations for owned agents without passing a member identity', async () => {
  setup(); f.data.commsThread = null; delete f.data.commsMessages; delete f.data.commsRefs; const go = await draw('/p/comms-preview');
  // One agent of their own: New starts the conversation with it. Nobody else's agent is offered.
  expect(named('New').props['aria-label']).toBe('New conversation with Art'); expect(text()).not.toContain('bob');
  await press('New');
  expect(f.call).toHaveBeenCalledWith('comms.open', { agent: 'art', thread: expect.stringMatching(/^th:/) });
  expect(go).toHaveBeenCalledWith(expect.stringMatching(/^\/p\/comms-preview\/thread\//));
});
it('uses server counts, search and thread/message pages without caching old private words', async () => {
  setup(); f.data.commsThreads = Array.from({ length: 51 }, (_, n) => thread({ id: `th:${n}` }));
  f.data.commsMessages = Array.from({ length: 51 }, (_, n) => message({ seq: n+1 }));
  await draw(); expect(tree.root.findAllByType('Row')).toHaveLength(50);
  expect(tree.root.findByType('Split').props.folders[0].count).toBe(120);
  expect(pager('Conversation pages').props).toMatchObject({ hasPrevious: false, hasNext: true });
  await act(async () => { pager('Conversation pages').props.next(); }); expect(f.requests.findLast(row => row.query.includes('query Comms('))?.variables.offset).toBe(50);
  await act(async () => { tree.root.findByType('Search').props.onChange('needle'); });
  expect(f.requests.findLast(row => row.query.includes('query Comms('))?.variables).toMatchObject({ search: 'needle', offset: 0 });
  // Earlier messages are a page of their own, read above the newest ones: the thread's own reading never moves.
  const threadReads = () => new Set(f.requests.filter(row => row.query.includes('query CommsThread(')).map(row => row.variables.before));
  expect(threadReads()).toEqual(new Set([null])); expect(drawnMessages()).toBe(50);
  await press('Earlier messages');
  expect(threadReads()).toEqual(new Set([null, 2])); expect(named('Latest messages')).toBeUndefined();
  // The page before 2 is message 1 alone: it is drawn above, the newest fifty stay, and there is nothing earlier to ask for.
  expect(drawnMessages()).toBe(51); expect(named('Earlier messages')).toBeUndefined();
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
  const go = await draw(); expect(text()).toContain('SOURCE TASK'); expect(text()).toContain('MENTIONED TASK');
  // A task's stored state is said in plain words.
  expect(work('MENTIONED TASK').props.status).toBe('t-12 · in progress'); expect(text()).not.toContain('in_progress');
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
  expect(pager('Conversation work pages').props).toMatchObject({ hasPrevious: false, hasNext: true });
  f.data.sourceTasks = [{ id: 't-50', title: 'SOURCE-50', status: 'open' }];
  await act(async () => { pager('Conversation work pages').props.next(); });
  expect(f.requests.findLast(row => row.query.includes('ConversationWork('))?.variables.offset).toBe(50);
  expect(text()).toContain('SOURCE-50'); expect(text()).not.toContain('SOURCE-49');
});
it('archives, restores and confirms deletion through shared operations', async () => {
  setup(); const go = await draw();
  await press('More'); await press('Archive');
  expect(f.call).toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'archive', archived: true });
  f.data.commsThread = thread({ archivedAt: '2026-11-14T18:00:01Z' });
  await act(async () => { tree.update(h(CommsApp, { path: '/p/comms-preview/thread/pump', go })); });
  expect(named('Send')).toBeUndefined();
  expect(text()).toContain('This conversation is archived. Restore it from More to write here.');
  await press('More'); await press('Restore');
  expect(f.call).toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'archive', archived: false });
  await press('More'); await press('Delete');
  expect(f.call).not.toHaveBeenCalledWith('comms.change', { thread: 'th:pump', change: 'delete' });
  await press('Delete thread');
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
  const scroll = {scrollTop:800,scrollHeight:1000,clientHeight:200,firstElementChild:{},addEventListener:(name:string,fn:()=>void)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name)};
  vi.stubGlobal('ResizeObserver',class {observe() {} disconnect() {}});
  const go = vi.fn();
  await act(async () => { tree = create(h(CommsApp,{path:'/p/comms-preview/thread/pump',go}),{createNodeMock:(node:{props:Record<string,unknown>})=>node.props['data-comms-scroll']===''?scroll:null}); });
  f.call.mockClear(); f.data.commsThread = thread({readSeq:1});
  await act(async () => { scroll.scrollTop=0; listeners.get('scroll')?.(); });
  f.data.commsMessages = [message(),message({seq:2,words:'UNSEEN AT BOTTOM'})];
  await act(async () => { tree.update(h(CommsApp,{path:'/p/comms-preview/thread/pump',go})); });
  expect(f.call).not.toHaveBeenCalledWith('comms.change',{thread:'th:pump',change:'read',seq:2});
  await press('1 new message');
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
 f.data.questions=[{id:'in-timing',sourceId:'a-tempo'}];
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
 f.data.ordinaryApprovals=[{id:'a-command'}];f.data.questions=[{id:'in-command',sourceId:'a-command'}];f.data.items={'in-command':{id:'in-command',source:'approval',sourceId:'a-command',waitsOnKind:'approval',waitsOnId:'a-command',thread:'th:pump',state:'waiting',answers:'yes-no',at:'2026-11-14T18:00:00Z',read:false,refs:[],body:{words:'Run the fixture?'},bodyKeepUntil:new Date(Date.now()+60000).toISOString()}};
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
 expect(work('SOURCE TASK LABEL').props.status).toBe('t-90 · open · Made here');
 expect(text()).toContain('CHANGE TITLE 50');expect(text()).toContain('CHANGE TITLE 51');expect(JSON.stringify(tree.root.findByProps({'aria-label':'Conversation change github:house/loom#51'}).findAllByType('p').map((node:{props:{children:ReactNode}})=>node.props.children))).toContain('Made here');
 expect(pager('Conversation work pages').props).toMatchObject({hasNext:true,disabled:false});
 f.data.sourceTasks=[];f.data.madeChanges=[{id:'github:house/loom#51'}];
 await act(async()=>{pager('Conversation work pages').props.next();});
 expect(f.requests.findLast(row=>row.query.includes('ConversationWork('))?.variables.offset).toBe(50);expect(text()).not.toContain('CHANGE TITLE 50');expect(text()).toContain('CHANGE TITLE 51');
});

it('keeps a mentioned source task labelled Made here while the source list is on a different page',async()=>{
 setup();f.data.sourceTasks=[];f.data.commsRefs=[{ref:'t-77',messageSeq:1}];f.data.mentionedTasks={'t-77':[{id:'t-77',title:'MENTIONED SOURCE',status:'open',sourceKind:'conversation',sourceId:'cv-pump'}]};
 await draw();expect(work('MENTIONED SOURCE').props.status).toBe('t-77 · open · Made here');
});

it('opens both a source task and a mentioned task in the Tasks tile',async()=>{
 setup();f.data.sourceTasks=[{id:'t-90',title:'SOURCE TO OPEN',status:'open'}];f.data.commsRefs=[{ref:'t-91',messageSeq:1}];f.data.mentionedTasks={'t-91':[{id:'t-91',title:'MENTION TO OPEN',status:'open'}]};
 const go=await draw();
 for(const [label,id] of [['SOURCE TO OPEN','t-90'],['MENTION TO OPEN','t-91']]){
  await act(async()=>{work(label).props.onClick();});expect(go).toHaveBeenLastCalledWith('/p/tasks-preview/task/'+id);
 }
});

it('shows the exact setting proposal to its private conversation member while the owner answer waits in a different Inbox',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-14T18:00:00Z'));setup();timingQuestion();f.data.owner=false;f.data.questions=[];f.data.commsMessages=[];f.data.ordinaryApprovals=[{id:'a-tempo'}];
 await draw();expect(text()).toContain('Tempo settings change');expect(text()).toContain('Before');expect(text()).toContain('After');expect(named('Allow')).toBeUndefined();expect(named('Deny')).toBeUndefined();
});

it('shows an open question once: in the stream where it was asked, or in the one block over the message bar', async () => {
  setup(); f.data.owner = true;
  const item = (id: string, body: string, extra = {}) => ({ id, source: 'thread', thread: 'th:pump', state: 'waiting', answers: 'yes-no', at: '2026-11-14T18:00:00Z', read: true, refs: [], body: { words: body, ifYes: 'Art orders it.', ifNo: 'Art looks again.' }, bodyKeepUntil: new Date(Date.now()+60000).toISOString(), ...extra });
  // One question was asked in a message; the conversation's own list of questions names it too, and one more.
  f.data.commsMessages = [message(), message({ seq: 2, kind: 'ask', inboxItem: 'in-ask' })];
  f.data.questions = [{ id: 'in-ask' }, { id: 'in-other' }];
  f.data.items = { 'in-ask': item('in-ask', 'ASKED IN THE STREAM'), 'in-other': item('in-other', 'ASKED ELSEWHERE') };
  f.data.commsThread = thread({ working: false });
  const go = await draw();
  const count = (needle: string) => text().split(needle).length - 1;
  expect(count('ASKED IN THE STREAM')).toBe(1); expect(count('ASKED ELSEWHERE')).toBe(1);
  // The one in the stream is inside the messages; the other is in the block named for what it is, after them and before the bar.
  expect(tree.root.findByProps({ 'data-comms-scroll': '' }).findAllByType('Reader').map(words).join(' ')).toContain('ASKED IN THE STREAM');
  const block = () => tree.root.findByProps({ className: 'comms__waiting' });
  expect(block().findByType('Section').props.label).toBe('Waiting on you');
  expect(block().findAllByType('Reader')).toHaveLength(1);
  expect(tree.root.findByProps({ className: 'comms__work' }).findAllByType('Reader')).toHaveLength(0);
  const order = tree.root.findByProps({ className: 'comms__body' }).children.map((child: { props: { className: string } }) => child.props.className);
  expect(order).toEqual(['comms__stream', 'comms__waiting', 'comms__work', 'comms__compose']);
  // A compact card: the question, what Yes and No do in one line, two answers and the way to the whole item.
  const card = block().findByType('Reader');
  expect(words(card)).toBe('ASKED ELSEWHEREYes: Art orders it. No: Art looks again.AllowDenyOpen in Inbox');
  expect(card.findAllByType('Button')).toHaveLength(2); expect(card.findAllByType('select')).toHaveLength(0); expect(card.findAllByType('Input')).toHaveLength(0);
  await act(async () => { block().findByType('LinkButton').props.onClick(); });
  expect(go).toHaveBeenCalledWith('/p/inbox-preview/ask/in-other');
  // No pager under one page of questions (the kit's Pager draws nothing then).
  expect(pager('Question pages').props).toMatchObject({ hasPrevious: false, hasNext: false });
  // The thread's head says it waits on this person, as nothing else is going on in it.
  expect(words(tree.root.findByType('header').findByType('Meta'))).toBe('with Art · Waiting on you'); expect(text()).not.toContain('Newer questions'); expect(text()).not.toContain('Older questions');
});

it('says times in the household\'s zone, briefly, and names an agent as the shared directory does', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-14T19:00:00Z')); setup();
  f.data.deskTime = { at: Date.now(), timezone: 'Asia/Tokyo' };
  f.data.memoryPeopleAccess = { directory: true }; f.data.memoryPeople = [{ id: 'commons:art', slug: 'art', agent: null, name: 'Arthur', kind: 'agent' }];
  await draw();
  // 18:00 UTC is three in the morning in Tokyo, the same day there as now: the time alone, with no zone's name.
  expect(tree.root.findAllByType('time').map((node: Drawn) => words(node))).toEqual(['3:00 AM']);
  expect(text()).not.toContain('Asia/Tokyo'); expect(text()).not.toContain(' CT');
  expect(tree.root.findByType('Textarea').props['aria-label']).toBe('Message Arthur'); expect(tree.root.findByType('Row').props.meta).toBe('Arthur');
  expect(words(tree.root.findByType('header').findByType('Meta'))).toBe('with Arthur · Working');
});

// Only the part that changes is replaced: opening a thread is the reader's business, another folder, search or page the list's.
const titles = () => tree.root.findAllByType('Row').map((node: { props: { title: string } }) => node.props.title);
const asked = (name: string) => f.requests.findLast(row => row.query.includes(`query ${name}(`));
it('opening a thread leaves the list, counts, search and pages as they were, and the reader alone loads', async () => {
  setup(); f.data.commsThreads = [thread(), thread({ id: 'th:filter', title: 'Private filter' })]; const go = vi.fn();
  await draw('/p/comms-preview', go);
  const rows = titles(), folders = tree.root.findByType('Split').props.folders, list = asked('Comms');
  expect(rows).toHaveLength(2); expect(asked('CommsThread')?.options).toMatchObject({ pause: true });
  f.thread = 'loading';
  await act(async () => { tree.update(h(CommsApp, { path: '/p/comms-preview/thread/filter', go })); });
  expect(titles()).toEqual(rows); expect(tree.root.findByType('Split').props).toMatchObject({ folders, listBusy: undefined });
  expect(tree.root.findByType('Search').props.disabled).toBe(false); expect(pager('Conversation pages').props).toMatchObject({ disabled: false, hasPrevious: false });
  expect(asked('Comms')).toEqual(list); expect(asked('Comms')?.variables).toMatchObject({ selected: false });
  expect(asked('CommsThread')).toMatchObject({ variables: { id: 'th:filter', before: null }, options: { keep: true, pause: false } });
  expect(tree.root.findAllByType('Loading')).toHaveLength(1); expect(named('Send')).toBeUndefined();
  // The thread that was open before is not the open thread: its kept words are not drawn and nothing can act on it.
  f.thread = 'live'; f.heldThread = true;
  f.lastThread = { commsThread: thread(), commsMessages: [message()], commsRefs: [] };
  await act(async () => { tree.update(h(CommsApp, { path: '/p/comms-preview/thread/filter', go })); });
  expect(text()).not.toContain('PRIVATE REPLY'); expect(named('Send')).toBeUndefined(); expect(named('More')).toBeUndefined();
  expect(tree.root.findAllByType('Loading')).toHaveLength(1); expect(titles()).toEqual(rows); expect(f.call).not.toHaveBeenCalled();
});
it('keeps the rows and counts in place while another folder loads, and a thread’s messages while an earlier page loads', async () => {
  setup(); f.data.commsMessages = Array.from({ length: 51 }, (_, n) => message({ seq: n+1 }));
  await draw();
  const rows = titles(), folders = tree.root.findByType('Split').props.folders;
  f.hold = true;
  await act(async () => { tree.root.findByType('Split').props.onFolder('1'); });
  expect(asked('Comms')).toMatchObject({ variables: { archived: true, offset: 0 }, options: { keep: true } });
  expect(titles()).toEqual(rows); expect(tree.root.findByType('Split').props).toMatchObject({ folders, listBusy: true });
  expect(tree.root.findByType('Search').props.disabled).toBe(false); expect(tree.root.findAllByType('Loading')).toHaveLength(0);
  // An earlier page is read on its own: while it loads, the one line where it will be says so and every message shown stays.
  const before = drawnMessages(); f.heldThread = true;
  await press('Earlier messages');
  expect(asked('CommsThread')).toMatchObject({ variables: { id: 'th:pump', before: 2 }, options: { keep: true } });
  expect(text()).toContain('PRIVATE REPLY'); expect(drawnMessages()).toBe(before); expect(named('Send')).toBeDefined();
  expect(tree.root.findAllByType('Loading').map((node: { props: { label?: string } }) => node.props.label)).toEqual(['Loading earlier messages…']);
  expect(f.requests.filter(row => row.query.includes('query CommsThread(')).at(-2)?.variables).toMatchObject({ id: 'th:pump', before: null });
  // The moment the feed fails, everything kept goes with it.
  f.hold = false; f.heldThread = false; f.status = 'offline';
  await act(async () => { tree.update(h(CommsApp, { path: '/p/comms-preview/thread/pump', go: vi.fn() })); });
  expect(titles()).toHaveLength(0); expect(text()).not.toContain('PRIVATE REPLY'); expect(named('Send')).toBeUndefined();
});
