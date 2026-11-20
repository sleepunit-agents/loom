import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { SharedTaskForm, type TaskFormProps } from './shared-form';
import type { SharedTask } from './shared-view';
vi.mock('../../kit', () => Object.fromEntries(['Actions','Button','Field','Fields','Input','Textarea'].map(name => [name,(props: {children?:ReactNode}) => h(name,props,props.children)])));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); });
const task: SharedTask = { id:'t-1',title:'Pump',type:'task',status:'open',priority:2,position:1,ownerKind:'agent',owner:'art',project:null,assigneeKind:null,assignee:null,goal:'Works',why:'Broken',doneWhen:'',description:'',ask:null,ifYes:null,ifNo:null,closeReason:null,sourceKind:null,sourceId:null };
const props = (patch: Partial<TaskFormProps> = {}): TaskFormProps => ({status:'live',action:'create',people:[{kind:'agent',id:'art',label:'Art'},{kind:'member',id:'jonathan',label:'Jonathan'}],projects:[{id:'pond',label:'Pond'}],tasks:[{id:'t-1',title:'Pump'},{id:'t-2',title:'Pond'}],submit:vi.fn(async () => {}),done:vi.fn(),cancel:vi.fn(),...patch});
const draw = async (p:TaskFormProps) => {await act(async () => {tree=create(h(SharedTaskForm,p));});};
async function field(label: string, value: string) {
  const node = tree.root.findAllByType('Field').find((node: {props: {label: string}}) => node.props.label === label);
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
  // Blocked by lists what blocks it now, each with its own Remove; adding one is the form's filled button.
  const next=props({action:'link',task,links:[{task:'t-1',dependsOn:'t-2',type:'blocks'}]}); await act(async () => tree.update(h(SharedTaskForm,next)));
  await act(async () => tree.root.findAllByType('Button').find((b:{props:{children:string}})=>b.props.children==='Remove').props.onClick());
  expect(next.submit).toHaveBeenCalledWith({action:'unlink',id:'t-1',dependsOn:'t-2',type:'blocks'});
  const add=props({action:'link',task,tasks:[{id:'t-1',title:'Pump'},{id:'t-2',title:'Pond'},{id:'t-3',title:'Hose'}]}); await act(async () => tree.update(h(SharedTaskForm,add)));
  await field('Blocking task','t-3'); await act(submit);
  expect(add.submit).toHaveBeenCalledWith({action:'link',id:'t-1',dependsOn:'t-3',type:'blocks'});
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
it('has one row of buttons with the submit filled, plain labels, names without kind words, and no form for a one-step action',async () => {
  await draw(props({action:'close',task}));
  const buttons=()=>tree.root.findByType('Actions').findAllByType('Button');
  expect(buttons().map((b:{props:{children:string;variant?:string}})=>[b.props.children,b.props.variant])).toEqual([['Close task','primary'],['Cancel',undefined]]);
  const reason=tree.root.findByType('Field'); expect(reason.props.label).toBe('Reason'); expect(reason.props.hint).toContain('cancelled');
  await act(async () => tree.update(h(SharedTaskForm,props({action:'create'}))));
  const owner=tree.root.findAllByType('Field').find((node:{props:{label:string}})=>node.props.label==='Owner');
  expect(owner.findAllByType('option').map((o:{props:{children:string}})=>o.props.children)).toEqual(['Household','Art','Jonathan']);
  // Escape closes it, and the key goes no further (a one-pane reader would otherwise go back to the list).
  const cancel=vi.fn(), key={key:'Escape',defaultPrevented:false,preventDefault:vi.fn(),stopPropagation:vi.fn()};
  await act(async () => tree.update(h(SharedTaskForm,props({action:'comment',task,cancel}))));
  await act(async () => tree.root.findByType('form').props.onKeyDown(key));
  expect(cancel).toHaveBeenCalledOnce(); expect(key.preventDefault).toHaveBeenCalled(); expect(key.stopPropagation).toHaveBeenCalled();
  for (const action of ['claim','unclaim','reopen'] as const) { await act(async () => tree.update(h(SharedTaskForm,props({action,task})))); expect(tree.toJSON()).toBeNull(); }
});
