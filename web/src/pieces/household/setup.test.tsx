import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h} from 'react';
// @ts-expect-error Existing renderer has no declarations.
import {act,create} from 'react-test-renderer';
// Test-only `any` bridges the existing untyped renderer and lightweight kit
// stand-ins; mutable snapshots deliberately include unavailable/stale states.
// Production query values remain typed as SetupData in the consumer.
const f=vi.hoisted(()=>({reading:{} as any,save:vi.fn()}));
vi.mock('../../data/graphql',()=>({useDataQuery:()=>f.reading}));
vi.mock('../../data/operation',()=>({memberOperation:f.save}));
vi.mock('../../kit',()=>({AppFrame:({children}:any)=>h('main',{},children),Button:({children,...props}:any)=>h('button',props,children),Input:(props:any)=>h('input',props),Empty:({title}:any)=>h('p',{},title),Error:({text}:any)=>h('p',{role:'alert'},text),Loading:()=>h('p',{},'Loading')}));
import Setup from './index';
(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{if(tree)await act(async()=>tree.unmount());vi.unstubAllGlobals();vi.clearAllMocks();});
function seed(){f.reading={status:'live',data:{members:[{id:'owner',role:'owner',fullOwner:false,memberAgentsByMember:[]},{id:'peer',role:'member',fullOwner:false,memberAgentsByMember:[{agent:'art'}]}],agents:[{id:'art',about:'Fixture biography',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}]}};}
it('clears retained administration forms when loading, offline, denied or current owner role is lost',async()=>{
 seed();await act(async()=>{tree=create(h(Setup));});expect(tree.root.findAllByType('form')).toHaveLength(3);
 for(const status of ['loading','offline','denied']){f.reading={...f.reading,status};await act(async()=>tree.update(h(Setup)));expect(tree.root.findAllByType('form')).toHaveLength(0);expect(JSON.stringify(tree.toJSON())).not.toContain('Fixture biography');}
 seed();await act(async()=>tree.update(h(Setup)));expect(tree.root.findAllByType('form')).toHaveLength(3);
 f.reading={status:'live',data:{...f.reading.data,members:[f.reading.data.members[1]]}};await act(async()=>tree.update(h(Setup)));expect(tree.root.findAllByType('form')).toHaveLength(0);
});
it('keeps household role separate from every-agent ownership and sends the existing canonical member input',async()=>{
 seed();f.save.mockResolvedValue({id:'peer'});await act(async()=>{tree=create(h(Setup));});
 const form=()=>tree.root.findByProps({'aria-label':'Save membership for peer'});
 expect(form().findByType('select').props.value).toBe('member');
 const full=form().findAllByType('input').find((input:any)=>input.props.checked!==undefined);expect(full.props.disabled).toBe(true);
 await act(async()=>form().findByType('select').props.onChange({target:{value:'owner'}}));
 expect(form().findAllByType('input').find((input:any)=>input.props.checked!==undefined).props.checked).toBe(false);
 vi.stubGlobal('FormData',class{getAll(){return ['art'];}});
 await act(async()=>form().props.onSubmit({preventDefault(){},currentTarget:{}}));
 expect(f.save).toHaveBeenCalledWith('household.setMember',{id:'peer',role:'owner',fullOwner:false,agents:['art']});
 expect(JSON.stringify(form().toJSON?.()??tree.toJSON())).toContain('Saved');
 await act(async()=>form().findAllByType('input').find((input:any)=>input.props.checked!==undefined).props.onChange({target:{checked:true}}));
 await act(async()=>form().props.onSubmit({preventDefault(){},currentTarget:{}}));
 expect(f.save).toHaveBeenLastCalledWith('household.setMember',{id:'peer',role:'owner',fullOwner:true,agents:['art']});
});
it('shows success only for the exact acknowledged member ID',async()=>{
 seed();await act(async()=>{tree=create(h(Setup));});
 vi.stubGlobal('FormData',class{getAll(){return [];}});
 const form=()=>tree.root.findByProps({'aria-label':'Save membership for peer'});
 for(const result of [{id:'other'},{},undefined]){
  f.save.mockResolvedValueOnce(result);
  await act(async()=>form().props.onSubmit({preventDefault(){},currentTarget:{}}));
  expect(form().findAllByProps({role:'alert'})).toHaveLength(1);
  expect(JSON.stringify(tree.toJSON())).not.toContain('Saved');
 }
 f.save.mockResolvedValueOnce({id:'peer'});
 await act(async()=>form().props.onSubmit({preventDefault(){},currentTarget:{}}));
 expect(form().findAllByProps({role:'alert'})).toHaveLength(0);
 expect(JSON.stringify(tree.toJSON())).toContain('Saved');
});
