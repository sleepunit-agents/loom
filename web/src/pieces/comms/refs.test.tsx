import {afterEach,expect,it,vi} from 'vitest';
import * as React from 'react';
import {createElement as h,type ReactNode} from 'react';
// @ts-expect-error Existing renderer has no declarations.
import {act,create} from 'react-test-renderer';
const f=vi.hoisted(()=>({status:'live',rows:new Map<string,unknown[]>(),scopes:[] as string[]}));
vi.mock('../../data',()=>({useRecordScopes:(type:string,scopes:string[])=>scopes.map(scope=>{expect(type).toBe('comms.refCards');f.scopes.push(scope);return {status:f.status,records:f.rows.get(scope)??[]};})}));
vi.mock('../../kit',()=>({Button:(p:{children?:ReactNode})=>h('button',p,p.children)}));
import {ThreadRefs,RefText,cardFor} from './refs';
import {refBits,refBatches} from './ref-bits';
import {replyHtml} from './render';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>;
afterEach(async()=>{await act(async()=>tree?.unmount());f.rows.clear();f.scopes=[];f.status='live';});
it('recognizes qualified forge refs before task-shaped owners, preserving words and omitting bare repos',()=>{
 const text='t-12/repo#3 t-4 repo#3 acme/app#4 note:pond/plan. [[subject]] @art a-1234abcd cv-123456abcdef';
 const parts=refBits(text);expect(parts.map(p=>p.text).join('')).toBe(text);
 expect(parts.flatMap(p=>p.ref?[p.ref]:[])).toEqual(['github:t-12/repo#3','t-4','github:acme/app#4','note:pond/plan','knowledge:subject','at:art','a-1234abcd','cv-123456abcdef']);
 expect(refBits('../repo#3 ./repo#3 note:pond/../private').some(p=>p.ref)).toBe(false);
});
it('marks only markdown prose, without turning code, links, images or raw HTML into chips',()=>{
 const html=replyHtml('See **t-1** and acme/app#3. `t-2` [t-3](https://example.com/t-4)\n\n```\nt-5\n```\n<script>t-6</script> ![t-7](https://example.com/p.png)');
 expect(html).toContain('data-comms-ref="t-1"');expect(html).toContain('data-comms-ref="github:acme/app#3"');
 for(const id of [2,3,4,5,7])expect(html).not.toContain(`data-comms-ref="t-${id}"`);
 expect(html).not.toContain('<script>');expect(html).not.toContain('<img');
 expect(replyHtml('[bad](javascript:alert(1))')).not.toContain('href="javascript:');
});
it('bounds, deduplicates and scopes batches, leaving null and unknown cards as plain text',async()=>{
 const refs=Array.from({length:121},(_,i)=>`t-${i+1}`);expect(refBatches([...refs,'t-1','x'.repeat(201)]).map(p=>p.length)).toEqual([60,60,1]);
 const escaped=Array.from({length:60},(_,i)=>'\\'.repeat(190)+i);for(const batch of refBatches(escaped,'th:one'))expect(JSON.stringify({thread:'th:one',refs:batch}).length).toBeLessThanOrEqual(14000);
 const part=refBatches(refs)[0],scope=JSON.stringify({thread:'th:one',refs:part});
 f.rows.set(scope,[{id:scope,thread:'th:one',cards:{'t-1':{kind:'task',title:'Visible',status:'Open',url:'/p/tasks-preview/task/t-1'},'t-10':null}}]);
 await act(async()=>{tree=create(h(ThreadRefs,{thread:'th:one',refs,connected:true,children:h(RefText,{text:'t-1 t-10 t-999'})}));});
 expect(tree.root.findAllByType('button').map((b:{props:{children:string}})=>b.props.children)).toEqual(['t-1']);
 expect(new Set(f.scopes).size).toBe(3);for(const raw of f.scopes){const s=JSON.parse(raw);expect(s.thread).toBe('th:one');expect(s.refs.length).toBeLessThanOrEqual(60);}
});
it('withdraws cached private titles immediately on disconnect, missing row and exact source changes',async()=>{
 const refs=['t-1'],scope=JSON.stringify({thread:'th:one',refs}),card={kind:'task',title:'PRIVATE TITLE',status:'Open',url:'/p/tasks-preview/task/t-1'};
 f.rows.set(scope,[{id:scope,thread:'th:one',cards:{'t-1':card}}]);
 const render=(thread='th:one',connected=true)=>h(ThreadRefs,{thread,refs,connected,children:h(RefText,{text:'t-1'})});
 await act(async()=>{tree=create(render());});expect(JSON.stringify(tree.toJSON())).toContain('PRIVATE TITLE');
 for(const boundary of ['offline','denied','connected','thread','mismatch','missing']){
  f.status=boundary==='offline'||boundary==='denied'?boundary:'live';
  f.rows.set(scope,boundary==='missing'?[]:[{id:boundary==='mismatch'?'other':scope,thread:'th:one',cards:{'t-1':card}}]);
  await act(async()=>tree.update(render(boundary==='thread'?'th:two':'th:one',boundary!=='connected')));
  expect(tree.root.findAllByType('button')).toHaveLength(0);expect(JSON.stringify(tree.toJSON())).not.toContain('PRIVATE TITLE');
 }
});
it('allows only exact fixed task/Changes readers or the exact public GitHub identity',()=>{
 const task={kind:'task',title:'Title',status:'Open',url:'/p/tasks-preview/task/t-1'};
 expect(cardFor('t-1',task)).toEqual(task);
 for(const url of ['https://evil.example/','//evil.example','/p/tasks-preview/task/t-2','/p/tasks-preview/task/../secrets'])expect(cardFor('t-1',{...task,url})).toBeUndefined();
 const pr={kind:'pr',title:'Change',status:'Open',url:'/p/changes-preview/change/github%3Aacme%2Fapp%233'};
 expect(cardFor('github:Acme/App#3',pr)).toEqual(pr);
 expect(cardFor('github:Acme/App#3',{...pr,url:'https://github.com/acme/app/issues/3'})).toBeTruthy();
 expect(cardFor('github:Acme/App#3',{...pr,url:'https://github.com/acme/app/pull/3'})).toBeUndefined();
 expect(cardFor('__proto__',task)).toBeUndefined();
});

it('adding refs keeps the reader and its local state mounted',async()=>{
 const mount=vi.fn(),unmount=vi.fn();
 const Child=()=>{React.useEffect(()=>{mount();return unmount;},[]);return h('p',null,'Reader');};
 const render=(refs:string[])=>h(ThreadRefs,{thread:'th:one',refs,connected:true,children:h(Child)});
 await act(async()=>{tree=create(render([]));});
 await act(async()=>tree.update(render(['t-1'])));
 await act(async()=>tree.update(render(Array.from({length:121},(_,i)=>`t-${i}`))));
 expect(mount).toHaveBeenCalledTimes(1);expect(unmount).not.toHaveBeenCalled();
});

it('accepts only bounded Comms reader routes for exact conversation ids',()=>{
 const card={kind:'conversation',title:'Earlier thread',status:'Archived',url:'/p/comms-preview/thread/earlier-1'};
 expect(cardFor('cv-012345abcdef',card)).toEqual(card);
 for(const ref of ['cv-other','cv-012345abcdeg','t-1'])expect(cardFor(ref,card)).toBeUndefined();
 for(const url of ['https://evil.example','/p/comms-preview/thread/../secrets','/p/comms-preview/thread/one?secret=yes','/p/comms-preview/thread/one/extra'])expect(cardFor('cv-012345abcdef',{...card,url})).toBeUndefined();
});
