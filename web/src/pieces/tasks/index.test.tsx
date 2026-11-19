import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import Tasks from './index';
import type { TasksSelection } from './query';
const feed = vi.hoisted(() => ({ current: { status: 'live', data: { tasks: [] } } as { status: 'live'; data: TasksSelection } }));
vi.mock('../../data/graphql', () => ({ useDataQuery: () => feed.current }));
vi.mock('../../kit', () => ({
  ...Object.fromEntries(['List','Row','NoteRow','Empty','Error','Loading','Button','LinkButton','Actions','Search','Input','Textarea','Field','Fields','Reader','Meta','Title','Facts','Fact','Section','Body','Chip','RefCard'].map(name => [name, (props: {children?:ReactNode}) => h(name, props, props.children)])),
  Menu: (props: {children(close:()=>void):ReactNode}) => h('Menu', props, props.children(() => {})),
  Split: (props: {list?:ReactNode;reader?:ReactNode;listTop?:ReactNode;listAction?:ReactNode;search?:ReactNode}) => h('Split', props, props.search, props.listAction, props.listTop, props.list, props.reader),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
it('keeps pending and rejected creates out of the list until the canonical feed supplies a row', async () => {
  let reject!: (error: Error) => void;
  const submit = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  await act(async () => { tree = create(h(Tasks, { submit, people: [{ kind: 'agent', id: 'art', label: 'Art' }] })); });
  const createButton = tree.root.findAllByType('Button').find((node: {props: {children: string}}) => node.props.children === 'Create task');
  expect(createButton).toBeDefined();
  await act(async () => createButton.props.onClick());
  for (const [label, value] of [['Title','Unconfirmed pump'],['Goal','Works'],['Why','Broken'],['Owner','agent:art']]) {
    const field = tree.root.findAllByType('Field').find((node: {props: {label: string}}) => node.props.label === label);
    await act(async () => field.findAll((node: {props: {onChange?: unknown}}) => !!node.props.onChange)[0].props.onChange({target:{value}}));
  }
  let saving!: Promise<void>;
  await act(async () => { saving = tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}); });
  expect(submit).toHaveBeenCalledOnce();
  expect(tree.root.findAllByType('Row')).toHaveLength(0);
  await act(async () => { reject(new Error('Write denied')); await saving; });
  expect(tree.root.findByProps({role:'alert'}).children).toEqual(['Write denied']);
  expect(tree.root.findAllByType('Row')).toHaveLength(0);
  feed.current = { status: 'live', data: { tasks: [{ id:'t-1', title:'Server pump', type:'task', status:'open', priority:2, position:1, ownerKind:'agent', owner:'art', project:null, assigneeKind:null, assignee:null, goal:'Works', why:'Broken', doneWhen:'', description:'', ask:null, ifYes:null, ifNo:null, closeReason:null, sourceKind:null, sourceId:null, commentCount:0, isReady:true, changeTasksByTask:[], taskLinksByTask:[], taskCommentsByTask:[] }] } };
  await act(async () => tree.update(h(Tasks, { submit })));
  expect(tree.root.findAllByType('Row').map((node: {props: {title: string}}) => node.props.title)).toEqual(['Server pump']);
});

it('opens on the folder and the one agent its path asks for, and shows everyone’s again when asked', async () => {
  const task = (id: string, fields: object) => ({ id, title: `Task ${id}`, type: 'task', status: 'in_progress', priority: 2, position: 1, ownerKind: 'agent', owner: 'art', project: null, assigneeKind: 'agent', assignee: 'art',
    goal: '', why: '', doneWhen: '', description: '', ask: null, ifYes: null, ifNo: null, closeReason: null, sourceKind: null, sourceId: null, isReady: false, isShelved: false, taskCommentsByTask: [], taskLinksByTask: [], changeTasksByTask: [], ...fields });
  feed.current = { status: 'live', data: { tasks: [task('t-1', {}), task('t-2', { assignee: 'mark' }), task('t-3', { status: 'open', assigneeKind: null, assignee: null, isReady: true }), task('t-4', { assigneeKind: 'member', assignee: 'art' })] } } as typeof feed.current;
  const go = vi.fn(), titles = () => tree.root.findAllByType('Row').map((node: {props: {title: string}}) => node.props.title);
  await act(async () => { tree = create(h(Tasks, { path: '/p/tasks-preview/?folder=progress&assignee=art', go })); });
  expect(tree.root.findByType('Split').props.folder).toBe('progress'); expect(titles()).toEqual(['Task t-1']);
  // Opening one keeps a clean path, with no doubled slash.
  await act(async () => tree.root.findAllByType('Row')[0].props.onClick()); expect(go).toHaveBeenLastCalledWith('/p/tasks-preview/task/t-1');
  // The filter is a quiet note over the rows, by the agent's name, with a link that lifts it.
  const all = tree.root.findAllByType('LinkButton').find((node: {props: {children: unknown}}) => [node.props.children].flat().join('').includes('show everyone'));
  expect(tree.root.findAllByType('Body').some((node: {props: {children: unknown}}) => [node.props.children].flat().join('').startsWith('Only Art’s tasks'))).toBe(true);
  await act(async () => all.props.onClick()); expect(titles()).toEqual(['Task t-1', 'Task t-2', 'Task t-4']);
  // A path that asks nothing opens as before.
  await act(async () => tree.unmount()); await act(async () => { tree = create(h(Tasks, { path: '/p/tasks-preview', go })); });
  expect(tree.root.findByType('Split').props.folder).toBe('ready'); expect(titles()).toEqual(['Task t-3']);
});

it('claims, unclaims and reopens at once with no form, one at a time, and says a refusal under the actions', async () => {
  const row = { id:'t-1', title:'Pump', type:'task', status:'open', priority:2, position:1, ownerKind:'agent', owner:'art', project:null, assigneeKind:null, assignee:null, goal:'Works', why:'Broken', doneWhen:'', description:'', ask:null, ifYes:null, ifNo:null, closeReason:null, sourceKind:null, sourceId:null, commentCount:0, isReady:true, isShelved:false, changeTasksByTask:[], taskLinksByTask:[], taskCommentsByTask:[] };
  feed.current = { status: 'live', data: { tasks: [row] } } as typeof feed.current;
  let reject!: (error: Error) => void;
  const submit = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  await act(async () => { tree = create(h(Tasks, { path: '/p/tasks-preview/task/t-1', go: vi.fn(), submit })); });
  const button = (label: string) => tree.root.findAllByType('Button').find((node: {props: {children: string}}) => node.props.children === label);
  await act(async () => { button('Claim').props.onClick(); button('Claim').props.onClick(); });
  expect(submit).toHaveBeenCalledExactlyOnceWith({ action: 'claim', id: 't-1' });
  expect(tree.root.findAllByType('form')).toHaveLength(0); expect(button('Claim').props.disabled).toBe(true);
  await act(async () => { reject(new Error('Someone else has it')); });
  expect(tree.root.findByType('Error').props.text).toBe('Someone else has it'); expect(button('Claim').props.disabled).toBeFalsy();
  // A form opens in place, one at a time; its own button closes it again.
  await act(async () => button('Comment').props.onClick());
  expect(tree.root.findByType('form').props['aria-label']).toBe('Add comment'); expect(tree.root.findAllByType('Error')).toHaveLength(0);
  await act(async () => button('Priority').props.onClick());
  expect(tree.root.findAllByType('form').map((node: {props: Record<string, string>}) => node.props['aria-label'])).toEqual(['Set priority']);
  await act(async () => button('Priority').props.onClick());
  expect(tree.root.findAllByType('form')).toHaveLength(0);
});
