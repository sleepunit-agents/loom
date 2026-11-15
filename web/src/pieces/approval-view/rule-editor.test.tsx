import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h,type ReactNode} from 'react';
// @ts-expect-error The renderer dependency has no declarations.
import {act,create} from 'react-test-renderer';
vi.mock('../../kit',()=>({Input:(props:object)=>h('input',props),Button:(props:{children?:ReactNode})=>h('button',props,props.children),Error:({text}:{text:string})=>h('p',{},text)}));
import {RuleEditor,type SaveRule} from './rule-editor';
import type {Rule} from './model';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;afterEach(async()=>{await act(async()=>tree?.unmount());});
const words=()=>JSON.stringify(tree.toJSON());
const field=(label:string)=>tree.root.findByProps({'aria-label':label});
async function fill(label:string,value:string){await act(async()=>field(label).props.onChange({target:{value}}));}
async function submit(){await act(async()=>field('Standing rule').props.onSubmit({preventDefault(){}}));}
it('keeps an unconfirmed rule intent ID for explicit retry, and creates a new intent only after confirmation',async()=>{
 const save=vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValue(undefined);
 await act(async()=>{tree=create(h(RuleEditor,{rules:[],save}));});
 await fill('Scope','github:acme/*');await fill('Person (optional)','sam');await fill('Answer','tell');await submit();
 expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][0]).toEqual({kind:'merge',scope:'github:acme/*',person:'sam',tier:'tell'});expect(words()).toContain('Could not save this rule');
 await submit();expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);expect(words()).toContain('Rule saved.');
 await submit();expect(save.mock.calls[2][1]).not.toBe(save.mock.calls[1][1]);
});
it('holds fields during pending save, prevents duplicate submit and waits for canonical rule publication',async()=>{
 let done!:()=>void;const save=vi.fn(()=>new Promise<void>(resolve=>{done=resolve;}));
 await act(async()=>{tree=create(h(RuleEditor,{rules:[],save}));});await fill('Scope','project:pond');await submit();await submit();
 expect(save).toHaveBeenCalledTimes(1);expect(tree.root.findByType('fieldset').props.disabled).toBe(true);expect(words()).toContain('Saving rule…');
 expect(tree.root.findAllByType('option').some((option:{props:{children:unknown}})=>String(option.props.children).includes('project:pond'))).toBe(false);
 await act(async()=>done());expect(tree.root.findAllByType('option').some((option:{props:{children:unknown}})=>String(option.props.children).includes('project:pond'))).toBe(false);
 const rule:Rule={kind:'merge',scope:'project:pond',person:'',tier:'ask',setBy:'pat',setAt:'2026-11-15T00:00:00Z'};
 await act(async()=>tree.update(h(RuleEditor,{rules:[rule],save})));expect(tree.root.findAllByType('option').some((option:{props:{children:unknown}})=>String(option.props.children).includes('project:pond'))).toBe(true);
});
it('edits and removes the exact selected kind/scope/person without changing canonical rows optimistically',async()=>{
 const rule:Rule={kind:'command',scope:'run *',person:'sam',tier:'tell',setBy:'pat',setAt:'2026-11-15T00:00:00Z'},save=vi.fn<SaveRule>(async()=>{});
 await act(async()=>{tree=create(h(RuleEditor,{rules:[rule],save}));});await fill('Rule',JSON.stringify([rule.kind,rule.scope,rule.person]));await fill('Answer','ask');await submit();
 expect(save.mock.calls[0][0]).toEqual({kind:'command',scope:'run *',person:'sam',tier:'ask'});expect(rule.tier).toBe('tell');
 await act(async()=>tree.root.findAllByType('button').find((button:{props:{children:unknown}})=>button.props.children==='Remove rule')!.props.onClick());
 expect(save.mock.calls[1][0]).toEqual({kind:'command',scope:'run *',person:'sam',tier:null});expect(rule.tier).toBe('tell');
});
