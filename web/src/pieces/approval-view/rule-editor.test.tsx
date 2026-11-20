import {afterEach,expect,it,vi} from 'vitest';
import {createElement as h,type ReactNode} from 'react';
// @ts-expect-error The renderer dependency has no declarations.
import {act,create} from 'react-test-renderer';
vi.mock('../../kit',()=>({Input:(props:object)=>h('input',props),Button:(props:{children?:ReactNode})=>h('button',props,props.children),Error:({text}:{text:string})=>h('p',{},text),
 ...Object.fromEntries(['Actions','Body','Field'].map(name=>[name,(props:{children?:ReactNode})=>h(name,props,props.children)])),Fields:(props:{children?:ReactNode})=>h('fieldset',props,props.children)}));
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
 const remove=()=>tree.root.findAllByType('button').some((button:{props:{children:unknown}})=>button.props.children==='Remove rule');
 expect(save).toHaveBeenCalledTimes(1);expect(tree.root.findByType('fieldset').props.disabled).toBe(true);expect(words()).toContain('Saving rule…');
 // Nothing says the rule exists (Remove is offered for one that does) until the program publishes it.
 expect(remove()).toBe(false);
 await act(async()=>done());expect(remove()).toBe(false);
 const rule:Rule={kind:'merge',scope:'project:pond',person:'',tier:'ask',setBy:'pat',setAt:'2026-11-15T00:00:00Z'};
 await act(async()=>tree.update(h(RuleEditor,{rules:[rule],save})));expect(remove()).toBe(true);
});
it('edits and removes the exact selected kind/scope/person without changing canonical rows optimistically',async()=>{
 const rule:Rule={kind:'command',scope:'run *',person:'sam',tier:'tell',setBy:'pat',setAt:'2026-11-15T00:00:00Z'},save=vi.fn<SaveRule>(async()=>{});
 await act(async()=>{tree=create(h(RuleEditor,{rules:[rule],save,rule}));});await fill('Answer','ask');await submit();
 expect(save.mock.calls[0][0]).toEqual({kind:'command',scope:'run *',person:'sam',tier:'ask'});expect(rule.tier).toBe('tell');
 await act(async()=>tree.root.findAllByType('button').find((button:{props:{children:unknown}})=>button.props.children==='Remove rule')!.props.onClick());
 expect(save.mock.calls[1][0]).toEqual({kind:'command',scope:'run *',person:'sam',tier:null});expect(rule.tier).toBe('tell');
});
it('opens a rule with its own fields, and a new rule (first or after an existing grant) on Ask me',async()=>{
 const rule:Rule={kind:'command',scope:'run *',person:'sam',tier:'do',setBy:'pat',setAt:'2026-11-15T00:00:00Z'},save=vi.fn<SaveRule>(async()=>{});
 await act(async()=>{tree=create(h(RuleEditor,{rules:[rule],save}));});await fill('Scope','github:acme/*');await submit();
 expect(save.mock.calls[0][0]).toEqual({kind:'merge',scope:'github:acme/*',person:'',tier:'ask'});
 // The reader mounts one editor per opened rule (its key), so each starts from the rule it was opened on.
 await act(async()=>tree.unmount());await act(async()=>{tree=create(h(RuleEditor,{rules:[rule],save,rule}));});
 expect(field('Answer').props.value).toBe('do');expect(field('Scope').props.value).toBe('run *');expect(field('Kind').props.value).toBe('command');
 await act(async()=>tree.unmount());await act(async()=>{tree=create(h(RuleEditor,{rules:[rule],save}));});await fill('Scope','project:pond');await submit();
 expect(save.mock.calls[1][0]).toEqual({kind:'merge',scope:'project:pond',person:'',tier:'ask'});
});
it('abandons an uncertain intent after fields change, even if changed back to the same body',async()=>{
 const save=vi.fn<SaveRule>().mockRejectedValue(new Error('unknown'));
 await act(async()=>{tree=create(h(RuleEditor,{rules:[],save}));});await fill('Scope','project:pond');await submit();
 await fill('Scope','project:bank');await fill('Scope','project:pond');await submit();
 expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);expect(save.mock.calls[1][1]).not.toBe(save.mock.calls[0][1]);
});

it('keeps the exact removal intent after publication and an unknown response, and never recreates it through Save',async()=>{
 const rule:Rule={kind:'merge',scope:'project:pond',person:'',tier:'ask',setBy:'pat',setAt:'2026-11-15T00:00:00Z'},save=vi.fn<SaveRule>().mockRejectedValueOnce(new Error('lost')).mockResolvedValue(undefined);
 await act(async()=>{tree=create(h(RuleEditor,{rules:[rule],save,rule}));});
 await act(async()=>tree.root.findAllByType('button').find((button:{props:{children:unknown}})=>button.props.children==='Remove rule')!.props.onClick());
 await act(async()=>tree.update(h(RuleEditor,{rules:[],save,rule})));
 expect(save.mock.calls[0][0].tier).toBe(null);expect(tree.root.findAllByType('button').find((button:{props:{children:unknown}})=>button.props.children==='Save rule')!.props.disabled).toBe(true);
 await submit();expect(save).toHaveBeenCalledTimes(1);
 await act(async()=>tree.root.findAllByType('button').find((button:{props:{children:unknown}})=>button.props.children==='Retry removal')!.props.onClick());
 expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);expect(tree.root.findAllByType('button').some((button:{props:{children:unknown}})=>button.props.children==='Retry removal')).toBe(false);
});
it('offers each kind in plain words and submits it through the native Kind selector',async()=>{
 const save=vi.fn<SaveRule>(async()=>{});
 await act(async()=>{tree=create(h(RuleEditor,{rules:[],save}));});
 expect(field('Kind').findAllByType('option').map((option:{props:{value:string}})=>option.props.value)).toEqual(['merge','command','setting','dangerous']);
 expect(field('Kind').findAllByType('option').map((option:{props:{children:string}})=>option.props.children)).toEqual(['Merging a pull request','Running a command on a machine','Changing a setting','Another dangerous action']);
 await fill('Scope','*');for(const kind of ['command','setting','dangerous','merge']){await fill('Kind',kind);await submit();expect(save.mock.calls.at(-1)![0]).toEqual({kind,scope:'*',person:'',tier:'ask'});}
});
