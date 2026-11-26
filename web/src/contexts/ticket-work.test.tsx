import {createElement} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
// @ts-expect-error The renderer ships without types.
import {act,create} from 'react-test-renderer';
import {TicketWork} from './ticket-work';
const live=vi.hoisted(()=>({checks:'passing'}));
vi.mock('../data/graphql',()=>({useDataQuery:(q:string)=>({status:'live',data:q.includes('ContextWorkLinks')?{ticket:{taskLinksByTask:[],taskLinksByDependsOn:[],changeTasksByTask:[{changeRow:{id:'pr',repository:'repo',number:1,title:'Build',state:'open',checks:live.checks,review:'approved',draft:false,waitingOn:'author'}}]},changeSync:[]}:{contextWorkJobs:[],sessions:[]}})}));
afterEach(()=>vi.unstubAllGlobals());
it('promotes and demotes the same PR, preserves a dismissal on reload, and scopes it to the view',async()=>{
  const storage=new Map<string,string>();vi.stubGlobal('location',{href:'https://loom.test/app/contexts.html'});vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v)});
  const props={target:{kind:'ticket' as const,id:'t-1'},row:{type:'task',status:'open'},open:vi.fn()};
  let tree:ReturnType<typeof create>;
  const draw=()=>createElement(TicketWork,props);
  await act(async()=>{tree=create(draw())});
  const pulls=()=>tree.root.findAllByType('details').filter((d:{props:{className?:string}})=>d.props.className?.includes('prCompanion'));
  expect(pulls()[0].props.className).toContain('far');
  live.checks='failing';await act(async()=>tree.update(draw()));expect(pulls()[0].props.className).toContain('near');expect(pulls()[0].props.open).toBe(true);
  live.checks='passing';await act(async()=>tree.update(draw()));expect(pulls()[0].props.className).toContain('far');
  await act(async()=>pulls()[0].findAllByType('button')[1].props.onClick());
  live.checks='failing';await act(async()=>tree.update(draw()));expect(pulls()).toHaveLength(0);
  await act(async()=>tree.unmount());await act(async()=>{tree=create(draw())});expect(pulls()).toHaveLength(0);
  await act(async()=>tree.unmount());await act(async()=>{tree=create(createElement(TicketWork,{...props,target:{...props.target,view:'decision'}}))});expect(pulls()).toHaveLength(1);
  await act(async()=>tree.unmount());live.checks='passing';
});
