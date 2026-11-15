import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database';
import { dataQueries } from './queries';
import { agents, agentStatus } from './schema';
import { deskAgentStatuses, deskAgentStatusQuery, type DeskAgentStatusData } from '../../../web/src/pieces/attention/agent-status';

it('reads the current minimal agent report, observes replacement, and reapplies fixture visibility', async () => {
  const client = new Database(':memory:');
  try {
    const db=createDataSchema(client), at='2026-11-14T00:00:00Z';
    for(const id of ['art','hidden'])db.insert(agents).values({id,about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
    db.insert(agentStatus).values([{agent:'art',state:'working',work:'Checking the fixture',changedAt:at},{agent:'hidden',state:'waiting',work:'Hidden work',changedAt:at}]).run();
    let visible=true;
    // Fixture policy only. Root supplies current agent sharing on the same HTTP/socket door.
    const schema=dataQueries(client,{tables:['agentStatus'],visibility:{agentStatus:f=>visible?sql`${f.agent} = 'art'`:sql`false`}});
    const read=()=>graphql({schema,source:deskAgentStatusQuery});
    const first=await read();expect(first.errors).toBeUndefined();
    expect(first.data).toEqual({agentStatus:[{agent:'art',state:'working',work:'Checking the fixture',changedAt:at}]});
    const data=first.data as unknown as DeskAgentStatusData;
    expect(deskAgentStatuses({status:'live',data})).toEqual({status:'live',records:[{id:'art',agent:'art',state:'working',work:'Checking the fixture',changedAt:Date.parse(at)}]});
    for(const status of ['loading','offline','denied'] as const)expect(deskAgentStatuses({status,data})).toEqual({status,records:[]});
    expect(deskAgentStatuses({status:'live'})).toEqual({status:'loading',records:[]});
    db.update(agentStatus).set({state:'idle',work:'',changedAt:'2026-11-14T01:00:00Z'}).where(sql`${agentStatus.agent} = 'art'`).run();
    expect((await read()).data).toEqual({agentStatus:[{agent:'art',state:'idle',work:'',changedAt:'2026-11-14T01:00:00Z'}]});
    visible=false;
    const empty=await read();expect(empty.data).toEqual({agentStatus:[]});
    expect(deskAgentStatuses({status:'live',data:empty.data as unknown as DeskAgentStatusData})).toEqual({status:'live',records:[]});
  } finally {client.close();}
});
