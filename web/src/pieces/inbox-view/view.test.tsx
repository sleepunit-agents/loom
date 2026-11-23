import { afterEach, expect, it, vi } from 'vitest';
import { Children, createElement as h, type ReactNode } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';
vi.mock('../../kit', () => Object.fromEntries(['Split', 'Row', 'NoteRow', 'Empty', 'Error', 'Loading', 'Button', 'LinkButton', 'Input', 'Textarea', 'Actions', 'Search', 'Pager', 'Reader', 'Meta', 'Title', 'Facts', 'Fact', 'Section', 'Body', 'Foot', 'Chips', 'Chip'].map(name => [name, (props: { children?: ReactNode; title?: ReactNode; status?: ReactNode; actions?: ReactNode; list?: ReactNode; reader?: ReactNode; search?: ReactNode; listTop?: ReactNode; onFolder?: (id: string) => void }) => name === 'Split' ? h(name, { label: 'Inbox', onFolder: props.onFolder }, props.listTop, props.list, props.reader, props.search) : name === 'NoteRow' ? h(name, { status: props.status }, props.title, props.actions, props.children) : h(name, props, props.children)])));
import { InboxQuestionCard, InboxView } from './index';
import { rows, type InboxActions, type InboxItem, type InboxSnapshot } from './model';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const item: InboxItem = { id: 'in-pump', source: 'thread', agent: 'art', project: 'pond', at: '2026-11-14T20:00:00Z', state: 'waiting', volume: 'full', answers: 'yes-no', read: false, refs: ['t-12'], body: { words: 'Buy the private pump?', why: 'In stock today', ifYes: 'Order it', ifNo: 'Skip it', link: 'https://example.test/pump' } };
const snapshot: InboxSnapshot = { status: 'live', items: [item] };
const buttons = () => tree.root.findAllByType('Button');
const named = (name: string) => buttons().find((button: { props: { children: string } }) => button.props.children === name);
const links = () => tree.root.findAllByType('LinkButton');
const notify = () => tree.root.findAllByType('select')[0];
async function draw(s = snapshot, actions?: InboxActions) { await act(async () => { tree = create(h(InboxQuestionCard, { id: item.id, snapshot: s, actions, zone: 'America/Chicago' })); }); }
it('shows the actual question and outcomes, marks it read, and serializes answer taps', async () => {
  let finish!: () => void;
  const answer = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), read = vi.fn(async () => {});
  await draw(snapshot, { answer, read });
  const text = JSON.stringify(tree.toJSON());
  for (const words of ['Buy the private pump?', 'In stock today', 'Order it', 'Skip it', 't-12', 'art · open', 'Nov 14, 2026, 2:00 PM', ' · pond', 'Or answer in your own words']) expect(text).toContain(words);
  expect(text).not.toContain('waiting'); expect(text).not.toContain('America/Chicago'); expect(text).not.toContain(' CT');
  expect(tree.root.findAllByType('Fact').map((fact: { props: { label: string } }) => fact.props.label)).toEqual(['Why', 'If yes', 'If no', 'About']);
  expect(tree.root.findByType('Section').props.label).toBe('Record your answer');
  expect(buttons().map((button: { props: { children: string; variant?: string } }) => [button.props.children, button.props.variant])).toEqual([['Yes', 'primary'], ['No', undefined], ['Record answer', undefined], ['Mark done', undefined], ['Dismiss', undefined]]);
  expect(read).toHaveBeenCalledExactlyOnceWith(item.id);
  await act(async () => { const yes = named('Yes'); yes.props.onClick(); yes.props.onClick(); });
  expect(answer).toHaveBeenCalledExactlyOnceWith(item.id, 'yes', undefined);
  await act(async () => { finish(); });
});
it('accepts words and acknowledgements while keeping linked source answers in their own app', async () => {
  const answer = vi.fn(async () => {}), openSource = vi.fn();
  await draw({ ...snapshot, items: [{ ...item, answers: 'words' }] }, { answer, openSource });
  expect(named('Yes')).toBeUndefined();
  await act(async () => { tree.root.findByType('Input').props.onChange({ target: { value: '  Pick the middle one  ' } }); });
  await act(async () => { named('Record answer').props.onClick(); });
  expect(answer).toHaveBeenCalledExactlyOnceWith(item.id, 'words', 'Pick the middle one');
  for (const source of ['task', 'approval', 'secret-request']) {
    const current = { ...item, source };
    await act(async () => { tree.update(h(InboxQuestionCard, { id: item.id, snapshot: { ...snapshot, items: [current] }, actions: { answer, openSource } })); });
    expect(buttons()).toHaveLength(0); expect(links()).toHaveLength(1);
    expect(links()[0].props.children).toBe({ task: 'Open the task', approval: 'Open in Approvals', 'secret-request': 'Open in Secrets' }[source]);
    await act(async () => { links()[0].props.onClick(); });
    expect(openSource).toHaveBeenLastCalledWith(current);
  }
});
it('withdraws all private text and controls on access loss, removal, or expired wording', async () => {
  const actions = { answer: vi.fn(async () => {}) };
  await draw(snapshot, actions);
  for (const status of ['offline', 'denied', 'loading'] as const) {
    await act(async () => { tree.update(h(InboxQuestionCard, { id: item.id, snapshot: { ...snapshot, status }, actions })); });
    expect(JSON.stringify(tree.toJSON())).not.toContain(item.body!.words); expect(buttons()).toHaveLength(0);
  }
  await act(async () => { tree.update(h(InboxQuestionCard, { id: item.id, snapshot: { status: 'live', items: [] }, actions })); });
  expect(buttons()).toHaveLength(0);
  await act(async () => { tree.update(h(InboxQuestionCard, { id: item.id, snapshot: { ...snapshot, items: [{ ...item, body: null }] }, actions })); });
  expect(buttons()).toHaveLength(0); expect(JSON.stringify(tree.toJSON())).not.toContain(item.body!.words);
});
it('shows generic save failures, answered history, and never turns an unsafe link into navigation', async () => {
  const answer = vi.fn(async () => { throw new Error('private server detail'); });
  await draw({ ...snapshot, items: [{ ...item, body: { ...item.body!, link: 'javascript:alert(1)' } }] }, { answer });
  expect(tree.root.findAllByType('a')).toHaveLength(0);
  await act(async () => { named('No').props.onClick(); });
  expect(tree.root.findAllByType('Error')).toHaveLength(1); expect(JSON.stringify(tree.toJSON())).not.toContain('private server detail');
  await act(async () => { tree.update(h(InboxQuestionCard, { id: item.id, snapshot: { ...snapshot, items: [{ ...item, state: 'answered', answer: 'yes', answeredBy: 'jonathan' }] }, actions: { answer } })); });
  expect(buttons()).toHaveLength(0); expect(JSON.stringify(tree.toJSON())).toContain('jonathan');
});
it('filters question/history/FYI/agent rows and hides retained detail when its current query is unavailable', async () => {
  const s: InboxSnapshot = { ...snapshot, items: [item, { ...item, id: 'done', state: 'answered' }, { ...item, id: 'notice', answers: null }, { ...item, id: 'muted', volume: 'mute' }] };
  expect(rows(s, 'needs', 'pump pond t-12').map(row => row.id)).toEqual([item.id]);
  expect(rows(s, 'answered', '').map(row => row.id)).toEqual(['done']);
  expect(rows(s, 'fyi', '').map(row => row.id)).toEqual(['notice']);
  expect(rows({ ...s, status: 'denied' }, 'all', '')).toEqual([]);
  await act(async () => { tree = create(h(InboxView, { snapshot, selected: item.id, select: vi.fn(), detail: { status: 'denied', item } })); });
  expect(tree.root.findAllByType('Reader')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).not.toContain(item.body!.words);
});

it('says Yes and No for the same question shown in chat as in the Inbox, on a compact card', async () => {
  const answer = vi.fn(async () => {});
  await act(async () => { tree = create(h(InboxQuestionCard, { id: item.id, snapshot, actions: { answer }, inline: true })); });
  expect(named('Allow')).toBeUndefined(); expect(named('Deny')).toBeUndefined();
  expect(buttons().map((button: { props: { children: string } }) => button.props.children)).toEqual(['Yes', 'No']);
  await act(async () => { named('No').props.onClick(); });
  expect(answer).toHaveBeenCalledExactlyOnceWith(item.id, 'no', undefined);
});

it('places current action outcomes in FYI and Errors and hides them with the mailbox on access loss', async () => {
  const results = { status: 'live' as const, results: [
    { id: 'saved', at: item.at, ok: true, text: 'Task closed' },
    { id: 'failed', at: item.at, ok: false, text: 'Answer failed' },
  ] };
  const props = { snapshot, results, select: vi.fn(), zone: 'America/Chicago' };
  await act(async () => { tree = create(h(InboxView, props)); });
  await act(async () => { tree.root.findByType('Split').props.onFolder('fyi'); });
  expect(JSON.stringify(tree.toJSON())).toContain('Task closed');
  expect(tree.root.findAllByType('NoteRow').map((row: { props: { status: string } }) => row.props.status)).toEqual(['Saved · Nov 14, 2026, 2:00 PM', 'Error · Nov 14, 2026, 2:00 PM']);
  await act(async () => { tree.root.findByType('Split').props.onFolder('errors'); });
  expect(JSON.stringify(tree.toJSON())).not.toContain('Task closed');
  expect(JSON.stringify(tree.toJSON())).toContain('Answer failed');
  await act(async () => { tree.update(h(InboxView, { ...props, snapshot: { ...snapshot, status: 'denied' } })); });
  expect(tree.root.findAllByType('Reader')).toHaveLength(0);
});
it('shows dim items as one-line entries, keeps mute hidden, and opens the complete question', async () => {
 const select=vi.fn(),dim={...item,volume:'dim' as const,body:{...item.body!,words:item.body!.words+'\r\nBring the spare hose.'}};
 const current:InboxSnapshot={status:'live',items:[dim,{...item,id:'muted',volume:'mute'}]};
 await act(async()=>{tree=create(h(InboxView,{snapshot:current,select}));});
 const entries=tree.root.findAllByType('Row');expect(entries).toHaveLength(1);expect(entries[0].props.title).toBe(item.body!.words);expect(entries[0].props.meta).toBeUndefined();expect(entries[0].props.status).toBeUndefined();
 await act(async()=>{entries[0].props.onClick();});expect(select).toHaveBeenCalledWith(item.id);
 await act(async()=>{tree.update(h(InboxView,{snapshot:current,selected:item.id,select}));});expect(JSON.stringify(tree.toJSON())).toContain('In stock today');
 expect(JSON.stringify(tree.toJSON())).toContain('Bring the spare hose.');
});

it('sets how loudly a managed card is shown from one quiet Notify control, without answering it, and waits for publication', async () => {
 let finish!:()=>void;
 const volume=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const quiet={...item,source:'approval',canSetVolume:true,volume:'dim' as const,quietUntil:'2026-11-15T20:00:00Z'};
 const props={id:item.id,snapshot:{...snapshot,items:[quiet]},actions:{volume},zone:'America/Chicago'};
 await act(async()=>{tree=create(h(InboxQuestionCard,props));});
 expect(buttons()).toHaveLength(0);expect(notify().props.value).toBe('dim');expect(notify().props['aria-label']).toBe('Notify');
 expect(notify().findAllByType('option').map((option:{props:{value:string;children:string}})=>[option.props.value,option.props.children])).toEqual([['full','Normal'],['dim','Quiet'],['mute','Hidden']]);
 expect(JSON.stringify(tree.toJSON())).toContain('back to normal');expect(JSON.stringify(tree.toJSON())).toContain('Nov 15, 2026, 2:00 PM');
 await act(async()=>{notify().props.onChange({target:{value:'dim'}});});
 expect(volume).not.toHaveBeenCalled();
 await act(async()=>{notify().props.onChange({target:{value:'mute'}});notify().props.onChange({target:{value:'full'}});});
 expect(volume).toHaveBeenCalledExactlyOnceWith(item.id,'mute');
 expect(notify().props.disabled).toBe(true);
 await act(async()=>{finish();});
 await act(async()=>{tree.update(h(InboxQuestionCard,{...props,snapshot:{...snapshot,items:[{...quiet,volume:'mute'}]}}));});
 expect(notify().props.value).toBe('mute');expect(notify().props.disabled).toBe(false);
 await act(async()=>{tree.update(h(InboxQuestionCard,{...props,snapshot:{...snapshot,items:[{...quiet,canSetVolume:false}]}}));});
 expect(notify()).toBeUndefined();
});

it.each(['waiting','resolved'] as const)('keeps the task link beside inline source controls for %s items',async state=>{
 const task:InboxItem={...item,source:'task',sourceId:'t-12',waitsOnKind:'task',waitsOnId:'t-12',state},openSource=vi.fn(),answer=vi.fn(async()=>{});
 await act(async()=>{tree=create(h(InboxQuestionCard,{id:task.id,snapshot:{status:'live',items:[task]},actions:{openSource,answer},sourceCard:h('p',null,'Inline task answer controls')}));});
 expect(JSON.stringify(tree.toJSON())).toContain('Inline task answer controls');
 const open=links().find((button:{props:{children:ReactNode}})=>Children.toArray(button.props.children).join('')==='Open the task');expect(open).toBeDefined();
 await act(async()=>open.props.onClick());expect(openSource).toHaveBeenCalledExactlyOnceWith(task);expect(answer).not.toHaveBeenCalled();expect(named('Yes')).toBeUndefined();
});

it('never shows a raw source word under a row that has no why', async () => {
  await act(async () => { tree = create(h(InboxView, { snapshot: { status: 'live', items: [{ ...item, source: 'notice', body: { words: 'Clock stopped' } }] }, select: vi.fn() })); });
  expect(tree.root.findByType('Row').props.meta).toBeUndefined();
});
it('keeps the open item’s row in the list while its own reading loads, and shows loading in the reader alone', async () => {
  const select = vi.fn(), other = { ...item, id: 'in-other', body: { words: 'Another question' } };
  const props = { snapshot: { status: 'live' as const, items: [item, other] }, selected: item.id, select, actions: { answer: vi.fn(async () => {}) } };
  await act(async () => { tree = create(h(InboxView, { ...props, detail: { status: 'loading', item: null } })); });
  const titles = () => tree.root.findAllByType('Row').map((row: { props: { title: string } }) => row.props.title);
  expect(titles()).toEqual([item.body!.words, 'Another question']);
  expect(tree.root.findAllByType('Loading')).toHaveLength(1); expect(buttons()).toHaveLength(0);
  // An answer for a different item than the open one is not drawn and offers nothing.
  await act(async () => { tree.update(h(InboxView, { ...props, detail: { status: 'live', item: other } })); });
  expect(tree.root.findAllByType('Reader')).toHaveLength(0); expect(buttons()).toHaveLength(0); expect(titles()).toHaveLength(2);
  await act(async () => { tree.update(h(InboxView, { ...props, detail: { status: 'live', item } })); });
  expect(named('Yes')).toBeDefined(); expect(titles()).toHaveLength(2);
  // A reading that failed or was refused takes the row with it, as before.
  await act(async () => { tree.update(h(InboxView, { ...props, detail: { status: 'offline', item: null } })); });
  expect(titles()).toEqual(['Another question']); expect(buttons()).toHaveLength(0);
});
