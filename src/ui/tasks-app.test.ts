import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement as h, useSyncExternalStore } from '../../web/node_modules/react/index.js';
import { act, create } from '../../web/node_modules/react-test-renderer/index.js';
import type { Task } from '../../web/src/pieces/tasks/model';
const f = vi.hoisted(() => ({ snapshot: { records: [] as Task[], status: 'live' }, listeners: new Set<() => void>(), call: vi.fn() }));
vi.mock('../../web/src/data', () => ({ useRecords: () => useSyncExternalStore((fn) => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.snapshot), call: f.call }));
vi.mock('../../web/src/lib/cojeev-motion/use-reduced-motion', () => ({ useReducedMotion: () => true }));
import TasksApp from '../../web/src/pieces/tasks';
import { ActionForm } from '../../web/src/pieces/tasks/actions';
import { pullRequests, type TaskAnswer } from '../../web/src/pieces/tasks/model';
import type { CallState, Result } from '../../web/src/data';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const task = (id: string, fields: Partial<Task> = {}): Task => ({ id,title:`Work ${id}`,type:'task',status:'open',priority:2,ready:true,dependsOn:[],comments:[],createdAt:'2026-11-12T00:00:00Z',...fields });
let tree: ReturnType<typeof create>;
const draw = async (element = h(TasksApp)) => { await act(async () => { tree = create(element); }); };
const text = () => JSON.stringify(tree.toJSON());
const words = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(words).join('');
const button = (name: string) => tree.root.findAllByType('button').find(b => words(b).startsWith(name))!;
const click = async (name: string) => { await act(async () => button(name).props.onClick()); };
beforeEach(() => { f.call.mockReset(); f.listeners.clear(); f.snapshot={records:[task('t-1',{goal:'A useful result',description:'Full detail',project:'pond',parent:'t-4',comments:[{actor:'art',at:'2026-11-12T00:00:00Z',text:'First comment'}]}),task('t-2',{status:'in_progress',ready:false,assignee:'art'}),task('t-3',{assignee:'jonathan',blocked:true,ready:false}),task('t-4',{type:'epic',ready:false}),task('t-5',{status:'closed',ready:false})],status:'live'}; });
describe('Tasks component on a fake store', () => {
  it('shows folders, projects, open-child epics, search and full reader, newest comment last', async () => {
    await draw();
    for (const name of ['Ready','In progress','Needs Jonathan','All open','Recently closed','pond','Work t-4']) expect(text()).toContain(name);
    await click('All open');
    const row = tree.root.findAllByType('button').find(b => b.props['data-split-row'] !== undefined && words(b).includes('Work t-1'))!;
    await act(async () => row.props.onClick());
    expect(text()).toContain('Full detail'); expect(text()).toContain('First comment'); expect(text()).toContain('Parent');
    await act(async () => { f.snapshot={...f.snapshot,records:f.snapshot.records.map(t => t.id==='t-1' ? {...t,comments:[...t.comments,{actor:'jonathan',at:'2026-11-12T01:00:00Z',text:'Second comment'}]} : t)}; f.listeners.forEach(fn=>fn()); });
    expect(text().indexOf('Second comment')).toBeGreaterThan(text().indexOf('First comment'));
    await act(async () => tree.root.findByProps({type:'search'}).props.onChange({target:{value:'useful'}}));
    expect(tree.root.findAllByProps({'data-split-row':''}).filter(b => b.props['aria-current'] !== undefined)).toHaveLength(1);
    await click('In progress'); expect(text()).toContain('Nothing matches');
    await act(async () => tree.unmount());
  });
  it('drops tasks and reader content on scope loss and displays offline/denied as errors', async () => {
    await draw();
    const row=tree.root.findAllByProps({'data-split-row':''})[0]; await act(async()=>row.props.onClick());
    for (const status of ['live','offline','denied']) {
      await act(async()=>{f.snapshot={records:[],status};f.listeners.forEach(fn=>fn());});
      expect(text()).not.toContain('Full detail');
      if(status!=='live') expect(tree.root.findAllByProps({role:'alert'}).length).toBeGreaterThan(0);
    }
    await act(async()=>tree.unmount());
  });
  it('finds and deduplicates linked pull requests without making external requests', () => {
    expect(pullRequests(task('t-1',{description:'sleepunit-agents/loom#831',comments:[{actor:'art',at:'',text:'https://github.com/sleepunit-agents/loom/pull/831'}]}))).toEqual([['sleepunit-agents/loom#831','https://github.com/sleepunit-agents/loom/pull/831']]);
  });
  it.each([
    ['claim',{},'claim',{}],['unclaim',{},'unclaim',{}],['close',{reason:'Done'},'close',{reason:'Done'}],['reopen',{},'reopen',{}],['comment',{text:'Hello'},'comment',{text:'Hello'}],
    ['edit',{title:'Updated',goal:'Result'},'update',{set:{title:'Updated',goal:'Result'}}],['priority',{priority:'1'},'update',{set:{priority:1}}],['project',{project:'pond'},'update',{set:{project:'pond'}}],
    ['create',{title:'New task',goal:'Useful',why:'Needed',priority:'2',project:''},'create',{title:'New task',goal:'Useful',why:'Needed',priority:2}],
  ] as const)('%s retains one pending call and shows plain transport and domain errors',async(action,fields,verb,expected)=>{
    let state: CallState<TaskAnswer>={pending:true,status:'pending'};
    const listeners=new Set<()=>void>();
    const request={id:'same-id',result:new Promise(()=>{}),subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>state};
    f.call.mockReturnValue(request);
    await draw(h(ActionForm,{action,task:action==='create'?undefined:task('t-1'),enabled:true,onCancel:()=>{}}));
    const original=globalThis.FormData;
    globalThis.FormData=class { *[Symbol.iterator](){yield* Object.entries(fields);} } as any;
    try { await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}})); } finally { globalThis.FormData=original; }
    expect(f.call).toHaveBeenCalledExactlyOnceWith(`tasks.${verb}`,{cli:true,...(action==='create'?{}:{id:'t-1'}),...expected});
    expect(tree.root.findByType('fieldset').props.disabled).toBe(true); expect(text()).toContain('Saving');
    const publish=async(result:Result<TaskAnswer>)=>act(async()=>{state={pending:false,status:'done',result};listeners.forEach(fn=>fn());});
    await publish({ok:false,code:'denied',message:'Project moved'}); expect(text()).toContain('denied: Project moved');
    expect(tree.root.findByType('fieldset').props.disabled).toBe(false);
    await publish({ok:true,value:{result:{ok:false,errors:['E_BAD_TRANSITION']}}}); expect(text()).toContain('E_BAD_TRANSITION');
    await publish({ok:true,value:{result:{ok:true}}}); expect(text()).toContain('Saved');
    await act(async()=>tree.unmount());
  });
});

it('opens imported task ids from encoded links and refuses malformed escapes',async()=>{
 const id='legacy/task %';f.snapshot={records:[task(id,{description:'Imported task detail'})],status:'live'};
 await draw(h(TasksApp,{path:`/p/tasks-preview/task/${encodeURIComponent(id)}`}));
 expect(text()).toContain('Imported task detail');await act(async()=>tree.unmount());
 await draw(h(TasksApp,{path:'/p/tasks-preview/task/%zz'}));expect(text()).not.toContain('Imported task detail');await act(async()=>tree.unmount());
});
