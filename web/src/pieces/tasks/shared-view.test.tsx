import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import type { tasks, taskLinks, taskComments } from '../../../../src/core/data/schema';
import { SharedTasks, type SharedTasksProps, type SharedTask, type SharedTaskLink, type SharedTaskComment } from './shared-view';
// Keep the browser projection assignable directly from Drizzle rows.
type Assert<T extends true> = T;
export type ProjectionContract = [Assert<typeof tasks.$inferSelect extends SharedTask ? true : false>, Assert<typeof taskLinks.$inferSelect extends SharedTaskLink ? true : false>, Assert<typeof taskComments.$inferSelect extends SharedTaskComment ? true : false>];
vi.mock('../../kit', () => ({
  ...Object.fromEntries(['List','Row','Empty','Error','Loading','Button','Input'].map(name => [name,(props: {children?:ReactNode}) => h(name,props,props.children)])),
  Split:(props: {list?:ReactNode;reader?:ReactNode;listTop?:ReactNode;search?:ReactNode}) => h('Split',props,props.search,props.listTop,props.list,props.reader),
}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const task = (id: string, patch: Partial<SharedTask> = {}): SharedTask => ({id,title:id,type:'task',status:'open',priority:2,position:1,ownerKind:'agent',owner:'art',project:null,assigneeKind:null,assignee:null,goal:'Goal',why:'Reason',doneWhen:'',description:'',ask:null,ifYes:null,ifNo:null,closeReason:null,sourceKind:null,sourceId:null,...patch});
const props = (patch: Partial<SharedTasksProps> = {}): SharedTasksProps => ({status:'live',tasks:[],links:[],comments:[],ready:[],questionFor:'jonathan',select:vi.fn(),act:vi.fn(),...patch});
const draw = async (p:SharedTasksProps) => {await act(async () => {tree=create(h(SharedTasks,p));});};
const rows = () => tree.root.findAllByType('Row');
const visibleText = (node: {children?: unknown[]} | unknown[] | string | null): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(n => visibleText(n as Parameters<typeof visibleText>[0])).join(' ') : node ? visibleText(node.children ?? []) : '';
it('uses the ready query and hand-kept position instead of guessing readiness from visible links',async () => {
  await draw(props({tasks:[task('t-1',{priority:1,position:7}),task('t-2',{priority:1,position:3}),task('t-3',{priority:0})],ready:['t-1','t-2']}));
  expect(rows().map((r:{props:{title:string}})=>r.props.title)).toEqual(['t-2','t-1']);
});
it('shows a person’s outstanding questions, and filters project and epic membership independently',async () => {
  await draw(props({tasks:[task('t-1',{assigneeKind:'member',assignee:'jonathan'}),task('t-2',{assigneeKind:'member',assignee:'jonathan',ask:'Buy it?',project:'pond'}),task('t-3',{type:'epic'})],links:[{task:'t-2',dependsOn:'t-3',type:'parent-child'}]}));
  for (const folder of ['questions','project:pond','epic:t-3']) {
    await act(async () => tree.root.findByType('Split').props.onFolder(folder));
    expect(rows().map((r:{props:{title:string}})=>r.props.title)).toEqual(['t-2']);
  }
});
it('shows ordered comments, provenance and task actions without offering claim on an outstanding ask',async () => {
  const t=task('t-1',{ask:'Buy it?',sourceKind:'conversation',sourceId:'cv-1'}), p=props({tasks:[t],selected:t.id,conversation:vi.fn(),comments:[{task:t.id,seq:2,actorKind:'member',actor:'jonathan',at:'2026-11-14T20:00:00Z',text:'Second'},{task:t.id,seq:1,actorKind:'agent',actor:'art',at:'2026-11-14T19:00:00Z',text:'First'}]});
  await draw(p);
  const buttons=tree.root.findAllByType('Button');
  expect(buttons.some((b:{props:{children:string}})=>b.props.children==='Claim')).toBe(false);
  await act(async () => buttons.find((b:{props:{children:string}})=>b.props.children==='Comment').props.onClick());
  expect(p.act).toHaveBeenCalledWith('comment',t);
  await act(async () => buttons.find((b:{props:{children:string}})=>b.props.children==='From conversation').props.onClick());
  expect(p.conversation).toHaveBeenCalledWith('cv-1');
  const json=visibleText(tree.toJSON());
  expect(json.indexOf('First')).toBeLessThan(json.indexOf('Second'));
});
it('clears task detail, comments, folders and actions as soon as the authorized snapshot is lost',async () => {
  const p=props({tasks:[task('t-1',{title:'Private pump',project:'private'})],ready:['t-1'],selected:'t-1',comments:[{task:'t-1',seq:1,actorKind:'agent',actor:'art',at:'2026-11-14T19:00:00Z',text:'Private comment'}]});
  await draw(p);
  for (const status of ['unavailable','denied','loading'] as const) {
    await act(async () => tree.update(h(SharedTasks,{...p,status})));
    const json=visibleText(tree.toJSON());
    expect(json).not.toContain('Private pump'); expect(json).not.toContain('Private comment');
    expect(tree.root.findByType('Split').props.folders.some((f:{id?:string})=>f.id==='project:private')).toBe(false);
    expect(tree.root.findAllByType('Button')).toHaveLength(1);
    expect(tree.root.findByType('Button').props.disabled).toBe(true);
  }
});
it('renders a closed cancelled task as cancelled and offers reopen rather than claim',async () => {
  await draw(props({tasks:[task('t-1',{status:'closed',closeReason:'cancelled'})],selected:'t-1'}));
  await act(async()=>tree.root.findByType('Split').props.onFolder('closed'));
  expect(rows()[0].props.status).toContain('cancelled');
  const labels=tree.root.findAllByType('Button').map((b:{props:{children:string}})=>b.props.children);
  expect(labels).toContain('Reopen'); expect(labels).not.toContain('Claim'); expect(labels).not.toContain('Close');
});

it('shows current linked pull request state and drops it with the authorized snapshot', async () => {
  const task = { id:'t-1', title:'Work', type:'task', status:'open', priority:2, position:0, ownerKind:'household', owner:null, project:null, assigneeKind:null, assignee:null, goal:'', why:'', doneWhen:'', description:'', ask:null, ifYes:null, ifNo:null, closeReason:null, sourceKind:null, sourceId:null } as SharedTask;
  const change = { task:'t-1',id:'github:acme/app#3',repository:'github:acme/app',number:3,state:'open',checks:'passing',review:'approved' } as const;
  const p = props({tasks:[task],selected:task.id,changes:[change]}); await draw(p);
  expect(tree.root.findByType('a').props.href).toBe('https://github.com/acme/app/pull/3');
  expect(visibleText(tree.root.findByType('a').parent)).toContain('passing · approved');
  await act(async () => tree.update(h(SharedTasks,{...p,changes:[{...change,checks:'failing',review:'changes_requested'}]})));
  expect(visibleText(tree.root.findByType('a').parent)).toContain('failing · changes requested');
  await act(async () => tree.update(h(SharedTasks,{...p,status:'denied'})));
  expect(tree.root.findAllByType('a')).toHaveLength(0);
});
