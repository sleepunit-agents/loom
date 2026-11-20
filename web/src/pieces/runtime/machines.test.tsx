import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import {act,create} from 'react-test-renderer';
const f=vi.hoisted(()=>({feed:{status:'live',data:{boxes:[{id:'box',name:'Workshop',owner:'lee',readers:['art']},{id:'other',name:'Elsewhere',owner:'sam'}],agents:[{id:'art'},{id:'fern'}]}},call:vi.fn()}));
vi.mock('../../data/graphql',()=>({useDataQuery:()=>f.feed}));
vi.mock('../../data/operation',()=>({memberOperation:f.call}));
vi.mock('../../kit',()=>({Button:(props:object)=>h('button',props),Error:()=>null,Loading:()=>null}));
import {OwnerMachines} from './machines';
import {briefTime} from '../../kit/time';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());vi.clearAllMocks();});
it('shows owner history and proposes and answers scoped read grants',async()=>{
 f.call.mockImplementation(async(name:string)=>name==='machine.history'?[{id:'read',askedAt:'2026-11-15T12:00:00Z',agent:'art',job:'job-private',word:'owners',read:'disk',args:'{}',bytes:50,outcome:'answered'}]:name==='machine.readerCards'?[{id:'card',ask:'Grant machine reads to fern?'}]:{});
 await act(async()=>{tree=create(h(OwnerMachines,{member:'lee'}));});
 const button=(name:string)=>tree.root.findAllByType('button').find((b:{children:unknown[]})=>b.children.join('')===name);
 expect(JSON.stringify(tree.toJSON())).not.toContain('Elsewhere');
 await act(async()=>button('Workshop').props.onClick());
 expect(f.call).toHaveBeenCalledWith('machine.history',{machine:'box'});
 expect(JSON.stringify(tree.toJSON())).toContain('job-private');
 await act(async()=>button('Allow').props.onClick());
 expect(f.call).toHaveBeenCalledWith('machine.answerReader',{id:'card',answer:'allow'});
 await act(async()=>button('Request revocation for art').props.onClick());
 expect(f.call).toHaveBeenCalledWith('machine.proposeReader',{box:'box',agent:'art',allow:false});
 await act(async()=>tree.root.findByType('select').props.onChange({target:{value:'fern'}}));
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}));
 expect(f.call).toHaveBeenCalledWith('machine.proposeReader',{box:'box',agent:'fern',allow:true});
 await act(async()=>tree.update(h(OwnerMachines,{member:'sam'})));
 expect(JSON.stringify(tree.toJSON())).not.toContain('job-private');
});
it('shows what each machine last read on itself quietly, and an open condition plainly',async()=>{
 const before=f.feed.data;
 const now=Date.now(),ago=(ms:number)=>new Date(now-ms).toISOString();
 const reading={usedPercent:null,sizeMib:null,freeMib:null,answers:null,level:'ok',readAt:ago(60_000),unknownSince:null,stale:false};
 f.feed={status:'live',data:{...before,boxReadings:[
  {...reading,box:'box',kind:'memory',thing:'',sizeMib:16384,freeMib:1946},
  {...reading,box:'box',kind:'disk',thing:'/',usedPercent:71,sizeMib:204800,freeMib:61440},
  {...reading,box:'box',kind:'containers',thing:'',answers:true},
  {...reading,box:'other',kind:'disk',thing:'/',usedPercent:99,sizeMib:1000,freeMib:10,level:'urgent'},
 ]}} as never;
 f.call.mockResolvedValue([]);
 await act(async()=>{tree=create(h(OwnerMachines,{member:'lee'}));});
 const text=()=>tree.root.findAllByType('p').map((p:{children:unknown[]})=>p.children.map(child=>typeof child==='string'?child:(child as {children:string[]}).children.join('')).join(''));
 // Shown without opening the machine, and nothing of a machine that is not this member's.
 expect(text()).toEqual(['Disk 71% · 60 GB free · Memory 1.9 GB available · Container runtime answering']);
 expect(tree.root.findAllByProps({role:'status'})).toHaveLength(0);
 f.feed={status:'live',data:{...before,boxReadings:[
  {...reading,box:'box',kind:'disk',thing:'/',usedPercent:91,sizeMib:204800,freeMib:18432,level:'raised'},
  {...reading,box:'box',kind:'disk',thing:'/srv/data',usedPercent:97,sizeMib:102400,freeMib:3072,level:'urgent'},
  {...reading,box:'box',kind:'containers',thing:'',answers:false,level:'raised'},
 ]}} as never;
 await act(async()=>tree.update(h(OwnerMachines,{member:'lee'})));
 expect(text()).toEqual(['/ is running out of room: 91% full, 18 GB free.','/srv/data is almost out of room: 97% full, 3 GB free.','The container runtime is not answering.',
  'Disk / 91% · 18 GB free · Disk /srv/data 97% · 3 GB free · Container runtime not answering']);
 expect(tree.root.findAllByProps({role:'status'})).toHaveLength(3);
 // A number is shown as current only while it is. One the worker can no longer take, or has not sent for
 // three of its intervals, says when it was read; one loom has given up on says it has not been read since.
 const old=ago(16*60_000),lost=ago(3*60_000),dead=ago(26*3_600_000);
 f.feed={status:'live',data:{...before,boxReadings:[
  {...reading,box:'box',kind:'disk',thing:'/',usedPercent:71,sizeMib:204800,freeMib:61440,readAt:ago(14*60_000)},
  {...reading,box:'box',kind:'disk',thing:'/old',usedPercent:40,sizeMib:204800,freeMib:122880,readAt:old},
  {...reading,box:'box',kind:'disk',thing:'/srv',usedPercent:91,sizeMib:204800,freeMib:18432,level:'raised',readAt:lost,unknownSince:ago(60_000)},
  {...reading,box:'box',kind:'disk',thing:'/was',usedPercent:96,sizeMib:204800,freeMib:8192,readAt:dead,unknownSince:dead,stale:true},
 ]}} as never;
 await act(async()=>tree.update(h(OwnerMachines,{member:'lee'})));
 // The disk that is still raised keeps its plain line; the stale one, whose notice loom closed, has none.
 expect(text()).toEqual(['/srv is running out of room: 91% full, 18 GB free.',
  `Disk / 71% · 60 GB free · Disk /old 40% · 120 GB free (as of ${briefTime(old,undefined,now)}) · Disk /srv 91% · 18 GB free (as of ${briefTime(lost,undefined,now)}) · Disk /was 96% · 8 GB free (not read since ${briefTime(dead,undefined,now)})`]);
 expect(briefTime(dead,undefined,now)).not.toBe(briefTime(new Date(now).toISOString(),undefined,now));
 f.feed={status:'live',data:{...before,boxReadings:[
  {...reading,box:'box',kind:'disk',thing:'/never',readAt:null,unknownSince:lost},
  {...reading,box:'box',kind:'memory',thing:'',readAt:null,unknownSince:lost},
  {...reading,box:'box',kind:'containers',thing:'',readAt:null,unknownSince:lost},
 ]}} as never;
 await act(async()=>tree.update(h(OwnerMachines,{member:'lee'})));
 expect(text()).toEqual(['Disk /never not yet read · Memory not yet read · Container runtime not yet read']);
 // A machine with no reading yet (an older worker, or none reporting) shows no line at all.
 f.feed={status:'live',data:before} as never;
 await act(async()=>tree.update(h(OwnerMachines,{member:'lee'})));
 expect(text()).toEqual([]);
});
it('ages readings in an open window and shows one condition for paths on the same disk',async()=>{
 const before=f.feed;
 vi.useFakeTimers();
 try {
  const now=Date.parse('2026-11-19T14:00:00Z');
  vi.setSystemTime(now);
  const disk={box:'box',kind:'disk',disk:'group',usedPercent:91,sizeMib:204800,freeMib:18432,level:'raised',
   readAt:new Date(now-14*60_000-1).toISOString(),unknownSince:null,stale:false};
  f.feed={status:'live',data:{...before.data,boxReadings:[
   {...disk,thing:'/srv/a',usedPercent:99,unknownSince:disk.readAt,readAt:new Date(now-16*60_000).toISOString()},
   {...disk,thing:'/srv/b'},
  ]}} as never;
  await act(async()=>{tree=create(h(OwnerMachines,{member:'lee'}));});
  const status=tree.root.findAllByProps({role:'status'});
  expect(status).toHaveLength(1);
  expect(status[0].findByType('strong').children.join('')).toBe('The disk holding /srv/a and /srv/b is running out of room: 91% full, 18 GB free.');
  const text=()=>JSON.stringify(tree.toJSON());
  expect(text().match(/as of/g)).toHaveLength(1);
  await act(async()=>{vi.advanceTimersByTime(60_000);});
  expect(text().match(/as of/g)).toHaveLength(2);
  await act(async()=>tree.unmount());
  expect(vi.getTimerCount()).toBe(0);
 } finally {
  f.feed=before;
  vi.useRealTimers();
 }
});
