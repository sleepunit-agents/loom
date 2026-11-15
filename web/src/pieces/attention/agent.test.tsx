import { deskWaitingFixture } from '../../../../src/ui/desk-waiting.fixture';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement as h, useMemo,useSyncExternalStore} from 'react';
// @ts-expect-error Existing renderer dependency has no declarations.
import {act,create} from 'react-test-renderer';
import type {Snapshot} from '../../data';
const f=vi.hoisted(()=>({snapshots:{} as Record<string,Snapshot<any>>,listeners:new Set<()=>void>(),call:vi.fn()}));
function homeFixture() {
 const snapshot=f.snapshots.thread;
 return {status:snapshot.status,data:{homeComms:{member:'owner',agents:f.snapshots['attention.ownedAgent'].records.map((a:any)=>a.id),summaries:f.snapshots['attention.ownedAgent'].records.map((a:any)=>{
  const recent=snapshot.records.filter((t:any)=>t.agent===a.id&&t.archived===null).sort((a:any,b:any)=>b.last-a.last||a.id.localeCompare(b.id));
  const last=recent[0],first=recent.find((t:any)=>t.unread);
  return {agent:a.id,unread:recent.filter((t:any)=>t.unread).length,last:last?{thread:last.id,title:last.title??'',at:new Date(last.last).toISOString()}:null,first:first?{thread:first.id}:null};
 })}}};
}
vi.mock('./agent-status',()=>({useDeskAgentStatuses:()=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots['attention.agent'])}));
vi.mock('../../data/graphql',()=>({useDataQuery:(document:string,variables?:Record<string,any>)=>{useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>document.includes('DeskWaiting')||document.includes('DeskAgentWaiting')?f.snapshots['attention.ask']:document.includes('DeskAgentDisplays')?f.snapshots['household.agentDisplay']:document.includes('DeskAgentProfiles')?f.snapshots['household.profile']:document.includes('MemoryActivity')?f.snapshots['activity.window']:document.includes('DeskAgentDirectory')?f.snapshots.person:document.includes('DeskHomeComms')?f.snapshots.thread:f.snapshots['attention.ownedAgent']);return useMemo(()=>document.includes('DeskWaiting')||document.includes('DeskAgentWaiting')?deskWaitingFixture(document,variables,f.snapshots['attention.ask'],'owner'):document.includes('DeskAgentDisplays')?{status:f.snapshots['household.agentDisplay'].status,data:{agents:f.snapshots['household.agentDisplay'].records.map((r:any)=>({id:r.id,markBg:r.mark.bg,markFg:r.mark.fg,faceShape:r.face.shape,faceEyes:r.face.eyes}))}}:document.includes('DeskAgentProfiles')?{status:f.snapshots['household.profile'].status,data:{agents:f.snapshots['household.profile'].records.map((p:any)=>({id:p.agent,about:p.description??'',aboutAskedAt:p.requestedAt??null}))}}:document.includes('MemoryActivity')?{status:f.snapshots['activity.window'].status,data:{memoryActivity:f.snapshots['activity.window'].records[0]??null}}:document.includes('DeskAgentDirectory')?{status:f.snapshots.person.status,data:{memoryPeopleAccess:{directory:true},memoryPeople:f.snapshots.person.records.map((p:any)=>({...p,agent:p.agent??null}))}}:document.includes('DeskHomeComms')?homeFixture():({status:f.snapshots['attention.ownedAgent'].status,data:{homeComms:{member:'owner',agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>a.id)},agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>({id:a.id,position:a.position??0}))}}),[f.snapshots['attention.ask'],f.snapshots['household.agentDisplay'],f.snapshots['household.profile'],f.snapshots['activity.window'],f.snapshots.person,f.snapshots.thread,f.snapshots['attention.ownedAgent'],document,variables?.agent]);}}));
vi.mock('../../data',()=>({useRecords:(type:string)=>(expect(['attention.ask','household.agentDisplay','household.profile','activity.window','person','thread','attention.agent','attention.ownedAgent']).not.toContain(type),useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots[type])),call:f.call,callOnce:f.call}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
import AgentApp from './agent';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let tree:ReturnType<typeof create>|undefined;
const live=(records:object[])=>({records,status:'live' as const});
const text=()=>JSON.stringify(tree!.toJSON());
const words=(node:any):string=>typeof node==='string'?node:(node.children??[]).map(words).join('');
const click=async(title:string)=>act(async()=>tree!.root.findAllByType('button').find((n:any)=>words(n).startsWith(title)).props.onClick());
const draw=async(path='/p/agents-preview/agent/art')=>{const go=vi.fn();await act(async()=>{tree=create(h(AgentApp,{path,go}));});return go;};
async function publish(type:string,status:Snapshot<any>['status'],records:object[]){await act(async()=>{f.snapshots[type]={status,records};f.listeners.forEach(fn=>fn());});}
beforeEach(()=>{f.call.mockClear();f.listeners.clear();f.snapshots={
 'attention.ownedAgent':live([{id:'art',name:'Art'},{id:'mark',name:'Mark'}]),
 person:live([{id:'commons:art',slug:'art',kind:'agent',name:'Art E Fish'}]),
 'household.profile':live([{id:'art',agent:'art',description:'Keeps the household moving.',canEdit:true},{id:'foreign',agent:'foreign',description:'Private foreign profile',canEdit:true}]),
 'household.agentDisplay':live([]),'activity.window':live([]),
 'attention.agent':live([{id:'status',agent:'art',state:'working',work:'Checking the desk',changedAt:1}]),
 'attention.ask':live([{id:'question',agent:'art',state:'open',ask:'Ship the desk?',why:'Ready to test',createdAt:1}]),
 thread:live([{id:'th:latest',agent:'art',archived:null,unread:false,last:3},{id:'th:unread',agent:'art',archived:null,unread:true,last:1}]),
};});
afterEach(async()=>{await act(async()=>tree?.unmount());tree=undefined;});
it('opens one owned agent with real profile/status and routes each deeper action to its owning app',async()=>{
 const go=await draw();expect(text()).not.toContain('Edit profile in Setup');expect(text()).toContain('Art E Fish agent window');expect(text()).toContain('Keeps the household moving.');expect(text()).toContain('Checking the desk');expect(text()).not.toContain('Private foreign profile');
 for(const [title,path] of [['Ship the desk?','/p/inbox-preview/ask/question'],['Conversation','/p/comms-preview/thread/unread'],['Activity','/p/activity-preview/?who=art'],['People','/p/people-preview/person/art']]){await click(title);expect(go).toHaveBeenLastCalledWith(path);}
 expect(f.call).not.toHaveBeenCalled();
});
it.each(['foreign','%ZZ'])('does not expand an unowned or malformed addressed agent: %s',async(id)=>{
 await draw('/p/agents-preview/agent/'+id);expect(text()).toContain('Agent not available');expect(text()).not.toContain('Private foreign profile');expect(text()).not.toContain('Keeps the household moving.');expect(text()).not.toContain('Ship the desk?');
});
it('withdraws profile, work, questions and navigation capabilities as each source is lost',async()=>{
 await draw();await publish('household.profile','offline',f.snapshots['household.profile'].records);expect(text()).not.toContain('Keeps the household moving.');expect(text()).not.toContain('Edit profile in Setup');expect(text()).toContain('Description unavailable.');
 await publish('attention.agent','denied',f.snapshots['attention.agent'].records);expect(text()).not.toContain('Checking the desk');expect(text()).toContain('Status unavailable.');
 await publish('attention.ask','offline',f.snapshots['attention.ask'].records);expect(text()).not.toContain('Ship the desk?');expect(text()).toContain('Questions unavailable.');
 await publish('attention.ownedAgent','offline',f.snapshots['attention.ownedAgent'].records);expect(text()).not.toContain('Art E Fish agent window');expect(text()).toContain('Your agents are unavailable');
});
it('does not infer profile edit permission and replaces an unread target when thread records disappear',async()=>{
 const go=await draw();await publish('household.profile','live',[{id:'art',agent:'art',canEdit:false}]);expect(text()).not.toContain('Edit profile in Setup');expect(text()).toContain('No profile description.');
 await publish('thread','offline',f.snapshots.thread.records);await click('Conversation');expect(go).toHaveBeenLastCalledWith('/p/comms-preview');
});
