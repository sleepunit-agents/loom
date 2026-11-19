import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import Tasks from './index';
import type { TasksSelection } from './query';
const feed = vi.hoisted(() => ({ current: { status: 'live', data: { tasks: [] } } as { status: 'live'; data: TasksSelection } }));
vi.mock('../../data/graphql', () => ({ useDataQuery: () => feed.current }));
vi.mock('../../components/ui/dialog', () => Object.fromEntries(['Dialog','DialogContent','DialogTitle'].map(name => [name, (props: { children?: ReactNode; open?: boolean }) => name === 'Dialog' && !props.open ? null : h(name, props, props.children)])));
vi.mock('../../kit', () => ({
  ...Object.fromEntries(['List','Row','Empty','Error','Loading','Button','Input','Textarea'].map(name => [name, (props: {children?:ReactNode}) => h(name, props, props.children)])),
  Split: (props: {list?:ReactNode;reader?:ReactNode;listTop?:ReactNode;search?:ReactNode}) => h('Split', props, props.search, props.listTop, props.list, props.reader),
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
    const field = tree.root.findAllByType('label').find((node: {children: unknown[]}) => node.children[0] === label);
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
  const all = tree.root.findAllByType('Button').find((node: {props: {children: unknown}}) => [node.props.children].flat().join('').includes('show everyone'));
  await act(async () => all.props.onClick()); expect(titles()).toEqual(['Task t-1', 'Task t-2', 'Task t-4']);
  // A path that asks nothing opens as before.
  await act(async () => tree.unmount()); await act(async () => { tree = create(h(Tasks, { path: '/p/tasks-preview', go })); });
  expect(tree.root.findByType('Split').props.folder).toBe('ready'); expect(titles()).toEqual(['Task t-3']);
});
