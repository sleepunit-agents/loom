import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {graphql,GraphQLObjectType,GraphQLSchema} from 'graphql/index.js';
import {memoryIdentityFields} from './identity-query.js';
import {QueryDeadlines} from './query-deadlines.js';
import {digestOnConnection} from '../../backends/salience.js';
import {episodesOnConnection} from '../../backends/episodes.js';
const close:Array<()=>void>=[];afterEach(()=>{for(const stop of close.splice(0).reverse())stop();});
it('uses current Memory visibility and closes its independent reader admission',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'memory-identity-fiction-'));close.push(()=>rmSync(directory,{recursive:true,force:true}));writeFileSync(join(directory,'IDENTITY.md'),'PRIVATE_IDENTITY');
 const deadlines=new QueryDeadlines(()=>0);close.push(()=>deadlines.close());
 const reader=memoryIdentityFields({sources:{commons:{directory,knowledge:join(directory,'knowledge.db'),people:join(directory,'people.db')},agents:[{agent:'art',directory,memories:join(directory,'missing.db')}]},now:()=>0,timezone:()=> 'UTC',sharing:()=>({members:{owner:{owner:true,agents:[]},peer:{owner:false,agents:[]}},projects:{},services:{}})},deadlines);close.push(reader.close);
 const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:reader.fields})}),query='{memoryIdentity(agent:"art"){creed}}';
 expect(await graphql({schema,source:query,contextValue:{viewer:{kind:'member',id:'owner'}}})).toMatchObject({data:{memoryIdentity:{creed:'PRIVATE_IDENTITY'}}});
 expect(await graphql({schema,source:query,contextValue:{viewer:{kind:'member',id:'peer'}}})).toMatchObject({data:{memoryIdentity:null}});
 reader.close();expect(await graphql({schema,source:query,contextValue:{viewer:{kind:'agent',id:'art'}}})).toMatchObject({data:{memoryIdentity:null}});
});
it('opts into current expiry/window selection while retaining the legacy helper defaults',()=>{
 const db=new Database(':memory:');close.push(()=>db.close());const now=Date.parse('2026-11-14T18:00:00Z');
 db.exec('CREATE TABLE memories(title TEXT,category TEXT,content TEXT,salience REAL,sourcing TEXT,created TEXT,updated TEXT,archived INTEGER,expires_at TEXT,project TEXT,metadata TEXT)');
 const insert=db.prepare('INSERT INTO memories VALUES(?,?,?,1,NULL,?,NULL,0,?,NULL,?)');insert.run('Expired','project','EXPIRED_BODY','2026-11-14T17:00:00.000Z','2026-11-14T18:00:00.000Z','{}');insert.run('Future','episode','FUTURE_BODY','2026-11-14T19:00:00.000Z',null,'{}');
 expect(digestOnConnection(db,{nowMs:now})).toContain('EXPIRED_BODY');expect(digestOnConnection(db,{nowMs:now,excludeExpired:true})).toBeNull();
 expect(episodesOnConnection(db,{nowMs:now})).toHaveLength(1);expect(episodesOnConnection(db,{nowMs:now,excludeFuture:true})).toEqual([]);
});
