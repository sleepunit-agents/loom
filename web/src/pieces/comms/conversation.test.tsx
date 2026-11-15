import React,{act,createElement as h} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {create,type ReactTestRenderer} from 'react-test-renderer';
const feed=vi.hoisted(()=>({result:{status:'live',data:undefined} as {status:string;data?:unknown},variables:{} as Record<string,unknown>}));
vi.mock('../../data/graphql',()=>({useDataQuery:(_query:unknown,variables:Record<string,unknown>)=>{feed.variables=variables;return feed.result;}}));
vi.mock('../../data',async original=>({...await original<object>(),useRecords:()=>{throw Error('Legacy reader mounted');}}));
vi.mock('../../kit',async original=>({...await original<object>(),Button:(props:object)=>h('button',props),Empty:({title}:{title:string})=>h('p',null,title),Error:({text}:{text:string})=>h('p',null,text),Loading:({label}:{label:string})=>h('p',null,label)}));
import CommsApp from './index';
let tree:ReactTestRenderer|undefined;
afterEach(async()=>{if(tree)await act(async()=>tree!.unmount());tree=undefined;});
const activity={id:'cv-fixture',label:'PRIVATE CONVERSATION LABEL',agent:'art',venue:'wake',turnsByConversation:Array.from({length:50},(_,i)=>({seq:100-i,at:'2026-11-15T12:00:00Z',kind:'action',fromKind:'agent',fromId:'art',outcome:'progressed'}))};
it('opens Memory conversation links without mounting legacy reads and pages by sequence',async()=>{
 feed.result={status:'live',data:{activity}};
 await act(async()=>{tree=create(h(CommsApp,{path:'/p/comms-preview/conversation/cv-fixture',go:vi.fn()}));});
 expect(JSON.stringify(tree!.toJSON())).toContain('PRIVATE CONVERSATION LABEL');expect(feed.variables).toEqual({id:'cv-fixture',before:2147483647});
 const earlier=tree!.root.findAllByType('button').find(button=>button.children.includes('Load earlier activity'))!;
 await act(async()=>earlier.props.onClick());expect(feed.variables.before).toBe(51);
});
it('withdraws the previous private label on disconnect and a current hidden result',async()=>{
 feed.result={status:'live',data:{activity}};
 const props={path:'/p/comms-preview/conversation/cv-fixture',go:vi.fn()};
 await act(async()=>{tree=create(h(CommsApp,props));});expect(JSON.stringify(tree!.toJSON())).toContain('PRIVATE CONVERSATION LABEL');
 feed.result={status:'offline',data:{activity}};
 await act(async()=>tree!.update(h(CommsApp,props)));expect(JSON.stringify(tree!.toJSON())).not.toContain('PRIVATE CONVERSATION LABEL');
 feed.result={status:'live',data:{activity:null}};
 await act(async()=>tree!.update(h(CommsApp,props)));expect(JSON.stringify(tree!.toJSON())).toContain('Conversation unavailable');expect(JSON.stringify(tree!.toJSON())).not.toContain('PRIVATE CONVERSATION LABEL');
});
