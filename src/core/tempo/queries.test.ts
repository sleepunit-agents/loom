import Database from 'better-sqlite3';
import { expect,it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { household } from '../data/schema.js';
import { tempoQueryFields } from './queries.js';
it('projects only timezone to member/agent schemas and gives no value to other callers',()=>{
 const client=new Database(':memory:'),db=createDataSchema(client);
 try {
  expect(tempoQueryFields(db,{kind:'member',id:'sam'}).tempoTimezone.resolve()).toBe('UTC');
  db.insert(household).values({timezone:'America/Chicago',backupTarget:'PRIVATE TARGET'}).run();
  for(const kind of ['member','agent'] as const)expect(tempoQueryFields(db,{kind,id:'caller'}).tempoTimezone.resolve()).toBe('America/Chicago');
  for(const kind of ['runner','service'] as const)expect(tempoQueryFields(db,{kind,id:'caller'}).tempoTimezone.resolve()).toBeNull();
  expect(Object.keys(tempoQueryFields(db,{kind:'member',id:'sam'}))).toEqual(['tempoTimezone']);
 } finally {client.close();}
});
