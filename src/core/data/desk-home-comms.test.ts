import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { expect, it } from 'vitest';
import { createDataSchema } from './database';
import { members, agents, memberAgents, memberPreferences as preferencesTable } from './schema';
import { dataQueries } from './queries';
import { withQueryFields } from './http';
import { memberPreferences, memberPreferencesQuery, type MemberPreferencesData } from '../../../web/src/shell/member-preferences';
import { CommsMessages } from '../conversations/messages';
import { CommsQueries, commsQueryFields } from '../conversations/comms-query';
import { homeComms, homeCommsQuery, type HomeCommsData } from '../../../web/src/pieces/attention/home-comms-data';

it('executes the exact desk summary selection without words and observes read/ownership changes', async () => {
 const statements:string[]=[],client=new Database(':memory:',{verbose:s=>{if(/^select/i.test(s))statements.push(s);}});
 try {
  const at='2026-11-14T00:00:00Z',db=createDataSchema(client,()=>at);
  db.insert(members).values([{id:'member',role:'member',joinedAt:at},{id:'other',role:'member',joinedAt:at}]).run();
  db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(memberAgents).values({member:'member',agent:'art'}).run();
  const key={seal:async(s:string)=>Buffer.from(s),hash:(s:string)=>s,open:async()=>{throw Error('Desk must not read words');}};
  const messages=new CommsMessages(db,key,()=>at),service=new CommsQueries(db,key,(viewer,f)=>viewer.kind==='member'?sql`${f.member} = ${viewer.id}`:sql`false`,()=>at);
  const own=messages.threads.open({id:'th:own',member:'member',agent:'art',title:'Current conversation'});
  const hidden=messages.threads.open({id:'th:hidden',member:'other',agent:'art',title:'Other member conversation'});
  await messages.send({thread:own.id,sender:'art',kind:'reply',words:'Private reply'});
  await messages.send({thread:hidden.id,sender:'art',kind:'reply',words:'Hidden reply'});
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:commsQueryFields(service)})});
  const read=()=>graphql({schema,source:homeCommsQuery,contextValue:{viewer:{kind:'member',id:'member'}}});
  const defaults={ground:'depth' as const,sound:false,pixel:true,icons:false,haptics:true,oneWindow:false,zoom:false,motion:'follow' as const,contrast:'follow' as const,changedAt:at};
  db.insert(preferencesTable).values([{...defaults,member:'member',look:'daylight'},{...defaults,member:'other',look:'lowlight'}]).run();
  const preferenceSchema=withQueryFields(dataQueries(client,{tables:['memberPreferences'],visibility:{memberPreferences:()=>sql`true`}}),commsQueryFields(service));
  const choices=await graphql({schema:preferenceSchema,source:memberPreferencesQuery});expect(choices.errors).toBeUndefined();
  const identityFor=(id:string)=>graphql({schema:preferenceSchema,source:homeCommsQuery,contextValue:{viewer:{kind:'member',id}}});
  for(const [id,look] of [['member','daylight'],['other','lowlight']] as const) {
    const identity=await identityFor(id);expect(identity.errors).toBeUndefined();
    expect(memberPreferences({status:'live',data:identity.data as unknown as HomeCommsData},{status:'live',data:choices.data as unknown as MemberPreferencesData}).records[0]).toMatchObject({id,prefs:{look}});
  }
  const missing=await identityFor('missing');expect(missing.errors).toBeUndefined();
  expect(memberPreferences({status:'live',data:missing.data as unknown as HomeCommsData},{status:'live',data:choices.data as unknown as MemberPreferencesData})).toEqual({status:'denied',records:[]});

  statements.length=0;
  const first=await read();expect(first.errors).toBeUndefined();
  expect(first.data).toEqual({homeComms:{member:'member',agents:['art'],summaries:[{agent:'art',unread:1,last:{thread:'th:own',title:'Current conversation',at},first:{thread:'th:own'}}]}});
  expect(statements.join('\n')).not.toContain('"words"');
  expect(homeComms({status:'live',data:first.data as unknown as HomeCommsData}).reading?.summaries[0].last?.at).toBe(Date.parse(at));
  messages.threads.read(own.id,1);
  const seen=await read();expect((seen.data as unknown as HomeCommsData).homeComms?.summaries[0].unread).toBe(0);
  db.delete(memberAgents).run();
  expect((await read()).data).toEqual({homeComms:{member:'member',agents:[],summaries:[]}});
 } finally {client.close();}
});
