import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
import type { InboxItem } from '../inbox-view/model';
type Asked = { query: string; variables: Record<string, unknown>; options?: { keep?: boolean; pause?: boolean } };
// `item` is the state of the open item's own reading; `hold` makes the list answer as the data hook does while
// the next folder, search or page loads (the last answer again, marked settling); `stray` answers with another item.
const f = vi.hoisted(() => ({ approvals: [] as unknown[], status: 'live', item: 'live', hold: false, stray: undefined as unknown, last: undefined as unknown, data: {} as Record<string, unknown>, requests: [] as Asked[], call: vi.fn(), read: vi.fn(), records: vi.fn() }));
vi.mock('../../data/graphql', () => ({ useDataQuery(query: string, variables: Record<string, unknown>, options?: Asked['options']) {
  // The household's zone, for the times the Inbox says (data/zone.ts): not one of the Inbox's own requests.
  if (query.includes('query DeskTime')) return { status: 'live', data: { deskTime: { at: 0, timezone: 'America/Chicago' } } };
  // The approvals an approval item's card is read from (data/work-views.ts): not one of the Inbox's own requests either.
  if (query.includes('query InboxProposalTitles')) return {status:'live', data:{inboxProposalTitles:[{approval:'a-grant',title:'Let Gage Taylor (Slack) use Art’s pond-et-livonia kit'}]}};
  if (query.includes('query ApprovalsView')) return { status: 'live', data: { approvals: f.approvals, approvalRules: [], approvalNotices: [], approvalRecord: [] } };
  if (/query (WorkAnswerOwner|WorkViewer)/.test(query)) return { status: 'live', data: { workAnswerOwner: false, workChangesRefresh: false, members: [], homeComms: null } };
  if (!variables) return { status: 'loading' };
  f.requests.push({ query, variables, options });
  if (options?.pause) return { status: 'loading' };
  if (query.includes('query InboxItem(')) {
    const status = f.status === 'live' ? f.item : f.status, one = f.data.inboxItem as { id: string } | null;
    return { status, data: status === 'live' ? { inboxItem: f.stray ?? (one?.id === variables.id ? one : (f.data.inboxItems as { id: string }[]).find(row => row.id === variables.id) ?? null) } : undefined };
  }
  if (f.status === 'live' && f.hold && options?.keep) return { status: 'live', data: f.last, settling: true };
  return { status: f.status, data: f.status === 'live' ? f.last = { ...f.data, inboxItems: variables.onlyErrors ? undefined : f.data.inboxItems, inboxItem: null } : undefined };
} }));
vi.mock('../../data', () => ({ callOnce: (name: string, input: unknown) => f.call(name, input), call: (name: string, input: unknown) => f.read(name, input), useRecords: f.records }));
vi.mock('../../kit', () => Object.fromEntries(['Split','Row','NoteRow','Empty','Error','Loading','Button','LinkButton','Input','Textarea','Actions','Search','Pager','Reader','Meta','Title','Facts','Fact','Section','Body','Foot','Chips','Chip'].map(name => [name,
  (props: { children?: ReactNode; title?: ReactNode; status?: ReactNode; actions?: ReactNode; folder?: string; folders?: unknown; onFolder?: (id: string) => void; listTop?: ReactNode; list?: ReactNode; reader?: ReactNode; search?: ReactNode; listBusy?: boolean; listCount?: number; listKey?: string }) => name === 'Split'
    ? h(name, { folder: props.folder, folders: props.folders, onFolder: props.onFolder, listBusy: props.listBusy, listCount: props.listCount, listKey: props.listKey }, props.listTop, props.list, props.reader, props.search)
    : name === 'NoteRow' ? h(name, { status: props.status }, props.title, props.actions, props.children) : h(name, props, props.children)])));
import InboxApp from './index';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { f.approvals = []; await act(async () => tree?.unmount()); vi.useRealTimers(); f.requests = []; f.call.mockReset(); f.read.mockReset(); f.records.mockReset(); vi.unstubAllGlobals(); });
function row(extra: Partial<InboxItem> = {}): InboxItem {
  return { id: 'in-1', canAnswer: true, source: 'thread', agent: 'art', at: '2026-11-14T18:00:00.000Z', state: 'waiting', volume: 'full', answers: 'yes-no', refs: [], read: false, body: { words: 'Buy the pump?', ifYes: 'Order it', ifNo: 'Skip it' }, ...extra };
}
function setup(item = row(), items = [item]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { const result = await f.call(url.replace('/api/','').replace('/','.'),JSON.parse(String(init.body)).input).result; return {ok:result.ok,json:async()=>result}; }));
  f.read.mockImplementation(() => ({ result: Promise.resolve({ ok: true, value: { saved: true } }) }));
  f.status = 'live'; f.item = 'live'; f.hold = false; f.stray = undefined; f.requests = []; f.records.mockClear(); f.call.mockImplementation(() => ({ result: Promise.resolve({ ok: true, value: { saved: true } }) }));
  f.data = { inboxItems: items, inboxItem: item, inboxFolders: { needs: 130, alerts: 3, answered: 12, fyi: 8, all: 150, agents: [{ id: 'art', count: 149 }, { id: 'mark', count: 1 }] },
    inboxActionResults: [{ id: 'result-1', at: item.at, ok: false, text: 'Action failed', page: '/p/tasks-preview', readAt: null }] };
}
const button = (name: string) => tree.root.findAllByType('Button').find((node: { props: { children: unknown } }) => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children) === name);
const text = () => JSON.stringify(tree.toJSON());
const listed = () => f.requests.findLast(row => row.query.includes('query Inbox('));
const opened = () => f.requests.findLast(row => row.query.includes('query InboxItem('));
const link = (name: string) => tree.root.findAllByType('LinkButton').find((node: { props: { children: unknown } }) => node.props.children === name);
it('mounts shared Inbox, server folder totals and actual authenticated read/answer operations', async () => {
  setup(); const go = vi.fn();
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go })); });
  expect(text()).toContain('Buy the pump?');
  expect(tree.root.findByType('Split').props.folders).toContainEqual({ id: 'needs', label: 'Needs you', count: 130 });
  expect(tree.root.findByType('Split').props.folders).toContainEqual({ id: 'agent:mark', label: 'mark', count: 1 });
  expect(f.records).not.toHaveBeenCalled();
  expect(f.call).toHaveBeenCalledWith('inbox.read', { item: 'in-1' });
  await act(async () => { button('Yes').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('inbox.answer', { item: 'in-1', answer: 'yes' });
  expect(listed()?.variables).toMatchObject({ folder: 'needs', offset: 0, search: '' });
  expect(opened()).toMatchObject({ variables: { id: 'in-1' } });
});
it('consumes whole-mailbox search without locally discarding source matches, pages and resets the cursor on search', async () => {
  const selected = row({ read: true, body: { words: 'Different display text' }, sourceId: 'needle' });
  setup(selected, Array.from({ length: 51 }, (_, n) => row({ id: `in-${n}`, read: true })));
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview', go: vi.fn() })); });
  expect(tree.root.findAllByType('Row')).toHaveLength(50);
  expect(tree.root.findByType('Pager').props).toMatchObject({ hasPrevious: false, hasNext: true });
  await act(async () => { tree.root.findByType('Pager').props.next(); });
  expect(listed()?.variables.offset).toBe(50);
  f.data.inboxItems = [selected];
  await act(async () => { tree.root.findByType('Search').props.onChange('needle'); });
  expect(listed()?.variables).toMatchObject({ search: 'needle', offset: 0 });
  expect(text()).toContain('Different display text'); expect(tree.root.findByType('Pager').props).toMatchObject({ hasPrevious: false, hasNext: false });
});
it.each([['task','t-1','Open the task','/p/tasks-preview/task/t-1'], ['approval','a-1','Open in Approvals','/p/approvals-preview/approval/a-1'], ['secret-request','s /1','Open in Secrets','/p/settings-preview/requests/s%20%2F1']])('opens %s source questions and dismisses actual action notices without central answers', async (source, sourceId, label, path) => {
  setup(row({ source, sourceId, read: true })); const go = vi.fn();
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go })); });
  expect(button('Yes')).toBeUndefined();
  await act(async () => { link(label).props.onClick(); });
  expect(go).toHaveBeenCalledWith(path);
  await act(async () => { tree.root.findByType('Split').props.onFolder('errors'); });
  expect(listed()?.variables.onlyErrors).toBe(true);
  expect(text()).toContain('Action failed');
  await act(async () => { link('Dismiss').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('inbox.dismissResult', { id: 'result-1' });
});
it('opens the answered approval from its decision tell', async () => {
  setup(row({ source: 'approval', sourceId: 'a-card:tell:allow', refs: ['a-card'], answers: null,
    waitsOnKind: null, waitsOnId: null, canAnswer: false, read: true }));
  const go = vi.fn();
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go })); });
  expect(button('Yes')).toBeUndefined();
  expect(text()).not.toContain('Answer this at its source.');
  await act(async () => { link('Open in Approvals').props.onClick(); });
  expect(go).toHaveBeenCalledWith('/p/approvals-preview/approval/a-card');
});
it('withdraws private question and answer words at their independent deadlines and on access loss', async () => {
  vi.useFakeTimers(); const now = Date.parse('2026-11-14T18:00:00.000Z'); vi.setSystemTime(now);
  setup(row({ thread: 'th:private', read: true, state: 'answered', body: { words: 'PRIVATE QUESTION' }, answerText: 'PRIVATE ANSWER', answer: 'words',
    bodyKeepUntil: new Date(now + 1000).toISOString(), answerKeepUntil: new Date(now + 2000).toISOString() }));
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go: vi.fn() })); });
  expect(text()).toContain('PRIVATE QUESTION'); expect(text()).toContain('PRIVATE ANSWER');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(text()).not.toContain('PRIVATE QUESTION'); expect(text()).toContain('PRIVATE ANSWER');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(text()).not.toContain('PRIVATE ANSWER');
  f.status = 'denied'; await act(async () => { tree.update(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go: vi.fn() })); });
  expect(tree.root.findAllByType('Row')).toHaveLength(0); expect(button('Yes')).toBeUndefined(); expect(text()).not.toContain('Buy the pump');
});

it.each(['denied','offline'])('withdraws still-retained private words immediately when %s', async status => {
  setup(row({ thread: 'th:private', read: true, state: 'answered', body: { words: 'LIVE PRIVATE QUESTION' }, answerText: 'LIVE PRIVATE ANSWER', answer: 'words',
    bodyKeepUntil: new Date(Date.now() + 60000).toISOString(), answerKeepUntil: new Date(Date.now() + 120000).toISOString() }));
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go: vi.fn() })); });
  expect(text()).toContain('LIVE PRIVATE QUESTION'); expect(text()).toContain('LIVE PRIVATE ANSWER');
  f.status = status;
  await act(async () => { tree.update(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go: vi.fn() })); });
  expect(text()).not.toContain('LIVE PRIVATE QUESTION'); expect(text()).not.toContain('LIVE PRIVATE ANSWER');
  expect(tree.root.findAllByType('Row')).toHaveLength(0);
});

it('opens the Alerts folder using the shared notice projection', async () => {
  setup(row({ source: 'notice', answers: null, body: { words: 'Alert from Loom' } }));
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview', go: vi.fn() })); });
  expect(tree.root.findByType('Split').props.folders).toContainEqual({ id: 'alerts', label: 'Alerts', count: 3 });
  await act(async () => { tree.root.findByType('Split').props.onFolder('alerts'); });
  expect(listed()?.variables).toMatchObject({ folder: 'alerts', offset: 0 });
  expect(text()).toContain('Alert from Loom');
});

it('records opening reads over the current cookie HTTP door without a separate write connection', async () => {
  setup();
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview/ask/in-1', go: vi.fn() })); });
  expect(fetch).toHaveBeenCalledWith('/api/inbox/read', expect.objectContaining({method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'}}));
  expect(f.read).not.toHaveBeenCalled();
});

it('marks an unread item only when its mounted tile becomes visible', async () => {
  setup(); const go=vi.fn();
  await act(async()=>{tree=create(h(InboxApp,{path:'/p/inbox-preview/ask/in-1',go,visible:false}));});
  expect(f.call).not.toHaveBeenCalled();
  await act(async()=>{tree.update(h(InboxApp,{path:'/p/inbox-preview/ask/in-1',go,visible:true}));});
  expect(f.call).toHaveBeenCalledWith('inbox.read',{item:'in-1'});
});
it('keeps another recipient’s visible item readable without offering an answer',async()=>{
 setup(row({canAnswer:false}));await act(async()=>{tree=create(h(InboxApp,{path:'/p/inbox-preview/ask/in-1',go:vi.fn()}));});expect(JSON.stringify(tree.toJSON())).toContain('Buy the pump?');expect(button('Yes')).toBeUndefined();expect(button('Record answer')).toBeUndefined();expect(f.call).toHaveBeenCalledWith('inbox.read',{item:'in-1'});
});

it('hides retained private words when a canonical result cannot be decoded',async()=>{
  setup(row({thread:'th:private',read:true,body:{words:'Private fictional question'},bodyKeepUntil:new Date(Date.now()+60000).toISOString()}));
  await act(async()=>{tree=create(h(InboxApp,{path:'/p/inbox-preview/ask/in-1',go:()=>{}}));});
  expect(text()).toContain('Private fictional question');
  f.data={...f.data,inboxFolders:null};
  await act(async()=>tree.update(h(InboxApp,{path:'/p/inbox-preview/ask/in-1',go:()=>{}})));
  expect(text()).not.toContain('Private fictional question');
  expect(f.records).not.toHaveBeenCalled();
});

it('offers recipient volume independently of managed answers through the current cookie door',async()=>{
 setup(row({source:'approval',canAnswer:false,canSetVolume:true,read:true}));
 const props={path:'/p/inbox-preview/ask/in-1',go:vi.fn()};
 await act(async()=>{tree=create(h(InboxApp,props));});
 expect(button('Yes')).toBeUndefined();
 await act(async()=>{tree.root.findByType('select').props.onChange({target:{value:'mute'}});});
 expect(fetch).toHaveBeenCalledWith('/api/inbox/volume',expect.objectContaining({method:'POST',credentials:'same-origin'}));
 expect(f.call).toHaveBeenCalledWith('inbox.volume',{item:'in-1',volume:'mute'});
 f.data.inboxItem=row({canAnswer:false,canSetVolume:false,read:true});
 await act(async()=>{tree.update(h(InboxApp,props));});
 expect(tree.root.findAllByType('select')).toHaveLength(0);
});

// Only the part that changes is replaced: opening an item is the reader's business, another folder, search or page the list's.
const page = () => Array.from({ length: 51 }, (_, n) => row({ id: `in-${n}`, read: true, body: { words: `Question ${n}` } }));
const state = () => ({ rows: tree.root.findAllByType('Row').map((node: { props: { title: string } }) => node.props.title), folders: tree.root.findByType('Split').props.folders,
  count: tree.root.findByType('Split').props.listCount, search: tree.root.findByType('Search').props.disabled,
  pager: (({ disabled, hasPrevious, hasNext }: Record<string, unknown>) => ({ disabled, hasPrevious, hasNext }))(tree.root.findByType('Pager').props) });
it('opening an item leaves the list, counts, search and pager as they were, and the reader alone loads', async () => {
  setup(row({ id: 'in-elsewhere', read: true, body: { words: 'Not on this page' } }), page()); const go = vi.fn();
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview', go })); });
  const before = state(), asked = listed();
  expect(before.rows).toHaveLength(50); expect(before.search).toBe(false); expect(before.pager).toMatchObject({ disabled: false, hasNext: true });
  expect(opened()?.options).toMatchObject({ pause: true });
  f.item = 'loading';
  await act(async () => { tree.update(h(InboxApp, { path: '/p/inbox-preview/ask/in-elsewhere', go })); });
  expect(state()).toEqual(before); expect(tree.root.findByType('Split').props.listBusy).toBeUndefined();
  // The list's request did not change, so the hook has nothing to ask again.
  expect(listed()).toEqual(asked);
  expect(tree.root.findAllByType('Loading')).toHaveLength(1); expect(text()).not.toContain('Not on this page'); expect(button('Yes')).toBeUndefined();
  f.item = 'live';
  await act(async () => { tree.update(h(InboxApp, { path: '/p/inbox-preview/ask/in-elsewhere', go })); });
  expect(state()).toEqual(before); expect(tree.root.findAllByType('Loading')).toHaveLength(0); expect(tree.root.findByType('Title').props.children).toBe('Not on this page');
});
it('shows a clicked row at once from what the list already knows, and never offers a control for another item', async () => {
  setup(row({ id: 'in-3', body: { words: 'Question 3' } }), page()); const go = vi.fn();
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview', go })); });
  f.item = 'loading';
  await act(async () => { tree.root.findAllByType('Row').find((node: { props: { title: string } }) => node.props.title === 'Question 3').props.onClick(); });
  expect(go).toHaveBeenCalledWith('/p/inbox-preview/ask/in-3');
  await act(async () => { tree.update(h(InboxApp, { path: '/p/inbox-preview/ask/in-3', go })); });
  expect(tree.root.findAllByType('Row')).toHaveLength(50); expect(tree.root.findAllByType('Loading')).toHaveLength(0);
  expect(tree.root.findByType('Title').props.children).toBe('Question 3');
  await act(async () => { button('Yes').props.onClick(); });
  expect(f.call).toHaveBeenCalledWith('inbox.answer', { item: 'in-3', answer: 'yes' });
  // An answer for some other item is not the open item: nothing is drawn from it and nothing can act on it.
  f.item = 'live'; f.stray = row({ id: 'in-7', canSetVolume: true, body: { words: 'Stray question' } }); f.call.mockClear();
  await act(async () => { tree.update(h(InboxApp, { path: '/p/inbox-preview/ask/in-3', go })); });
  expect(text()).not.toContain('Stray question'); expect(button('Yes')).toBeUndefined(); expect(tree.root.findAllByType('select')).toHaveLength(0);
  expect(f.call).not.toHaveBeenCalled(); expect(tree.root.findAllByType('Row')).toHaveLength(50);
});
it('keeps the folders, counts, rows, search and pager in place while another folder, search or page loads', async () => {
  setup(row({ id: 'in-3', body: { words: 'Question 3' } }), page()); const go = vi.fn();
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview', go })); });
  const before = state(), list = tree.root.findByType('Split').props.listKey;
  f.hold = true;
  await act(async () => { tree.root.findByType('Pager').props.next(); });
  expect(listed()).toMatchObject({ variables: { offset: 50 }, options: { keep: true } });
  expect(state()).toEqual({ ...before, pager: { ...before.pager, hasPrevious: true } });
  expect(tree.root.findByType('Split').props).toMatchObject({ listBusy: true }); expect(tree.root.findByType('Split').props.listKey).not.toBe(list);
  expect(tree.root.findAllByType('Loading')).toHaveLength(0);
  await act(async () => { tree.root.findByType('Search').props.onChange('pump'); });
  expect(listed()?.variables).toMatchObject({ search: 'pump', offset: 0 });
  expect(tree.root.findByType('Search').props).toMatchObject({ value: 'pump', disabled: false }); expect(state().rows).toEqual(before.rows); expect(state().folders).toEqual(before.folders);
  // Another folder: its name and count head the list at once, over the last rows until its own arrive.
  await act(async () => { tree.root.findByType('Split').props.onFolder('answered'); });
  expect(listed()?.variables).toMatchObject({ folder: 'answered', offset: 0 });
  expect(tree.root.findByType('Split').props).toMatchObject({ folder: 'answered', listCount: 12, listBusy: true }); expect(state().rows).toEqual(before.rows);
  // Rows kept from the last page lend the reader nothing: an item opened now waits for its own reading.
  f.item = 'loading';
  await act(async () => { tree.update(h(InboxApp, { path: '/p/inbox-preview/ask/in-3', go })); });
  expect(tree.root.findAllByType('Loading')).toHaveLength(1); expect(button('Yes')).toBeUndefined(); expect(state().rows).toEqual(before.rows);
  // The moment the feed fails, the kept rows and counts go with it.
  f.hold = false; f.status = 'offline';
  await act(async () => { tree.update(h(InboxApp, { path: '/p/inbox-preview/ask/in-3', go })); });
  expect(tree.root.findAllByType('Row')).toHaveLength(0); expect(text()).not.toContain('Question'); expect(tree.root.findByType('Search').props.disabled).toBe(true);
});

it('says an approval item as its card says it: the plain sentence in the row and the title, and the card itself in the reader', async () => {
  const account = { platform: 'slack', workspace: 'T02AYL3QM', user: 'U07V8CZUC1J' }, after = { agent: 'art', grant: true, kit: 'pond-et-livonia', to: account };
  const raw = 'Grant art kit pond-et-livonia to slack user U07V8CZUC1J in T02AYL3QM?';
  const item = row({ source: 'approval', waitsOnKind: 'approval', waitsOnId: 'a-grant', canAnswer: false, body: { words: raw, why: 'Restore the recorded Pond field scope.', ifYes: 'Grant it.', ifNo: 'Keep the current access.' } });
  setup(item);
  f.approvals = [{ id: 'a-grant', kind: 'setting', operation: 'household.change', target: 'household:kitGrant:art/pond-et-livonia ' + JSON.stringify(account), what: 'kitGrant art/pond-et-livonia ' + JSON.stringify(account) + ': ' + JSON.stringify(after),
    changeSummary: 'kitGrant art/pond-et-livonia ' + JSON.stringify(account) + ': ' + JSON.stringify(after), ask: raw, ifYes: 'Grant it.', ifNo: 'Keep the current access.', why: 'Restore the recorded Pond field scope.', agent: 'art', project: null, member: null, conversation: null,
    state: 'pending', details: JSON.stringify({ change: 'kitGrant', after, seal: { nonce: 'n', digest: 'd' } }), askedAt: item.at, decidedBy: null, expiresAt: null }];
  f.records.mockReturnValue({ status: 'loading', records: [] });
  await act(async () => { tree = create(h(InboxApp, { path: '/p/inbox-preview/ask/in-1' })); });
  const sentence = 'Let Gage Taylor (Slack) use Art’s pond-et-livonia kit';
  expect(tree.root.findByType('Row' as never).props.title).toBe(sentence);
  expect(tree.root.findAllByType('Title' as never)[0].props.children).toBe(sentence);
  const words = JSON.stringify(tree.toJSON());
  expect(words).not.toContain('When Art works on that account’s word in an eligible conversation.');
  expect(words).not.toContain('Grant art kit'); expect(words).not.toContain('{\\"');
  // An approval the reader may not see leaves the item in the words stored with it.
  f.approvals = [];
  await act(async () => { tree.update(h(InboxApp, { path: '/p/inbox-preview/ask/in-1' })); });
  expect(tree.root.findByType('Row' as never).props.title).toBe(raw);
});
