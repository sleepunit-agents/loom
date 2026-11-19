import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import {act,create} from 'react-test-renderer';
const f=vi.hoisted(()=>({feed:{status:'live',data:{boxes:[{id:'box',name:'Workshop',owner:'lee',readers:['art']},{id:'other',name:'Elsewhere',owner:'sam'}],agents:[{id:'art'},{id:'fern'}]}},call:vi.fn()}));
vi.mock('../../data/graphql',()=>({useDataQuery:()=>f.feed}));
vi.mock('../../data/operation',()=>({memberOperation:f.call}));
vi.mock('../../kit',()=>({Button:(props:object)=>h('button',props),Error:()=>null,Loading:()=>null}));
import {OwnerMachines} from './machines';
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
 const reading={usedPercent:null,sizeMib:null,freeMib:null,answers:null,level:'ok'};
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
 // A machine with no reading yet (an older worker, or none reporting) shows no line at all.
 f.feed={status:'live',data:before} as never;
 await act(async()=>tree.update(h(OwnerMachines,{member:'lee'})));
 expect(text()).toEqual([]);
});
