import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from '../../web/node_modules/react/index.js';
import { act, create } from '../../web/node_modules/react-test-renderer/index.js';
import type { DataQuerySnapshot } from '../../web/src/data/graphql';
import type { TasksSelection, TaskSelection } from '../../web/src/pieces/tasks/query';
import { tasksQuery } from '../../web/src/pieces/tasks/query';
const f = vi.hoisted(() => ({snapshot: {status:'loading'} as DataQuerySnapshot<TasksSelection>, read: vi.fn()}));
vi.mock('../../web/src/data/graphql', () => ({useDataQuery: (query: string) => { f.read(query); return f.snapshot; }}));
vi.mock('../../web/src/pieces/tasks/shared-view', () => ({SharedTasks: (props: unknown) => h('Tasks',props)}));
vi.mock('../../web/src/pieces/tasks/shared-form', () => ({SharedTaskForm: (props: unknown) => h('Form',props)}));
vi.mock('../../web/src/components/ui/dialog', () => Object.fromEntries(['Dialog','DialogContent','DialogTitle'].map(name => [name, (props: {children?: ReactNode; open?: boolean}) => name === 'Dialog' && !props.open ? null : h(name, props, props.children)])));
import TasksApp from '../../web/src/pieces/tasks';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); f.read.mockClear(); });
const task = (id: string, isReady: boolean): TaskSelection => ({id,title:id,type:'task',status:'open',priority:2,position:1,ownerKind:'member',owner:'sam',project:'pond',assigneeKind:null,assignee:null,goal:'Goal',why:'Why',doneWhen:'',description:'',ask:null,ifYes:null,ifNo:null,closeReason:null,sourceKind:null,sourceId:null,commentCount:1,isReady,changeTasksByTask:[],taskLinksByTask:[],taskCommentsByTask:[{task:id,seq:1,actorKind:'member',actor:'sam',at:'2026-11-14T00:00:00Z',text:'Comment'}]});
it('mounts the generated selection, authoritative readiness, comments and shell navigation without a record feed', async () => {
  f.snapshot = {status:'live',data:{tasks:[task('a',false),task('b',true)]}};
  const go = vi.fn();
  await act(async () => {tree = create(h(TasksApp,{path:'/p/tasks-preview/task/~a',go,questionFor:'sam'}));});
  expect(f.read).toHaveBeenCalledWith(tasksQuery);
  const props = tree.root.findByType('Tasks').props;
  expect(props.ready).toEqual(['b']); expect(props.selected).toBe('a'); expect(props.questionFor).toBe('sam');
  expect(props.comments).toHaveLength(2); expect(props.act).toBeUndefined();
  await act(async () => props.select('b'));
  expect(go).toHaveBeenCalledWith('/p/tasks-preview/task/~b');
});
it('clears all projections on lost feed and discards open forms before reconnect', async () => {
  f.snapshot = {status:'live',data:{tasks:[task('a',true)]}};
  const submit=vi.fn();
  await act(async () => {tree=create(h(TasksApp,{submit}));});
  await act(async () => tree.root.findByType('Tasks').props.act('comment',f.snapshot.data!.tasks[0]));
  expect(tree.root.findByType('Form').props.submit).toBe(submit);
  for (const status of ['offline','loading','denied'] as const) {
    f.snapshot={status,data:{tasks:[task('a',true)]}};
    await act(async () => tree.update(h(TasksApp,{submit})));
    const props=tree.root.findByType('Tasks').props;
    expect(props.tasks).toEqual([]);expect(props.comments).toEqual([]);expect(props.links).toEqual([]);expect(props.ready).toEqual([]);
    expect(tree.root.findAllByType('Form')).toHaveLength(0);
  }
  f.snapshot={status:'live',data:{tasks:[task('a',true)]}};
  await act(async () => tree.update(h(TasksApp,{submit})));
  expect(tree.root.findAllByType('Form')).toHaveLength(0);
});
