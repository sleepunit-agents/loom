import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { SharedTaskForm, type TaskFormProps } from './shared-form';
import type { SharedTask } from './shared-view';
vi.mock('../../kit', () => Object.fromEntries(['Button','Input','Textarea'].map(name => [name,(props: {children?:ReactNode}) => h(name,props,props.children)])));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const task: SharedTask = { id:'t-1',title:'Pump',type:'task',status:'open',priority:2,position:1,ownerKind:'agent',owner:'art',project:null,assigneeKind:null,assignee:null,goal:'Works',why:'Broken',doneWhen:'',description:'',ask:null,ifYes:null,ifNo:null,closeReason:null,sourceKind:null,sourceId:null };
const props = (patch: Partial<TaskFormProps> = {}): TaskFormProps => ({status:'live',action:'create',people:[{kind:'agent',id:'art',label:'Art'},{kind:'member',id:'jonathan',label:'Jonathan'}],projects:[{id:'pond',label:'Pond'}],tasks:[{id:'t-1',title:'Pump'},{id:'t-2',title:'Pond'}],submit:vi.fn(async () => {}),done:vi.fn(),cancel:vi.fn(),...patch});
const draw = async (p:TaskFormProps) => {await act(async () => {tree=create(h(SharedTaskForm,p));});};
async function field(label: string, value: string) {
  const node = tree.root.findAllByType('label').find((node: {children: unknown[]}) => node.children[0] === label);
  const control = node.findAll((node: {props: {onChange?: unknown}}) => !!node.props.onChange)[0];
  await act(async () => control.props.onChange({target:{value,checked:value==='true'}}));
}
const submit = () => tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()});
it('creates owned work with conversation provenance and sends no actor supplied by the browser',async () => {
  const p=props({conversation:'cv-1'}); await draw(p);
  for (const [name,value] of [['Title','  New pump  '],['Goal','Pump works'],['Why','Old one broke'],['Owner','agent:art'],['Project','pond'],['Parent task','t-2']]) await field(name,value);
  await act(submit);
  expect(p.submit).toHaveBeenCalledWith({action:'create',input:{title:'New pump',goal:'Pump works',why:'Old one broke',doneWhen:'',description:'',priority:2,project:'pond',type:'task',owner:{kind:'agent',id:'art'},parent:'t-2',source:{kind:'conversation',id:'cv-1'}}});
  expect(p.done).toHaveBeenCalledOnce();
});
it('emits only the edited priority and maps removal to the explicit blocker relation',async () => {
  const p=props({action:'priority',task}); await draw(p); await field('Priority','0'); await act(submit);
  expect(p.submit).toHaveBeenCalledWith({action:'edit',id:'t-1',input:{priority:0}});
  const next=props({action:'link',task}); await act(async () => tree.update(h(SharedTaskForm,next)));
  await field('Blocking task','t-2');
  await act(async () => tree.root.findByType('input').props.onChange({target:{checked:true}}));
  await act(submit);
  expect(next.submit).toHaveBeenCalledWith({action:'unlink',id:'t-1',dependsOn:'t-2',type:'blocks'});
});
it('locks duplicate submits, preserves a failed draft and retries it deliberately',async () => {
  let reject!: (error:Error) => void;
  const pending=new Promise<void>((_,no)=>{reject=no;});
  const p=props({action:'comment',task,submit:vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined)}); await draw(p); await field('Comment','Keep this');
  let saving: Promise<void>;
  await act(async () => {saving=submit(); await submit();});
  expect(p.submit).toHaveBeenCalledTimes(1);
  await act(async () => {reject(new Error('Connection lost')); await saving;});
  expect(tree.root.findByProps({role:'alert'}).children).toEqual(['Connection lost']);
  expect(tree.root.findByType('Textarea').props.value).toBe('Keep this');
  expect(p.done).not.toHaveBeenCalled();
  await act(submit); expect(p.submit).toHaveBeenCalledTimes(2); expect(p.done).toHaveBeenCalledOnce();
});
it('drops drafts on snapshot loss and ignores completion of an unmounted write',async () => {
  let resolve!: () => void; const pending=new Promise<void>(yes=>{resolve=yes;});
  const p=props({action:'comment',task,submit:vi.fn(()=>pending)}); await draw(p); await field('Comment','Private draft');
  let saving: Promise<void>; await act(async () => {saving=submit();});
  await act(async () => tree.update(h(SharedTaskForm,{...p,status:'denied'})));
  expect(tree.toJSON()).toBeNull();
  await act(async () => {resolve(); await saving;}); expect(p.done).not.toHaveBeenCalled();
  await act(async () => tree.update(h(SharedTaskForm,p)));
  expect(tree.root.findByType('Textarea').props.value).toBe('');
});
