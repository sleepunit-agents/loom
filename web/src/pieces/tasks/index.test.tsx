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
