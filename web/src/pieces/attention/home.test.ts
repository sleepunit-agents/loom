import { deskWaitingFixture } from '../../../../src/ui/desk-waiting.fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useMemo, useSyncExternalStore } from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
/** A person's waiting question as the desk fixture carries it. */
interface Ask { id:string; agent?:string; project?:string; member?:string; ask:string; why?:string; if_yes?:string; if_no?:string; href?:string; refs?:string[]; answers?:'yes-no'|'words'; source:{kind:string;id:string}; state:'open'|'answered'|'resolved'; createdAt:number; changedAt:number; [field:string]:unknown }
import type { OwnedAgent, AgentStatus } from './home-model';
import type { Snapshot } from '../../data';
// Renderer nodes carry arbitrary DOM callbacks; snapshots mix three record types for the hook fake.
type Node={children:Array<Node|string>;props:Record<string,any>};
const f=vi.hoisted(()=>({snapshots:{} as Record<string,Snapshot<any>>,listeners:new Set<()=>void>(),call:vi.fn(),once:vi.fn()}));
vi.mock('./agent-status',()=>({useDeskAgentStatuses:()=>useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots['attention.agent'])}));
vi.mock('../../data/graphql',()=>({useDataQuery:(document:string,variables?:Record<string,any>)=>{useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>document.includes('DeskWaiting')||document.includes('DeskAgentWaiting')?f.snapshots['attention.ask']:document.includes('DeskAgentDisplays')?f.snapshots['household.agentDisplay']:document.includes('MemoryActivity')?f.snapshots['activity.window']:document.includes('DeskAgentDirectory')?f.snapshots.person:document.includes('DeskRoster')?f.snapshots['attention.ownedAgent']:document.includes('DeskHomeComms')?f.snapshots['generated.homeComms']:document.includes('DeskCardTalk')?f.snapshots['conversation.summary']:f.snapshots['generated.jobs']);return useMemo(()=>document.includes('DeskWaiting')||document.includes('DeskAgentWaiting')?deskWaitingFixture(document,variables,f.snapshots['attention.ask'],f.snapshots['generated.homeComms']?.records[0]?.member??''):document.includes('DeskAgentDisplays')?{status:f.snapshots['household.agentDisplay'].status,data:{agents:f.snapshots['household.agentDisplay'].records.map((r:any)=>({id:r.id,markBg:r.mark.bg,markFg:r.mark.fg,faceShape:r.face.shape,faceEyes:r.face.eyes}))}}:document.includes('MemoryActivity')?{status:f.snapshots['activity.window'].status,data:{memoryActivity:f.snapshots['activity.window'].records[0]??null}}:document.includes('DeskAgentDirectory')?{status:f.snapshots.person.status,data:{memoryPeopleAccess:{directory:true},memoryPeople:f.snapshots.person.records.map((p:any)=>({...p,agent:p.agent??null}))}}:document.includes('DeskHomeComms')?{status:f.snapshots['generated.homeComms'].status,data:{homeComms:f.snapshots['generated.homeComms'].records[0]??null}}:document.includes('DeskDoing')?{status:f.snapshots['generated.jobs'].status,data:{agentDoing:{more:(f.snapshots['generated.jobs'] as any).more??0,items:f.snapshots['generated.jobs'].records.filter((row:any)=>row.agent===variables?.agent).map((row:any)=>({kind:'job',title:null,with:null,place:null,direct:null,ref:null,machine:null,href:null,since:row.queuedAt??'2026-11-14T01:00:00Z',state:'running',...row}))}}}:({status:document.includes('DeskRoster')?f.snapshots['attention.ownedAgent'].status:document.includes('DeskCardTalk')?(f.snapshots['conversation.summary']?.status??'live'):'live',data:{homeComms:{member:'owner',agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>a.id)},recent:(f.snapshots['conversation.summary']?.records??[]).filter((row:any)=>row.agent===variables?.agent).map((row:any)=>({venue:'loom',place:'th:'+row.id,label:row.id,lastAt:'2026-11-14T10:00:00Z',...row})).sort((a:any,b:any)=>b.lastAt.localeCompare(a.lastAt)).slice(0,variables?.limit??3),answered:(f.snapshots['conversation.summary']?.records??[]).filter((row:any)=>row.agent===variables?.agent).map((row:any)=>({venue:'loom',place:'th:'+row.id,label:row.id,lastAt:'2026-11-14T10:00:00Z',...row})).sort((a:any,b:any)=>b.lastAt.localeCompare(a.lastAt)).filter((row:any)=>row.lastAnswer).slice(0,1),agents:(f.snapshots['attention.ownedAgent']?.records??[]).map((a:any)=>({id:a.id,position:a.position??0}))}}),[f.snapshots['attention.ask'],f.snapshots['household.agentDisplay'],f.snapshots['activity.window'],f.snapshots.person,f.snapshots['generated.homeComms'],f.snapshots['attention.ownedAgent'],f.snapshots['generated.jobs'],f.snapshots['conversation.summary'],document,variables?.agent]);}}));
vi.mock('../../data',()=>({useRecords:(type:string)=>(expect(['attention.ask','household.agentDisplay','activity.window','person','wake','clock','attention.agent','thread','attention.ownedAgent']).not.toContain(type),useSyncExternalStore(fn=>{f.listeners.add(fn);return()=>{f.listeners.delete(fn);};},()=>f.snapshots[type])),call:f.call,callOnce:f.once}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion',()=>({useReducedMotion:()=>true}));
vi.mock('../../data/operation',()=>({memberOperation:(name:string,input:object)=>f.once(name,input).result.then((result:any)=>{if(!result.ok)throw new Error(result.message);return result.value;})}));
import Home from './home';
import { orderedAgents } from './home-model';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const ask=(id:string,fields:Partial<Ask>={}):Ask=>({id,agent:'art',ask:`Question ${id}`,why:'The whole reason',if_yes:'I continue.',if_no:'I stop.',refs:['t-2205'],source:{kind:'piece',id:'test'},state:'open',createdAt:1,changedAt:1,...fields});
const live=<T,>(records:T[])=>({records,status:'live' as const});
let tree:ReturnType<typeof create>|undefined;
const words=(node:Node|string):string=>typeof node==='string'?node:(node.children??[]).map(words).join('');
const text=()=>JSON.stringify(tree!.toJSON());
const buttons=(label:string)=>tree!.root.findAllByType('button').filter((n:Node)=>words(n)===label);
const click=async(label:string)=>act(async()=>buttons(label)[0].props.onClick());
const draw=async(go=vi.fn())=>{await act(async()=>{tree=create(h<{go?:(path:string)=>void}>(Home,{go}));});return go;};
async function publish(type:string,snapshot:Snapshot<any>){await act(async()=>{f.snapshots[type]=snapshot;f.listeners.forEach(fn=>fn());});}
beforeEach(()=>{f.call.mockReset();f.once.mockReset();f.once.mockReturnValue({result:new Promise(()=>{})});f.listeners.clear();f.snapshots={'activity.window':live([]),'attention.ownedAgent':live<OwnedAgent>([{id:'mark',name:'Mark'},{id:'art',name:'Art'}]),'generated.homeComms':live([{member:'owner',agents:[],summaries:[]}]),'household.agentDisplay':live([]),'person':live([]),'generated.jobs':live([]),'attention.ask':live<Ask>([]),'attention.agent':live<AgentStatus>([])};});
afterEach(async()=>{await act(async()=>tree?.unmount());tree=undefined;});
it('keeps idle owned cards in saved position order with stable id ties, without deriving agents from asks or work',async()=>{
  f.snapshots['attention.ask']=live([ask('foreign',{agent:'other'})]);
  await draw();expect(tree!.root.findAllByType('section').filter((n:Node)=>n.props['aria-label']?.endsWith(' card')).map((n:Node)=>n.props['aria-label'])).toEqual(['Art card','Mark card']);
  expect(text()).toContain('Nothing right now');expect(text()).not.toContain('other card');
  expect(orderedAgents([{id:'z',name:'ALPHA',position:1},{id:'a',name:'alpha',position:0},{id:'b',name:'Beta',position:2}]).map(a=>a.id)).toEqual(['a','z','b']);
});
const band=()=>tree!.root.findByProps({'aria-label':'Needs you'});
const chips=()=>band().findAllByType('li');
const bandLink=()=>band().findAllByType('a');
it.each([[0,'Needs you · 0',undefined],[1,'Needs you · 1','Inbox ›'],[3,'Needs you · 3','Inbox ›'],[5,'Needs you · 5','+2 more · Inbox ›']] as const)('shows the band with %i waiting: its count, at most three chips, and the Inbox link at its end',async(count,label,link)=>{
  f.snapshots['attention.ask']=live([...Array.from({length:count},(_,n)=>ask(`q${n+1}`,{createdAt:n+1})),ask('done',{state:'answered'}),ask('resolved',{state:'resolved'})]);
  const go=await draw();
  expect(words(band())).toContain(label);expect(chips()).toHaveLength(Math.min(count,3));
  expect(chips().map((chip:Node)=>words(chip.findAllByType('b')[0]))).toEqual(Array.from({length:Math.min(count,3)},(_,n)=>`Question q${count-n}`));
  expect(bandLink().map(words)).toEqual(link?[link]:[]);
  if(!count){expect(words(band())).toContain('All clear. Nothing is waiting on you.');expect(text()).not.toContain('Inbox');return;}
  expect(words(band())).not.toContain('All clear');expect(text()).not.toContain('Question done');expect(text()).not.toContain('Question resolved');
  const preventDefault=vi.fn();await act(async()=>bandLink()[0].props.onClick({button:0,preventDefault}));
  expect(preventDefault).toHaveBeenCalled();expect(go).toHaveBeenLastCalledWith('/p/inbox-preview');expect(bandLink()[0].props.href).toBe('/p/inbox-preview');
});
it('is not an app in a window: no Home heading and no Inbox button outside the band',async()=>{
  f.snapshots['attention.ask']=live([ask('one',{agent:'other'})]);await draw();
  expect(tree!.root.findAll((n:Node)=>['h1','h2','h3'].includes(n.type as unknown as string)&&words(n)==='Home')).toHaveLength(0);
  expect(tree!.root.findAllByProps({className:'loom-kit-frame'})).toHaveLength(0);
  const inboxes=tree!.root.findAll((n:Node)=>['a','button'].includes(n.type as unknown as string)&&words(n).includes('Inbox'));
  expect(inboxes.map(words)).toEqual(['Inbox ›']);expect(band().findAll((n:Node)=>n===inboxes[0])).toHaveLength(1);
});
it('says who asked, keeps the whole words in the chip’s title, and opens that item in the Inbox',async()=>{
  f.snapshots['person']=live([{id:'commons:art',slug:'art',name:'Art Fish',kind:'agent'}]);
  f.snapshots['attention.ask']=live([ask('new/er',{createdAt:2,ask:'Ship the long\nsecond line?'}),ask('older',{createdAt:1,agent:undefined})]);
  const go=await draw(),open=chips().map((chip:Node)=>chip.findAllByType('button')[0]);
  expect(open.map(words)).toEqual(['Ship the long\nsecond line?Art Fish','Question olderHousehold']);
  expect(open[0].props.title).toBe('Ship the long\nsecond line?');expect(open[0].props['aria-label']).toBe('Ship the long\nsecond line? From Art Fish. Open in Inbox');
  await act(async()=>open[0].props.onClick());expect(go).toHaveBeenLastCalledWith('/p/inbox-preview/ask/new%2Fer');
  await act(async()=>open[1].props.onClick());expect(go).toHaveBeenLastCalledWith('/p/inbox-preview/ask/older');expect(f.once).not.toHaveBeenCalled();
});
it('answers a plain yes/no ask where it stands with the Inbox’s own action, and sends everything else to be read whole',async()=>{
  const plain={if_yes:undefined,if_no:undefined};
  f.snapshots['attention.ask']=live([ask('plain',{...plain,createdAt:9}),ask('lined',{createdAt:8}),ask('words',{...plain,answers:'words',createdAt:7})]);
  await draw();
  const answers=()=>chips().map((chip:Node)=>chip.findAllByType('button').slice(1).map(words));
  expect(answers()).toEqual([['Yes','No'],[],[]]);
  await act(async()=>chips()[0].findAllByType('button')[2].props.onClick());
  expect(f.once).toHaveBeenCalledTimes(1);expect(f.once).toHaveBeenLastCalledWith('inbox.answer',{item:'plain',answer:'no'});
  expect(chips()[0].findAllByType('button').slice(1).every((n:Node)=>n.props.disabled)).toBe(true);
  for(const fields of [{source:'approval'},{source:'task'},{source:'secret-request'},{waitsOnKind:'task'},{canAnswer:false}]){
    await publish('attention.ask',live([ask('managed',{...plain,...fields} as Partial<Ask>)]));expect(answers()).toEqual([[]]);
  }
  expect(f.once).toHaveBeenCalledTimes(1);
});
it('says plainly when the count is loading or cannot be read, and shows no chip or link then',async()=>{
  f.snapshots['attention.ask']=live([ask('secret')]);await draw();
  for(const [status,line] of [['loading','Checking…'],['offline','Can’t tell what is waiting on you right now.'],['denied','Sign in to see what is waiting on you.']] as const){
    await publish('attention.ask',{records:f.snapshots['attention.ask'].records,status});
    expect(words(band())).toBe('Needs you'+line);expect(chips()).toHaveLength(0);expect(bandLink()).toHaveLength(0);
  }
});
it.each(['loading','offline','denied'] as const)('shows %s errors without stale asks, statuses or ownership',async(status)=>{
  f.snapshots['attention.ask']=live([ask('secret')]);await draw();
  for(const type of ['attention.ask','attention.agent','attention.ownedAgent'])await publish(type,{records:f.snapshots[type].records,status});
  expect(text()).not.toContain('Question secret');expect(text()).not.toContain('All clear.');expect(text()).not.toContain('Art card');expect(text()).toContain(status==='loading'?'Opening':'Couldn’t load');expect(f.call).not.toHaveBeenCalled();
});
it('handles no owned agents and regaining scope without invented agents',async()=>{
  f.snapshots['attention.ownedAgent']=live([]);await draw();expect(text()).toContain('No agents of your own');
  await publish('attention.ownedAgent',live([{id:'mark',name:'Mark'}]));expect(text()).toContain('Mark card');expect(text()).not.toContain('Art card');
});



it('clears failed asks and statuses independently while retaining idle owned cards',async()=>{
  const first=ask('first');f.snapshots['attention.ask']=live([first]);
  const report:AgentStatus={id:'work',agent:'art',state:'working',work:'Current secret work',changedAt:1};
  f.snapshots['attention.agent']=live([report]);await draw();
  await publish('attention.agent',{records:[report],status:'offline'});
  expect(text()).not.toContain('Current secret work');expect(text()).toContain('Question first');expect(text()).toContain('Art card');
  await publish('attention.ask',{records:[first],status:'denied'});
  expect(text()).not.toContain('Question first');expect(text()).not.toContain('All clear.');expect(text()).toContain('Art card');expect(buttons('Check again')).toHaveLength(0);
});

const person=(slug:string,name:string,extra:Record<string,unknown>={})=>({id:`commons:${slug}`,slug,name,kind:'agent',...extra});
it('uses live directory agent names without adding relationship or project-only cards, and leaves People to the agent’s own page',async()=>{
  f.snapshots['person']=live([person('art','Zulu Fish'),person('mark','ALPHA Mark'),person('pond-bot','Not owned'),person('art','Relationship name',{id:'mark:art',agent:'mark'}),person('outsider','Outside')]);
  await draw();
  const cards=()=>tree!.root.findAllByType('section').filter((n:Node)=>n.props['aria-label']?.endsWith(' card')).map((n:Node)=>n.props['aria-label']);
  expect(cards()).toEqual(['Zulu Fish card','ALPHA Mark card']);
  expect(text()).not.toContain('Relationship name');expect(text()).not.toContain('Not owned');
  expect(tree!.root.findAllByProps({'aria-label':'Zulu Fish in People'})).toHaveLength(0);expect(f.call).not.toHaveBeenCalled();
  await publish('person',live([person('art','Beta Fish')]));
  expect(cards()).toEqual(['Beta Fish card','Mark card']);
});
it.each(['loading','offline','denied'] as const)('drops stale directory names and links on %s while retaining owned ids and Inbox previews',async(status)=>{
  const records=[person('art','Private display name')];f.snapshots['person']=live(records);f.snapshots['attention.ask']=live([ask('first')]);
  await draw();expect(text()).toContain('Private display name');
  await publish('person',{status,records});
  expect(text()).not.toContain('Private display name');expect(text()).toContain('Art card');expect(text()).toContain('Question first');expect(f.call).not.toHaveBeenCalled();
});
it('ignores person-kind and mismatched directory identities and blank names',async()=>{
  f.snapshots['person']=live([person('art','Wrong kind',{kind:'person'}),person('mark','Wrong id',{id:'commons:art'}),person('mark','   ')]);
  await draw();expect(text()).toContain('Art card');expect(text()).toContain('Mark card');expect(text()).not.toContain('Wrong');
});



const doingList=(name='Art')=>tree!.root.findByProps({'aria-label':`What ${name} is doing`});
const phrases=(name='Art')=>doingList(name).findAllByProps({className:'desk-doing-phrase'}).map(words);
it('leads each card with what its agent is doing, directly under its name, in server order, and says Working beside the name',async()=>{
  f.snapshots['attention.agent']=live([{id:'s',agent:'art',state:'idle',work:'',changedAt:1}]);
  f.snapshots['generated.jobs']={...live([
    {id:'j-term',agent:'art',kind:'terminal',title:'one · claude · loom',machine:'one',href:'/p/comms-preview/thread/term'},
    {id:'j-talk',agent:'art',kind:'loom',with:'mark',title:'Pump',state:'queued',href:'/p/comms-preview/thread/pump'},
    {id:'j-night',agent:'art',kind:'trigger',title:'Plan the night',href:'/p/tempo'},
    {id:'j-private',agent:'art',kind:'private'},
    {id:'j-foreign',agent:'other',kind:'job',title:'Runtime foreign'},
  ]),more:2};
  const go=await draw();
  // An agent's id is said by the name its card has; a private job has no link.
  expect(phrases()).toEqual(['At a terminal on one · claude · loom','Talking with Mark in loom','Running Plan the night','In a private conversation']);
  expect(words(doingList())).toContain('+2 more');expect(words(doingList())).toContain('Queued · since ');expect(words(doingList())).toContain('on one · since ');
  const card=tree!.root.findByProps({'aria-label':'Art card'});
  const drawn=(node:any):any=>!node||typeof node==='string'?undefined:Array.isArray(node)?node.map(drawn).find(Boolean):node.props?.['aria-label']==='Art card'?node:drawn(node.children??[]);
  expect(drawn(tree!.toJSON()).children.slice(0,2).map((n:any)=>n.props.className.split(' ')[0])).toEqual(['desk-home-identity','desk-doing']);
  expect(words(card.findByType('header').findByType('p'))).toBe('Working');
  const links=doingList().findAllByType('a');expect(links.map((n:Node)=>n.props.href)).toEqual(['/p/comms-preview/thread/term','/p/comms-preview/thread/pump','/p/tempo']);
  const preventDefault=vi.fn();await act(async()=>links[1].props.onClick({button:0,preventDefault}));expect(preventDefault).toHaveBeenCalled();expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/pump');
  expect(text()).not.toContain('Runtime foreign');expect(text()).not.toContain('Runtime jobs');expect(text()).not.toContain('Current jobs');
  // Mark has nothing: one quiet line, and the word it reported.
  expect(words(tree!.root.findByProps({'aria-label':'Mark card'}))).toContain('Nothing right now.');
  expect(words(tree!.root.findByProps({'aria-label':'Mark card'}).findByType('header').findByType('p'))).toBe('Quiet');
  await publish('generated.jobs',live([]));expect(text()).not.toContain('Plan the night');
  expect(words(tree!.root.findByProps({'aria-label':'Art card'}).findByType('header').findByType('p'))).toBe('Quiet');
});
it.each(['loading','offline','denied'] as const)('clears what an agent was doing and claims no empty list while %s',async(status)=>{
  f.snapshots['generated.jobs']=live([{id:'private',agent:'art',kind:'job',title:'Visible private Runtime title'}]);await draw();
  await publish('generated.jobs',{records:f.snapshots['generated.jobs'].records,status});
  const card=()=>tree!.root.findByProps({'aria-label':'Art card'});
  expect(words(card())).not.toContain('Visible private Runtime title');expect(words(card())).not.toContain('Nothing right now.');
  expect(words(card())).toContain(status==='loading'?'Checking…':'Can’t tell what it is doing right now.');
  await publish('generated.jobs',live([{id:'returned',agent:'art',kind:'job',title:'Runtime returned'}]));expect(phrases()).toEqual(['Runtime returned']);
  await publish('attention.ownedAgent',live([{id:'mark',name:'Mark'}]));expect(text()).not.toContain('Runtime returned');expect(text()).not.toContain('Art card');
});
const talk=(id:string,fields:Record<string,unknown>={})=>({id,agent:'art',label:`Talk ${id}`,venue:'loom',place:`th:${id}`,lastAt:'2026-11-14T10:00:00Z',...fields});
const artCard=()=>tree!.root.findByProps({'aria-label':'Art card'});
it('is a summary that leads to the agent’s own page: the name, the face and a quiet link all open it',async()=>{
  const go=await draw();
  const links=artCard().findByType('header').findAllByType('a');
  expect(links.map((n:Node)=>n.props.href)).toEqual(Array(3).fill('/p/agents-preview/agent/art'));
  expect(words(links[1])).toBe('Art');expect(words(links[2])).toBe('Open Art ›');
  for(const link of links){go.mockClear();const preventDefault=vi.fn();await act(async()=>link.props.onClick({button:0,preventDefault}));expect(preventDefault).toHaveBeenCalled();expect(go).toHaveBeenCalledWith('/p/agents-preview/agent/art');}
  // Steps, the reported line, the card's own ask and the People button live on that page, not here.
  expect(tree!.root.findAllByProps({'aria-label':'Art recent steps'})).toHaveLength(0);expect(text()).not.toMatch(/Last steps|No recent steps|Runtime jobs|No status reported|No retained agent answer|No unread threads/);
  expect(artCard().findAllByType('button').map(words)).toEqual([]);
});
it('shows the last answer in brief, opening its conversation, and nothing at all when there is none',async()=>{
  f.snapshots['conversation.summary']=live([talk('old',{lastAnswer:{at:'2026-11-14T11:00:00Z',words:'Line one\nLine two\nLine three\nLine four'}}),talk('channel',{venue:'discord',place:'[]',label:'Discord channel #pond'})]);
  const go=await draw(),answer=()=>artCard().findAllByProps({className:'desk-home-answer'});
  expect(answer()).toHaveLength(1);expect(words(answer()[0])).toContain('Last answer · ');
  // The whole text is in the block; the sheet clamps it to three lines.
  expect(words(answer()[0].findByProps({className:'desk-home-answer-words'}))).toBe('Line one\nLine two\nLine three\nLine four');
  expect(answer()[0].props.href).toBe('/p/comms-preview/thread/old');
  await act(async()=>answer()[0].props.onClick({button:0,preventDefault(){}}));expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/old');
  expect(tree!.root.findByProps({'aria-label':'Mark card'}).findAllByProps({className:'desk-home-answer'})).toHaveLength(0);
  await publish('conversation.summary',live([talk('old')]));expect(answer()).toHaveLength(0);expect(text()).not.toContain('Line one');expect(text()).not.toMatch(/Last answer|No retained agent answer|Answer unavailable/);
});
it('lists at most three recent conversations as quiet links, marks the unread one, and ends with All conversations',async()=>{
  f.snapshots['generated.homeComms']=live([{member:'owner',agents:[],summaries:[{agent:'art',unread:2,last:{thread:'th:d',title:'Talk d',at:'2026-11-14T00:00:00Z'},first:{thread:'th:b/1'}}]}]);
  f.snapshots['conversation.summary']=live([talk('a',{lastAt:'2026-11-14T01:00:00Z'}),talk('b/1',{lastAt:'2026-11-14T03:00:00Z'}),talk('c',{lastAt:'2026-11-14T02:00:00Z',venue:'discord',place:'[]',label:'Discord channel #pond'}),talk('d',{lastAt:'2026-11-14T04:00:00Z'}),talk('e',{lastAt:'2026-11-14T00:30:00Z'}),talk('foreign',{agent:'other'})]);
  const go=await draw(),nav=()=>artCard().findByProps({'aria-label':'Art conversations'});
  const rows=nav().findAllByProps({className:'desk-home-talk'});
  expect(rows.map((n:Node)=>words(n.findByProps({className:'desk-home-talk-title'})))).toEqual(['Talk d','Talk b/1','Discord channel #pond']);
  expect(rows.map((n:Node)=>n.props.href)).toEqual(['/p/comms-preview/thread/d','/p/comms-preview/thread/b%2F1','/p/comms-preview/conversation/c']);
  expect(rows.map((n:Node)=>n.findAllByProps({'aria-label':'Unread'}).length)).toEqual([0,1,0]);expect(words(nav())).toContain('Conversations · 2 unread');
  expect(nav().findAllByType('button')).toHaveLength(0);
  await act(async()=>rows[2].props.onClick({button:0,preventDefault(){}}));expect(go).toHaveBeenLastCalledWith('/p/comms-preview/conversation/c');
  const all=nav().findByProps({className:'desk-home-all'});expect(words(all)).toBe('All conversations ›');
  await act(async()=>all.props.onClick({button:0,preventDefault(){}}));expect(go).toHaveBeenLastCalledWith('/p/agents-preview/agent/art');expect(f.once).not.toHaveBeenCalled();
  // None, or a lost source: nothing is drawn, and no line says so.
  expect(tree!.root.findByProps({'aria-label':'Mark card'}).findAllByProps({className:'desk-home-talks'})).toHaveLength(0);
  await publish('conversation.summary',{status:'offline',records:f.snapshots['conversation.summary'].records});
  expect(artCard().findAllByProps({className:'desk-home-talks'})).toHaveLength(0);expect(text()).not.toContain('Talk d');expect(text()).not.toMatch(/No conversations|unavailable/);
});
it('withdraws compose eligibility on current ownership, identity and query loss',async()=>{
 f.snapshots['generated.homeComms']=live([{member:'owner',agents:['art'],summaries:[]}]);await draw();
 const composer=()=>tree!.root.findByProps({'data-compose':'art'}).findAllByType('form');
 expect(composer()).toHaveLength(1);expect(tree!.root.findByProps({'data-compose':'mark'}).findAllByType('form')).toHaveLength(0);
 expect(tree!.root.findByProps({'data-compose':'art'}).findByType('textarea').props).toMatchObject({'aria-label':'Message Art',placeholder:'Message Art',rows:1});
 await publish('generated.homeComms',live([{member:'owner',agents:[],summaries:[]}]));expect(composer()).toHaveLength(0);
 await publish('generated.homeComms',live([{member:'other',agents:['art'],summaries:[]}]));expect(composer()).toHaveLength(1);
 await publish('generated.homeComms',{...f.snapshots['generated.homeComms'],status:'offline'});expect(composer()).toHaveLength(0);
 await publish('generated.homeComms',live([]));expect(composer()).toHaveLength(0);
});

it('folds only phone rosters over four, prioritizes current working state then asks then unread, and unmounts other readers',async()=>{
 let matches=true;const changes=new Set<()=>void>();
 vi.stubGlobal('window',{matchMedia:()=>({get matches(){return matches;},addEventListener:(_s:string,f:()=>void)=>changes.add(f),removeEventListener:(_s:string,f:()=>void)=>changes.delete(f)}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
 try {
 const agents=['art','birch','cedar','elm','fern'].map(id=>({id,name:id}));
 f.snapshots['attention.ownedAgent']=live(agents);
 f.snapshots.person=live(agents.map(a=>({id:`commons:${a.id}`,slug:a.id,name:a.name,kind:'agent'})));
 f.snapshots['attention.ask']=live([ask('question',{agent:'birch'})]);
 const summary={member:'owner',agents:[],summaries:[{agent:'cedar',unread:2,last:{thread:'th:new/one',title:'Unread',at:'2026-11-14T00:00:00Z'},first:{thread:'th:new/one'}},{agent:'elm',unread:0,last:{thread:'th:latest',title:'Latest',at:'2026-11-14T00:00:00Z'},first:null}]};
 f.snapshots['generated.homeComms']=live([summary]);
 f.snapshots['attention.agent']=live([{id:'fern',agent:'fern',state:'working',work:'Working',changedAt:1}]);const go=await draw();
 const cards=()=>tree!.root.findAllByType('section').filter((n:Node)=>n.props.className?.startsWith('desk-home-card')).map((n:Node)=>n.props['data-agent']);
 const rows=()=>tree!.root.findAllByType('section').filter((n:Node)=>n.props.className==='desk-home-compact');
 expect(cards()).toEqual(['fern']);expect(rows()).toHaveLength(4);
 expect(tree!.root.findAllByProps({'aria-label':'birch desk details'})).toHaveLength(0);
 await act(async()=>tree!.root.findByProps({'aria-label':'Open cedar conversation'}).props.onClick());expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/new%2Fone');
 await act(async()=>tree!.root.findByProps({'aria-label':'Open elm conversation'}).props.onClick());expect(go).toHaveBeenLastCalledWith('/p/comms-preview/thread/latest');
 await publish('attention.agent',live([]));expect(cards()).toEqual(['birch']);
 await publish('attention.ask',{records:f.snapshots['attention.ask'].records,status:'denied'});expect(cards()).toEqual(['cedar']);expect(text()).not.toContain('Question question');
 await publish('generated.homeComms',{records:[summary],status:'offline'});expect(cards()).toEqual(['art']);expect(text()).not.toContain('2 unread');
 await act(async()=>{matches=false;changes.forEach(f=>f());});expect(cards()).toHaveLength(5);expect(rows()).toHaveLength(0);
 await act(async()=>{matches=true;changes.forEach(f=>f());});expect(cards()).toEqual(['art']);
 await publish('attention.ownedAgent',live(agents.slice(0,4)));expect(cards()).toHaveLength(4);expect(rows()).toHaveLength(0);
 } finally {await act(async()=>tree?.unmount());tree=undefined;vi.unstubAllGlobals();}
});



it('opens an owned agent’s dedicated window from its Home face',async()=>{
 const go=await draw(),link=tree!.root.findByProps({'aria-label':'Open Art agent window'});expect(link.props.href).toBe('/p/agents-preview/agent/art');const preventDefault=vi.fn();await act(async()=>link.props.onClick({button:0,preventDefault}));expect(preventDefault).toHaveBeenCalled();expect(go).toHaveBeenLastCalledWith('/p/agents-preview/agent/art');go.mockClear();await act(async()=>link.props.onClick({button:0,ctrlKey:true,preventDefault}));expect(go).not.toHaveBeenCalled();
});

it('renders the generated agent reply on Home instead of a human approval receipt, and removes it with its owned card',async()=>{
 f.snapshots['attention.ask']=live([ask('human',{state:'answered',answer:{kind:'yes',by:{kind:'member',id:'human-approver'},at:1}})]);
 f.snapshots['conversation.summary']=live([{id:'cv-art',agent:'art',lastAnswer:{at:'2026-11-14T11:00:00Z',words:'Actual agent reply'}}]);
 await draw();expect(text()).toContain('Actual agent reply');expect(text()).not.toContain('human-approver');
 await publish('attention.ownedAgent',live([{id:'mark',name:'Mark'}]));expect(text()).not.toContain('Actual agent reply');
});
