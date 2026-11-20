import {eq} from 'drizzle-orm';
/** Real Memory query fields, canonical client and tile entries. The websocket
 * boundary is mocked; this does not establish real root sign-in convergence. */
import {expect,it,vi} from 'vitest';
import {createElement as h} from '../../web/node_modules/react/index.js';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import {act,create} from '../../web/node_modules/react-test-renderer/index.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {graphql,GraphQLSchema,GraphQLObjectType} from 'graphql/index.js';
import { KnowledgePages } from '../../test/fixtures/knowledge-pages.js';
import Database from 'better-sqlite3';
import {createDataSchema} from '../core/data/database.js';
import {agents,members} from '../core/data/schema.js';
import {Conversations} from '../core/conversations/index.js';
import {PeopleStore} from '../backends/people.js';
import {ProjectsStore} from '../backends/projects.js';
import {peopleReader} from '../pieces/mind/people.js';
import {createProjectsReader} from '../pieces/mind/projects.js';
import {createActivityReader} from '../pieces/mind/activity.js';
import {sharedActivityConversations} from '../pieces/mind/activity-conversations.js';
import {memoryQueryFields} from './memory-queries.js';
const wire=vi.hoisted(()=>({create:vi.fn(),subscribe:vi.fn(),closed:undefined as undefined|(()=>void),call:vi.fn()}));
vi.mock('../../web/node_modules/graphql-ws/dist/index.js',()=>({createClient:(options:{on:{closed:()=>void}})=>{
 wire.create();wire.closed=options.on.closed;return {subscribe:wire.subscribe,dispose:vi.fn()};
}}));
vi.mock('../../web/src/memory/commands',()=>({memoryCall:wire.call}));
vi.mock('../../web/src/data',()=>({call:wire.call,useRecords:()=>{throw Error('Memory tiles must not read legacy records');}}));
vi.mock('../../web/src/kit',()=>({Search:'input',Reader:'article',Title:'h1',Meta:'p',Section:'section',Facts:'dl',Fact:'dd',Split:(p:any)=>h('main',{'data-tile':p.label},p.list,p.reader),List:(p:any)=>h('div',null,p.children),Row:(p:any)=>h('button',{onClick:p.onClick},p.title),Empty:(p:any)=>h('p',null,p.title),Loading:(p:any)=>h('p',null,p.label),Error:(p:any)=>h('p',null,p.text),Input:'input',Textarea:'textarea',Button:'button',Markdown:(p:any)=>h('p',null,p.text)}));
import Knowledge from '../../web/src/pieces/knowledge';
import People from '../../web/src/pieces/people';
import Projects from '../../web/src/pieces/projects';
import Activity from '../../web/src/pieces/activity';
vi.mock('../../web/src/face',()=>({default:()=>h('svg')}));
vi.mock('../../web/src/components/ui/avatar',()=>({Avatar:(p:any)=>h('span',null,p.children),AvatarFallback:(p:any)=>h('span',null,p.children)}));
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it('reads all four Memory tiles on one canonical client, switches details and clears words on denial and disconnect',async()=>{
 const home=mkdtempSync(join(tmpdir(),'memory-tiles-client-')),path=join(home,'knowledge.db'),source=new KnowledgePages({dbPath:path});
 let tree:ReturnType<typeof create>|undefined,owner=true;
 const now=Date.parse('2026-11-14T12:00:00Z'),dbClient=new Database(':memory:'),db=createDataSchema(dbClient),memories=join(home,'memories.db');
 db.insert(agents).values({id:'fiction',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(members).values({id:'sam',role:'owner',joinedAt:new Date(now).toISOString()}).run();
 const sharing=()=>({members:{sam:{owner,agents:[]}},projects:{}});
 const peopleStore=new PeopleStore({dbPath:memories,actor:'fiction'});peopleStore.write({slug:'friend',name:'Private fictional friend'});peopleStore.close();
 const projectsStore=new ProjectsStore({dbPath:memories});projectsStore.write({slug:'pond',name:'Private fictional pond',status:'paused'});projectsStore.close();
 const sources={commons:{directory:home,knowledge:path,people:join(home,'people.db')},agents:[{agent:'fiction',directory:home,memories}]};
 const people=peopleReader({directory:sources.commons.people,agents:sources.agents,sharing,now:()=>now});
 const projects=createProjectsReader({now:()=>now},{agents:sources.agents,sharing,people});
 const conversations=new Conversations(db,()=>new Date(now).toISOString());
 const thread=conversations.open({agent:'fiction',venue:'wake',place:'fiction',label:'Private fictional session'});
 const activity=createActivityReader({now:()=>now},{agents:sources.agents,sharing,conversations:sharedActivityConversations(db,{}),timezone:'America/Chicago'});
 const queries=memoryQueryFields(db,{sources,sharing,now:()=>now,projects,activity,conversationHref:id=>'/conversation/'+id,projectHref:(_agent,slug)=>'/project/'+slug});
 const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:queries.fields})});
 vi.stubGlobal('location',{protocol:'https:',host:'memory.invalid'});
 const selections=new Map<string,{query:string;variables:Record<string,unknown>;revision:number;sink:{next(value:unknown):void};stop:ReturnType<typeof vi.fn>}>();
 wire.subscribe.mockImplementation((request:{variables:{query:string;variables:Record<string,unknown>}},sink:{next(value:unknown):void})=>{
  const stop=vi.fn(),{query,variables}=request.variables;selections.set(JSON.stringify([query,variables]),{query,variables,revision:0,sink,stop});return stop;
 });
 const render=(slug:string)=>h('div',null,
  h(Knowledge,{path:'/p/knowledge-preview/page/'+slug,go:()=>{}}),
  h(People,{path:'/p/people-preview/person/friend',go:()=>{}}),
  h(Projects,{path:'/p/projects-preview/project/fiction%3Apond',go:()=>{}}),
  h(Activity,{path:'/p/activity-preview/?e='+encodeURIComponent('c~fiction~'+thread.id),go:()=>{}}));
 const text=()=>JSON.stringify(tree!.toJSON());
 const refresh=async(filter:(s:{query:string})=>boolean=()=>true)=>{await act(async()=>{for(const selection of selections.values()){if(!filter(selection))continue;
  const result=await graphql({schema,source:selection.query,variableValues:selection.variables,contextValue:{viewer:{kind:'member',id:'sam'}}});expect(result.errors).toBeUndefined();
  selection.sink.next({data:{observe:{revision:++selection.revision,patches:[{path:[],removed:false,value:result.data}]}}});
 }});};
 try{
  await source.writePage({slug:'pump',title:'Fictional pump',domain:'fiction',body:'Private pump words'});
  await source.writePage({slug:'clock',title:'Fictional clock',domain:'fiction',body:'Private clock words'});
  await act(async()=>{tree=create(render('pump'));});
  await act(async()=>{await expect.poll(()=>selections.size).toBe(12);});expect(wire.create).toHaveBeenCalledTimes(1);
  expect(text()).toContain('Opening knowledge');expect(text()).not.toContain('Private pump words');
  await refresh();await act(async()=>{await expect.poll(()=>[...selections.values()].some(s=>s.variables?.id==='fiction:friend')&&[...selections.values()].some(s=>s.variables?.to==='2026-11-14')).toBe(true);});await refresh();expect(text()).toContain('Private fictional friend');expect(text()).toContain('Private fictional pond');expect(text()).toContain('Private fictional session');expect(text()).toContain('Fictional pump');expect(text()).toContain('Private pump words');expect(wire.call).not.toHaveBeenCalled();
  const projectText=()=>JSON.stringify(tree!.root.findAllByType('main').find(p=>p.props['data-tile']==='Projects')!.findAllByType('h2').map(p=>p.props.children));
  expect(projectText()).toContain('People');
  // A paused index intentionally omits hub roles. Its normalized result must
  // not erase the selected hub's sections when only that selection refreshes.
  await refresh(s=>s.query.includes('query MemoryProjects {'));
  expect(projectText()).toContain('People');
  await act(async()=>tree!.update(render('clock')));expect(text()).not.toContain('Private pump words');expect(text()).not.toContain('Private clock words');
  await act(async()=>{await expect.poll(()=>[...selections.values()].some(s=>s.variables?.slug==='clock')).toBe(true);});await refresh();expect(text()).toContain('Private clock words');
  owner=false;db.update(members).set({role:'member'}).where(eq(members.id,'sam')).run();await refresh();expect(text()).toContain('don’t have access');expect(text()).not.toContain('Private clock words');expect(text()).not.toContain('Fictional pump');for(const words of ['Private fictional friend','Private fictional pond','Private fictional session'])expect(text()).not.toContain(words);
  owner=true;db.update(members).set({role:'owner'}).where(eq(members.id,'sam')).run();await refresh();expect(text()).toContain('Private clock words');
  await act(async()=>wire.closed!());expect(text()).toContain('Connection lost');expect(text()).not.toContain('Private clock words');
  expect(wire.create).toHaveBeenCalledTimes(1);expect(wire.call).not.toHaveBeenCalled();
  await act(async()=>tree!.unmount());tree=undefined;expect([...selections.values()].every(s=>s.stop.mock.calls.length===1)).toBe(true);
 }finally{if(tree)await act(async()=>tree!.unmount());queries.close();activity.close();projects.close();people.close();dbClient.close();source.close();rmSync(home,{recursive:true,force:true});vi.unstubAllGlobals();}
});
