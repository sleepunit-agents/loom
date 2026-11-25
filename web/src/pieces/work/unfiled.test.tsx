import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement as h,type ReactNode} from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import {act,create} from 'react-test-renderer';
type Row={id:string;title:string;status:string;changedAt:string};
const f=vi.hoisted(()=>({calls:[] as {query:string;variables?:Record<string,unknown>;options?:{pause?:boolean}}[],
  pages:new Map<number,Row[]>(), home:[] as Row[], status:'live'}));
vi.mock('../../data/graphql',()=>({useDataQuery:(query:string,variables?:Record<string,unknown>,options?:{pause?:boolean})=>{
  f.calls.push({query,variables,options});
  if(options?.pause) return {status:'loading'};
  if(query.includes('WorkUnfiled')) return {status:f.status,data:{unfiled:f.pages.get(Number(variables?.offset)) ?? []}};
  if(query.includes('WorkHome')) return {status:'live',data:{projects:[],inFlight:[],unfiled:f.home}};
  return {status:'live',data:{homeComms:null}};
}}));
vi.mock('../../data/visibility',()=>({useReadingVisible:()=>true}));
vi.mock('../../kit',()=>Object.fromEntries(['AppFrame','Body','Empty','Error','LinkButton','List','Loading','Pager','Row','Section'].map(name=>
  [name,(props:{children?:ReactNode})=>h(name,Object.fromEntries(Object.entries(props).filter(([key])=>key!=='children')),props.children)])));
import Work from './index';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
const rows=(from:number,count:number)=>Array.from({length:count},(_,n)=>({id:`t-${from+n}`,title:`Unfiled ${from+n}`,status:'open',changedAt:'2026-11-24T00:00:00Z'}));
const words=()=>JSON.stringify(tree.toJSON());
const find=(type:string)=>tree.root.findAllByType(type) as {props:Record<string,(()=>void)&string&boolean&{label:string}>}[];
async function draw(path:string,go:(href:string)=>void){await act(async()=>{tree=create(h(Work,{path,go}));});}
beforeEach(()=>{f.calls=[];f.pages=new Map([[0,rows(1,51)],[50,rows(52,3)]]);f.home=[];f.status='live';});
afterEach(async()=>{await act(async()=>tree?.unmount());});

it('opens unfiled tickets from the Work home, pages by route, opens a story and returns to the same page',async()=>{
  const go=vi.fn();
  f.home=rows(1,1);
  await draw('/p/work',go);
  const entry=find('Row').find(row=>row.props.title==='Unfiled tickets')!;
  expect(entry.props.meta).toBe('Unfiled 1');
  expect(words()).not.toContain('No projects yet');
  entry.props.onClick();
  expect(go).toHaveBeenLastCalledWith('/p/work/unfiled');
  await act(async()=>tree.update(h(Work,{path:'/p/work/unfiled',go})));
  expect(f.calls.filter(call=>call.query.includes('WorkHome')).at(-1)?.options?.pause).toBe(true);
  expect(f.calls.filter(call=>call.query.includes('WorkUnfiled')).at(-1)?.variables).toEqual({offset:0});
  expect(find('Row')).toHaveLength(50);
  expect(words()).not.toContain('Unfiled 51');
  const pager=find('Pager')[0];
  expect(pager.props).toMatchObject({hasPrevious:false,hasNext:true});
  pager.props.next();
  expect(go).toHaveBeenLastCalledWith('/p/work/unfiled/2');
  await act(async()=>tree.update(h(Work,{path:'/p/work/unfiled/2',go})));
  expect(f.calls.filter(call=>call.query.includes('WorkUnfiled')).at(-1)?.variables).toEqual({offset:50});
  expect(find('Row').map(row=>row.props.title)).toEqual(['Unfiled 52','Unfiled 53','Unfiled 54']);
  expect(find('Pager')[0].props).toMatchObject({hasPrevious:true,hasNext:false});
  find('Row')[1].props.onClick();
  expect(go).toHaveBeenLastCalledWith('/p/tasks-preview/task/t-53');
  // Back from the story: the shell hands Work the route it left, and the same page reads again.
  await act(async()=>tree.update(h(Work,{path:'/p/tasks-preview/task/t-53',go})));
  await act(async()=>tree.update(h(Work,{path:'/p/work/unfiled/2',go})));
  expect(find('Row').map(row=>row.props.title)).toContain('Unfiled 53');
  find('Pager')[0].props.previous();
  expect(go).toHaveBeenLastCalledWith('/p/work/unfiled');
  expect(find('AppFrame')[0].props.crumb).toEqual({label:'Work',href:'/p/work'});
});

it('shows no entry and an honest empty state when the reader sees no unfiled tickets',async()=>{
  const go=vi.fn();
  f.pages=new Map();
  await draw('/p/work',go);
  expect(find('Row').some(row=>row.props.title==='Unfiled tickets')).toBe(false);
  expect(words()).toContain('No projects yet');
  await act(async()=>tree.update(h(Work,{path:'/p/work/unfiled',go})));
  expect(find('Empty')[0].props.title).toBe('No unfiled tickets');
  expect(find('Pager')).toHaveLength(0);
  await act(async()=>tree.update(h(Work,{path:'/p/work/unfiled/3',go})));
  expect(find('Empty')[0].props.title).toBe('No more unfiled tickets');
});

it('refuses a malformed page without querying and withholds rows when the feed is not live',async()=>{
  const go=vi.fn();
  await draw('/p/work/unfiled/0',go);
  expect(find('Empty')[0].props.title).toBe('Page unavailable');
  expect(f.calls.filter(call=>call.query.includes('WorkUnfiled')).every(call=>call.options?.pause)).toBe(true);
  find('LinkButton')[0].props.onClick();
  expect(go).toHaveBeenLastCalledWith('/p/work/unfiled');
  f.status='offline';
  await act(async()=>tree.update(h(Work,{path:'/p/work/unfiled',go})));
  expect(find('Row')).toHaveLength(0);
  expect(words()).toContain('Unfiled tickets are unavailable.');
});

it('keeps a reader whose only unfiled ticket is closed able to open its story from Work and return',async()=>{
  const go=vi.fn();
  const done={id:'t-9',title:'Finished note',status:'closed',changedAt:'2026-11-24T00:00:00Z'};
  f.home=[done];
  f.pages=new Map([[0,[done]]]);
  await draw('/p/work',go);
  const entry=find('Row').find(row=>row.props.title==='Unfiled tickets')!;
  expect(entry.props.meta).toBe('Finished note');
  entry.props.onClick();
  expect(go).toHaveBeenLastCalledWith('/p/work/unfiled');
  await act(async()=>tree.update(h(Work,{path:'/p/work/unfiled',go})));
  const row=find('Row').find(row=>row.props.title==='Finished note')!;
  expect(row.props.status).toBe('Closed');
  expect(find('Pager')[0].props).toMatchObject({hasPrevious:false,hasNext:false});
  row.props.onClick();
  expect(go).toHaveBeenLastCalledWith('/p/tasks-preview/task/t-9');
  await act(async()=>tree.update(h(Work,{path:'/p/tasks-preview/task/t-9',go})));
  await act(async()=>tree.update(h(Work,{path:'/p/work/unfiled',go})));
  expect(find('Row').map(row=>row.props.title)).toEqual(['Finished note']);
  expect(words()).not.toContain('No unfiled tickets');
});
