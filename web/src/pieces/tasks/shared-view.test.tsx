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
  ...Object.fromEntries(['List','Row','NoteRow','Empty','Error','Loading','Button','LinkButton','Actions','Search','Input','Textarea','Field','Fields','Reader','Meta','Title','Facts','Fact','Section','Body','Chip','RefCard'].map(name => [name,(props: {children?:ReactNode}) => h(name,props,props.children)])),
  // What is behind More is drawn open, so a test can say where each action is.
  Menu:(props: {children(close:()=>void):ReactNode}) => h('Menu',props,props.children(() => {})),
  Split:(props: {list?:ReactNode;reader?:ReactNode;listTop?:ReactNode;listAction?:ReactNode;search?:ReactNode}) => h('Split',props,props.search,props.listAction,props.listTop,props.list,props.reader),
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
  // One link to where it came from, and never the conversation's stored id.
  await act(async () => tree.root.findAllByType('LinkButton').find((b:{props:{children:string}})=>b.props.children==='From a conversation').props.onClick());
  expect(p.conversation).toHaveBeenCalledWith('cv-1'); expect(visibleText(tree.toJSON())).not.toContain('cv-1');
  const json=visibleText(tree.toJSON());
  expect(json.indexOf('First')).toBeLessThan(json.indexOf('Second'));
  // Each comment is said by a name, never by a kind word and an id.
  expect(tree.root.findAllByType('strong').map((node:{props:{children:string}})=>node.props.children)).toEqual(['Art','Jonathan']);
  expect(json).not.toContain('agent'); expect(json).not.toContain('member');
});
it('labels an archived conversation without offering a link to a missing thread', async () => {
  const archived = task('t-1', {sourceKind:'old-conversation', sourceId:'cv-old'});
  await draw(props({tasks:[archived], selected:archived.id, conversation:vi.fn()}));
  const text = visibleText(tree.toJSON());
  expect(text).toContain('From an archived conversation');
  expect(text).not.toContain('cv-old');
  expect(tree.root.findAllByType('LinkButton').some((link:{props:{children:string}}) => link.props.children.includes('conversation'))).toBe(false);
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
  const change = { task:'t-1',id:'github:acme/app#3',repository:'github:acme/app',number:3,title:'Order script',state:'open',draft:false,checks:'passing',review:'approved',waitingOn:'you' } as const;
  const openChange = vi.fn(), p = props({tasks:[task],selected:task.id,changes:[change],openChange}); await draw(p);
  // The same bordered card a conversation shows: its title and state in plain words, Open, and its page on GitHub.
  const card = () => tree.root.findByType('RefCard');
  expect(card().props.label).toBe('Pull request acme/app#3');
  expect(tree.root.findByType('a').props.href).toBe('https://github.com/acme/app/pull/3');
  expect(visibleText(card())).toContain('Order script'); expect(visibleText(card())).toContain('Checks passing · Approved · Waiting on you');
  await act(async () => card().findAllByType('Button').find((b:{props:{children:string}})=>b.props.children==='Open').props.onClick());
  expect(openChange).toHaveBeenCalledWith('github:acme/app#3');
  await act(async () => tree.update(h(SharedTasks,{...p,changes:[{...change,checks:'failing',review:'changes_requested',waitingOn:'author'}]})));
  expect(visibleText(card())).toContain('Checks failing · Changes requested · Waiting on its author');
  await act(async () => tree.update(h(SharedTasks,{...p,status:'denied'})));
  expect(tree.root.findAllByType('a')).toHaveLength(0);
});
it('shows a shelved task under its project marked as shelved, and in no list or count of open work',async () => {
  const shelved=task('t-1',{project:'phasecraft',isShelved:true}), held=task('t-2',{project:'phasecraft',status:'in_progress',isShelved:true,assigneeKind:'member',assignee:'jonathan',ask:'Buy it?'}), live=task('t-3',{project:'pond'});
  await draw(props({tasks:[shelved,held,live],ready:['t-3'],selected:'t-1'}));
  const split=tree.root.findByType('Split'), titles=()=>rows().map((r:{props:{title:string}})=>r.props.title);
  const count=(id:string)=>(split.props.folders as {id?:string;count?:number}[]).find(folder=>folder.id===id)?.count;
  // Counted under Shelved only: not ready, in progress, needing its person, or open.
  expect(['ready','progress','questions','open','shelved','closed'].map(count)).toEqual([1,0,0,1,2,0]);
  for (const [folder,expected] of [['ready',['t-3']],['progress',[]],['questions',[]],['open',['t-3']],['shelved',['t-1','t-2']],['project:phasecraft',['t-1','t-2']],['project:pond',['t-3']]] as const) {
    await act(async () => split.props.onFolder(folder));
    expect(titles(),folder).toEqual(expected);
  }
  // Browsing its project, each row says shelved and what it was; the open one cannot be claimed.
  await act(async () => split.props.onFolder('project:phasecraft'));
  expect(rows().map((r:{props:{status:string}})=>r.props.status)).toEqual(['t-1 · P2 · shelved · was open','t-2 · P2 · shelved · was in progress']);
  expect(visibleText(tree.toJSON())).toContain('shelved with its project · was open');
  const buttons=tree.root.findAllByType('Button').map((b:{props:{children:string}})=>b.props.children);
  expect(buttons).not.toContain('Claim');
  expect(buttons).toEqual(expect.arrayContaining(['Comment','Project','Close']));
});

it('keeps six actions in one row with one filled, the rest behind More, and opens nothing for a relation that is not there',async () => {
  const mineInProgress=task('t-2',{status:'in_progress',assigneeKind:'member',assignee:'jonathan'});
  await draw(props({tasks:[task('t-1'),mineInProgress],selected:'t-1',names:{art:'Art'}}));
  const row=()=>{const inMenu=tree.root.findByType('Menu').findAllByType('Button');return tree.root.findByType('Actions').findAllByType('Button').filter((b:unknown)=>!inMenu.includes(b));};
  const behind=()=>tree.root.findByType('Menu').findAllByType('Button').map((b:{props:{children:string}})=>b.props.children);
  expect(row().map((b:{props:{children:string}})=>b.props.children)).toEqual(['Claim','Close','Comment','Edit','Priority','Project']);
  expect(behind()).toEqual(['Ask a person','Parent','Blocked by…']);
  expect(row().filter((b:{props:{variant?:string}})=>b.props.variant==='primary').map((b:{props:{children:string}})=>b.props.children)).toEqual(['Claim']);
  // No heading over nothing: a task with no relations and no comments names none.
  expect(tree.root.findAllByType('Fact').map((f:{props:{label:string}})=>f.props.label)).not.toEqual(expect.arrayContaining(['Parent','Children','Blocked by','Blocks']));
  expect(tree.root.findAllByType('Section')).toHaveLength(0);
  // Owner is a name, with no kind word.
  expect(tree.root.findAllByType('Fact').find((f:{props:{label:string}})=>f.props.label==='Owner').props.children).toBe('Art');
  // Yours and in progress: Close is the one filled button.
  await act(async () => tree.update(h(SharedTasks,props({tasks:[task('t-1'),mineInProgress],selected:'t-2'}))));
  expect(row().filter((b:{props:{variant?:string}})=>b.props.variant==='primary').map((b:{props:{children:string}})=>b.props.children)).toEqual(['Close']);
});
it('shows a parent and a blocker as a title and a chip that opens it, and the form in place under the actions',async () => {
  const p=props({tasks:[task('t-1'),task('t-2',{title:'Pond'}),task('t-3',{title:'Hose'})],selected:'t-1',links:[{task:'t-1',dependsOn:'t-2',type:'parent-child'},{task:'t-1',dependsOn:'t-3',type:'blocks'},{task:'t-1',dependsOn:'t-9',type:'blocks'}],
    form:{action:'comment',node:h('form',{'aria-label':'Add comment'})}});
  await draw(p);
  const fact=(label:string)=>tree.root.findAllByType('Fact').find((f:{props:{label:string}})=>f.props.label===label);
  expect(visibleText(fact('Parent').children)).toContain('Pond'); expect(fact('Children')).toBeUndefined(); expect(fact('Blocks')).toBeUndefined();
  const chips=fact('Blocked by').findAllByType('Chip');
  expect(chips.map((c:{props:{children:string}})=>c.props.children)).toEqual(['t-3','t-9']);
  // One this person cannot see is its id alone, and opens nothing.
  expect(chips[1].props.onClick).toBeUndefined();
  await act(async () => chips[0].props.onClick()); expect(p.select).toHaveBeenCalledWith('t-3');
  expect(tree.root.findByType('Section').props.label).toBe('Add comment'); expect(tree.root.findByType('Section').findAllByType('form')).toHaveLength(1);
});
it('names its folders as the site does, counts projects and epics, and heads neither when there are none',async () => {
  await draw(props({tasks:[task('t-1',{project:'pond'}),task('t-2',{project:'pond',status:'closed'}),task('t-3',{project:'done',status:'closed'}),task('t-4',{type:'epic',title:'Fix the pond'})],links:[{task:'t-1',dependsOn:'t-4',type:'parent-child'}],names:{jonathan:'Jonathan'}}));
  const folders=()=>tree.root.findByType('Split').props.folders as ({id?:string;label?:string;count?:number;heading?:string})[];
  expect(folders().filter(f=>f.id&&!f.id.includes(':')).map(f=>f.label)).toEqual(['Ready','In progress','Needs Jonathan','All open','Recently closed','Shelved']);
  expect(folders().filter(f=>f.id?.includes(':')).map(f=>[f.label,f.count])).toEqual([['pond',1],['Fix the pond',1]]);
  expect(folders().filter(f=>f.heading).map(f=>f.heading)).toEqual(['Projects','Epics']);
  expect(tree.root.findByType('Split').props.listTitle).toBe('Ready'); expect(tree.root.findByType('Split').props.backLabel).toBe('Back to Tasks');
  await act(async () => tree.update(h(SharedTasks,props({tasks:[task('t-1')]}))));
  expect(folders().some(f=>f.heading)).toBe(false);
});
it('counts open epic children once across a household-sized sidebar',async()=>{
 const tasks=Array.from({length:2384},(_,i)=>task(String(i),{
  type:i<14?'epic':'task',status:i>=429?'closed':'open',project:'project-'+i%25
 }));
 let childReads=0;
 const links:SharedTaskLink[]=Array.from({length:1104},(_,i)=>({
  get task(){childReads++;return String(i+14);},dependsOn:String(i%14),
  type:i<824?'parent-child':'blocks'
 }));
 await draw(props({tasks,links}));
 const folders=tree.root.findByType('Split').props.folders as {id?:string;count?:number}[];
 const counts=folders.filter(f=>f.id?.startsWith('epic:')).map(f=>f.count);
 expect(counts).toEqual(Array.from({length:14},(_,i)=>i<9?30:29));
 expect(childReads).toBeLessThanOrEqual(links.length);
});
