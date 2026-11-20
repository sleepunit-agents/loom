import React,{act,createElement as h} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {create,type ReactTestRenderer} from 'react-test-renderer';
const feed=vi.hoisted(()=>({result:{status:'live',data:undefined} as {status:string;data?:unknown;settling?:boolean},variables:{} as Record<string,unknown>}));
vi.mock('../../data/graphql',()=>({useDataQuery:(_query:unknown,variables:Record<string,unknown>,options?:{keep?:boolean})=>{feed.variables=variables;return feed.result.settling&&!options?.keep?{status:'loading'}:feed.result;}}));
vi.mock('../../data',async original=>({...await original<object>(),useRecords:()=>{throw Error('Legacy reader mounted');}}));
vi.mock('../../kit',async original=>({...await original<object>(),Button:(props:object)=>h('button',props),Empty:({title}:{title:string})=>h('p',null,title),Error:({text}:{text:string})=>h('p',null,text),Loading:({label}:{label:string})=>h('p',null,label)}));
import CommsApp from './index';
let tree:ReactTestRenderer|undefined;
afterEach(async()=>{if(tree)await act(async()=>tree!.unmount());tree=undefined;vi.useRealTimers();});
const activity={id:'cv-fixture',label:'PRIVATE CONVERSATION LABEL',agent:'art',venue:'wake',turnsByConversation:Array.from({length:50},(_,i)=>({seq:100-i,at:'2026-11-15T12:00:00Z',kind:'action',fromKind:'agent',fromId:'art',outcome:'progressed'}))};
it('opens Memory conversation links without mounting legacy reads and pages by sequence',async()=>{
 feed.result={status:'live',data:{activity}};
 await act(async()=>{tree=create(h(CommsApp,{path:'/p/comms-preview/conversation/cv-fixture',go:vi.fn()}));});
 expect(JSON.stringify(tree!.toJSON())).toContain('PRIVATE CONVERSATION LABEL');expect(feed.variables).toEqual({id:'cv-fixture',before:2147483647});
 const earlier=tree!.root.findAllByType('button').find(button=>button.children.includes('Load earlier activity'))!;
 await act(async()=>earlier.props.onClick());expect(feed.variables.before).toBe(51);
});
it('says each step briefly in the household\'s time and in plain words, never a zone\'s id or a stored word',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-19T18:00:00Z'));
 feed.result={status:'live',data:{activity,deskTime:{timezone:'Asia/Tokyo'}}};
 const props={path:'/p/comms-preview/conversation/cv-fixture',go:vi.fn()};
 await act(async()=>{tree=create(h(CommsApp,props));});
 const time=()=>tree!.root.findAllByType('time')[0];
 expect(time().children).toEqual(['Nov 15, 9:00 PM']);expect(time().props).toMatchObject({dateTime:'2026-11-15T12:00:00Z',title:'Nov 15, 2026, 9:00 PM'});
 feed.result={status:'live',data:{activity,deskTime:{timezone:'Europe/London'}}};
 await act(async()=>tree!.update(h(CommsApp,props)));
 expect(time().children).toEqual(['Nov 15, 12:00 PM']);
 const text=JSON.stringify(tree!.toJSON());
 expect(text).toContain('Step from art · made progress');
 for(const raw of ['Asia/Tokyo','Europe/London','progressed','action · ','2026-11-15T12:00:00Z"]}'])expect(text).not.toContain(raw);
 // With no zone read yet a step still says a brief time (the device's), never the stored stamp.
 feed.result={status:'live',data:{activity:{...activity,turnsByConversation:[{seq:1,at:'2026-11-15T12:00:00Z',kind:'refused',fromKind:'schedule',fromId:null,outcome:'none'}]}}};
 await act(async()=>tree!.update(h(CommsApp,props)));
 expect(time().children.join('')).toMatch(/^Nov 1[56], \d{1,2}:00 [AP]M$/);expect(JSON.stringify(tree!.toJSON())).toContain('Refused from a schedule"');
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
it('keeps the steps and the label on screen while an earlier page loads, and drops them when the feed fails',async()=>{
 feed.result={status:'live',data:{activity}};
 const props={path:'/p/comms-preview/conversation/cv-fixture',go:vi.fn()};
 await act(async()=>{tree=create(h(CommsApp,props));});
 const earlier=()=>tree!.root.findAllByType('button').find(button=>button.children.includes('Load earlier activity'))!;
 // As the data hook answers with `keep`: the last answer again, marked settling.
 feed.result={status:'live',data:{activity},settling:true};
 await act(async()=>earlier().props.onClick());expect(feed.variables.before).toBe(51);
 const text=JSON.stringify(tree!.toJSON());
 expect(text).toContain('PRIVATE CONVERSATION LABEL');expect(tree!.root.findAllByType('li')).toHaveLength(50);expect(text).not.toContain('Opening conversation activity');
 expect(earlier().props.disabled).toBe(true);
 feed.result={status:'offline'};
 await act(async()=>tree!.update(h(CommsApp,props)));
 expect(JSON.stringify(tree!.toJSON())).not.toContain('PRIVATE CONVERSATION LABEL');expect(tree!.root.findAllByType('li')).toHaveLength(0);
});
