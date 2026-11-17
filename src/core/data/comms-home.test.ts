import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database.js';
import { agents, members, memberAgents } from './schema.js';
import { CommsQueries, commsQueryFields } from '../conversations/comms-query.js';
import { CommsMessages } from '../conversations/messages.js';
import { homeCommsQuery } from '../../../web/src/pieces/attention/home-comms-data.js';

it('keeps the actual Home selection at the same few statements for two and ten owned agents', async () => {
  const statements:string[]=[],client=new Database(':memory:',{verbose:s=>{if(/^select\b/i.test(s))statements.push(s);}});
  try {
    const at='2026-11-15T00:00:00.000Z',db=createDataSchema(client,()=>at);
    db.insert(members).values([{id:'member',role:'member',joinedAt:at},{id:'other',role:'member',joinedAt:at}]).run();
    const key={seal:async(s:string)=>Buffer.from(s),hash:(s:string)=>s,open:async()=>{throw Error('Home must never decrypt words');}};
    const comms=new CommsMessages(db,key,()=>at);
    const service=new CommsQueries(db,key,(viewer,f)=>sql`${f.member}=${viewer.id}`,()=>at);
    const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:commsQueryFields(service)})});
    const read=async()=>{
      statements.length=0;
      const result=await graphql({schema,source:homeCommsQuery,contextValue:{viewer:{kind:'member',id:'member'}}});
      expect(result.errors).toBeUndefined();
      expect(statements.join('\n')).not.toContain('"words"');
      return {data:JSON.parse(JSON.stringify(result.data)).homeComms,count:statements.length};
    };
    let small=0;
    for(let n=0;n<10;n++){
      const agent='agent-'+n;
      db.insert(agents).values({id:agent,about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
      db.insert(memberAgents).values({member:'member',agent}).run();
      const visible=comms.threads.open({id:'th:visible-'+n,member:'member',agent,title:'Visible '+n});
      const hidden=comms.threads.open({id:'th:hidden-'+n,member:'other',agent,title:'Forbidden '+n});
      await comms.send({thread:visible.id,sender:agent,kind:'reply',words:'Allowed reply'});
      await comms.send({thread:hidden.id,sender:agent,kind:'reply',words:'Forbidden reply'});
      if(n===1){const result=await read();expect(result.data.agents).toHaveLength(2);small=result.count;}
    }
    const large=await read();
    // Six for the household's sharing, which policy.ts is asked about, then the agents and the threads.
    expect(large.count).toBe(small);expect(large.count).toBe(8);
    expect(large.data.summaries).toHaveLength(10);
    for(const row of large.data.summaries)expect(row).toMatchObject({unread:1,last:{thread:'th:visible-'+row.agent.split('-')[1]}});
    expect(JSON.stringify(large.data)).not.toContain('Forbidden');
  } finally {client.close();}
});
