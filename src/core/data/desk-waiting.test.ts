import Database from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database';
import { agents, members, memberAgents, inbox as inboxTable } from './schema';
import { CommsMessages } from '../conversations/messages';
import { CommsQueries, commsQueryFields } from '../conversations/comms-query';
import { InboxQueries, inboxQueryFields } from '../conversations/inbox-query';
import { deskWaitingCountsQuery, deskAgentWaitingQuery, waitingCounts, waitingPreview, type WaitingCountsData, type WaitingPreviewData } from '../../../web/src/pieces/attention/waiting';
it('executes exact desk counts and first-item queries with recipient filtering, no legacy store and no counting from a page',async()=>{
 const client=new Database(':memory:');
 try {
  const at='2026-11-14T00:00:00Z',db=createDataSchema(client,()=>at);let opens=0,allowed=true;
  db.insert(members).values([{id:'alice',role:'member',joinedAt:at},{id:'bob',role:'member',joinedAt:at}]).run();
  db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(memberAgents).values({member:'alice',agent:'art'}).run();
  const key={seal:async(s:string)=>Buffer.from(s),hash:(s:string)=>s,open:async(b:Uint8Array)=>{opens++;return Buffer.from(b).toString();}};
  const messages=new CommsMessages(db,key,()=>at),thread=messages.threads.open({member:'alice',agent:'art',title:'Private'});
  const ask=await messages.ask(thread.id,'art','ask-one',{words:'Own private question',answers:'yes-no'});
  for(let n=0;n<101;n++)messages.threads.conversations.send({toKind:'person',to:'alice',member:'alice',agent:'art',source:'notice',fromKind:'agent',words:'Older question',answers:'words'});
  db.update(inboxTable).set({at:'2026-11-13T00:00:00Z'}).where(eq(inboxTable.source,'notice')).run();
  const policy=(viewer:any,fields:any)=>allowed&&viewer.kind==='member'?eq(fields.member,viewer.id):sql`false`;
  const inbox=new InboxQueries(db,key,policy,()=>at),comms=new CommsQueries(db,key,policy,()=>at);
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:{...inboxQueryFields(inbox),...commsQueryFields(comms)}})});
  const read=(source:string,id='alice',variables?:Record<string,string>)=>graphql({schema,source,variableValues:variables,contextValue:{viewer:{kind:'member',id}}});
  const count=await read(deskWaitingCountsQuery);expect(count.errors).toBeUndefined();
  const counts=waitingCounts({status:'live',data:count.data as unknown as WaitingCountsData});
  expect(counts.total).toBe(102);expect(counts.agents.get('art')).toBe(102);expect(opens).toBe(0);
  const first=await read(deskAgentWaitingQuery,'alice',{agent:'art'});expect(first.errors).toBeUndefined();
  const shown=waitingPreview({status:'live',data:first.data as unknown as WaitingPreviewData},Date.parse(at),'art');
  expect(shown.item).toMatchObject({id:ask.inboxItem,body:{words:'Own private question'}});
  const bob=await read(deskAgentWaitingQuery,'bob',{agent:'art'});expect(bob.errors).toBeUndefined();
  expect(waitingPreview({status:'live',data:bob.data as unknown as WaitingPreviewData},Date.parse(at)).item).toBeUndefined();
  allowed=false;const revoked=await read(deskWaitingCountsQuery);expect(revoked.errors).toBeUndefined();
  expect(waitingCounts({status:'live',data:revoked.data as unknown as WaitingCountsData}).total).toBe(0);
 }finally{client.close();}
});
