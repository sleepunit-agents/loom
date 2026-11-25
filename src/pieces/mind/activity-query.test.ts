import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GraphQLObjectType,GraphQLSchema,graphql} from 'graphql/index.js';
import {sql} from 'drizzle-orm';
import {createDataSchema} from '../../core/data/database.js';
import {dataQueries} from '../../core/data/queries.js';
import {FakeClock,type Sharing,type Viewer} from '../../core/index.js';
import {createActivityReader} from './activity.js';
import {activityQueryFields} from './activity-query.js';
import type {ActivityConversations,ActivityRun} from './activity-role.js';

const homes:string[]=[],closes:Array<()=>void>=[];
afterEach(()=>{for(const close of closes.splice(0).reverse())close();for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
const dir=()=>{const home=mkdtempSync(join(tmpdir(),'activity-query-'));homes.push(home);return home;};
const owner:Viewer={kind:'member',id:'owner'},member:Viewer={kind:'member',id:'member'},guest:Viewer={kind:'member',id:'guest'};
const now=Date.parse('2026-11-14T18:00:00Z');
function fixture(path:string,conversations?:ActivityConversations){
 let sharing:Sharing={members:{owner:{owner:true,agents:[]},member:{owner:false,agents:['fiction']},guest:{owner:false,agents:[]}},projects:{pond:{members:['guest'],agents:[]}}};
 const clock=new FakeClock(now);
 const reader=createActivityReader(clock,{agents:[{agent:'fiction',memories:path}],sharing:()=>sharing,conversations,timezone:'America/Chicago'});closes.push(()=>reader.close());
 const client=new Database(':memory:');closes.push(()=>client.close());createDataSchema(client);
 const generated=dataQueries(client,{tables:['tasks'],visibility:{tasks:()=>sql`true`}});
 const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:{...generated.getQueryType()!.toConfig().fields,...activityQueryFields(reader)}})});
 return {generated,clock,sharing:(next:Sharing)=>{sharing=next;},query:(source:string,viewer:Viewer=owner)=>graphql({schema,source,contextValue:{viewer}}),schema};
}
function episodes(){
 const path=join(dir(),'memories.db'),db=new Database(path);closes.push(()=>db.close());
 db.exec('CREATE TABLE memories(ref TEXT PRIMARY KEY,title TEXT,content TEXT,created TEXT,project TEXT,metadata TEXT,expires_at TEXT,category TEXT,archived INTEGER)');
 const body='Fictional complete episode. '.repeat(1000)+'Finished t-998 and sleepunit-agents/loom#998.';
 db.prepare('INSERT INTO memories VALUES(?,?,?,?,NULL,?,NULL,?,0)').run('m-story','Shipped the pond fix',body,'2026-11-14T17:00:00Z','{"where":"terminal"}','episode');
 return {path,body,db};
}
it('composes Activity with generated fields, selecting summaries separately from complete stories and references',async()=>{
 const s=episodes(),f=fixture(s.path);
 expect((await graphql({schema:f.generated,source:'{ memoryActivity { id } }'})).errors?.[0].message).toContain('Cannot query field "memoryActivity"');
 const result=await f.query('{ tasks { id } memoryActivity { days conversations episodes entries { id title what } } memoryActivityEntry(id:"e~fiction~m-story") { story asked decided tasks { label href } prs { label href } } }');
 expect(result.errors).toBeUndefined();
 expect(result.data).toEqual({tasks:[],memoryActivity:{days:['2026-11-14','2026-11-13','2026-11-12'],conversations:'unavailable',episodes:'available',entries:[{id:'e~fiction~m-story',title:'Shipped the pond fix',what:'work'}]},memoryActivityEntry:{story:s.body,asked:[],decided:[],tasks:[{label:'t-998',href:'/p/work/backlog/task/t-998'}],prs:[{label:'loom#998',href:'https://github.com/sleepunit-agents/loom/pull/998'}]}});
 expect(await f.query('{ memoryActivity(to:"2026-02-30") { id } memoryActivityEntry(id:"bad") { id } }')).toEqual({data:{memoryActivity:null,memoryActivityEntry:null}});
});
it('uses each authenticated viewer and replacement sharing snapshots without exposing private episodes through a project',async()=>{
 const s=episodes(),f=fixture(s.path),query='{ memoryActivity { entries { id } } memoryActivityEntry(id:"e~fiction~m-story") { story } }';
 expect(await f.query(query,member)).toMatchObject({data:{memoryActivity:{entries:[{id:'e~fiction~m-story'}]},memoryActivityEntry:{story:s.body}}});
 for(const viewer of [guest,{kind:'runner',id:'box'},{kind:'agent',id:'other'}] as Viewer[])expect(await f.query(query,viewer)).toEqual({data:{memoryActivity:null,memoryActivityEntry:null}});
 f.sharing({members:{owner:{owner:false,agents:[]},member:{owner:false,agents:[]}},projects:{}});
 expect(await f.query(query)).toEqual({data:{memoryActivity:null,memoryActivityEntry:null}});
 expect(await f.query(query,member)).toEqual({data:{memoryActivity:null,memoryActivityEntry:null}});
 expect((await f.query('{ memoryActivity(viewer:"owner") { id } }')).errors).toBeDefined();
 expect((await f.query('mutation { memoryActivity { id } }')).errors).toBeDefined();
 expect(await graphql({schema:f.schema,source:query})).toEqual({data:{memoryActivity:null,memoryActivityEntry:null}});
});
it('keeps shared conversations visible independently of private episodes and rechecks scope and expiry',async()=>{
 const s=episodes();let scope='pond';
 const run=():ActivityRun=>({kind:'digest',key:'dg-story',at:'2026-11-14T17:00:00Z',expires:now+1000,conversation:{id:'cv-111111111111',agent:'fiction',venue:'terminal',place:'terminal',label:'Shared pond work',people:[],project:scope},summary:'Shipped pond work.',asked:[],decided:[],tasks:['t-7'],links:[],more:[]});
 const f=fixture(s.path,{agents:()=>['fiction'],list:()=>({available:true,rows:[run()]}),read:()=>run(),conversation:()=>run().conversation});
 const query='{ memoryActivity { entries { id } } memoryActivityEntry(id:"d~fiction~dg-story") { story tasks { label } } memoryActivityEntryPrivate:memoryActivityEntry(id:"e~fiction~m-story") { story } }';
 expect(await f.query(query,guest)).toMatchObject({data:{memoryActivity:{entries:[{id:'d~fiction~dg-story'}]},memoryActivityEntry:{story:'Shipped pond work.',tasks:[{label:'t-7'}]},memoryActivityEntryPrivate:null}});
 scope='other';expect(await f.query(query,guest)).toMatchObject({data:{memoryActivity:{entries:[]},memoryActivityEntry:null,memoryActivityEntryPrivate:null}});
 scope='pond';f.clock.advance(1000);expect(await f.query(query,guest)).toMatchObject({data:{memoryActivity:{entries:[]},memoryActivityEntry:null}});
});
it('keeps absent files absent and reports source failure without disclosing paths or denied data',async()=>{
 const path=join(dir(),'absent.db'),f=fixture(path);
 expect(await f.query('{ memoryActivity { episodes entries { id } } }')).toEqual({data:{memoryActivity:{episodes:'unavailable',entries:[]}}});expect(existsSync(path)).toBe(false);
 const broken=join(dir(),'broken.db');writeFileSync(broken,'not a database');const bad=fixture(broken),query='{ memoryActivityEntry(id:"e~fiction~m-story") { story } }';
 const answer=await bad.query(query);expect(answer.data).toEqual({memoryActivityEntry:null});expect(answer.errors?.[0].message).toBe('Activity entry is unavailable');expect(JSON.stringify(answer)).not.toContain(broken);
 expect(await bad.query(query,guest)).toEqual({data:{memoryActivityEntry:null}});
});

it('offers only live agents in the Activity filter',async()=>{
 const f=fixture(episodes().path),query='{ memoryActivityAccess { allowed agents } }';
 expect((await f.query(query)).data).toEqual({memoryActivityAccess:{allowed:true,agents:['fiction']}});
 f.sharing({members:{owner:{owner:true,agents:['fiction']}},projects:{},agents:[]});
 expect((await f.query(query)).data).toEqual({memoryActivityAccess:{allowed:true,agents:[]}});
});

it('returns session evidence from the authenticated agent’s visible episodes including those recorded when a long-running session started',async()=>{
 const s=episodes(),f=fixture(s.path);
 const insert=s.db.prepare("INSERT INTO memories VALUES(?,?,?, ?,NULL,?,?, 'episode',?)");
 const at='2026-11-14T17:00:00Z',id='abcdef01-0000-0000-0000-000000000001';
 insert.run('meta','Private title','older form: session abcdef01',at,JSON.stringify({session_id:id,transcript_path:'/fixture/12345678-0000-0000-0000-000000000000.jsonl'}),null,0);
 insert.run('text','session aaaaaaaa','transcript /tmp/bbbbbbbb-0000-0000-0000-000000000000.jsonl',at,'{}',null,0);
 for(const [ref,created,meta,expires,archived] of [
  ['future','2026-11-15T00:00:00Z','{}',null,0],
  ['archived',at,'{}',null,1],['expired',at,'{}',at,0],['hidden',at,'{"conversation":"cv-222222222222"}',null,0],
 ] as const)insert.run(ref,'session deadbeef','private',created,meta,expires,archived);
 insert.run('older','session 10101010','','2026-01-01T00:00:00Z','{}',null,0);
 const query='{memoryOwnEpisodeSessions}';
 expect(await f.query(query,{kind:'agent',id:'fiction'})).toEqual({data:{memoryOwnEpisodeSessions:['10101010','12345678-0000-0000-0000-000000000000','aaaaaaaa',id,'bbbbbbbb-0000-0000-0000-000000000000']}});
 expect(await f.query(query,owner)).toEqual({data:{memoryOwnEpisodeSessions:null}});
 expect((await f.query(query,{kind:'agent',id:'other'})).data?.memoryOwnEpisodeSessions).toBeNull();
});
