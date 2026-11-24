import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from '../../web/node_modules/react/index.js';
import { act, create } from '../../web/node_modules/react-test-renderer/index.js';
import type { DataQuerySnapshot } from '../../web/src/data/graphql';
import type { TasksSelection, TaskSelection } from '../../web/src/pieces/tasks/query';
import { taskCommentsQuery, taskSourceQuery, tasksQuery } from '../../web/src/pieces/tasks/query';
const f = vi.hoisted(() => ({snapshot: {status:'loading'} as DataQuerySnapshot<TasksSelection>, source: {status:'live',data:{source:null}} as DataQuerySnapshot<{source:{id:string;venue:string;place:string}|null}>, read: vi.fn()}));
vi.mock('../../web/src/data/graphql', () => ({useDataQuery: (query: string, variables: unknown, options: unknown) => { f.read(query, variables, options); return query === taskSourceQuery ? f.source : f.snapshot; }}));
// The open form is handed to the view, which draws it in the reader.
vi.mock('../../web/src/pieces/tasks/shared-view', () => ({SharedTasks: (props: {form?: {node: ReactNode}}) => h('Tasks',props,props.form?.node)}));
vi.mock('../../web/src/pieces/tasks/shared-form', () => ({SharedTaskForm: (props: unknown) => h('Form',props)}));
import TasksApp from '../../web/src/pieces/tasks';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); f.read.mockClear(); });
const task = (id: string, isReady: boolean): TaskSelection => ({id,title:id,type:'task',status:'open',priority:2,position:1,ownerKind:'member',owner:'sam',project:'pond',assigneeKind:null,assignee:null,goal:'Goal',why:'Why',doneWhen:'',description:'',ask:null,ifYes:null,ifNo:null,closeReason:null,sourceKind:null,sourceId:null,commentCount:1,isReady,taskLinksByTask:[]});
it('mounts the generated selection, authoritative readiness, comments and shell navigation without a record feed', async () => {
  f.snapshot = {status:'live',data:{tasks:[task('a',false),task('b',true)],selectedTask:{id:'a',changeTasksByTask:[{changeRow:null},{changeRow:{id:'pr',repository:'garden',number:3,title:'Repair',state:'open',draft:false,checks:'passing',review:'approved',waitingOn:'done'}}],taskCommentsByTask:[{task:'a',seq:1,actorKind:'member',actor:'sam',at:'2026-11-14T00:00:00Z',text:'Comment'}]}}};
  const go = vi.fn();
  await act(async () => {tree = create(h(TasksApp,{path:'/p/tasks-preview/task/~a',go,questionFor:'sam'}));});
  expect(f.read).toHaveBeenCalledWith(tasksQuery, {selected:'a', withComments:true}, {keep:true});
  const props = tree.root.findByType('Tasks').props;
  expect(props.ready).toEqual(['b']); expect(props.selected).toBe('a'); expect(props.questionFor).toBe('sam');
  expect(props.changes).toMatchObject([{id:'pr',task:'a'}]); expect(props.comments).toHaveLength(1); expect(props.act).toBeUndefined();
  await act(async () => props.select('b'));
  expect(go).toHaveBeenCalledWith('/p/tasks-preview/task/~b');
  // The detail feed can retain the previous task until its replacement arrives.
  await act(async () => tree.update(h(TasksApp,{path:'/p/tasks-preview/task/~b',go})));
  const switched = tree.root.findByType('Tasks').props;
  expect(switched.changes ?? []).toEqual([]); expect(switched.comments).toEqual([]);
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

it('keeps the list selection stable and reads comments only for the visible open task', async () => {
  f.snapshot = {status:'live', data:{tasks:[task('a',true),task('b',true)]}};
  await act(async () => { tree = create(h(TasksApp,{path:'/p/tasks-preview'})); });
  for (const id of ['a', 'b', 'hidden', undefined]) {
    const props = {path:id ? '/p/tasks-preview/task/~' + id : '/p/tasks-preview'};
    f.read.mockClear();
    await act(async () => { tree.update(h(TasksApp,props)); });
    expect(f.read).toHaveBeenCalledWith(tasksQuery, {selected:'',withComments:false}, {keep:true});
    expect(f.read).toHaveBeenCalledWith(taskCommentsQuery, {selected:id}, {pause:id!=='a' && id!=='b'});
  }
});

it('offers a route only for the selected task’s visible source', async () => {
  const row = {...task('a',true), sourceKind:'conversation', sourceId:'cv-a'};
  f.snapshot = {status:'live',data:{tasks:[row]}};
  const go = vi.fn(), props = {path:'/p/tasks-preview/task/~a',go};
  const render = async () => act(async () => { tree.update(h(TasksApp,props)); });
  const open = () => tree.root.findByType('Tasks').props.conversation;
  await act(async () => { tree=create(h(TasksApp,props)); });
  expect(f.read).toHaveBeenCalledWith(taskSourceQuery,{id:'cv-a'},{pause:false});
  expect(open()).toBeUndefined();
  for (const [venue,place,path] of [
    ['loom','th:pump','/p/comms-preview/thread/pump'],
    ['wake','nightly','/p/comms-preview/conversation/cv-a'],
  ]) {
    f.source = {status:'live',data:{source:{id:'cv-a',venue,place}}};
    await render();open()('cv-a');expect(go).toHaveBeenLastCalledWith(path);
  }
  f.source = {status:'denied',data:f.source.data};await render();expect(open()).toBeUndefined();
  f.source = {status:'live',data:{source:{id:'different',venue:'loom',place:'th:other'}}};
  await render();expect(open()).toBeUndefined();
  f.snapshot = {status:'live',data:{tasks:[{...row,sourceKind:'old-conversation'}]}};
  await render();expect(f.read).toHaveBeenCalledWith(taskSourceQuery,{id:null},{pause:true});
  expect(open()).toBeUndefined();
});
