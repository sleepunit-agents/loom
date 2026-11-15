import {expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {graphql,GraphQLObjectType,GraphQLSchema} from 'graphql/index.js';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {household,members} from './core/data/schema.js';
import {deskTimeFields,startDeskTime} from './desk-time.js';
it('reads only the current personal household time and applies current member removal',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(Date.parse('2026-11-14T18:41:29Z')),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 try{
  db.insert(members).values({id:'sam',role:'member',joinedAt:new Date(clock.now()).toISOString()}).run();db.insert(household).values({timezone:'America/Chicago'}).run();
  const schema=new GraphQLSchema({query:new GraphQLObjectType({name:'Query',fields:deskTimeFields(db,clock)})});
  const read=(viewer:object)=>graphql({schema,source:'{ deskTime { at timezone } }',contextValue:{viewer}});
  const prepared=vi.spyOn(client,'prepare');
  expect(await read({kind:'member',id:'sam'})).toMatchObject({data:{deskTime:{at:Date.parse('2026-11-14T18:41:00Z'),timezone:'America/Chicago'}}});
  expect(prepared.mock.calls).toHaveLength(1);expect(prepared.mock.calls[0][0]).toMatch(/from "members" left join "household".*where "members"\."id" = \?/);prepared.mockRestore();
  expect(await read({kind:'agent',id:'sam'})).toMatchObject({data:{deskTime:null}});expect(await read({kind:'member',id:'missing'})).toMatchObject({data:{deskTime:null}});
  db.delete(members).run();expect(await read({kind:'member',id:'sam'})).toMatchObject({data:{deskTime:null}});
 }finally{client.close();}
});
it('publishes the current minute once after a long jump, and cancels queued or scheduled callbacks on close',async()=>{
 const clock=new FakeClock(1000),changed=vi.fn(),report=vi.fn(),stop=startDeskTime(clock,changed,report);
 clock.advance(365*86400000);expect(changed).not.toHaveBeenCalled();await Promise.resolve();expect(changed).toHaveBeenCalledTimes(1);
 clock.advance(60000);stop();await Promise.resolve();expect(changed).toHaveBeenCalledTimes(1);clock.advance(60000);await Promise.resolve();expect(changed).toHaveBeenCalledTimes(1);expect(report).not.toHaveBeenCalled();
});
