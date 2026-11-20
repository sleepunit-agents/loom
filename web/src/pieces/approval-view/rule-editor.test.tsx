import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h,type ReactNode} from 'react';
// @ts-expect-error The renderer dependency has no declarations.
import {act,create} from 'react-test-renderer';
vi.mock('../../kit',()=>({Input:(props:object)=>h('input',props),Button:(props:{children?:ReactNode})=>h('button',props,props.children),Error:({text}:{text:string})=>h('p',{},text),
 ...Object.fromEntries(['Actions','Body','Field'].map(name=>[name,(props:{children?:ReactNode})=>h(name,props,props.children)])),Fields:(props:{children?:ReactNode})=>h('fieldset',props,props.children)}));
import {RuleEditor} from './rule-editor';
import type {Rule} from './model';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;afterEach(async()=>{await act(async()=>tree?.unmount());});
const request=vi.hoisted(()=>({prepare:vi.fn(),clear:vi.fn(),disabled:false,reader:null}));
vi.mock('../attention/setting-request',()=>({useSettingRequest:()=>request}));
const field=(label:string)=>tree.root.findByProps({'aria-label':label});
async function fill(label:string,value:string){await act(async()=>field(label).props.onChange({target:{value}}));}
async function submit(){await act(async()=>field('Standing rule').props.onSubmit({preventDefault(){}}));}
it('prepares the normalized rule and only offers removal for the same kind, scope and person',async()=>{
 const rule:Rule={kind:'merge',scope:'github:pond/*',person:'sam',tier:'ask',setBy:'pat',setAt:'2026-11-15T00:00:00Z'};
 await act(async()=>{tree=create(h(RuleEditor,{rules:[rule],go:vi.fn()}));});
 const removal=()=>tree.root.findAllByType('button').find((button:{props:{children:unknown}})=>button.props.children==='Review removal');
 await fill('Scope',' github:Pond/* ');await fill('Person (optional)',' sam ');await fill('Answer','tell');await submit();
 expect(request.prepare).toHaveBeenLastCalledWith({kind:'merge',scope:'github:pond/*',person:'sam',tier:'tell'});
 await act(async()=>removal().props.onClick());
 expect(request.prepare).toHaveBeenLastCalledWith({kind:'merge',scope:'github:pond/*',person:'sam',tier:null});
 await fill('Person (optional)','lee');expect(removal()).toBeUndefined();
 await act(async()=>field('Standing rule').props.onChange());expect(request.clear).toHaveBeenCalled();
 expect(rule.tier).toBe('ask');
});
it('disables the controls when the agent mailbox is unavailable',async()=>{
 request.disabled=true;
 try{
  await act(async()=>{tree=create(h(RuleEditor,{rules:[],go:vi.fn()}));});
  expect(tree.root.findByType('fieldset').props.disabled).toBe(true);
  expect(tree.root.findByProps({type:'submit'}).props.disabled).toBe(true);
 }finally{request.disabled=false;}
});
